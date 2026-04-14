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

推荐阈值不应该是单一固定值，而应该按 lane 分级：

- `0ms`：记录 ingress start，启动 ACK timer
- `1.2s`：如果最终 lane 是 `runner / spawn_single / spawn_multi`，且 아직没有可见回复，则发送第一条 ACK
- `2.5s`：如果最终 lane 是 `direct` 且属于 `control_observer / session_control / local_surface_lookup`，且 아직没有可见回复，则发送第一条 ACK
- `5s`：无论 lane 是什么，只要仍没有用户可见回复，必须有一条兜底 ACK 或 progress note

解释：

- `800ms` 作为统一阈值过于激进，容易把正常稍慢的 direct 回答也变成“每条都先 ACK”。
- `runner / spawn` 的用户预期本来就是“要去后台查/派发”，因此 1-1.2s 就应该 ACK。
- `direct` lane 尤其是状态类问题，2-3s 内给出 ACK 更符合 Slack 实际体感，也不会把系统做成“每条都抢着发 ACK”。
- `5s` 应作为硬上限，不允许继续沉默。

### 7.2 ACK 类型

ACK 文案必须是**有限模板集**，不是自由生成，也不是每个 case 手写特判。

只允许以下模板：

- `brief_status`
  - `我先看一下，马上给你结论。`
- `dispatch_status`
  - `我先派发处理，稍后给你结果。`
- `state_lookup_status`
  - `我先看一下当前状态，马上回复你。`
- `live_lookup_status`
  - `我先看一下最新更新，马上给你结论。`

选择规则：

- `runner + fresh_live_lookup` -> `live_lookup_status`
- `runner + generic inspect / spawn_*` -> `dispatch_status`
- `direct + control_observer / session_control / local_surface_lookup` -> `state_lookup_status`
- 其他 direct 慢回复 -> `brief_status`

额外约束：

- 同一 turn 最多只允许一个 **user-visible** ACK owner
- `pre_dispatch ACK` 成功后，必须取消 2s / 15s guard timer
- `timer ACK` 触发后，后续不允许再补一条语义重复的 eager ACK
- 如果发送失败，允许写 ledger，但不允许再次生成第二种文案去“碰碰运气”

### 7.3 ACK target truth

ACK target 只能来自 canonical binding：

- `session-thread-map`
- `session bindings`
- normalized `target/thread_id`

不允许直接依赖不稳定的 session key 字符串切片。

实现约束：

- 统一由一处 resolver 负责：
  - 输入：session key / session id / thread key / binding key
  - 输出：`origin + target + thread_id`
- 任何调用 `sendAckDirect`、`send_channel_message`、completion relay 的代码都必须走这一 resolver
- 不允许再保留第二套“只会切 `slack:default:direct:*` 字符串”的 ACK 专用解析器

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

### 11.1 runner / spawn 超时与重试要求

这部分必须显式设计，不能继续隐含在各种 shell loop、heartbeat、watchdog 里。

#### runner

- `dispatch_timeout`
  - 含义：controller 启动 runner dispatch 后，在限定时间内没有拿到 task registration / queue evidence
  - 动作：标记 `dispatch_failed`
  - fallback：直接进入 `main_agent_handoff_packet` 或 `retry_once`

- `queue_timeout`
  - 含义：task 已进入 queued，但在 `queue_timeout_seconds` 内没有 claim
  - 动作：标记 `task_timed_out`
  - fallback：如果 resident runner 不健康 -> 切 `ondemand`; 否则按 retry budget 重排一次

- `running_timeout`
  - 含义：claim 成功后超过 `lease_timeout_seconds`
  - 动作：标记 `runner_lease_expired`
  - fallback：按 failure taxonomy 决定 `retry_runner` / `fallback_main`

#### spawn_single / spawn_multi

- `spawn_bootstrap_timeout`
  - 含义：spawn command 已发出，但 child session / task registration 没有出现
  - 动作：标记 `spawn_bootstrap_failed`
  - fallback：直接回主 agent，不要无限等

- `spawn_execution_timeout`
  - 含义：child 已 running，但超过预算无 terminal result
  - 动作：标记 `spawn_execution_timeout`
  - fallback：生成主 agent correction packet，总结目前已知事实

#### 统一原则

- timeout 必须写 execution ledger
- timeout 必须进入 lifecycle truth，而不是只打日志
- timeout 不能只靠 watchdog 兜底；dispatch/controller 自身就要有 deadline
- 主 agent 接到 fallback packet 后，应该知道：
  - 卡在哪一阶段
  - 已经尝试了哪些 fallback
  - 现在建议怎么回复用户

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
- 同一 turn 不允许出现双 ACK 文案
- replay 中必须能看到：
  - `ack_owner`
  - `ack_kind`
  - `ack_mode`
  - `ack_target_resolution_state`
  - `ack_delivery_state`

### Runner / spawn

- “已派发”必须有 dispatch evidence
- runner queue / claim / running 必须连贯
- spawn/native command 参数要做 capability probe，不允许再出现固定 flag mismatch
- `queued` 超时、`running` 超时、`spawn bootstrap` 超时都必须进入 task lifecycle truth
- 不允许出现：
  - task-state 仍是 `queued`
  - runner-queue 已空
  - 但系统继续声称“任务已派发正常”

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

默认设计要求：

- runner **默认模式必须是 `resident`**
- `ondemand` 只能作为 fallback mode，不得再作为默认或隐式常态
- 任何 runtime / status / UI / replay / health surface 都必须把 `resident` 视为默认真相源

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

### 15.6 用户面与 operator 面仍未彻底分离

现象：

- DM 中仍出现 task card / operator surface / buttons
- 例如：
  - `OctoClaw task: ...`
  - `View / Queue / Retrieve / Timeline / Graph`
- 同一请求中还会多次输出 operator progress 文本

说明：

- controller / runtime 仍把内部运维面消息直接投递到用户面
- 用户面和 operator 面没有隔离 contract

设计要求：

- DM / 用户会话默认只允许三类用户可见消息：
  - ACK
  - 最终答案
  - 一条必要的简短 progress note
- `task card / buttons / details / queue / retrieve / timeline / graph` 默认只能进入 operator surface
- `operator_surface` 与 `user_surface` 必须是两个 schema，不允许一个 payload 同时承担两种角色

### 15.7 原任务失败与补救任务成功被混成同一个“成功”

现象：

- 原始 dispatch 任务卡在 `queued`
- 后续补救路径又创建了第二个任务
- 最后系统把第二个任务的成功说成“这次 runner 成功了”

说明：

- controller 没有维护统一的 execution chain
- retry / replacement / manual recovery 没有挂在同一个 controller execution id 下

设计要求：

- 每个用户请求必须有一个稳定的 `controller_execution_id`
- 同一次用户请求下的所有 retry / replacement task 都挂到这个 execution id
- task 之间必须显式记录：
  - `supersedes`
  - `superseded_by`
  - `replacement_reason`
- 对用户汇报时，必须区分：
  - 原任务是否成功
  - 是否存在补救任务
  - 最终采用的是哪条结果

### 15.8 latest truth reconciliation 缺失

现象：

- 同一次回答中既说“最新版是 2026.4.12”
- 又补充“CHANGELOG 里还有 2026.4.14”

说明：

- controller 把多个信息源直接拼接给主 agent / compose 层
- 没有先做“哪个版本才是 latest truth”的统一收敛

设计要求：

- 在进入用户可见 compose 之前，controller 必须先做 latest truth reconciliation
- 如果存在多个候选 latest version：
  - 先统一成一个 `latest_version_packet`
  - 再允许生成用户答案
- 不能把互相冲突的 latest candidates 同时直接暴露给用户

---

## 16. 基于生产观察的下一步优先级

### P0

1. ACK target canonical binding only
2. ACK owner 唯一化（progress ACK / eager ACK / timer ACK 合并）
3. CLI / helper capability negotiation
4. resident runner truth 与 on-demand truth 分离（并把默认 mode 固定为 `resident`）
5. 用户面 / operator 面分离
6. replacement / superseded execution chain
7. latest truth reconciliation

### P1

1. resident tmux runner lifecycle 设计落地
2. mirror/native task binding truth 分层
3. controller -> main correction packet surface

### P2

1. 生产 acceptance 仪表盘
2. ACK / dispatch / delivery latency 分段指标
3. taskflow substrate 健康面板

---

## 17. 实施清单（给另一个 AI 的明确修改说明）

本节不是方向描述，而是“应该改哪些文件、每个文件要承担什么修改”。

### Workstream A：ACK ingress 与 target resolution

目标：

- ACK 不再依赖主 agent
- ACK target 解析唯一化
- 消除双 ACK

主要文件：

- [extensions/octoclaw-runtime/index.js](../extensions/octoclaw-runtime/index.js)
- [lib/session_ops.py](../lib/session_ops.py)
- [lib/task_events.py](../lib/task_events.py)
- [tests/test_octoclaw_runtime_extension.py](../tests/test_octoclaw_runtime_extension.py)
- [tests/test_session_ops.py](../tests/test_session_ops.py)

必须修改：

1. 删除或废弃 ACK 专用的第二套 Slack target 解析逻辑
2. 将 `resolveAckTargetFromSessionKey` 改成 canonical binding first
3. 给每个 turn 增加 `ack_owner`
4. `scheduleEagerPreDispatchAck` 与 ACK guard 统一抢 owner：
   - 一方成功后另一方必须取消
5. replay 中明确写：
   - `ack_owner`
   - `ack_delivery_state`
   - `ack_target_resolution_state`

验收：

- 对 `agent:main:slack:default:direct:u...` 能稳定解析成 `user:U...`
- 同一 turn Slack 上只出现一条 ACK
- replay 中不存在“ack_sent=true 且随后又有第二种 ackKind”的情况

### Workstream B：front gate / intent packet

目标：

- 高置信中文状态类 / 新鲜查询类问题在 front gate 就进对的 lane

主要文件：

- [extensions/octoclaw-runtime/policy/intent.js](../extensions/octoclaw-runtime/policy/intent.js)
- [extensions/octoclaw-runtime/policy/route.js](../extensions/octoclaw-runtime/policy/route.js)
- [tests/test_octoclaw_runtime_extension.py](../tests/test_octoclaw_runtime_extension.py)
- [tests/test_runtime_policy.py](../tests/test_runtime_policy.py)

必须修改：

1. `runtime_model` 作为 operator surface 注册
2. 版本号 + 新特性 / release notes / 更新内容 类句式稳定进入 `fresh_live_lookup`
3. `intent_packet.available` 不能因为空对象而短路 deterministic route features
4. control-observer / local-surface / fresh-live-lookup 三者的优先级要清楚：
   - 当前模型 / 当前版本 / 当前状态 -> local surface / control observer
   - 版本特性 / 发布说明 / 上游更新 -> fresh live lookup

验收：

- `你现在到底是啥模型` -> `local_surface_lookup`
- `帮我查下openclaw 4.12 的新特性` -> `fresh_live_lookup`
- `你是怎么查的` / `刚才single成功了吗` -> `execution_followup`

### Workstream C：judge-applied route 语义收敛

目标：

- 一旦最终 route 变成 runner/spawn，task semantic 也必须一起切过去

主要文件：

- [extensions/octoclaw-runtime/policy/decide.js](../extensions/octoclaw-runtime/policy/decide.js)
- [lib/octoclaw_policy.py](../lib/octoclaw_policy.py)
- [tests/test_octoclaw_runtime_extension.py](../tests/test_octoclaw_runtime_extension.py)

必须修改：

1. `policyJudgeApplyState` 成功后，如果 final route != base route：
   - 同步覆盖 `task_class`
   - `work_contract`
   - `work_type`
   - `phase`
   - `worker_pool`
2. `preDispatchAckPolicy` 不能再只看旧 taskClass
3. `runner` lane 的 direct-answer 残留语义必须消失

验收：

- 不再出现 `route=runner` 但 `taskClass=direct_answer`
- `fresh_external_lookup` 最终一定收敛成 `fast_tool_check + inspect_report`

### Workstream D：runner / spawn capability negotiation

目标：

- controller 不再假设 helper / OpenClaw CLI 支持某个参数

主要文件：

- [lib/task-state-update.py](../lib/task-state-update.py)
- [lib/dispatch_task.py](../lib/dispatch_task.py)
- [lib/runner_dispatch.py](../lib/runner_dispatch.py)
- [lib/octoclaw_spawn.py](../lib/octoclaw_spawn.py)
- [tests/test_task_state_update.py](../tests/test_task_state_update.py)
- [tests/test_dispatch_task.py](../tests/test_dispatch_task.py)
- [tests/test_octoclaw_spawn.py](../tests/test_octoclaw_spawn.py)

必须修改：

1. `task-state-update.py upsert` 与 dispatch 协议字段对齐
2. native spawn 只在 CLI 支持时传 `--model` / `--thinking`
3. runner goal / runner playbook 使用的 OpenClaw CLI flag 必须 capability probe
4. 任何 `unknown option ...` 都要进入 capability failure taxonomy，而不是静默失败

验收：

- 不再出现 `task-state-update.py 不认 --dispatch-key ...`
- 不再出现 `unknown option '--model'`
- 不再出现 `unknown option '--no-confirm'`

### Workstream E：resident runner truth

目标：

- 明确 resident vs ondemand，不再拿旧 on-demand heartbeat 充当 resident runner 健康状态
- runner 默认运行方式固定为 `resident`

主要文件：

- [lib/dispatch_task.py](../lib/dispatch_task.py)
- [lib/runner_dispatch.py](../lib/runner_dispatch.py)
- [lib/runner_queue.py](../lib/runner_queue.py)
- [lib/runtime_snapshot.py](../lib/runtime_snapshot.py)
- [lib/runner_loop.sh](../lib/runner_loop.sh)
- [tests/test_dispatch_task.py](../tests/test_dispatch_task.py)
- [tests/test_runner_runtime.py](../tests/test_runner_runtime.py)

必须修改：

1. 增加明确的 runner mode state：
   - `resident`
   - `ondemand`
2. `resident` 设为默认 mode：
   - config 默认值
   - runtime decision 默认值
   - status / UI 默认展示
   - docs / acceptance 默认假设
3. `ondemand` 只能在 resident 不健康或显式 fallback 时出现
4. resident runner 要有独立健康状态文件或 mode 标记
5. queue 为空但 task-state queued 时，必须进入 `lost / timed_out / dispatch_failed` 之一
6. 如果继续用 tmux resident 模式：
   - gateway restart 后自动恢复 worker
   - worker context reset per job

验收：

- `queued` 任务不再无限增长 `task_timed_out`
- 不再出现“runner_health_snapshot=ok，但实际没有可 claim worker”
- 默认健康状态下，新的 runner task 不允许落到 `ondemand` 模式

### Workstream F：mirror / native binding truth

目标：

- 不再把 `mirror-only` 当 `native-bound`

主要文件：

- [lib/openclaw_taskflow_adapter.py](../lib/openclaw_taskflow_adapter.py)
- [lib/runtime_task_record.py](../lib/runtime_task_record.py)
- [lib/runtime_snapshot.py](../lib/runtime_snapshot.py)
- [lib/task-state-update.py](../lib/task-state-update.py)

必须修改：

1. binding_state 分层：
   - `mirror_only`
   - `mirror_with_match`
   - `native_bound`
2. UI / provenance / observer 只能消费真实 binding truth
3. `task_id/flow_id` 为空时，不能展示成已经绑定原生 substrate

验收：

- `native_binding_state=none` 时，surface 文案必须明确是 mirror-only

### Workstream G：user surface / operator surface separation

目标：

- 用户面不再收到内部 task card / buttons / operator chatter

主要文件：

- [lib/notifier.py](../lib/notifier.py)
- [lib/task_display.py](../lib/task_display.py)
- [lib/task-state-update.py](../lib/task-state-update.py)
- [extensions/octoclaw-runtime/index.js](../extensions/octoclaw-runtime/index.js)
- [tests/test_notifier.py](../tests/test_notifier.py)
- [tests/test_task_display.py](../tests/test_task_display.py)

必须修改：

1. 明确 `user_surface` 与 `operator_surface` 两套 payload contract
2. DM 默认禁用 task card / buttons
3. progress relay 在用户面只允许固定简短文本，不允许直接回放 operator surface
4. completion relay 只能发送最终答案，不得夹带 task action buttons

验收：

- Slack DM 中不再出现 `View / Queue / Retrieve / Timeline / Graph`
- 不再出现多条重复 `OctoClaw task: ...` 卡片

### Workstream H：replacement / superseded execution chain

目标：

- 原任务失败、补救任务成功时，系统必须能表达“补救成功但原任务失败”，不能混成单个成功

主要文件：

- [lib/dispatch_task.py](../lib/dispatch_task.py)
- [lib/runner_dispatch.py](../lib/runner_dispatch.py)
- [lib/runtime_task_record.py](../lib/runtime_task_record.py)
- [lib/task-state-update.py](../lib/task-state-update.py)
- [lib/runtime_snapshot.py](../lib/runtime_snapshot.py)

必须修改：

1. 为每个用户请求引入 `controller_execution_id`
2. retry / replacement task 记录 `supersedes` / `superseded_by`
3. handoff / user summary 必须说明：
   - 原任务状态
   - 是否有 replacement
   - 最终采用哪个 task 的结果

验收：

- 原任务卡 `queued`、补救任务 `done` 时，用户摘要不再写成“runner 成功了”
- ledger 能回放完整 replacement chain

### Workstream I：latest truth reconciliation

目标：

- latest version / latest release / latest changelog 在输出前必须统一成单一真相

主要文件：

- [lib/runner_goal_contract.py](../lib/runner_goal_contract.py)
- [lib/runner_dispatch.py](../lib/runner_dispatch.py)
- [lib/dispatch_task.py](../lib/dispatch_task.py)
- [extensions/octoclaw-runtime/index.js](../extensions/octoclaw-runtime/index.js)

必须修改：

1. 对“版本号 + changelog + release notes”类任务增加统一结果包：
   - `latest_version`
   - `latest_source`
   - `supporting_sources`
2. compose 前必须先 reconcile latest truth
3. 如果 source 冲突未解决，不允许直接下结论

验收：

- 同一次回答中不再出现 `latest=2026.4.12` 同时又说 `2026.4.14 刚发`
- final answer 中 latest version 只能有一个

---

## 18. 回归与上线验收（必须逐条执行）

### 18.1 离线测试

至少运行：

```bash
pytest tests/test_runtime_policy.py
pytest tests/test_octoclaw_runtime_extension.py
pytest tests/test_dispatch_task.py
pytest tests/test_task_state_update.py
pytest tests/test_octoclaw_spawn.py
pytest tests/test_runner_runtime.py
```

### 18.2 运行目录验证

必须确认安装目录中的真实运行文件已经同步：

- `~/.openclaw/extensions/octoclaw-runtime`
- `~/.openclaw/workspace/openclaw/skills/octopus`

### 18.3 线上 Slack 验收句子

至少用真实 DM 发送并观察：

1. `你现在到底是啥模型`
2. `你是怎么查的`
3. `不是 刚才single成功了吗`
4. `你用runner查下openclaw的新版本是啥 以及新特性 看看可以吗`
5. `再检查下openclaw 的新版本和新特性`

验收期望：

- 1s 内有 ACK 或直接答案
- 第 4 条必须进入 runner
- 第 5 条只允许一个用户面 ACK
- ACK 不允许双发
- replay 中 ACK 必须可观测
- dispatch 必须有 `dispatch_called`
- runner 必须有 queue/claim/running/terminal 证据
- 用户面不出现 operator buttons / task cards
- latest version 结论唯一
- 如果补救任务接管，用户摘要必须显式说明 replacement

### 18.4 失败判据

任一出现都算未通过：

- `pre_dispatch_ack_attempted` 但 target resolution 仍失败
- Slack 出现两条语义重复 ACK
- Slack DM 出现 operator card / task buttons
- `route=runner` 但无 `dispatch_called`
- `dispatch_called` 后 queue 中无对应 job，task-state 却长期 `queued`
- 原任务失败但补救任务成功时，用户答案仍把整体说成“原任务成功”
- 同一次回答里 latest version 出现多个冲突值
- native-spawn stderr 再出现 `unknown option '--model'`
- runner goal stderr 再出现 `unknown option '--no-confirm'`
