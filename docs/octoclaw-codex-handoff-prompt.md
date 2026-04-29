# OctoClaw 重构 — Codex 执行话术

> 这是给 Codex CLI 的执行 prompt，Codex 作为指挥者，通过 opencode-supervisor skill
> 用 ACP 控制 OpenCode 逐任务完成 OctoClaw 的重构，每步验收通过才继续下一步。

---

## 直接复制给 Codex 的 Prompt

---

你是 OctoClaw 重构项目的指挥者。你的职责是架构判断、需求解释、验收审核、提交决策。
不要自己写大段代码——范围清楚的实现任务交给 OpenCode；高风险的小修自己做。

**项目**：OctoClaw — OpenClaw 的多 Agent 智能调度插件（TypeScript monorepo）  
**仓库**：https://github.com/guanbear/OctoClaw  
**base 分支**：`release/0.3.0-ts-rebuild`（只读参考，不直接提交）  
**工作分支**：`refactor/0.4.0-stable`（所有重构 commit 推到这里）

---

### 第一步：环境准备

1. 克隆并切换到工作分支：
   ```bash
   git clone --branch refactor/0.4.0-stable https://github.com/guanbear/OctoClaw.git ~/workspace/OctoClaw
   cd ~/workspace/OctoClaw
   # 确认在正确分支
   git branch   # 应显示 * refactor/0.4.0-stable
   pnpm install
   pnpm build
   pnpm test
   ```
   测试必须全部通过，记录基线失败数（如有），后续只关注 **新增失败**。

2. 读完以下两个文档（先读架构文档建立全局认知，再读实施指南作为执行手册）：
   - `docs/octoclaw-architecture-diagnosis-and-refactor-plan-2026-04-29.md` — 为什么改、改什么
   - `docs/octoclaw-refactor-impl-guide-2026-04-29.md` — 怎么改、每步验收标准

3. 启动 ACP（把路径换成你实际的本地路径）：
   ```bash
   opencode acp --cwd ~/workspace/OctoClaw
   ```
   通过 JSON-RPC：`initialize → session/new → session/prompt`。  
   监听 `session/update`：首次 2–3 分钟后查，正常 5–10 分钟查一次，build/test 等预估时间 + 1–2 分钟。

---

### 第二步：执行循环

**任务优先级顺序**（严格按此顺序，不能跳）：

```
P0-T1 → P0-T2 → P0-T3 → P0-T4
     → P1-T5 → P1-T6 → P1-T7 → P1-T8
     → P2-T9 → P2-T10 → P2-T11
     → QF-1 → QF-2 → QF-3 → QF-4
```

P0 任务中 T2/T3/T4 可在 T1 完成后并行发给 OpenCode，但每个任务独立 commit。

**每个任务的执行步骤**：

```
1. 按下方 OpenSpec 模板构造 work packet
2. 发 session/prompt，第一行 ulw，触发 OMO Ultrawork
3. 等 OpenCode 回显 5 条计划，确认 allowed scope 正确再让它继续
4. 监听进度，只关心：plan ready / file edits / tests / blocked / final report
5. OpenCode 完成后执行 Review Gate（见下方）
6. 验收通过 → 提交
7. 验收不通过 → 发 correction packet，不提交
```

---

### 第三步：Review Gate（每个任务完成后必须执行）

```bash
git status --short
git diff --stat
git diff HEAD           # 重点看：是否改了 allowed scope 以外的文件
pnpm --filter @octoclaw/runtime run build   # 先跑 focused build
pnpm test -- <任务相关的测试文件>            # 先跑 focused tests
pnpm test                                   # 再跑全量
```

检查清单：
- [ ] 只改了 allowed scope 里的文件
- [ ] 没有无关重写（其他模块没有改动）
- [ ] 没有引入 secret / 生成垃圾代码
- [ ] 没有 P3/P4 live-path 泄漏（不能默认 multi-agent，不能把 ClawTeam/tmux 变核心依赖）
- [ ] 没有违反 OctoClaw 硬约束（见下方）
- [ ] 实施指南里该任务的**全部验收标准**都满足

**通过** → Commit Gate：
```bash
git add <具体文件，不用 -A>
git commit -m "refactor: [任务ID] — [一句话说明]"
git push origin refactor/0.4.0-stable
```

**不通过** → 发 correction packet 给 OpenCode，不提交，修正后重新 Review Gate。

---

### OctoClaw 硬约束（每个 OpenSpec 都要带这段）

```
OctoClaw hard constraints — violation = immediate stop:
- Native TaskFlow is execution lifecycle truth.
- WorkContract is semantic/delegation/handoff truth; not execution proof by itself.
- TaskFlow created ≠ spawnExecuted. spawnExecuted requires TaskRun/session/process evidence.
- ACK/status/display/grounding packets are projections only, not truth.
- Never inject raw child transcript into parent context.
- Do not default to multi-agent. Do not make ClawTeam/tmux a core dependency.
- Do not do online self-tuning or modify live route policy without shadow/gate/rollback.
```

---

### OpenSpec 模板（每个任务一份）

```
ulw
OpenSpec Work Packet
Problem: <一句话描述这个任务要解决的问题>.
Docs: docs/octoclaw-refactor-impl-guide-2026-04-29.md — 章节 <任务ID>.
Non-goals: <绝对不能改的东西，从实施指南"绝对不能做"列表提取>.
Allowed scope: <允许修改的文件列表，从实施指南"涉及文件"提取>.
Acceptance: <验收标准，从实施指南逐条提取>.
Commit boundary: no commit — Codex reviews first.
Risks/rollback: <已知风险和回滚目标>.
Before editing: echo a 5-bullet plan and confirm allowed scope.
After editing: report changed files, tests run, remaining risks, and any scope deviations.
Do not rewrite unrelated modules. Do not commit until Codex reviews.

OctoClaw hard constraints — violation = immediate stop:
- Native TaskFlow is execution lifecycle truth.
- WorkContract is semantic/delegation/handoff truth; not execution proof by itself.
- TaskFlow created ≠ spawnExecuted. spawnExecuted requires TaskRun/session/process evidence.
- ACK/status/display/grounding packets are projections only, not truth.
- Never inject raw child transcript into parent context.
- Do not default to multi-agent. Do not make ClawTeam/tmux a core dependency.
```

---

### 各任务的具体 OpenSpec Packet

---

#### P0-T1 — Completion File Protocol

```
ulw
OpenSpec Work Packet
Problem: child-finalizer.ts 用启发式扫描 session 文件猜结果（530行），
  导致 delegate 任务完成后 IM 里没有真实结果。需要引入显式结构化完成文件协议。
Docs: docs/octoclaw-refactor-impl-guide-2026-04-29.md — 章节 P0-T1，共6步。
Non-goals:
  - 不改 taskflow-bridge.ts（稳定 API，不动）
  - 不改 ChildCompletionFinalizerOptions 和 ChildCompletionFinalizerResult 接口签名
  - 不删除 scheduleChildCompletionFinalizer / resetChildCompletionFinalizers 函数名
  - 不改 registration.ts 里除 buildSubagentSpawnMessage 以外的函数
Allowed scope:
  - packages/octoclaw-contracts/src/completion.ts（新建）
  - packages/octoclaw-contracts/src/index.ts（加 export）
  - extensions/octoclaw-runtime/src/resolve/env.ts（加两个函数）
  - extensions/octoclaw-runtime/src/tools/registration.ts（只改 buildSubagentSpawnMessage）
  - extensions/octoclaw-runtime/src/delegate/child-finalizer.ts（完全重写）
Acceptance:
  - pnpm --filter @octoclaw/contracts run build 通过
  - pnpm test 无新增失败
  - child-finalizer.ts 不含 readdirSync / .jsonl 扫描 / [OctoClaw Delegated Task] 字符串
  - buildSubagentSpawnMessage 输出含 octoclaw.worker_completion/v1 和 completion file 路径
  - finalizeChildSessionOnce 在无 completion 文件时返回 { status: "pending" }
  - finalizeChildSessionOnce 在有 completion 文件时调用 IM adapter 并返回 completed/delivery_failed
Commit boundary: no commit — Codex reviews first.
Risks/rollback: 向后兼容：部署窗口期已运行的 worker 无 completion 文件，finalizer 继续
  pending 直到超时，超时后写 failureCode=completion_file_not_written。回滚：git revert。
Before editing: echo a 5-bullet plan and confirm allowed scope.
After editing: report changed files, tests run, remaining risks, and any scope deviations.
Do not rewrite unrelated modules. Do not commit until Codex reviews.

OctoClaw hard constraints — violation = immediate stop:
- Native TaskFlow is execution lifecycle truth.
- WorkContract is semantic/delegation/handoff truth; not execution proof by itself.
- TaskFlow created ≠ spawnExecuted. spawnExecuted requires TaskRun/session/process evidence.
- ACK/status/display/grounding packets are projections only, not truth.
- Never inject raw child transcript into parent context.
- Do not default to multi-agent. Do not make ClawTeam/tmux a core dependency.
```

---

#### P0-T2 — 删除 minified alias

```
ulw
OpenSpec Work Packet
Problem: detached-task-runtime-host.ts 通过 loadOpenClawDistModule 加载 OpenClaw 内部
  minified bundle，用 ["a","o","f","l","i","s","d"] 等单字母 alias 访问内部函数。
  OpenClaw 升级时随时断裂。需改为 stub runtime。
Docs: docs/octoclaw-refactor-impl-guide-2026-04-29.md — 章节 P0-T2。
Non-goals:
  - 不改 taskflow-bridge.ts（用稳定 plugin API，不动）
  - 不改 detached-task-runtime.ts（接口定义文件）
  - 不删除 createHostDetachedTaskLifecycleRuntime 函数名（plugin.ts 调用）
Allowed scope:
  - extensions/octoclaw-runtime/src/adapter/detached-task-runtime-host.ts（完全重写）
Acceptance:
  - pnpm --filter @octoclaw/runtime run build 通过
  - pnpm test 无新增失败
  - detached-task-runtime-host.ts 不含 loadOpenClawDistModule / task-executor /
    TASK_EXECUTOR_ALIASES / ["a"] / ["o"] / ["f"] 字符串
  - OpenClaw 不可用时进程不崩溃（warn 日志即可）
Commit boundary: no commit — Codex reviews first.
Risks/rollback: stub runtime 不调用 OpenClaw 内部函数，task lifecycle 由 completion file 
  protocol 处理（P0-T1）。若 P0-T1 未完成，stub 会导致 delivery 不触发，但不会崩溃。
Before editing: echo a 5-bullet plan and confirm allowed scope.
After editing: report changed files, tests run, remaining risks, and any scope deviations.
Do not rewrite unrelated modules. Do not commit until Codex reviews.

OctoClaw hard constraints — violation = immediate stop:
[同上]
```

---

#### P0-T3 — ACK Guard 先于 Judge

```
ulw
OpenSpec Work Packet
Problem: extension-entry.ts 的 before_prompt_build hook 里，startAckGuard 在
  resolvePolicyDecisionForContext（judge）完成后才启动。judge LLM 调用超时时
  ACK guard 不启动，watchdog 行为异常，用户收不到任何反馈。
Docs: docs/octoclaw-refactor-impl-guide-2026-04-29.md — 章节 P0-T3，共2步。
Non-goals:
  - 不改 ACK guard 的 watchdog 逻辑
  - 不改 sendRouteCommitAck 函数本身
  - 不改 startLatencyAckTimer 的延迟时间（3500ms）
  - 不改 cancelAckGuardForState / watchdogTick 等现有 ACK guard 函数
Allowed scope:
  - extensions/octoclaw-runtime/src/extension-entry.ts（before_prompt_build hook 内部顺序）
  - extensions/octoclaw-runtime/src/ack/ack-guard.ts（新增 updateAckGuardDecision 函数）
Acceptance:
  - pnpm --filter @octoclaw/runtime run build 通过
  - pnpm test 无新增失败
  - extension-entry.ts 里 startAckGuard 调用在 resolvePolicyDecisionForContext 之前
  - updateAckGuardDecision 函数存在于 ack-guard.ts
  - judge 抛异常/超时/返回 null 时 ACK guard 已启动（不依赖 judge 完成）
Commit boundary: no commit — Codex reviews first.
Risks/rollback: ACK guard 用空决策启动，极端情况下 guard 可能比 judge 早 cancel。
  已有 cancelAckGuardForState 保护，影响面可控。
Before editing: echo a 5-bullet plan and confirm allowed scope.
After editing: report changed files, tests run, remaining risks, and any scope deviations.
Do not rewrite unrelated modules. Do not commit until Codex reviews.

OctoClaw hard constraints — violation = immediate stop:
[同上]
```

---

#### P0-T4 — 删除 Remote Judge

```
ulw
OpenSpec Work Packet
Problem: 项目有 local/remote 双 judge + shouldEscalate 升级链路，约 300 行代码。
  remote judge 默认 enabled=false + shadowMode=true，从未生效。
  这是死代码，增加复杂度和配置负担。需全部删除，只保留单 judge 架构。
Docs: docs/octoclaw-refactor-impl-guide-2026-04-29.md — 章节 P0-T4，共6步。
Non-goals:
  - 不删除 callLlmJudge / resolveJudgeConfig / isActionableJudgeResult / judgeResultToRouteOverride
  - 不删除 JudgeFastConfig 类型（只删 Dual/Remote 相关）
  - 不改 judge prompt（buildJudgeSystemPrompt / buildJudgeUserPrompt）
  - 不改 Ollama 特殊处理（isOllamaEndpoint / postOllamaNative）
Allowed scope:
  - packages/octoclaw-policy/src/judge/judge-schema.ts（删 DualJudgeConfig 等）
  - extensions/octoclaw-runtime/src/resolve/llm-judge.ts（删 callRemoteJudge 等）
  - packages/octoclaw-policy/src/judge/judge-prompt.ts（删 remote prompt builder）
  - packages/octoclaw-policy/src/spec/prompt-builder.ts（删 remote judge prompt 函数）
  - extensions/octoclaw-runtime/src/extension-entry.ts（删 remoteJudgeRaw 约15行）
  - extensions/octoclaw-runtime/src/resolve/policy-resolver.ts（简化 dual judge 流程）
Acceptance:
  - pnpm --filter @octoclaw/policy run build 通过
  - pnpm --filter @octoclaw/runtime run build 通过
  - pnpm test 无新增失败
  - DualJudgeConfig / callRemoteJudge / shouldEscalate / resolveDualJudgeConfig /
    remoteJudgeRaw / _remoteJudgeConfig / remoteJudgeOverrideApplied 不再出现
  - 不配置 OCTOCLAW_JUDGE_FAST 时，judge 跳过，routeHintRequired=true 注入 system prompt
Commit boundary: no commit — Codex reviews first.
Risks/rollback: remote judge 从未生效，删除无功能损失。若 resolveStatelessPolicyDecision
  修改引入 bug，git revert 回滚。
Before editing: echo a 5-bullet plan and confirm allowed scope.
After editing: report changed files, tests run, remaining risks, and any scope deviations.
Do not rewrite unrelated modules. Do not commit until Codex reviews.

OctoClaw hard constraints — violation = immediate stop:
[同上]
```

---

#### P1-T5 — IM Adapter 注册表

```
ulw
OpenSpec Work Packet
Problem: im/index.ts 硬编码只支持 Slack，getAdapterForSession 只返回 SlackAdapter|null，
  无注册机制。要支持其他 IM 必须改核心文件，阻碍社区扩展。
Docs: docs/octoclaw-refactor-impl-guide-2026-04-29.md — 章节 P1-T5，共3步。
Non-goals:
  - 不改 SlackAdapter 的 send / react / executeSend 等已有方法实现
  - 不改 ack-guard.ts 里对 getAdapterForSession 的调用签名
Allowed scope:
  - extensions/octoclaw-runtime/src/im/adapter.ts（新建接口）
  - extensions/octoclaw-runtime/src/im/index.ts（改为注册表模式）
  - extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts（实现 IMAdapter 接口）
Acceptance:
  - pnpm --filter @octoclaw/runtime run build 通过
  - pnpm test 无新增失败
  - getAdapterForSession("slack:user:ABC") 返回 SlackAdapter 实例
  - getAdapterForSession("feishu:user:ABC") 返回 null（未注册时）
  - registerIMAdapter 调用后 getAdapterForSession 能找到自定义 adapter
  - 调用 getAdapterForSession 的其他文件无需修改
Commit boundary: no commit — Codex reviews first.
Risks/rollback: 接口变更只影响 SlackAdapter 声明，不影响运行逻辑。
Before editing: echo a 5-bullet plan and confirm allowed scope.
After editing: report changed files, tests run, remaining risks, and any scope deviations.
Do not rewrite unrelated modules. Do not commit until Codex reviews.

OctoClaw hard constraints — violation = immediate stop:
[同上]
```

---

#### P1-T7 — ACK/Progress 三相模型

```
ulw
OpenSpec Work Packet
Problem: ACK 系统（tier 计时器）和 Progress 系统（execution transitions）并行运行，
  职责重叠，三处重复发送函数，~100 条随机模板，no_valid_thread_anchor 导致进度通知
  静默消失。需统一为三相模型（ACK/Progress/Final），单一发送路径。
Docs: docs/octoclaw-refactor-impl-guide-2026-04-29.md — 章节 P1-T7，共6步。
Non-goals:
  - 不删除 AckStage / ackStageText / selectAckTemplate export（向后兼容）
  - 不改 sendReactionAckDetailed（emoji reaction 逻辑不同）
  - 不删除 emitExecutionTransitionNotification 函数（child-finalizer.ts 调用）
  - 不改 detectExecutionTransition（状态机检测逻辑保持不变）
  - reply 路由下 tier1/2/3 必须仍然工作（18s/45s/120s）
Allowed scope:
  - extensions/octoclaw-runtime/src/im/send.ts（新建）
  - extensions/octoclaw-runtime/src/ack/ack-templates.ts（完全替换，精简到 ~80行）
  - extensions/octoclaw-runtime/src/ack/ack-template-registry.ts（删除整个文件）
  - extensions/octoclaw-runtime/src/ack/ack-timing.ts（新增 getAckTierDelays 函数）
  - extensions/octoclaw-runtime/src/ack/ack-guard.ts（sendAckDirectDetailed 改调 sendIMMessage）
  - extensions/octoclaw-runtime/src/ack/execution-transition-notifier.ts（修复 skip + 改调）
Acceptance:
  - pnpm --filter @octoclaw/runtime run build 通过
  - pnpm test 无新增失败
  - ack-template-registry.ts 不存在
  - ack-templates.ts ≤ 80 行
  - execution-transition-notifier.ts 不含 no_valid_thread_anchor → skipped 逻辑
  - ack-guard.ts sendAckDirectDetailed 不含 runCommand("openclaw", ...) 实现
  - getAckTierDelays("delegate") 返回 [0,0,0]
  - getAckTierDelays("reply") 返回 [18000, 45000, 120000]
  - im/send.ts 存在且 sendIMMessage 可导出
Commit boundary: no commit — Codex reviews first.
Risks/rollback: ack-templates 精简后文案减少，随机范围缩小，但功能不变。
  ack-template-registry 删除前确认没有其他 import。
Before editing: echo a 5-bullet plan and confirm allowed scope.
After editing: report changed files, tests run, remaining risks, and any scope deviations.
Do not rewrite unrelated modules. Do not commit until Codex reviews.

OctoClaw hard constraints — violation = immediate stop:
[同上]
```

---

#### P1-T8 — replay-logger 拆分

```
ulw
OpenSpec Work Packet
Problem: replay-logger.ts 是 1715 行 God File，包含5种不同职责（receipt、replay log、
  delivery relay、message guard、policy utils）。名字误导，51个 export 分散关注点。
  同时 delivery relay 部分（L830-1185，约350行）在 P0-T1 实施后被 completion protocol
  取代，应删除。
Docs: docs/octoclaw-refactor-impl-guide-2026-04-29.md — 章节 P1-T8，共6步。
Non-goals:
  - 不改任何 export 函数的签名（只移动位置）
  - 不删除 replay-logger.ts（改为 re-export shim，向后兼容）
  - 不改 guardAssistantMessageForPolicyState 的逻辑（只搬家）
  - P0-T1 未完成时不删除 delivery relay 函数（先检查后删）
Allowed scope:
  - extensions/octoclaw-runtime/src/receipt.ts（新建）
  - extensions/octoclaw-runtime/src/replay/replay.ts（新建）
  - extensions/octoclaw-runtime/src/replay/message-guard.ts（新建）
  - extensions/octoclaw-runtime/src/replay/policy-utils.ts（新建）
  - extensions/octoclaw-runtime/src/replay/replay-logger.ts（改为 re-export shim）
  - extensions/octoclaw-runtime/src/extension-entry.ts（recordPolicyReplay 调用改 fire-and-forget）
Acceptance:
  - pnpm --filter @octoclaw/runtime run build 通过
  - pnpm test 无新增失败
  - receipt.ts 存在，含 TurnExecutionReceipt 和 buildTurnExecutionReceipt
  - replay/message-guard.ts 存在，含 guardAssistantMessageForPolicyState
  - replay/policy-utils.ts 存在，含 workflowEnforcementRule
  - replay-logger.ts ≤ 30 行（只有 re-exports）
  - registerPendingDelivery / reconcilePendingDeliveriesForSession 不再出现
    （仅在 P0-T1 已完成且确认无其他依赖时删除）
  - extension-entry.ts 里 recordPolicyReplay 调用改为 fire-and-forget（void + .catch）
Commit boundary: no commit — Codex reviews first.
Risks/rollback: 纯代码搬移，不改逻辑。re-export shim 确保向后兼容，所有 import 不需修改。
Before editing: echo a 5-bullet plan and confirm allowed scope.
After editing: report changed files, tests run, remaining risks, and any scope deviations.
Do not rewrite unrelated modules. Do not commit until Codex reviews.

OctoClaw hard constraints — violation = immediate stop:
[同上]
```

---

#### P2-T10 — 插件开关 + openclaw.plugin.json 清理

```
ulw
OpenSpec Work Packet
Problem: OctoClaw 无法在不卸载的情况下关闭。openclaw.plugin.json 的 configSchema 包含
  已废弃字段（remoteJudge、timeoutLocalMs、local、ackTimerFirstTierMs 等）。
  需加入 enabled 开关并清理 configSchema。
Docs: docs/octoclaw-refactor-impl-guide-2026-04-29.md — 章节 P2-T10，共2步。
Non-goals:
  - 不删除 delegationEnabled 字段（现有用户可能已配置）
  - 不修改 hook 注册逻辑本身（只在 register 开头加 enabled 检查）
Allowed scope:
  - extensions/octoclaw-runtime/src/extension-entry.ts（register 函数开头加 enabled 检查）
  - extensions/octoclaw-runtime/openclaw.plugin.json（完整替换 configSchema）
Acceptance:
  - pnpm --filter @octoclaw/runtime run build 通过
  - pnpm test 无新增失败
  - pluginConfig.enabled = false 时 register 直接 return，不注册任何 hook
  - openclaw.plugin.json 不含 remoteJudge / timeoutLocalMs / local / ackTimerFirstTierMs
  - openclaw.plugin.json 含 enabled 字段，default: true
  - judgeFast 的 configSchema 只有 8 个字段
Commit boundary: no commit — Codex reviews first.
Risks/rollback: configSchema 是 OpenClaw 用于 UI/validation 的，修改不影响运行时行为。
  enabled 检查只在 register 开头，不影响已注册的任何 hook。
Before editing: echo a 5-bullet plan and confirm allowed scope.
After editing: report changed files, tests run, remaining risks, and any scope deviations.
Do not rewrite unrelated modules. Do not commit until Codex reviews.

OctoClaw hard constraints — violation = immediate stop:
[同上]
```

---

#### P2-T9 — 合并幽灵包

```
ulw
OpenSpec Work Packet
Problem: octoclaw-fast-reply（245行）和 octoclaw-delegation（668行）只被
  runtime-payloads.ts 的 5 个函数使用，没有自己的 openclaw.plugin.json，
  不是独立插件，单独成包增加 2 个 build 步骤。需内联到 octoclaw-runtime。
Docs: docs/octoclaw-refactor-impl-guide-2026-04-29.md — 章节 P2-T9，共4步。
Non-goals:
  - 不修改移过来的函数逻辑（只是搬家）
  - 不删除测试文件
Allowed scope:
  - extensions/octoclaw-runtime/src/payloads/fast-reply/（新建目录，从 fast-reply 移入）
  - extensions/octoclaw-runtime/src/payloads/delegation/（新建目录，从 delegation 移入）
  - extensions/octoclaw-runtime/src/runtime-payloads.ts（改 import 路径）
  - extensions/octoclaw-runtime/package.json（删除 @octoclaw/fast-reply / delegation 依赖）
  - pnpm-workspace.yaml（删除两个包）
  - extensions/octoclaw-fast-reply/（删除整个目录）
  - extensions/octoclaw-delegation/（删除整个目录）
Acceptance:
  - pnpm --filter @octoclaw/runtime run build 通过
  - pnpm test 无新增失败（原两包的测试现在在 runtime 里跑）
  - extensions/octoclaw-fast-reply 目录不存在
  - extensions/octoclaw-delegation 目录不存在
  - runtime-payloads.ts import 改为相对路径
  - pnpm-workspace.yaml 不再有这两个包
Commit boundary: no commit — Codex reviews first.
Risks/rollback: 纯代码搬移，运行逻辑不变。测试迁移确保功能等价。
Before editing: echo a 5-bullet plan and confirm allowed scope.
After editing: report changed files, tests run, remaining risks, and any scope deviations.
Do not rewrite unrelated modules. Do not commit until Codex reviews.

OctoClaw hard constraints — violation = immediate stop:
[同上]
```

---

#### P2-T11 — octoclawctl 统一安装工具

```
ulw
OpenSpec Work Packet
Problem: tools/install（1053行）和 tools/manage（911行）功能重叠，各自硬编码
  DEPLOY_PACKAGE_NAMES，tools/install 有 macOS 专属 launchctl 代码（非 macOS 不工作），
  没有插件 enable/disable 命令。需合并为 tools/octoclawctl，提供统一 CLI。
Docs: docs/octoclaw-refactor-impl-guide-2026-04-29.md — 章节 P2-T11，共6步。
Non-goals:
  - 不删除 tools/install / tools/manage（保留，但加 deprecation notice）
  - 不引入新的 OpenClaw 内部 API 依赖（只用 openclaw CLI 命令）
  - 不修改 extension 的运行时逻辑（只改安装/配置工具）
Allowed scope:
  - tools/octoclawctl/（新建目录，含 src/cli.ts / install.ts / config.ts / manage.ts / platform.ts）
  - tools/octoclawctl/package.json（新建）
  - tools/octoclawctl/tsconfig.json（新建）
  - pnpm-workspace.yaml（加入 tools/octoclawctl）
  - tools/install/src/index.ts（加 deprecation notice 注释，不删除）
  - tools/manage/src/index.ts（加 deprecation notice 注释，不删除）
Acceptance:
  - pnpm --filter octoclawctl run build 通过
  - pnpm --filter octoclawctl run test 通过
  - node tools/octoclawctl/dist/cli.js --help 显示命令列表
  - node tools/octoclawctl/dist/cli.js status 正常运行
  - tools/octoclawctl/src 不含 launchctl setenv 调用
  - platform.ts 的 restartService 支持 macOS 和 Linux（darwin + linux 分支）
  - ~/.octoclaw/config.json 可被正确读写
Commit boundary: no commit — Codex reviews first.
Risks/rollback: 新增工具，不删旧工具。失败直接删除 tools/octoclawctl 回滚。
Before editing: echo a 5-bullet plan and confirm allowed scope.
After editing: report changed files, tests run, remaining risks, and any scope deviations.
Do not rewrite unrelated modules. Do not commit until Codex reviews.

OctoClaw hard constraints — violation = immediate stop:
[同上]
```

---

#### QF-1 — "lost" → "failed" 映射

```
ulw
OpenSpec Work Packet (compact)
Problem: materializer.ts mapSubstrateToContractStatus 的 default case 把 "lost" 映射到
  "queued"。task 丢失应显示 failed，不是排队中。
Docs: docs/octoclaw-refactor-impl-guide-2026-04-29.md — 章节 QF-1。
Non-goals: 不改其他 case。
Allowed scope: extensions/octoclaw-runtime/src/work-contract/materializer.ts（一行）
Acceptance: switch 语句有 case "lost": return "failed"。pnpm test 通过。
Commit boundary: no commit — Codex reviews first.
Before editing: echo a 5-bullet plan and confirm allowed scope.
After editing: report changed files, tests run, remaining risks, and any scope deviations.
```

---

#### QF-2 — ACK 常量去重

```
ulw
OpenSpec Work Packet (compact)
Problem: ack-decision.ts 和 ack-timing.ts 各自定义相同的 tier 延迟常量（18000/45000/120000），
  两份维护，随时不同步。
Docs: docs/octoclaw-refactor-impl-guide-2026-04-29.md — 章节 QF-2。
Non-goals: 不改常量值本身。
Allowed scope: extensions/octoclaw-runtime/src/ack/ack-decision.ts（删自定义，改为 import）
Acceptance: ack-decision.ts 不含独立定义的 tier1_ms:18000 等常量，从 ack-timing.ts import。
  pnpm test 通过。
Commit boundary: no commit — Codex reviews first.
Before editing: echo a 5-bullet plan and confirm allowed scope.
After editing: report changed files, tests run, remaining risks, and any scope deviations.
```

---

#### QF-3 — delegate-packets runtime throw

```
ulw
OpenSpec Work Packet (compact)
Problem: delegate-packets.ts:70 当 relevantExcerpts 有值但 contextEscalationReason 缺失时
  抛 runtime error，可能在 dispatch 路径上造成 unhandled rejection。
Docs: docs/octoclaw-refactor-impl-guide-2026-04-29.md — 章节 QF-3。
Non-goals: 不改函数其他逻辑。
Allowed scope:
  - extensions/octoclaw-runtime/src/context/delegate-packets.ts（接口 + 删 throw）
  - 所有调用 buildDelegateHandoffPacket 的地方（传 null 代替省略）
Acceptance: contextEscalationReason 改为 ... | null（必填），删除 runtime throw。
  pnpm --filter @octoclaw/runtime run build 通过，无 type error。pnpm test 通过。
Commit boundary: no commit — Codex reviews first.
Before editing: echo a 5-bullet plan and confirm allowed scope.
After editing: report changed files, tests run, remaining risks, and any scope deviations.
```

---

#### QF-4 — PolicyStateStore entries() type cast

```
ulw
OpenSpec Work Packet (compact)
Problem: policy-state.ts:494 用 (store as unknown as {entries: Map<...>}).entries.entries()
  type cast 访问私有成员，不干净。
Docs: docs/octoclaw-refactor-impl-guide-2026-04-29.md — 章节 QF-4。
Non-goals: 不改 PolicyStateStore 其他方法。
Allowed scope: extensions/octoclaw-runtime/src/state/policy-state.ts
Acceptance: _entries 替代 entries 作为私有成员名，PolicyStateStore 有 public getEntries() 方法，
  createPolicyStateStore 用 getEntries() 替代 type cast。pnpm test 通过。
Commit boundary: no commit — Codex reviews first.
Before editing: echo a 5-bullet plan and confirm allowed scope.
After editing: report changed files, tests run, remaining risks, and any scope deviations.
```

---

### 失败处理

- **OpenCode 改了 allowed scope 外的文件** → 停止，重申 authority model，发 correction packet 要求 revert 越界改动
- **测试失败但怀疑是历史问题** → 记录 `git stash && pnpm test` 的输出，确认是否是已有失败
- **OpenCode 连续不靠谱（两次 correction 无改善）** → Codex 接手该任务自己做
- **ACP 卡住** → abort session，缩小 packet，拆分成更小的子任务
- **build 失败** → 不提交，发 correction packet，附上完整错误输出

---

### 最终验证脚本（全部任务完成后跑）

```bash
cd ~/workspace/OctoClaw   # 换成你的实际路径
git branch   # 确认在 refactor/0.4.0-stable

# 全量构建和测试
pnpm build && pnpm test

# 关键字符串验证
grep -r "task-executor\|TASK_EXECUTOR_ALIASES\|\[\"a\"\]" extensions/ packages/ --include="*.ts" | grep -v test
grep -r "DualJudgeConfig\|callRemoteJudge\|shouldEscalate" extensions/ packages/ --include="*.ts"
grep -r "readdirSync.*session\|\[OctoClaw Delegated Task\].*finaliz" extensions/ --include="*.ts"
grep -r "no_valid_thread_anchor.*skipped" extensions/ --include="*.ts"
grep -r "ACK_TEMPLATE_POOL\|buildTemplateEntry" extensions/ --include="*.ts"
grep -r "launchctl.*setenv.*OCTOCLAW" tools/ --include="*.ts"
# 以上全部应无输出

# 关键新增验证
ls extensions/octoclaw-runtime/src/receipt.ts
ls extensions/octoclaw-runtime/src/replay/message-guard.ts
ls extensions/octoclaw-runtime/src/im/send.ts
wc -l extensions/octoclaw-runtime/src/replay/replay-logger.ts   # ≤ 30
wc -l extensions/octoclaw-runtime/src/delegate/child-finalizer.ts  # ≤ 220
wc -l extensions/octoclaw-runtime/src/ack/ack-templates.ts      # ≤ 80

# 包数量
ls extensions/ packages/   # fast-reply 和 delegation 不应存在
```

---

*文档生成于 2026-04-29，对应 release/0.3.0-ts-rebuild 分支。*
