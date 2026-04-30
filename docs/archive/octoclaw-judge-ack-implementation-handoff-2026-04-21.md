# OctoClaw Judge / ACK Implementation Handoff

日期：2026-04-21

状态：implementation handoff

用途：给其他 AI / 协作者直接开工用。重点不是再讨论架构，而是明确“不要自由设计”“先做什么”“哪些不能做”。

## 1. 阅读顺序

先按这个顺序读：

1. [octoclaw-ts-rebuild-design-v1.md](https://github.com/guanbear/OctoClaw/blob/release/0.3.0-ts-rebuild/docs/octoclaw-ts-rebuild-design-v1.md)
2. [octoclaw-judge-ack-policy-spec-2026-04-21.md](https://github.com/guanbear/OctoClaw/blob/release/0.3.0-ts-rebuild/docs/octoclaw-judge-ack-policy-spec-2026-04-21.md)
3. [octoclaw-ts-rebuild-implementation-plan-2026-04-15.md](https://github.com/guanbear/OctoClaw/blob/release/0.3.0-ts-rebuild/docs/octoclaw-ts-rebuild-implementation-plan-2026-04-15.md)
4. [octoclaw-native-taskflow-and-agent-runtime-borrowings-2026-04-20.md](https://github.com/guanbear/OctoClaw/blob/release/0.3.0-ts-rebuild/docs/octoclaw-native-taskflow-and-agent-runtime-borrowings-2026-04-20.md)

## 2. 非谈判约束

以下内容不要自由发挥：

1. 顶层 route 只保留 `reply | delegate`
2. 不要把 `observe` 重新做成顶层 route
3. judge 规则来自 canonical `decision policy spec`
4. `AGENTS.md` 不负责 judge 路由
5. `local_judge` 是热路径 authority
6. `remote_judge` 只做 escalation / adjudication
7. `ack_writer` 不是 judge authority，只能写 ACK 文案
8. 首个可见 ACK 不能依赖第二次模型调用
9. 新工具调用默认委派
10. 预计超过 1 分钟默认委派
11. scope 不明优先 `clarify`
12. 不允许把“问句”直接当成 `reply` 充分条件

## 3. 这轮实现真正要做什么

### 3.1 先做 judge / ACK substrate，不要先做 rich UI

优先顺序：

1. `decision policy spec` source-of-truth
2. prompt builder
3. `local_judge` integration
4. `remote_judge` escalation path
5. runtime ACK fallback
6. optional `ack_writer` lane

### 3.2 不要先做这些

1. 不要先做 future multi-agent
2. 不要先做 rich cockpit / board
3. 不要先做自由 router playground
4. 不要先在旧 JS/py 热路径里补 patch

## 4. 代码实现拆分建议

### PR1: canonical policy source

目标：

1. 建一个真正的 `decision policy spec`
2. 不再让 judge prompt 成为唯一规则源

建议落点：

1. `packages/octoclaw-policy/src/spec`
2. `packages/octoclaw-contracts/src/schemas.ts`

至少产出：

1. `decision-policy-spec.ts` 或 `decision-policy-spec.yaml`
2. types:
   - `Route`
   - `ReplyMode`
   - `DelegateRole`
   - `CoordinationModeHint`
   - `Complexity`
   - `Scope`
   - `ToolNeedHint`
   - `DurationHint`

### PR2: prompt builder

目标：

1. 从 canonical spec 渲染 prompt view
2. 不再手写分叉 prompt 规则

至少产出：

1. `local_judge_prompt_view`
2. `remote_judge_prompt_view`
3. `ack_writer_prompt_view`

注意：

1. `ack_writer_prompt_view` 不允许输出 route override
2. `local_judge_prompt_view` 必须强调：
   - 问句不等于 reply
   - 工具调用默认委派
   - 超过 1 分钟默认委派
   - scope 不明优先 clarify

### PR3: local judge + validator

目标：

1. 打通 `local_judge`
2. 打通 validator/materializer 默认收口

至少实现：

1. `tool_need_hint == required -> prefer delegate`
2. `duration_hint == long -> prefer delegate`
3. `tool_need_hint == required && scope == unknown -> clarify before delegate`

注意：

1. `tool_need_hint` 和 `duration_hint` 不能只做 telemetry 字段
2. 它们必须影响 route 收口

### PR4: ACK runtime + optional ack_writer

目标：

1. 首响由 runtime 可靠兜底
2. 如启用 `ack_writer`，它只做低优先级延迟增强

至少实现：

1. `ACK0` runtime fallback
2. `ack_writer` delayed trigger
3. `ack_writer` cancellation
4. shared-model priority queue

必须遵守：

1. `route_judge` 高优先级
2. `ack_writer` 低优先级
3. `ack_writer` 不得阻塞首响

## 5. 给实现 AI 的直接提示词

下面这段可以直接发给另一个 AI：

```text
你不是从零设计 OctoClaw。请严格按 release/0.3.0-ts-rebuild 分支上的 judge/ACK spec 实现，不要自由改主抽象。

先读：
1. docs/octoclaw-ts-rebuild-design-v1.md
2. docs/octoclaw-judge-ack-policy-spec-2026-04-21.md
3. docs/octoclaw-ts-rebuild-implementation-plan-2026-04-15.md
4. docs/octoclaw-native-taskflow-and-agent-runtime-borrowings-2026-04-20.md

非谈判约束：
- 顶层 route 只保留 `reply | delegate`
- 不要把 `observe` 恢复成顶层 route
- judge 规则必须来自 canonical decision policy spec
- prompt 必须由 policy spec 渲染，不要继续手写散乱规则 prompt
- `local_judge` 是热路径 authority
- `remote_judge` 只做 escalation / adjudication
- `ack_writer` 不是 authority，只能写 ACK 文案
- 首个可见 ACK 不能依赖第二次模型调用
- 新工具调用默认委派
- 预计超过 1 分钟默认委派
- scope 不明优先 `clarify`
- validator/materializer 必须把 `tool_need_hint` / `duration_hint` 真正收口到 route

本轮只做 judge/ACK substrate，不做 rich UI，不做 future multi-agent。

优先任务：
1. 建 canonical decision policy spec
2. 建 prompt builder
3. 打通 local_judge
4. 打通 validator 默认收口
5. 打通 runtime ACK fallback
6. 可选：打通 low-priority ack_writer

不要做：
1. 继续在旧 JS/py 热路径里补 patch
2. 先做多 agent
3. 让 ack_writer 重新参与 route 判断
4. 把 tool_need_hint / duration_hint 只当日志字段
```

## 6. 验收要点

做完以后至少要能验证：

1. “查最新版本/查状态/查本机环境”不再天然偏 `reply`
2. scope 不明时会更稳定地走 `clarify`
3. 需要新工具调用时 route 会被收口到 `delegate`
4. 长任务不会继续压在主线程
5. 首个可见 ACK 不依赖 `ack_writer`
6. `ack_writer` 不会抢 `local_judge` 热路径
7. local/remote judge 不再各自维护一套 prompt 规则

## 7. 一句话总结

这轮不是“优化 prompt”，而是：

> **把 judge 规则从散乱 prompt 提升成 canonical policy source，再通过 validator 和 ACK/runtime 分层，把“快回复”和“该委派就委派”真正做实。**
