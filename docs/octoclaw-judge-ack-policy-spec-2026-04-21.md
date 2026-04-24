# OctoClaw Judge / ACK Policy Spec

日期：2026-04-21

状态：v1 working spec

用途：这份文档从总设计稿里拆出 judge、ACK、policy spec 的正式细化口径，方便实现与评审，不再要求执行者从 `design-v1` 的大段正文里自己拼规则。

关联小 spec：

1. [octoclaw-ack-state-source-matrix-2026-04-21.md](https://github.com/guanbear/OctoClaw/blob/release/0.3.0-ts-rebuild/docs/octoclaw-ack-state-source-matrix-2026-04-21.md)
2. [octoclaw-ack-decision-truth-table-2026-04-21.md](https://github.com/guanbear/OctoClaw/blob/release/0.3.0-ts-rebuild/docs/octoclaw-ack-decision-truth-table-2026-04-21.md)
3. [octoclaw-ack-thread-delivery-spec-2026-04-21.md](https://github.com/guanbear/OctoClaw/blob/release/0.3.0-ts-rebuild/docs/octoclaw-ack-thread-delivery-spec-2026-04-21.md)

## 1. 目标

这份 spec 只回答 5 件事：

1. judge 体系怎么分层
2. ACK 与 judge 怎么协作
3. canonical `decision policy spec` 长什么样
4. 什么情况下必须偏向 `delegate`
5. local judge / ack writer / remote judge 的职责边界是什么

## 2. 角色分层

v1 只保留一个热路径 authority judge，再加一个可选本地文案增强 lane：

1. `local_judge`
   - 热路径 authority
   - 负责 route / reply_mode / delegate_role / complexity / scope / tool_need_hint / duration_hint / confidence
2. `ack_writer`
   - 非 authority
   - 只负责短 ACK / nudge 文案
   - 不参与 route 决策
3. `remote_judge`
   - escalation / adjudication only
   - 只在低置信度或高风险时介入

一句话：

> `local_judge` 判路由，`ack_writer` 写短文案，`remote_judge` 只做仲裁。

## 3. ACK 协作模型

### 3.1 总原则

1. 首个可见 ACK 不能依赖第二次模型调用
2. 首个可见 ACK 仍由 runtime controller 兜底
3. 如需更自然的 ACK，可异步触发本地 `ack_writer`
4. `ack_writer` 永远不能阻塞 `local_judge`

### 3.2 两阶段 ACK 能力

这不是说每次一定发两条消息，而是说系统有两个能力层：

1. `ACK0`
   - 首个可见反馈
   - runtime fallback / reaction / soft-ack
   - 不依赖第二次模型调用
2. `ACK1`
   - 延迟触发的短 ACK / nudge
   - 仅在仍然静默时使用
   - 可由本地 `ack_writer` 生成

### 3.3 推荐触发时序

当前 v1 推荐把 ACK Phase 1 默认收成 **reply 路径专用**。2026-04-24 修正后，首个可见 ACK 不再固定等 5s，而是拆成两个互斥 modality：

1. `reaction_ack = 800ms - 1200ms`
   - channel 支持 reaction / emoji ack 且配置允许时使用
   - 算作 ACK0
   - 发送后不再发送 `text_ack0`
2. `text_ack0 = 2500ms - 3500ms`
   - channel 不支持 reaction、reaction 不可靠、或场景偏正式时使用
   - 算作 ACK0
3. `ack0_hard_ceiling = 5s`
   - 只是保守上限，不是默认等待时间
4. `tier1 = 18s`
5. `tier2 = 45s`
6. `tier3 = 120s`

推荐时序解释：

1. `0-800ms`
   - 优先等主模型自己首响
   - 避免主模型本可很快出字时被 ACK 抢占
2. `~1s`
   - 若仍无 first token，且 channel 支持 reaction ACK，则 runtime 可发 `reaction_ack`
   - `reaction_ack` 与 `text_ack0` 对同一 turn 二选一
3. `~3s`
   - 若仍无 first token，且未发 reaction ACK，Phase 1 gate 允许，则 runtime 发 `text_ack0`
4. `~18s`
   - 到达 `tier1`
   - 若仍静默且仍处于 ACK eligible 状态，则允许第一次更明确的“还在处理”提示
5. `~45s`
   - 到达 `tier2`
   - 若仍静默，则进入长一点的处理中提示
6. `~120s`
   - 到达 `tier3`
   - 若仍静默，则允许转成“是否继续等待/是否先给阶段结果”的话术
7. 正式输出已出现
   - 立即取消 `ack_writer`
   - 后续 tiered ACK 也必须 suppress

### 3.4 ACK Phase 1：状态门控，而不是纯超时

v1 不应继续把 ACK 理解成“到了某个时间点就发一句安抚话”。

更稳的 Phase 1 目标是：

1. 只有系统**真的还处于主模型生成未首字 / 工具执行 / 委派执行 / blocked** 状态时，ACK 才有资格发送
2. 一旦系统已经进入**最终答复流**或**最终交付待发送**阶段，就必须 suppress ACK
3. 不追求“精确预测 300ms 后马上答完”，而是先把“明显不该发 ACK 的时机”排掉

#### 3.4.1 Phase 1 可依赖的状态来源

Phase 1 必须优先消费 OpenClaw substrate / native taskflow truth，再叠加 OctoClaw runtime hook 信号。

建议分成两类：

1. OpenClaw / native truth 可直接提供的状态
   - `queued`
   - `running`
   - `blocked`
   - `completed`
   - `failed`
   - `cancelled`
   - `checkpoint_seen`
   - `result_ready`
2. OctoClaw runtime hook / streaming 层补充的状态
   - `main_model_active`
   - `first_token_seen`
   - `tool_active`
   - `delegated_running`
   - `final_response_streaming`
   - `delivery_pending`
   - `delivered`

#### 3.4.2 Phase 1 ACK eligibility gate

ACK 不应只由 wall-clock timer 决定。

更合理的是：

1. timer 只负责“到点后允许检查”
2. 是否真正发送 ACK，要看当前是否仍满足 `ack_eligible`

推荐 gate：

```yaml
ack_phase1_gate:
  route_scope:
    - reply_only_in_v1
  ack_eligible_when_any:
    - main_model_active_without_first_token
    - tool_active
    - blocked
  ack_suppress_when_any:
    - first_token_seen
    - final_response_streaming
    - delivery_pending
    - delivered
```

#### 3.4.3 Phase 1 关键现实约束

Phase 1 可以稳定做到：

1. 真在 reply 路径主模型已接手但无 first token、工具执行、或 blocked 时才 ACK
2. 一旦最终答复开始流出，立刻 suppress ACK
3. 一旦最终交付已经进入待发送阶段，不再补 ACK

Phase 1 不要求稳定做到：

1. 在还没有 first token 前，精确预测“马上几百毫秒内就会答完”
2. 通过模型主观推断“应该快好了”来 suppress ACK

这条边界必须写清楚，避免实现时又把 ACK 做回“猜测式魔法”。

## 4. 复用同一个本地模型的方式

v1 可以复用同一个本地 Qwen 服务，但必须按 job type 分开：

1. `route_judge`
   - high priority
   - hot path
   - 负责结构化输出
2. `ack_writer`
   - low priority
   - delayed trigger
   - cancelable
   - 只写一句短文案

更稳的实现不是双并发抢资源，而是：

1. 同一个本地模型服务
2. priority queue
3. `route_judge` 永远高于 `ack_writer`
4. `ack_writer` 只在需要时才入队

## 5. judge 输出 contract

`local_judge` 至少输出：

```json
{
  "route": "reply | delegate",
  "reply_mode": "answer | clarify | null",
  "delegate_role": "observer | default | code | research | review | null",
  "coordination_mode_hint": "solo_worker | advisor_assisted | multi_agent_controlled | null",
  "complexity": "simple | normal | deep | null",
  "scope": "local | remote | both | unknown",
  "tool_need_hint": "none | maybe | required",
  "duration_hint": "short | medium | long",
  "confidence": 0.0,
  "reason_codes": []
}
```

`ack_writer` 至少输出：

```json
{
  "ack_text": "",
  "tone": "neutral | warm | concise",
  "suppression_hint": "send | suppress"
}
```

## 6. canonical decision policy spec

### 6.1 设计原则

`decision policy spec` 不是 prompt 文案，而是规则真相源。

它至少包含：

1. `labels`
2. `definitions`
3. `decision_rubric`
4. `iron_laws`
5. `validator_default_rules`
6. `escalation_rules`
7. `output_schema`

judge 仍然使用 prompt，但 prompt 必须由：

> `policy spec -> prompt view`

渲染生成。

### 6.2 三个 prompt view

同一份 spec 至少渲染成：

1. `local_judge_prompt_view`
2. `remote_judge_prompt_view`
3. `ack_writer_prompt_view`

`ack_writer_prompt_view` 只允许写短 ACK，不允许改 route / role / complexity。

## 7. 最小 policy labels

```yaml
route:
  labels:
    - reply
    - delegate

reply_mode:
  labels:
    - answer
    - clarify

delegate_role:
  labels:
    - observer
    - default
    - code
    - research
    - review

coordination_mode_hint:
  labels:
    - solo_worker
    - advisor_assisted
    - multi_agent_controlled

complexity:
  labels:
    - simple
    - normal
    - deep

scope:
  labels:
    - local
    - remote
    - both
    - unknown

tool_need_hint:
  labels:
    - none
    - maybe
    - required

duration_hint:
  labels:
    - short
    - medium
    - long
```

## 8. 铁律原则

这是 v1 最关键的防漂移规则。

```yaml
iron_laws:
  - id: delegate_on_required_tooling
    rule: >
      If new tooling, probing, command execution, workspace access, or environment lookup
      is required, default to delegate rather than reply.
  - id: delegate_on_long_running_work
    rule: >
      If the work is likely to exceed one minute or clearly exceed main-thread fast-response budget,
      default to delegate rather than reply.
  - id: clarify_before_guessing_scope
    rule: >
      If scope or target is unclear, prefer clarify rather than guessing and executing in the wrong place.
  - id: main_thread_exception_only
    rule: >
      Only keep work on the main thread when direct reply is truly part of the user-facing response
      and no new execution work unit is needed.
```

这 4 条里最重要的是前两条：

1. **新工具调用默认委派**
2. **预计超过 1 分钟默认委派**

## 9. 反 reply 偏置规则

judge 之所以容易漂向 `reply`，通常不是模型太笨，而是 spec 太宽。

v1 应明确写死：

1. 问句不等于 `reply`
2. “查版本 / 查最新 / 查状态 / 查本机 / 查远端 / 查 release / 版本对比” 这类 fresh state lookup，默认偏 `delegate`
3. 需要真实 probe、环境读取、workspace inspection、command execution，默认偏 `delegate`
4. scope 不明优先 `clarify`
5. 不允许靠猜 scope / guess target 把 case 硬压成 `reply.answer`

## 10. rubric

### 10.1 `reply`

适用于：

1. 不需要创建新的执行工作单元
2. 主链现在就能安全回答
3. 或当前最合理下一步是补问
4. 不需要新的工具、命令、环境探测、文件写入
5. 即使要引用状态，也能靠现成 truth / summary / artifact refs 快速组织回复

### 10.2 `delegate`

适用于：

1. 需要创建新的执行工作单元
2. 需要工作区访问、环境探测、命令执行、日志读取、验证或较长处理过程
3. 主线程如果硬答，只能靠猜，或只能把执行脏活塞进主链
4. 任务值得从主 agent 上下文中剥离

### 10.3 `reply_mode = clarify`

适用于：

1. 当前信息不足，不能安全直接回答
2. scope / target / critical slot 不清楚
3. 当前也不适合直接启动 delegated execution

## 11. validator 默认收口

为防止实现时把 `tool_need_hint` / `duration_hint` 当装饰字段，默认收口规则应写死：

```yaml
validator_default_rules:
  - if: "tool_need_hint == required"
    then: "prefer delegate"
  - if: "duration_hint == long"
    then: "prefer delegate"
  - if: "tool_need_hint == required && scope == unknown"
    then: "reply_mode = clarify before delegate"
  - if: "tool_need_hint == none && duration_hint == short"
    then: "reply remains eligible"
```

一句话：

> `tool_need_hint` 和 `duration_hint` 不是参考信息，而是默认 route 收口信号。

## 12. judge 上下文

### 12.1 local judge small packet

```json
{
  "current_turn": "",
  "thread_summary": "",
  "active_intent": "",
  "last_agent_act": "",
  "pending_slots": {},
  "open_decision": "",
  "anchor_or_task_binding": null,
  "scope_hint": "unknown",
  "recent_excerpt": []
}
```

### 12.2 remote judge expanded packet

在 small packet 基础上增加：

1. `candidate_decision_from_local`
2. `escalation_reason`
3. `optional_task_snapshot`
4. `optional_system_state_summary`

### 12.3 ack writer packet

`ack_writer` 不看完整 judge packet，默认只看：

```json
{
  "current_turn": "",
  "route": "reply | delegate",
  "reply_mode": "answer | clarify | null",
  "delegate_role": "observer | default | code | research | review | null",
  "scope": "local | remote | both | unknown",
  "status_phase": "",
  "reason_codes": []
}
```

### 12.4 ACK phase gate packet

ACK controller 在 Phase 1 不需要再次调用 judge，只需要消费一个很小的状态包：

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

这个 packet 的设计原则是：

1. 优先取 substrate truth
2. 只补最少量 runtime streaming 信号
3. 不让 ACK controller 自己去猜“是不是快答完了”

## 13. main agent 与 AGENTS.md

`AGENTS.md` 不负责 judge 路由。

它只负责：

1. 主 agent 行为宪法
2. 快回复原则
3. objection protocol
4. 不允许 silent override

真正的 route / mode / role / complexity / scope 规则，只能来自 canonical `decision policy spec`。

## 14. 落地边界

这份 spec 只负责 judge 和 ACK。

不在这里解决：

1. delegated task / attempt 生命周期细节
2. native flow/task binding 全量模型
3. status surface 全量字段
4. future multi-agent scheduler

这些内容继续以：

1. `octoclaw-ts-rebuild-design-v1.md`
2. `octoclaw-ts-rebuild-implementation-plan-2026-04-15.md`
3. `octoclaw-native-taskflow-and-agent-runtime-borrowings-2026-04-20.md`

为主。
