# OctoClaw ACK Thread Delivery Spec

日期：2026-04-21

状态：v1 working spec

用途：定义 ACK 如何稳定回到正确的用户 thread / session，避免再次出现“ACK 跑到 thread 外面”的回归。

## 1. 背景问题

当前风险不是 ACK 文案本身，而是 ACK target resolution 很容易退化成：

1. 只看 `session_key`
2. 自己在 ACK 模块里再维护一套简化解析
3. 最终丢掉真实 `thread binding`

这会直接导致：

1. ACK 发回 channel root
2. ACK 发到 thread 外层
3. dedupe key 和实际 target 不一致

## 2. 规范目标

ACK delivery 必须保证：

1. route / judge / ACK 共享同一套 canonical session/thread truth
2. ACK 模块不再自己发明另一套简化 session 解析
3. dedupe / delivery / outbox 都围绕同一 `thread binding`

## 3. canonical resolver 原则

ACK delivery 必须复用 runtime 的 canonical session resolver，不允许在 ACK 模块里长期维护平行实现。

推荐优先级：

1. `session_thread_key`
2. `session_binding_key`
3. `session_origin`
4. canonical user-facing session descriptor
5. direct session key fallback

这意味着：

1. 如果 metadata 已明确给出 `session_thread_key`，ACK 必须优先回这个 thread
2. 如果只有 `session_binding_key`，ACK 至少要回正确的 user/channel binding
3. 只有在前面都不可用时，才允许退回 direct session key

## 4. ACK target contract

ACK controller 不应直接消费散乱的 `ctx.sessionKey / ctx.sessionId / stateKey`，而应消费一个统一 target 包：

```json
{
  "session_key": "",
  "session_origin": "",
  "session_target": "",
  "session_binding_key": "",
  "session_thread_key": "",
  "thread_id": "",
  "message_id": ""
}
```

推荐实现：

1. `buildPolicyMetadata(...)` 产出这个包
2. canonical resolver 从 descriptor / registry / binding 中补全
3. ACK send path 只吃规范化后的 target

## 5. dedupe key 规则

ACK dedupe key 必须基于真实 thread 绑定，而不是回退后的模糊 state key。

推荐组成：

1. `thread_id` 或 canonical `session_thread_key`
2. `anchor_id`（如果存在）
3. `ack_stage`
4. `route_phase`
5. `message_turn_id`

明确禁止：

1. 直接用 `parsed.target || stateKey` 代替 thread binding
2. 让 dedupe key 和实际 send target 使用不同解析逻辑

## 6. send path 规范

ACK send path 必须遵守：

1. 先 canonical resolve target
2. 再 build dedupe key
3. 再 send
4. send receipt 回写同一 target identity

也就是说，不能先用简化 key 去 dedupe，再用另一套 target 发送。

## 7. 回退策略

如果 thread target 解析失败，不要静默改发到错误位置。

允许的回退顺序：

1. thread target
2. binding target
3. user-facing session root
4. drop / unresolved

是否允许 root fallback，必须明确配置；默认不应悄悄把 thread 内 ACK 发回 root。

## 8. 诊断字段

每次 ACK send 至少记录：

1. `ack_target_resolution_state`
2. `ack_delivery_state`
3. `resolved_thread_key`
4. `resolved_binding_key`
5. `resolved_target`
6. `fallback_level`

这样以后线上再出 thread 偏移时，能直接看出是：

1. metadata 丢了
2. canonical resolver 失效
3. send path fallback 太激进

## 9. 验收标准

至少验证这 4 类 case：

1. thread 内用户消息 -> ACK 仍回同一 thread
2. delegate 路径 pre-dispatch ACK -> 仍回同一 thread
3. latency ACK -> 仍回同一 thread
4. formal reply 已发送后，ACK 不会再回 root 或额外发一条 thread 外消息

## 10. 一句话总结

> ACK thread delivery 不是“尽量解析对就行”，而必须建立在 canonical session/thread resolver 上；ACK 模块不允许再长期维护一套简化的 thread 解析器。
