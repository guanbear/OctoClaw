# OctoClaw ACK Decision Truth Table

日期：2026-04-21

状态：v1 working spec

用途：把 ACK Phase 1 的决策从“原则描述”进一步收成一张实现可直接对照的真值表，避免实现时各自理解。

2026-04-24 修正：

1. 首 ACK 不再固定等 5s；`reaction_ack` 默认约 1s，`text_ack0` 默认约 3s，5s 只是保守上限。
2. `reaction_ack` 与 `text_ack0` 对同一 turn 二选一，二者都算 ACK0。
3. reply 路径下 `main_model_active && !first_token_seen` 也可触发 ACK0，不再只限定 `tool_active / blocked`。
4. 模板文案必须来自 stage/channel/tone scoped registry，并用稳定 hash 选择，不能用无边界随机万能模板池。

## 1. 目标

这份表只回答一件事：

> 到了 ACK 检查点之后，系统到底该 `send_reaction_ack`、`send_text_ack0`、`enqueue_ack_writer`、`suppress_ack` 还是 `cancel_ack_writer`。

timer 只是“到点检查”的时钟，不是“到点就直接发 ACK”的命令。

## 2. 输入字段

最小输入：

1. `silence_elapsed`
2. `route`
3. `reaction_ack_checkpoint_elapsed`
4. `text_ack0_checkpoint_elapsed`
5. `reaction_ack_supported`
6. `reaction_ack_enabled`
7. `reaction_ack_sent`
8. `text_ack0_sent`
9. `first_token_seen`
10. `main_model_active`
11. `tool_active`
12. `blocked`
13. `final_response_streaming`
14. `delivery_pending`
15. `delivered`
16. `formal_reply_visible`
17. `delegate_update_visible`
18. `user_input_active`

## 3. 输出动作

1. `send_reaction_ack`
2. `send_text_ack0`
3. `enqueue_ack_writer`
4. `suppress_ack`
5. `cancel_ack_writer`
6. `no_action`

## 4. 总优先级

ACK 决策优先级固定为：

1. `delivered`
2. `final_response_streaming`
3. `delivery_pending`
4. `formal_reply_visible / delegate_update_visible`
5. `first_token_seen`
6. `user_input_active`
7. `main_model_active / tool_active / delegated_running / blocked`
8. `reaction_ack_checkpoint_elapsed / text_ack0_checkpoint_elapsed / silence_elapsed`

也就是说，只要进入“最终答复已开始/待投递/已送达”这组状态，ACK 一律不该继续发。

## 5. 真值表

| 条件 | 动作 | 说明 |
| --- | --- | --- |
| `route != reply` | `suppress_ack` | v1 Phase 1 默认不把 reply-style ACK 用在 delegate 路径 |
| `delivered == true` | `suppress_ack + cancel_ack_writer` | 已经交付，ACK 完全结束 |
| `final_response_streaming == true` | `suppress_ack + cancel_ack_writer` | 最终答复已开始流出，不能再插 ACK |
| `delivery_pending == true` | `suppress_ack + cancel_ack_writer` | 结果已在发送路径上，不再补 ACK |
| `formal_reply_visible == true` | `suppress_ack + cancel_ack_writer` | 用户已看到正式主回复 |
| `first_token_seen == true` | `suppress_ack + cancel_ack_writer` | 主模型已开始首字输出，ACK 不再抢首响 |
| `delegate_update_visible == true` 且用户已有可见进展 | `suppress_ack` | 已有可见 delegate 进展，无需补 ACK |
| `user_input_active == true` | `no_action` | 用户仍在连续输入，不抢插 ACK |
| `silence_elapsed == false` | `no_action` | 还没到检查窗口 |
| `reaction_ack_checkpoint_elapsed == true` 且 `reaction_ack_supported && reaction_ack_enabled` 且 `main_model_active || tool_active || blocked` 且 `reaction_ack_sent == false` 且 `text_ack0_sent == false` | `send_reaction_ack` | 表情/反应 ACK0；约 1s 检查点 |
| `text_ack0_checkpoint_elapsed == true` 且 `reaction_ack_sent == false` 且 `text_ack0_sent == false` 且 `main_model_active || tool_active || blocked` | `send_text_ack0` | 文字 ACK0；约 3s 检查点 |
| `ack0 已发出` 且仍静默 且 `main_model_active || tool_active || blocked` | `enqueue_ack_writer` | 允许低优先级补更自然 nudge |
| `ack_writer 已排队` 且出现 `final_response_streaming || delivery_pending || delivered || formal_reply_visible` | `cancel_ack_writer` | 一旦正式输出出现，立即取消 |
| `silence_elapsed == true` 但没有 `main_model_active / tool_active / blocked` | `suppress_ack` | 不再按纯超时盲发 ACK |

## 6. 推荐伪代码

```ts
if (delivered || final_response_streaming || delivery_pending) {
  return suppress_and_cancel;
}

if (route !== "reply") {
  return suppress;
}

if (formal_reply_visible || delegate_update_visible || first_token_seen) {
  return suppress_and_cancel;
}

if (user_input_active) {
  return no_action;
}

if (!(main_model_active || tool_active || blocked)) {
  return suppress;
}

if (
  reaction_ack_checkpoint_elapsed &&
  reaction_ack_supported &&
  reaction_ack_enabled &&
  !reaction_ack_sent &&
  !text_ack0_sent
) {
  return send_reaction_ack;
}

if (
  text_ack0_checkpoint_elapsed &&
  !reaction_ack_sent &&
  !text_ack0_sent
) {
  return send_text_ack0;
}

if (!silence_elapsed) {
  return no_action;
}

return enqueue_ack_writer;
```

## 7. 实现注意事项

1. `delegate_update_visible` 只指用户已看到的正式进展，不包括内部 checkpoint
2. `formal_reply_visible` 必须由真正的用户可见主回复驱动，不包括 reaction 或软 ACK
3. `enqueue_ack_writer` 必须是低优先级、可取消
4. `send_reaction_ack` / `send_text_ack0` 不应再次触发 route judge
5. `reaction_ack` 与 `text_ack0` 对同一 turn 二选一，且都必须写入同一 ACK0 receipt/lease 体系
6. ACK 文案从模板 registry 稳定选择，不使用无边界随机模板池

## 8. Phase 1 不解决的事

1. 不尝试预测“再过 300ms 就答完”
2. 不尝试用模型判断“现在像不像在总结最后答案”
3. 不把 ACK writer 当作第二个 route authority

## 9. 一句话总结

> ACK Phase 1 的真值表本质上是：先看“是不是已经进入最终输出阶段”，再看“是不是还真的在执行”，最后才看 silence timer。
