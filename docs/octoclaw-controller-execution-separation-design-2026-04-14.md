# OctoClaw Controller / Execution Separation Design（2026-04-14）

状态：draft  
目标：减少主 agent 被控制面打扰，降低 ACK 延迟，减少 runner / spawn 误派发，保留主 agent 的纠偏权而不是让它承担日常调度。

关联文档：

- [octoclaw-router-policy-refactor-2026-04-10.md](./octoclaw-router-policy-refactor-2026-04-10.md)
- [octoclaw-runtime-slimming-plan-2026-04-12.md](./octoclaw-runtime-slimming-plan-2026-04-12.md)
- [octoclaw-design-foundation.md](./octoclaw-design-foundation.md)

---

## 1. 问题定义

当前慢回复、乱回复、runner 不稳定，不是单点 bug，而是职责边界错位：

- 主 agent 同时负责 ACK、路由判断、runner / spawn 派发、会话污染防护、失败重试、最终回答。
- judge / route / dispatch / task-state / delivery 各自维护一套“当前到底发生了什么”的说法。
- control-observer 问题、当前模型问题、任务进度问题，本质是查状态，却经常拉起主 agent 做完整生成式回答。
- active-memory 会打断主链首响应。
- delegated lane 出错后，主 agent 常常被拖回执行细节，既慢又容易说乱。

需要的不是再加几条 regex，也不是改几句文案，而是把控制面、执行面、回答面拆开。

---

## 2. 目标

这次设计目标只有四个：

1. ACK 不依赖主 agent。
2. 默认路由、派发、重试由 controller 负责。
3. 主 agent 只看结构化 execution ledger，不直接消费脏执行上下文。
4. 主 agent 保留纠偏权，但不负责日常调度。

补充约束：

- controller 的误判必须可纠正。
- runner / spawn / direct 都要写入同一份 lifecycle truth。
- 用户追问“怎么查的”“刚才那个任务成功了吗”时，应该优先走轻量状态控制器，而不是拉起主 agent 做重思考。

---

## 3. 新架构

```text
Transport / Gateway ingress
  -> ingress ACK
  -> controller
      -> front gate signal extractor
      -> judge adapter
      -> route + budget planner
      -> dispatch / retry / fallback
      -> execution ledger
  -> execution plane
      -> runner
      -> spawn_single / spawn_multi
      -> native taskflow binding
  -> answer plane
      -> main agent (direct lane only by default)
      -> correction / compose / explanation when needed
```

---

## 4. 三层职责

### 4.1 Transport / ingress plane

这一层负责：

- 接收 IM 消息
- 生成稳定的 session / binding / thread 目标
- 发送首个 ACK

不负责：

- 主回答
- 路由纠偏
- provenance 推理

规则：

- ACK 在 transport 层发出，不等待主 agent。
- ACK target 必须只依赖 canonical session binding，不允许再用“半解析 session 字符串”当事实源。
- ACK send failure 要写 execution ledger，并带 `reason=target_resolution_failed | send_failed | channel_error`。

### 4.2 Controller plane

这一层负责：

- front gate signal extraction
- judge 调用
- 决定 direct / runner / spawn_single / spawn_multi
- 派发
- retry / fallback
- 生命周期写账

不负责：

- 直接写用户长答案

规则：

- controller 是默认调度者。
- 只要 route 不是 `direct`，主 agent 不进入执行路径。
- 派发成功必须有证据：
  - `dispatch_called`
  - materialization record
  - queue / claim / running transition
- 没有证据不能说“已派发”。

### 4.3 Answer plane

这一层负责：

- direct lane 回答
- delegated 结果的最终收口
- 低置信 / 冲突 / relevance 失败时纠偏

不负责：

- 默认 ACK
- 默认 runner 派发
- 默认重试调度

---

## 5. 主 agent 的正确角色

主 agent 不是被完全拿出系统，而是从“控制面总控”退回“回答与纠偏者”。

### 5.1 主 agent 默认负责什么

- `route=direct` 的真实回答
- delegated 结果回来的最终 compose
- 用户追问解释时读取 execution ledger 做叙述

### 5.2 主 agent 不再默认负责什么

- 收消息后的第一跳 ACK
- runner / spawn 的实际派发
- queue / claim / lease / timeout 管理
- 失败重试策略
- session 污染修复

### 5.3 主 agent 保留什么权力

保留纠偏权：

- controller 低置信
- judge 与 rule 冲突
- delegated result relevance 失败
- retry / fallback 都失败
- 用户显式追问来龙去脉

---

## 6. “2”的细化：controller 默认派发，但主 agent 保留纠偏权

用户担心点是对的：如果 controller 派错了，而主 agent 完全不知情，系统会更糟。

因此设计不是：

> controller 一票定生死，主 agent 永远不参与

而是：

> controller 负责默认执行；主 agent 在歧义 / 失败 / 追问时读取 execution ledger 介入纠偏

### 6.1 controller 默认执行

适合 controller 自动执行的情况：

- local surface lookup
- fresh live lookup
- 明确 runner playbook / runner goal
- 明确 spawn_single / spawn_multi
- control-observer 查询

### 6.2 触发主 agent 纠偏的条件

任何一条满足都可以上升到主 agent：

- route margin 太小
- judge 输出低置信或 invalid
- delegated result relevance failed
- dispatch failed after retry budget exhausted
- fallback exhausted
- 用户问“为什么这样判”“你刚才怎么查的”“是不是派错了”

### 6.3 主 agent 读取什么

主 agent 不读取脏 transcript，而读取 `execution ledger packet`：

```json
{
  "user_goal": "...",
  "final_route": "runner",
  "decision_reason_codes": ["fresh_live_lookup"],
  "ack_state": "sent",
  "dispatch_state": "claimed",
  "runner_plan_kind": "upstream_release_lookup",
  "result_state": "relevance_failed",
  "fallbacks_attempted": ["runner"],
  "handoff_needed": true
}
```

这样主 agent 知道来龙去脉，但不会被原始执行噪音污染。

---

## 7. ACK 设计

### 7.1 ingress ACK

ACK 前移到 gateway / ingress：

- 收到消息后立即启动 ACK timer
- timer 不依赖主 agent
- timer 不依赖 active-memory
- timer 不依赖 judge 完成

推荐阈值：

- 300-500ms：开始计时
- 800ms：若还无可见回复，发送 neutral ACK

### 7.2 ACK 类型

只有三类：

- `brief_status`：`我先看一下，马上给你结论。`
- `dispatch_status`：`我先派发处理，稍后给你结果。`
- `state_lookup_status`：`我先看一下当前状态，马上回复你。`

ACK 文案由 controller/ledger 状态决定，不由主 agent 自由生成。

### 7.3 ACK target truth

ACK target 只能来自 canonical binding：

- `session-thread-map`
- `session bindings`
- normalized `target/thread_id`

不允许直接依赖不稳定的 session key 字符串切片。

---

## 8. Execution ledger 作为唯一事实源

### 8.1 主原则

所有用户可见状态都以 execution ledger 为唯一真相源。

至少包括：

- ingress ACK
- route decision
- judge result
- dispatch evidence
- claim / running / completed / failed
- delivery attempt / delivery success / delivery failure
- fallback / retry chain

### 8.2 不能再出现的状态

以下都属于坏状态：

- route=runner，但 taskClass 仍是 direct_answer
- 显示已派发，但没有 queue / claim 证据
- ACK 说已处理，但 ledger 里没有 ACK event
- 主 agent 解释 provenance 时只能靠自己记忆

---

## 9. Active-memory 设计

active-memory 必须异步化。

规则：

- ACK / route / dispatch 是主链
- active-memory 是 sidecar
- 如果 memory 在预算内回来，就增强回答
- 超预算直接放弃，不得阻塞首响应

active-memory 只能影响：

- direct answer 质量
- final compose 质量

不能影响：

- 首 ACK
- route 决策完成
- delegated 派发

---

## 10. Control-observer / local-surface 问题

这些问题不是“生成式回答任务”，而是状态查询：

- 你现在是什么模型
- 你是怎么查的
- 刚才 single 成功了吗
- 当前版本是多少
- control UI 地址

设计要求：

- 优先走轻量控制器 + execution ledger / local surface lookup
- 主 agent 只在需要解释时介入
- 默认不进入大上下文生成

这样能显著减少主 agent 被控制性问题打扰。

---

## 11. Retry / fallback 设计

fallback 不再由主 agent 自己“想怎么办”，而由 controller 的 failure taxonomy 决定。

例如：

- `dispatch_target_unresolvable` -> retry target resolution once, else fail visible
- `runner_queue_full` -> wait / retry according to queue policy
- `runner_worker_unhealthy` -> fallback to on-demand worker
- `relevance_failed` -> one retry with goal-runner, else escalate to main agent
- `spawn_backend_flag_incompatible` -> degrade command generation, not user-visible hard fail

主 agent 只接收已经收敛后的 failure packet。

---

## 12. 实施优先级

### P0

1. ingress ACK 独立化
2. ACK target canonical binding
3. execution ledger 补齐 ACK / dispatch / delivery
4. judge-applied route 语义收敛
5. runner / spawn 协议一致性

### P1

1. control-observer 轻量控制器
2. active-memory sidecar 化
3. fallback taxonomy controller 化

### P2

1. 主 agent correction packet surface
2. controller / execution / answer plane 明确模块边界
3. 在线 acceptance 指标面板

---

## 13. 验收标准

### ACK

- Slack DM 收到消息后 1s 内必须有可见 ACK 或直接答案
- `ack_sent` 必须落 ledger
- ACK target resolution failure 必须可观测

### Runner / spawn

- “已派发”必须有 dispatch evidence
- runner queue / claim / running 必须连贯
- spawn/native command 参数要做 capability probe，不允许再出现固定 flag mismatch

### Main agent

- 默认不参与 delegated 派发
- control-observer 问题优先不唤起主 agent
- 发生纠偏时，主 agent 必须能从 execution ledger 读到完整来龙去脉

---

## 14. 一句话总结

这轮正确方向不是继续堆规则，也不是继续教主 agent 更聪明，而是：

> 让 ACK 前移到 ingress，让 controller 管默认执行，让 execution ledger 成为唯一事实源，让主 agent 只负责回答和纠偏。  

---

## 15. 2026-04-14 生产观察补充

以下问题来自 2026-04-14 `macmini` 真实 Slack / gateway 运行记录，说明当前系统仍有几条“结构没对齐”的残留问题。

### 15.1 ACK 不是没触发，而是 target resolution 和 ACK ownership 仍不稳定

现象：

- 某些 runner turn 已进入 `pre_dispatch_ack_attempted`
- 但 replay 显示 `delivered=false` / `reason=unresolvable` / `channel_message_failed`
- 另一些 turn 会出现双 ACK，例如：
  - `我先处理一下，稍后把结果告诉你。`
  - `收到，我看一下`

说明：

- ACK target 解析仍存在多路径：descriptor/binding + session key 字符串 fallback
- ACK ownership 也不唯一：`eager pre-dispatch ACK` 与 `2s/15s ACK guard` 同时可能生效

设计要求：

- ACK target resolution 只能走 canonical session binding
- ACK source 必须单一：同一 turn 只能有一个 owner
- `eager ACK` 成功后必须立刻取消 guard timer
- `ACK failed` 与 `ACK delivered` 必须显式写 execution ledger

### 15.2 runner 参数问题本质是“协议协商缺失”

现象：

- `task-state-update.py` 曾经不认 `--dispatch-key / --lane-key / --capacity-group`
- native spawn 曾经把 `openclaw agent --model ...` 固定传给不支持该参数的 CLI
- runner goal 命令还出现过 `unknown option '--no-confirm'`

说明：

- 不是单个参数名写错，而是 controller / helper / CLI 之间缺少 capability negotiation

设计要求：

- 所有跨进程参数都必须走 capability probe 或 versioned contract
- 禁止“controller 假设对端支持某 flag”
- 对外部 CLI（OpenClaw 本体）必须做 option negotiation
- 对内部 helper（task-state-update / runner_dispatch）必须做 schema-version alignment

### 15.3 runner 运行模型与设计不一致：系统仍在“假装有常驻 runner”

现象：

- `runner_health_snapshot` 经常引用旧的 `runner-ondemand-*`
- 队列里任务长期 `queued`
- task-state 里 operator surface 写着 `tmux_session_name=octoclaw-runtime`
- 但实际执行链仍大量依赖 one-shot on-demand loop

说明：

- 当前系统并没有真正的 resident runner truth
- 只是把“历史 on-demand worker 的健康状态”当成 resident runner 的健康状态使用

设计要求：

- 明确 runner mode：`resident` / `ondemand`
- resident runner 必须有独立 heartbeat / lease / queue ownership
- 不允许使用“旧 on-demand worker 的 heartbeat”来证明当前 resident runner 可用
- 如果继续保留 tmux resident 设计，就要：
  - 常驻 runner process
  - 每个 job clean context
  - gateway / OpenClaw restart 后自动重建 resident worker

### 15.4 native task binding 仍停留在 mirror-only 幻觉层

现象：

- 大量 task record 里仍是：
  - `openclaw_taskflow_backend = mirror`
  - `native_binding_state = none`
  - `task_id/flow_id = ""`
- 但上层 UI / surface 仍会展示 taskflow 绑定语义

说明：

- 当前更多是“投影记录”，不是实绑定
- controller / UI / provenance 已经在消费 taskflow 语义，但 substrate 还没有真正成为 source of truth

设计要求：

- 明确区分：
  - `mirror-only`
  - `mirror-with-native-match`
  - `native-bound`
- 不允许在 `native_binding_state=none` 时把 taskflow 当成真实 substrate 使用
- execution ledger 中必须清晰暴露 binding truth

### 15.5 controller 仍会把 runner 判定后的 turn 拉回主链

现象：

- 真实 case 中曾出现：
  - `route=runner`
  - 但后续 `lane=main durationMs=12024 error=...`

说明：

- route 决策与实际执行 ownership 之间仍有回流路径

设计要求：

- `route != direct` 时，主 agent 默认不进入执行路径
- controller 负责默认 dispatch
- 主 agent 只在纠偏条件触发时介入

---

## 16. 基于生产观察的下一步优先级

### P0

1. ACK target canonical binding only
2. ACK owner 唯一化（progress ACK / eager ACK / timer ACK 合并）
3. CLI / helper capability negotiation
4. resident runner truth 与 on-demand truth 分离

### P1

1. resident tmux runner lifecycle 设计落地
2. mirror/native task binding truth 分层
3. controller -> main correction packet surface

### P2

1. 生产 acceptance 仪表盘
2. ACK / dispatch / delivery latency 分段指标
3. taskflow substrate 健康面板
