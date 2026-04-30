# OctoClaw ACK State Source Matrix

日期：2026-04-21

状态：v1 working spec

用途：这份文档专门定义 ACK Phase 1 需要消费的最小状态集合。重点不是“设计更多状态”，而是明确：

1. 每个状态从哪里来
2. 谁负责 set / clear
3. 真相源优先级是什么
4. ACK controller 应该怎么消费这些状态

## 1. 设计边界

ACK Phase 1 只依赖 4 个核心 gate 状态：

1. `tool_active`
2. `delegated_running`
3. `final_response_streaming`
4. `delivery_pending`

再辅以 substrate/native truth：

1. `queued`
2. `running`
3. `blocked`
4. `completed`
5. `failed`
6. `cancelled`
7. `checkpoint_seen`
8. `result_ready`

这份 spec 的目标不是建立一套“大而全 agent 心理状态机”，而是为了：

1. 真在执行时才 ACK
2. 一旦最终答复开始流或进入待投递，就 suppress ACK
3. 避免 wall-clock 到点就盲发 ACK

## 2. 真相源优先级

ACK controller 必须遵守下面的优先级：

1. **OpenClaw substrate / native taskflow truth**
2. **OctoClaw runtime hook / streaming signals**
3. **本地 tracking state / cached view**

也就是说：

1. 如果 native truth 已显示 `completed/failed/cancelled`，不得继续把该工作视为 `delegated_running`
2. runtime 补充信号只用于 ACK gate，不允许覆盖 substrate 的终态事实
3. cached ACK state 只作为短时投影，不得成为独立真相源

## 3. 状态来源矩阵

| 状态 | 来源类型 | set 条件 | clear 条件 | 真相源优先级 | ACK 用法 |
| --- | --- | --- | --- | --- | --- |
| `tool_active` | runtime hook | 主线程开始执行工具/检索/probe | 工具调用结束、报错、取消、最终答复开始 | 中 | `true` 时 ACK eligible |
| `delegated_running` | native + runtime | 已创建 delegate attempt，native task/flow 进入 `queued/running/blocked` | native 进入 `completed/failed/cancelled`，或 attempt superseded | 高 | `true` 时 ACK eligible |
| `final_response_streaming` | runtime streaming | 主线程最终答复首 token / 首 chunk 发出 | turn 结束，或本次 delivery 完成/清理 | 中 | `true` 时 suppress ACK |
| `delivery_pending` | delivery/outbox | 最终结果已 ready，已进入 outbox / pending send | delivery receipt 成功，或 send failed terminal | 中高 | `true` 时 suppress ACK |
| `queued` | native truth | native flow/task 已 accepted 但未真正开始 | native 进入 `running/blocked/completed/...` | 最高 | 可辅助解释 delegate 尚未启动 |
| `running` | native truth | native task 正在执行 | native 进入终态 | 最高 | 可辅助推导 `delegated_running=true` |
| `blocked` | native truth | native task/flow 明确 blocked | unblocked 或终态 | 最高 | ACK eligible，且可带 blocked 文案 |
| `completed` | native truth | native task 完成 | 终态保持 | 最高 | suppress delegate-running 型 ACK |
| `failed` | native truth | native task 失败 | 终态保持 | 最高 | suppress普通 ACK，交 recovery 决定 |
| `cancelled` | native truth | native task 被取消 | 终态保持 | 最高 | suppress ACK |
| `checkpoint_seen` | native truth | 收到 checkpoint/revision 事件 | turn cleanup | 高 | 可选增强 ACK 文案，不单独触发 ACK |
| `result_ready` | native truth | substrate/result 已 ready | delivery 完成或 cleanup | 高 | 通常与 `delivery_pending` 一起 suppress ACK |

## 4. 每个核心状态的 owner

### 4.1 `tool_active`

owner：

1. runtime hook / tool wrapper

要求：

1. 只在真正开始工具执行时 set
2. 不允许把“普通思考/组织语言”也记成 `tool_active`
3. 工具结束时必须 clear
4. 如果工具抛错，也必须 clear

### 4.2 `delegated_running`

owner：

1. delegate materializer
2. native taskflow adapter
3. recovery / attempt switch

要求：

1. delegate accepted 后不能直接永远视为 running
2. 应以 native `queued/running/blocked` 投影为主
3. attempt 被 `superseded` 后必须从旧 attempt 上 clear

### 4.3 `final_response_streaming`

owner：

1. runtime streaming hook
2. main-thread final delivery stream adapter

要求：

1. 只在最终用户可见答复首 token / 首 chunk 出现时 set
2. 不能把 pre-dispatch ACK / intermediate status update 误算成 final streaming
3. 一旦 set，ACK controller 必须立即 suppress 后续 ACK

### 4.4 `delivery_pending`

owner：

1. delivery outbox
2. send/receipt bridge

要求：

1. 只在最终结果 ready 且进入待发送阶段时 set
2. 发送成功或终止失败时 clear
3. `delivery_pending` 不等于 `final_response_streaming`

## 5. ACK controller 消费规则

ACK controller 不应自己推理这些状态，而只消费一个聚合包。

最小 packet：

```json
{
  "state_key": "",
  "route": "reply | delegate",
  "native_state": "queued | running | blocked | completed | failed | cancelled",
  "checkpoint_seen": false,
  "result_ready": false,
  "tool_active": false,
  "delegated_running": false,
  "final_response_streaming": false,
  "delivery_pending": false,
  "delivered": false
}
```

消费原则：

1. `tool_active || delegated_running || native_state == blocked` 才 eligible
2. `final_response_streaming || delivery_pending || delivered` 一律 suppress
3. `completed || failed || cancelled` 默认不再发送普通 ACK

## 6. 兜底清理

为了避免状态卡死，允许轻量兜底清理，但这不是主真相源。

建议的兜底：

1. turn finalize 时清理 `tool_active`
2. delivery finalize 时清理 `delivery_pending`
3. stream finalize 时清理 `final_response_streaming`
4. substrate 终态事件到达时兜底清理 `delegated_running`

## 7. 明确禁止

1. 不允许为了 ACK 去扫 transcript / 原始日志
2. 不允许用模型推断“是不是快答完了”
3. 不允许让 ACK state 独立于 substrate 长时间漂移
4. 不允许把“thinking / composing / summarizing”这类宽泛心理状态塞进 Phase 1

## 8. 一句话总结

> ACK Phase 1 只需要 4 个窄状态：`tool_active / delegated_running / final_response_streaming / delivery_pending`。其中 substrate truth 优先，runtime signal 只做补充，ACK controller 只消费、不自行推理。
