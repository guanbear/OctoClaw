# OctoClaw Judge / ACK Policy Spec

日期：2026-04-21

状态：v1 working spec

用途：这份文档从总设计稿里拆出 judge、ACK、policy spec 的正式细化口径，方便实现与评审，不再要求执行者从 `design-v1` 的大段正文里自己拼规则。

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

1. `0-1s`
   - 优先等主模型自己首响
   - 若已明确是长 `delegate` 路径，则优先保证有可见 ACK
2. `~3s`
   - 若仍无首响，则 runtime 发 `ACK0`
3. `~3-5s`
   - 若 `route_judge` 已完成，且仍无正式 reply / delegate update，则低优先级触发 `ack_writer`
4. 正式输出已出现
   - 立即取消 `ack_writer`

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
