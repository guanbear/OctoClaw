# OctoClaw 基于 OpenClaw 原生能力的瘦身落地实现文档

日期：2026-05-01

适用范围：OctoClaw refactor 0.4.0 stable，目标宿主 OpenClaw v2026.4.29。

关联审查文档：[`octoclaw-openclaw-native-slimming-review-2026-05-01.md`](./octoclaw-openclaw-native-slimming-review-2026-05-01.md)。审查文档负责“为什么这么改”；本文负责“按什么顺序改、改到什么程度算完成”。

## 0. 结论

建议另起本文，不继续扩展审查文档。

原因是这次改造跨 runtime、ACK、footer、judge、Slack/IM、WorkContract、状态投影。如果把源码映射、阶段目标、验收标准都塞进审查文档，后续执行时很难定位。推荐结构是：

- 审查文档：架构判断、问题列表、取舍理由。
- 本文：落地路线、文件级改法、验收标准、测试矩阵。

最终目标不是把 OctoClaw 删除，而是把它收缩成：策略、语义合同、模型成本策略、IM 体验层。执行真相、子 agent 生命周期、完成回传、队列、线程路由和状态 registry 应尽量交回 OpenClaw。

0.5.0 的主线落地方式是 `sessions_spawn planner/confirm`：`octoclaw_dispatch` 只生成经过 admission 的 `NativeSpawnIntent`，主 agent 调 OpenClaw 原生 `sessions_spawn`，再通过 `octoclaw_dispatch_confirm` 把 `runId/childSessionKey` 写回 OctoClaw metadata。`api.runtime.subagent.run()` 不作为 0.5.0 主路径；direct plugin SDK spawn 只作为未来替换点。

### 0.1 0.5.0 Master Plan 口径

本文就是 0.5.0 重构的 master implementation plan，不再另起一份完整计划文档。后续如果需要给 Codex/opencode 交接，只写短 handoff，handoff 必须指回本文和 OpenSpec，不承载另一套计划。

0.5.0/0.5.x 的完成定义按四档管理：

| 档位 | 范围 | 完成标准 |
| --- | --- | --- |
| Must ship | `sessions_spawn planner/confirm` 主链、NativeSpawnIntent gate、`octoclaw_dispatch_confirm`、delegate ACK 时序、源码/部署一致、核心回归测试、真实 Slack smoke、OpenSpec 同步 | planner allowlist 内真实 Slack delegate 能完成 `dispatch -> sessions_spawn -> confirm -> ACK`，无 `invalid_status:planned`，无提前“已委派”，重启/重复 confirm 不制造假状态 |
| Should ship | ACK/footer/judge 的必要瘦身、runtime-ledger 职责收缩、status/provenance follow-up 禁止 spawn、planner path 下关闭 completion file/finalizer/outbox、native status projector 初版、SR-P0/SR-P1/SR-P2 | 用户可见噪声明显降低，状态回答不重新 spawn，planner path 不依赖 completion file，SQLite 只做 metadata/audit，neutral ACK 和路由分桶有可观测指标 |
| 0.5.x immediate | legacy scheduler/finalizer/outbox 从默认 planner/native path 下线；Slack delivery port 替换 Slack CLI/shell 热路径；只在 0.5.0 Must+Should 稳定后执行 | 真实 Slack smoke 无 `completion_file_timeout`，native announce final delivery 正常，debug footer 不误标 `reply`，`OCTOCLAW_LEGACY_*` rollback 可用 |
| Deferred | 非 Slack IM delivery port 适配、managed flow 编排增强、direct SDK spawn、warm worker pool/A2A 常驻 worker、未暴露 tool allowlist/private hook | 进入 0.6.0 或单独 research OpenSpec；不作为 0.5.0/0.5.x immediate 阻塞项 |

0.5.0 的发布验收只看 Must ship + Should ship。`0.5.x immediate` 是 0.5.0 稳定后的紧邻收尾，不阻塞 0.5.0 发版；delivery port 的近期范围只做 Slack，非 Slack IM 保持现有 fallback，不在本轮重构里强行迁移。

远端 Codex/opencode 接手时应先建立这个 master task board，然后按 slice 推进。当前真实 Slack smoke handoff 只覆盖 Must ship 的 P0/P1：证明 native `sessions_spawn` 是否命中 OctoClaw `before_tool_call` gate，并修复 `invalid_status:planned`。P0/P1 通过后，再继续做 ACK/footer/judge、legacy 默认路径下线和 metadata/status 收口。

## 1. 预期目标

### 1.1 用户体验目标

1. 用户发消息后尽早看到轻量 ACK。优先 reaction/typing，慢回复才补短文本。
2. delegate 只在原生 `sessions_spawn` accepted 且 `octoclaw_dispatch_confirm` 成功后告诉用户“已交给子 agent”。
3. 子 agent 完成后，由 OpenClaw 原生 handoff/announce 回到 requester，而不是依赖 child 写 completion file。
4. Slack 群/频道里不因为 footer、重复 ACK、fallback outbox 产生多条噪声消息。
5. 用户问“刚才的任务怎么样了”时，状态来自 OpenClaw native runs/flows，而不是 OctoClaw 自己猜。

### 1.2 工程目标

1. planner path 下不再启动 OctoClaw 自建 scheduler、completion binding、child-finalizer、delivery outbox。
2. WorkContract 和 OctoClaw metadata store 只保存语义合同、route/judge/replay、IM anchor 和 native refs，不再作为执行状态权威。
3. judge 不生成用户可见 ACK，不直接授权副作用；它只输出 route/role/complexity/new-work/deliverable 等结构化信号。
4. footer 默认关闭，只在 compact/debug 模式显示。
5. IM delivery 通过 OpenClaw runtime/channel route 能力或明确的 port，不再在热路径 shell out CLI 并解析 stdout/stderr。

### 1.3 成功指标

- Slack/IM ACK：配置允许时 reaction ACK p95 < 300ms；慢文本 ACK 每个 turn 最多 1 条。
- 中性首 ACK：Slack 收到消息后 1-5s 内发出 reaction 或短文本；文案只能表达“收到/正在判断”，不能表达“已委派/已启动”。
- main fast path：短任务、简单查证、状态/来源追问默认不走 delegate；真实 Slack smoke 中 false delegate 明显下降。
- delegate ACK：必须包含原生 accepted + confirm 事实，`sessions_spawn` accepted 到 confirm/用户 ACK p95 < 1s。
- planner 启动延迟：delegate route commit 到 `sessions_spawn_intent_allowed` p95 < 30s 作为 0.5.0 诊断目标，不再承诺所有子 agent 从用户消息到启动小于 10s。
- child 启动延迟：只记录 `sessions_spawn accepted -> child visible progress/first tool/final` 指标；不把 p95 <= 10s 作为 0.5.0 验收门槛。
- spawn evidence：delegate 成功时必须有 `runId` 或 OpenClaw native task/run id；只有 `childSessionKey` 不算强证据。
- duplicate visible messages：正常 delegate 流程中重复 ACK/完成通知为 0。
- restart recovery：OpenClaw 重启后仍可通过 native runs/flows 查到 active/recent child run。
- footer：生产默认无 route/model/footer 暴露。

### 1.4 速度与响应性专项 P0-P2（0.5.0 现实版）

本专项用于修复 0.5.0 planner/native path 的体验回退。2026-05-02 macmini 真实 Slack smoke 暴露了一个关键事实：planner/native spawn 本身可以通过，但用户直到约 90s 才看到“任务已启动”。其中 SQLite intent 从创建到 accepted 约 19s，真正慢点主要在 parent embedded run 启动、工具 bundle、system prompt、stream setup、模型首轮决策，以及 child embedded run 的完整启动。SQLite 不是 90s 的主因，但可以作为 footer/status/native refs 和延迟观测的快路径来优化稳定性。

因此 0.5.0 不再承诺“委派一定更快”或“子 agent 从用户消息到启动稳定小于 10s”。新的产品口径是：**短任务更快，长任务不堵；少误委派，而不是少做 OctoClaw**。OpenSpec 中只保留 `SR-P0` 到 `SR-P2` 三个速度专项：P0 恢复中性首 ACK，P1 调整委派规则，P2 瘦身 planner/native 热路径并补齐观测。原先设想的 direct SDK spawn、warm worker pool、未暴露工具 allowlist、child start p95 <= 10s 都不进入 0.5.0 验收。

#### SR-P0：恢复中性首 ACK

目标：恢复旧 OctoClaw “马上有反应”的体验，但不恢复旧实现里可能提前声称已委派的语义。

实现口径：

- 新增或修复 `neutral inbound ack`，从原始 Slack event 的 `channel/message.ts/thread_ts`、或规范化 session target 直接发出。
- 不依赖 route commit、judge、policy state、`sessions_spawn` 或 `octoclaw_dispatch_confirm`。
- 文案只允许表达“收到，正在判断并准备处理。”；不能出现“已委派”“任务已启动”“子 agent 已在处理”。
- 如果 reaction 成功，默认不再发文本首 ACK；reaction 失败且配置允许时，才发短文本 fallback。
- 修复 `maybeSendLatencyAck: suppressed due to no valid thread target`：首 ACK 的 target resolution 必须以 inbound anchor 为 truth，而不是从后续 policy state 推断。
- `任务已启动。` 仍只允许在 native `sessions_spawn` accepted 且 `octoclaw_dispatch_confirm` 成功后发送。

验收：

- Slack 真实 smoke 中 neutral ACK p95 <= 5s。
- spawn 失败、gate 阻止、judge 降级时不出现“已委派/任务已启动”。
- 同一 turn 不重复发 reaction + 文本 + route commit ACK。
- 线程 target 缺失时 fail closed 并写 replay，不向 channel root 误发。

2026-05-03 最新 PC12 证据：

- 本机已部署当前 `extensions/octoclaw-runtime/dist` 后串行跑两条真实 Slack planner-native smoke：
  - `/tmp/pc12-neutral-ack-20260503T021244Z-1/slack-acceptance-2026-05-03-04-17-06.{json,md}`
  - `/tmp/pc12-neutral-ack-20260503T041747Z-2/slack-acceptance-2026-05-03-04-21-06.{json,md}`
- 两条均为 harness `pass`，neutralAckMs 分别为 `3087` / `3234`，latest two-sample nearest-rank p95/max 为 `3234ms`，低于 5s 目标。
- 两条 replay 均记录 `anchorSource=ctx`、`fallbackUsed=false`，且 `message_received`、`before_dispatch`、`before_prompt_build` 三入口 dedupe 后只发一条首 ACK；单测覆盖 event anchor 和 fallback-history 兜底。
- Accepted ACK 仍未优化：两条 acceptedAckMs 为 `89865` / `112168`，`sessions_spawn_intent_allowed` 阶段约 `80s`，应继续作为 SR-P2/PC15 性能方向观察，不能把它和 neutral ACK 混在一起。
- 两条 final 均为 `route=delegate | ... | via=native_announce`，`completion_file_timeout=0`，transcript 只有 neutral ACK、accepted ACK、final 三条可见消息。
- 2026-05-04 local / 2026-05-03 UTC 最新 ticket-fix smoke：`/tmp/octoclaw-planner-native-user-20260504-ticket-fix/out/slack-acceptance-2026-05-03-22-36-12.{json,md}`，harness `pass`；thread `1777847588.374549`，WorkContract `wc-ab450a65b9afe6f5`，spawnIntent `nsp_moqcltjd_68eac0a0`，runId `0a355aee-aaea-49cd-a768-493cfa5c7d58`，childSession `agent:main:subagent:e01f185d-0aa1-4ee0-b438-6db9461140f3`。
- 最新 smoke 的 neutralAckMs `5201`，Slack reaction `eyes`；acceptedAckMs `102093`，finalMs `182784`。Replay stage：`message_received=5057ms`、`before_dispatch=5098ms`、`before_prompt_build=86211ms`、`sessions_spawn_intent_allowed=96922ms`、`sessions_spawn_accepted=102776ms`、`dispatch_confirm=102778ms`、`native_child_final=183504ms`。
- 最新 smoke final footer 为 `route=delegate | model=zhipu/GLM-5.1 · thread | via=native_announce | worker=octoclaw-research | wc=wc-ab450`，`completionFileTimeoutCount=0`，Slack transcript 无重复 final；后续 duplicate replay 被 `already_delivered` 拒绝。
- 2026-05-04 clean planner-native 三样本：`/tmp/octoclaw-sr-p1-smoke-20260504/run{3,4,5}-clean/` 均为 harness `pass`。neutralAckMs 为 `4724` / `4735` / `4722`，nearest-rank p95/max `4735ms`，三次均为 Slack reaction；acceptedAckMs 为 `111112` / `111567` / `110619`，finalMs 为 `208413` / `305340` / `217014`。
- 最新 clean run5：`/tmp/octoclaw-sr-p1-smoke-20260504/run5-clean/slack-acceptance-2026-05-04-02-07-19.{json,md}`；thread `1777860220.481439`，WorkContract `wc-8952a8e3a003c912`，spawnIntent `nsp_moqk4odi_c2da90d2`，runId `793c2d86-badc-4c10-bd78-03efe2cb7937`，childSession `agent:main:subagent:afcea35f-6139-41e6-b588-942311844f37`，decision_bucket `must_delegate`。
- 最新 clean run5 replay：`completion_file_timeout=0`、`duplicateFinal=0`、`footerVia=native_announce`、PC13 delivery `delivery_transport=slack_api` / `target_source=inbound_anchor` / `footer_source=envelope`。Stage：`message_received=3606ms`、`before_dispatch=3649ms`、`before_prompt_build=87659ms`、`sessions_spawn_intent_allowed=104851ms`、`sessions_spawn_accepted=111138ms`、`dispatch_confirm=111141ms`、`native_child_final=217610ms`。
- 2026-05-04 confirm hardening 补充：`confirmNativeSpawn()` 在 intent store read/expire 抛 `SQLITE_BUSY` / `SQLITE_LOCKED` / `SQLITE_UNAVAILABLE` 时返回 fail-closed JSON；`octoclaw_dispatch_confirm` tool 仍写 `dispatch_confirm_completed ok=false` replay，不直接异常退出。双 confirm/race 回滚改为 CAS-style：失败方只在当前 WorkContract native refs 仍匹配自身 `runId/childSessionKey` 时回滚，并且只恢复 native-ref 相关字段，不擦掉成功方 refs 或其他并发更新。
- 2026-05-04 budgeted_main live 尝试 `/tmp/octoclaw-sr-p1-smoke-20260504/run-budget-1/` 未作为验收证据：真实 Slack turn 没产出 `decision_bucket=budgeted_main_then_delegate`，judge 2s timeout 后按 reply 完成。固定 30s soft budget 的 local runtime tests 已过，但 live `budgeted_main_escalated_pending -> octoclaw_dispatch` evidence 仍未补齐，不能提前宣布 SR-P1 完整闭环。
- 2026-05-04 follow-up：`octoclawctl` unified config now preserves/projects `judge.local` and `judge.timeoutLocalMs`; deployed macmini config, manifest, `openclaw.json`, legacy `judge-fast.json`, and launchctl env all resolve local judge effective timeout to `4000ms`. This fixes the 2s operational override.
- 2026-05-04 additional budgeted_main live attempts remain unaccepted as evidence:
  - `/tmp/octoclaw-sr-p1-smoke-20260504/run-budget-2/slack-acceptance-2026-05-04-06-57-24.{json,md}` produced a normal reply path, not `budgeted_main_then_delegate`; thread `1777877599.213359`, neutral reaction `4873ms`, final `route=reply | via=rule`, no budget replay events.
  - `/tmp/octoclaw-sr-p1-smoke-20260504/run-budget-3/slack-acceptance-2026-05-04-07-09-30.{json,md}` hit the harness total timeout; runtime replay for thread `1777878030.931209` shows reaction ACK, repeated `before_prompt_build`, `dispatch_terminal_failure`, compaction notice, context overflow, and session file lock/fallback. It does not prove the fixed 30s soft escalation chain.

#### SR-P1：启动成本感知的委派规则

目标：把 delegate 从“默认更快”改成“只在长任务、并行、上下文隔离、成本分层有明确收益时使用”。短任务、轻量查证、状态/来源追问默认走 main fast path。但这不是把阈值整体调高，更不是让系统“不敢委派”；规则必须同时防 false delegate 和 false reply。

三段式决策口径：

- `must_reply/main_fast_path`：简单回答、状态/来源追问、澄清问题、单步只读查证、当前上下文可直接完成的任务。
- `must_delegate`：用户明确要求后台/子 agent/并行、代码修改/测试/构建、长命令、多步工具链、大量上下文阅读、review/验证，或明显无法放进固定 30s main execution budget。
- `budgeted_main_then_delegate`：无法高置信判断时，主 agent 先在固定 30s soft runtime budget 内尝试；超过预算后进入升级待执行状态，或在需要写操作、长命令、多步工具、测试/build/review/validation 时立即转 `octoclaw_dispatch`。

实现口径：

- judge 只输出两档 `route=reply|delegate` 和成本信号；runtime 再用 `confidence`、`tool_need_hint`、`duration_hint`、`scope`、`evidence_required` 派生 `must_reply` / `must_delegate` / `budgeted_main_then_delegate`。
- `duration_hint=short`、`tool_need_hint=none`、`scope=local|unknown`、`evidence_required=false` 且高置信 `route=reply` 时派生 `must_reply`；`tool_need_hint=maybe`、`duration_hint=medium`、`scope=remote|both`、`evidence_required=true` 或低置信 reply 派生 `budgeted_main_then_delegate`。
- `fresh_live_lookup` 不再自动 delegate；先允许 main fast path 做一次轻量只读查证，预算超限再转 delegate。
- `conversation route_hint=delegate` 不能单独强制 delegate；必须同时满足 long duration、required tools、code/test/edit、explicit delegate、或多步/并行收益。
- `fast_first_response` 不再作为 delegate reason code；delegate reason 应收敛为 `background_execution`、`context_hygiene`、`parallelism`、`cost_tiering`、`specialized_tools`、`quality_isolation`。
- status/provenance/execution follow-up 一律不 spawn；优先 native state、replay、WorkContract refs，缺证据则诚实回复无可验证记录。
- rule、local judge、cheap LLM judge、route hint、AGENTS.md/prompt 注入必须同步使用“route 两档 + runtime 成本派生三档”；不能只改某一层，否则会出现 local 判 main fast path、LLM 或 prompt 又因 `fresh_live_lookup` 拉回 delegate 的抖动。
- local/cheap judge 输出不能只有 `reply/delegate`，还必须带 `duration_hint`、`tool_need_hint`、`scope`、`evidence_required`、`reason_codes`。`decision_bucket` / `startup_cost_policy` / `hard_delegate_signal` 只能作为 telemetry，不能作为 SR-P1 权威。

验收：

- 简单解释、简单查版本/状态、来源追问、单步轻量查证不触发 `octoclaw_dispatch`。
- route replay 记录 `startup_cost_policy` 或等价字段，说明为什么 main fast path 或 delegate。
- false delegate rate 在 nightly/Slack smoke 中可观测并下降。
- false reply rate 同样必须可观测；明确长任务、代码/测试、多步工具、用户显式后台/并行不能被 main fast path 吃掉。
- 主模型仍可在超过 fast path 预算后提交 route hint/dispatch，不被静态规则卡死。
- 2026-05-04 实现状态：rule/router 已改为 runtime 派生三段式 bucket，judge 只需给两档 route 和成本信号；focused tests 覆盖 false delegate / false reply、低置信 reply 进入 budget、以及 judge `decision_bucket` 只作为 telemetry。固定 30s soft runtime budget 状态机和 focused tests 已补入，但真实 Slack SR-P1 evidence 矩阵仍需继续补齐，不能把 SR-P1 或 0.5.0 说成端到端完成。

#### SR-P2：瘦身 planner/native 热路径和观测

目标：减少主 agent 从用户消息到 `sessions_spawn` 的模型/工具回合，把真实 delegate 的 route commit 到 `sessions_spawn_intent_allowed` 控制在 30s 内；同时只用 OpenClaw 4.29 已确认存在的能力降低 child run 成本，并把状态、footer、native refs 和延迟观测做成轻量快路径。

实现口径：

- 将 planner path 的 `octoclaw_policy_decide -> octoclaw_dispatch` 合并为更直接的 planner tool（例如 `octoclaw_plan_native_spawn`），或让 `octoclaw_dispatch` 在已有 decision 时直接返回 `NativeSpawnIntent + sessionsSpawnArgs`。
- local judge 高置信 delegate 且 admission 通过时，system instruction 要求主 agent 直接进入 fast/native planner handshake：先调用 `octoclaw_dispatch(fast=true)` 或复用已有 decision 生成/消费 `NativeSpawnIntent`，再调用原生 `sessions_spawn`，最后调用 `octoclaw_dispatch_confirm`；不要先解释、总结或二次规划，也不能绕过 dispatch/gate/confirm 裸调 `sessions_spawn`。
- `sessionsSpawnArgs` 必须小：只包含 `task/label/runtime/model/thinking/cwd/runTimeoutSeconds/mode/cleanup/sandbox/context/lightContext` 等 OpenClaw 原生允许字段，不传 `target/channel/to/threadId/replyTo/transport`。
- planner path 默认传 `sessionsSpawnArgs.context="isolated"` 和 `sessionsSpawnArgs.lightContext=true`；child prompt 只保留任务、上下文摘要、验收标准、交付格式和必要 guardrail，不塞 parent 长上下文或 raw transcript。
- child 默认使用快/便宜模型，复杂任务再按 complexity/model policy 升级；`thinking` 默认关闭或低档，`runTimeoutSeconds` 按 expected duration 设置并保留保守下限，避免 native announce 前被过早杀掉。
- 如果当前 OpenClaw 不支持通过 `sessions_spawn` 限制工具面，不在 0.5.0 自造 private hook；只记录为上游 wishlist。
- SQLite 保留为 metadata/audit store，并把 accepted native refs、WorkContract projection、spawn intent transition 放到 indexed lookup 路径。
- NativeSpawnIntent 状态转换改为原子 SQL：`UPDATE ... WHERE status=? AND args_hash=? RETURNING ...`，减少 read-modify-write race。
- `openRuntimeLedger()` 的 migration/PRAGMA 应只在进程启动或连接创建时执行；热路径避免每次 open/close 都重复初始化。
- SQLite lock 等待要有 retry/backoff/replay 指标；`SQLITE_BUSY` 不得被误判为 no task/no spawn。
- footer route 优先 accepted native refs / child result provenance / `childSessionKey/runId`，不能被 child announce 后 parent 的新 `route=reply` 覆盖成 `reply`。
- Slack smoke 必须记录 neutral ACK、policy/judge、dispatch intent、spawn allowed、accepted confirm、child final、footer provenance 的分段时间。
- hard confirm 不变：只能 `planned -> spawn_call_started -> accepted`；不能为了速度允许 `planned -> accepted`。

验收：

- route commit 到 `sessions_spawn_intent_allowed` p95 <= 30s。
- `octoclaw_dispatch`/planner tool 不直接 spawn、不发 delegate accepted ACK、不写 legacy scheduler/completion/outbox。
- 真实 Slack smoke replay 中能看到 `suppressed_until_native_confirm -> sessions_spawn_intent_allowed -> spawn_started`。
- `sessionsSpawnArgs` 中稳定包含 `context="isolated"` 和 `lightContext=true`，且 child prompt 长度有上限。
- cheap model/fast profile 的选择写入 WorkContract/native refs，便于复盘成本。
- child 启动指标只做观测，不作为 0.5.0 阻塞目标；优化不能牺牲 confirm correctness。
- native child final footer 在 debug 模式显示 `route=delegate`，`via=subagent` 或 `via=native_announce`。
- status/provenance follow-up 不触发新的 spawn。
- SQLite lock/retry 有 replay 事件；锁等待不会导致 confirm 成功但 native refs 丢失。
- 删除或损坏 `task-state.json` 后，已 accepted native task 仍可查到 status/footer provenance。
- 真实 Slack smoke 报告能区分 main fast path、delegate planner、child execution 三段耗时。

## 2. OpenClaw v2026.4.29 源码能力图谱

以下源码位置来自 `openclaw-upstream` 的 `v2026.4.29` tag。

### 2.1 Native subagent spawn

源码：

- `src/agents/tools/sessions-spawn-tool.ts`
- `src/agents/subagent-spawn.ts`
- `docs/tools/subagents.md`

关键能力：

- 工具名是 `sessions_spawn`，非阻塞返回 `{ status: "accepted", runId, childSessionKey }`。
- 参数支持 `task`、`label`、`runtime`、`agentId`、`model`、`thinking`、`cwd`、`runTimeoutSeconds`、`thread`、`mode`、`cleanup`、`sandbox`、`context`、`lightContext`、`attachments`。`context` 支持 `isolated` / `fork`，默认 `isolated`；`fork` 只适合 child 确实需要 requester transcript 的 native subagent 场景。planner path 使用 `context="isolated"`，并由 intent hash/gate 防止主模型改写。
- `sessions_spawn` 明确拒绝 `target/channel/to/threadId/replyTo/transport` 这类 channel delivery 参数；投递应交给 message/session delivery 能力。
- `subagent-spawn.ts` 会处理 max depth、max children、agent allowlist、sandbox 继承、model/thinking plan、lightweight bootstrap context、child session key、run id、registry registration、lifecycle hooks。
- OpenClaw 原生 spawn 已有 requester origin、child session、task lane、run timeout、cleanup、completion announce 的框架。

OctoClaw 可用点：

- model/cost policy 最终映射为 `model`、`thinking`、`runTimeoutSeconds`、`context="isolated"`、`lightContext`，大上下文通过 attachments 或 workspace refs 传递。
- WorkContract 保存 `runId`、`childSessionKey`、`mode`、`modelApplied`，不再推进自建执行状态。
- 不再要求 child worker 写 `.completion.json`。

### 2.2 Native subagent completion delivery

源码：

- `src/agents/subagent-spawn.ts`
- `src/agents/subagent-registry-run-manager.ts`
- `src/agents/subagent-registry-lifecycle.ts`
- `src/agents/subagent-announce-delivery.ts`
- `src/agents/subagent-announce-dispatch.ts`
- `docs/tools/subagents.md`

关键能力：

- 这条 announce/delivery 能力在 tool-level `sessions_spawn` 路径上可靠：`sessions_spawn` 调 `spawnSubagentDirect()`，注册 subagent run，registry 等待 `agent.wait` 完成后触发 announce cleanup flow。
- completion announce 是 push-based。
- `expectsCompletionMessage=true` 时先 direct delivery，失败后 queue fallback；direct delivery 有 transient retry/backoff。
- completion handoff 会带 result/status/runtime stats，并要求 requester agent 用正常 assistant voice 改写，不是原样转发内部 metadata。
- `api.runtime.subagent.run()` 只返回 `runId`，没有完整 child session / requester origin / registry registration / `expectsCompletionMessage` 语义，不能当作这条 announce/delivery 链路的等价入口。

OctoClaw 0.5.0 可用点：

- 通过 planner 让主 agent 调原生 `sessions_spawn`，从而使用 native announce/delivery。
- planner path 停用 `delegate/child-finalizer.ts` 和 completion file poller。
- planner path 不再自建 delivery outbox 负责完成通知。
- 只在 WorkContract projection 中展示 native status 和语义摘要。

### 2.3 Native task runs / flows

源码：

- `src/plugins/runtime/types-core.ts`
- `src/plugins/runtime/runtime-tasks.types.ts`

关键能力：

- plugin runtime 暴露 `api.runtime.tasks.runs`、`api.runtime.tasks.flows`、`api.runtime.tasks.managedFlows`。
- `runs.bindSession()` / `runs.fromToolContext()` 可读 `get/list/findLatest/resolve/cancel`。
- `flows.bindSession()` / `flows.fromToolContext()` 可读 `get/list/findLatest/resolve/getTaskSummary`。
- `runtime.taskFlow` 仍在，但已标记 deprecated，应优先用 `runtime.tasks.flows`。

OctoClaw 可用点：

- `task-state.json` 降级为 projection cache，不再是状态源。
- status/status panel 从 native runs/flows 派生。
- 只有真正多步 orchestration 才用 managed flow，不要为单次 child spawn 重造 flow。

### 2.4 Visible replies / message tool-only

源码：

- `src/plugin-sdk/channel-reply-pipeline.ts`
- `extensions/slack/src/monitor/message-handler/prepare.ts`
- `extensions/slack/src/monitor/message-handler/dispatch.ts`
- `docs/channels/groups.md`

关键能力：

- OpenClaw v2026.4.29 群/频道默认 `messages.groupChat.visibleReplies: "message_tool"`。
- tool-only 模式下，普通 final reply 不自动发到房间；只有 message tool 的显式发送可见。
- Slack handler 会把它解析成 `sourceRepliesAreToolOnly`，并据此关闭普通 auto reply 的 streaming/typing/status reaction 等可见反馈。

OctoClaw 可用点：

- 不要用 footer 或 NO_REPLY 技巧控制群聊可见性。
- “是否可见”交给 OpenClaw `visibleReplies`；OctoClaw 只决定是否显式 message send。
- ACK reaction 要理解 tool-only gate，见 2.5。

### 2.5 Slack native ackReaction / statusReaction / typingReaction

源码：

- `extensions/slack/src/actions.ts`
- `extensions/slack/src/monitor/message-handler/prepare.ts`
- `extensions/slack/src/monitor/message-handler/dispatch.ts`
- `extensions/slack/src/monitor/provider.ts`
- `src/channels/ack-reactions.ts`
- `docs/channels/slack.md`

关键能力和限制：

- `reactSlackMessage()` 调 Slack `client.reactions.add()`，所以 Slack 里真实可见，不是 Web UI only。
- `messages.ackReaction`、`channels.slack.ackReaction` 会被解析。
- 默认 `messages.ackReactionScope` 是 `group-mentions`：DM 默认不 ack，群/频道默认需要 mention gate。
- `messages.statusReactions.enabled !== false` 时，status reaction controller 会接管 queued/thinking/tool/done/error。
- `removeAckAfterReply` 会在回复后清理或恢复 reaction。
- 群/频道默认 `message_tool` 会导致 `sourceRepliesAreToolOnly`，auto ack/status/typing reaction 被压掉。
- Slack app 必须有 `reactions:write`。

OctoClaw 可用点：

- `OCTOCLAW_NATIVE_ACK_REACTION_MODE=auto`：复用 OpenClaw 原生 auto ACK，适合 DM 或 `visibleReplies: "automatic"` 的房间。
- `OCTOCLAW_NATIVE_ACK_REACTION_MODE=explicit`：在 tool-only 群/频道中，OctoClaw 用明确的 Slack message anchor 显式 reaction。
- `off`：完全关闭 reaction ACK。

验证原生 Slack ACK 的临时配置：

```json5
{
  messages: {
    ackReaction: "eyes",
    ackReactionScope: "all",
    removeAckAfterReply: false,
    statusReactions: { enabled: false },
    groupChat: { visibleReplies: "automatic" }
  }
}
```

这只是验证配置。生产不应为了 ACK 轻易把群/频道改成 `automatic`。

### 2.6 Plugin state / metadata store

源码：

- `src/plugins/runtime/types-core.ts`
- `src/plugins/registry.ts`
- `src/plugin-state/plugin-state-store.types.ts`
- `docs/plugins/sdk-runtime.md`
- `src/plugins/runtime/runtime-tasks.types.ts`
- `src/plugins/runtime/runtime-channel.ts`

关键能力与限制：

- plugin runtime 在 v2026.4.29 暴露 `api.runtime.state.openKeyedStore<T>()`，但 `src/plugins/registry.ts` 的 runtime proxy 明确限制为 bundled plugin；外部/workspace plugin 调用会抛出 `openKeyedStore is only available for bundled plugins in this release.`。
- `runtime.tasks.runs` / `runtime.tasks.flows` 可读 native run/flow 状态，并提供 run cancel。
- `runtime.channel` 暴露 reply/outbound/routing/reaction helper，可作为 IM delivery port 的上游。
- OpenClaw 没有原生保存 OctoClaw WorkContract、judge reason、route seal、model profile、IM anchor 的完整字段。

OctoClaw 可用点：

- 执行状态以 OpenClaw native runs/flows/subagent registry 为准。
- WorkContract、route seal、judge/replay、model policy、native refs、IM anchor、ACK receipts 继续放 OctoClaw metadata store。
- 如果只需要少量文件状态，可通过 `resolveStateDir()` 定位 state 目录，但必须 atomic write、schema version、corrupt quarantine。
- 如果需要关系查询、索引、迁移和审计，SQLite 需要保留，但命名和职责应从 `runtime-ledger` 收缩成 `OctoClawMetadataStore`。
- 不允许 metadata store 重新承载 scheduler、completion binding、delivery retry/outbox 等 runtime 职责。

建议保留字段：

| 类别 | 字段 |
| --- | --- |
| Contract | `workContractId`、`turnId`、`expectedDeliverable`、acceptance criteria |
| Decision | route seal、judge source/confidence/reason codes、abstain/degraded reason |
| Model policy | role、model profile、thinking、cost band、timeout budget |
| Native refs | `openclawRunId`、`openclawTaskId`、`openclawFlowId`、`childSessionKey` |
| IM anchor | channel/account/to/thread/message ts、ACK dedupe receipt |
| Replay | prompt packet hash、decision snapshot、dispatch/admission result |

## 3. 当前 OctoClaw 实现中的对应重轮子

源码位置：

- `extensions/octoclaw-runtime/src/tools/registration.ts`：`octoclaw_dispatch` 热路径、ticket、scheduler、runtime helper、subagent spawn、completion instruction 都集中在这里。
- `extensions/octoclaw-runtime/src/runtime-ledger/*`：SQLite ledger 里混合了 OctoClaw metadata、ticket、scheduler、completion binding、native reconcile；需要拆成 metadata store + legacy runtime 轮子。
- `extensions/octoclaw-runtime/src/delegate/child-finalizer.ts`：轮询 child completion file 并投递结果。
- `extensions/octoclaw-runtime/src/delivery/delivery-outbox.ts`：自建 completion/result 投递 outbox。
- `extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts`：发送消息走 `openclaw message send` CLI，解析 stdout/stderr；reaction 直接调 Slack Web API。
- `extensions/octoclaw-runtime/src/ack/*`：ACK timer、dedupe、route commit、execution transition notice。
- `extensions/octoclaw-runtime/src/extension-entry.ts`：注册 hooks、footer、policy state、ACK、watchdog、tool。
- `packages/octoclaw-policy/src/judge/judge-schema.ts` 和 `extensions/octoclaw-runtime/src/resolve/llm-judge.ts`：judge schema、normalizer、默认 confidence。
- `extensions/octoclaw-runtime/src/work-contract/builders.ts`：WorkContract id 和 semantic contract 构造。

已经确认的明显问题：

- `buildWorkContractFromPolicy()` 用 `stableId("wc", [sessionKey, userAsk])`，同一 session 重复同一句会撞 id。
- `buildAckKey()` 接收 `ackStage` 但 key 没包含 stage。
- `coerceJudgeOutput()` 在缺 `confidence` 时默认 `0.7`，会把弱输出变成看似可执行。
- `isActionableJudgeResult()` 只看 confidence，不看 `abstainReason`、degraded reason、新工作、expected deliverable。
- `buildSubagentSpawnMessage()` 强制 child 最后写 `octoclaw.worker_completion/v1` 文件，这和 OpenClaw native announce 重叠且不稳定。
- `dispatchSpawnEvidence()` 在缺显式 false 时，仅有 `childSessionKey` 也可能算 spawnExecuted，证据太松。
- Slack send 热路径 shell out CLI 并解析 stdout/stderr，失败面大且和 OpenClaw 原生 delivery route 脱节。
- footer 当前默认偏可见，生产会暴露 route/model/internal ids。

## 4. 目标架构

```text
inbound turn
  -> OpenClaw channel monitor / route / visibleReplies
  -> OpenClaw native ackReaction 或 OctoClaw explicit reaction
  -> OctoClaw deterministic precheck
  -> OctoClaw cheap judge normalizer
  -> WorkContract semantic seal
  -> OpenClaw native sessions_spawn via planner/confirm
  -> OpenClaw native run registry + announce delivery
  -> OctoClaw status projection / debug projection
```

职责边界：

| 层 | OctoClaw 保留 | 交给 OpenClaw |
| --- | --- | --- |
| route | judge/precheck/semantic seal | tool policy、channel source delivery mode |
| delegation | WorkContract、model/cost policy、spawn plan | sessions_spawn、run registry、subagent lane、announce |
| status | user-safe projection | native runs/flows truth |
| ACK | 策略、文案、explicit reaction fallback | native ack/status/typing reaction |
| delivery | 何时发、发什么 | target/thread/retry/fallback |
| debug | compact/debug footer | 不负责正常可见性 |

## 5. Phase 0：先修 guardrail，不改大架构

目标：不引入 planner path，也先减少误判、重复、泄露。

### 5.1 WorkContract ID 不再撞

文件：

- `extensions/octoclaw-runtime/src/work-contract/builders.ts`
- `extensions/octoclaw-runtime/src/work-contract/builders.test.ts`

当前：

```ts
const workContractId = stableId("wc", [sessionKey, userAsk]);
```

改法：

- 生成 id 时加入 `turnId`、message anchor、routeSealId，或直接用 UUID。
- 推荐：`turnId` 先确定，再用 `stableId("wc", [sessionKey, turnId, decision.routeSealId ?? "", userAsk])`。
- 如果缺 message anchor，至少加 `Date.now()` 生成的 turn id 或 `randomUUID()`。

验收：

- 同一 session 连续两次相同 userAsk 生成不同 `workContractId`。
- replay/status 查询仍可通过 `turnId` 和 native refs 找到对应合同。

### 5.2 ACK dedupe key 加 stage

文件：

- `extensions/octoclaw-runtime/src/ack/ack-dedupe.ts`
- `extensions/octoclaw-runtime/src/ack/ack-guard.test.ts`

当前：

```ts
return `ack:${parts.threadId}:${parts.anchorId ?? "none"}:${parts.routePhase}:${parts.messageTurnId}`;
```

改法二选一：

1. 删除 tier ACK，只保留 reaction ACK0、slow text ACK、delegate accepted ACK、terminal/progress notice。
2. 如果保留 tier，key 必须包含 stage/kind/surface/target：

```text
ack:<surface>:<target>:<thread>:<anchor>:<turn>:<routePhase>:<ackStage>
```

验收：

- ACK0 不会误去重 delegate accepted ACK。
- tier1/tier2 若保留，不会互相吃掉。
- 同一 Slack 队列里不同 message id 的 reaction ACK 不互相去重。

### 5.3 Judge normalizer 收紧

文件：

- `packages/octoclaw-policy/src/judge/judge-schema.ts`
- `extensions/octoclaw-runtime/src/resolve/llm-judge.ts`

当前风险：

- 缺 confidence 默认 `0.7`。
- `isActionableJudgeResult()` 不看 `abstainReason`。
- delegate 缺 `is_new_work` / `expected_deliverable` 只是 degraded，但热路径仍可能误用。

改法：

- `coerceJudgeOutput()` 缺 `confidence` 时设为 `0` 或最多 `0.5`，并写 degraded reason。
- `isActionableJudgeResult()` 加：
  - `abstainReason` 非空则 false。
  - `judge_schema_degraded` 且 route=delegate 则 false。
  - route=delegate 必须 `is_new_work === true`。
  - route=delegate 必须有非空 `expected_deliverable`。
- `ackText` 不再进入用户可见 ACK，只保留 replay/eval。

验收：

- malformed/missing confidence judge 输出不会触发 delegate。
- 带 abstainReason 的结果不可 actionable。
- delegate 缺 expected deliverable 不会 spawn。

注意：实施前先看 `judge-schema.ts` 是否有本地未提交改动；如果有，先合并现有改动，再收紧 validator，避免把别的改动覆盖掉。

### 5.4 Footer 默认关闭

文件：

- `extensions/octoclaw-runtime/src/extension-entry.ts`
- `extensions/octoclaw-runtime/src/im/projection-footer.ts`
- `extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts`
- `extensions/octoclaw-runtime/src/extension-entry.test.ts`

新增配置：

```text
OCTOCLAW_PROJECTION_FOOTER_MODE=off|compact|debug
```

语义：

- `off`：默认，不追加 footer。
- `compact`：只在显式启用时追加 `route`、`model`、可选 `thread`。
- `debug`：仅本地/验收，允许 `via`、`workContractId`、judge source、native ids。

验收：

- 默认生产回复无 footer。
- `NO_REPLY`、ACK、delegate accepted ACK 永不追加 footer。
- debug footer 不重复追加。

### 5.5 停止过早 delegate ACK

文件：

- `extensions/octoclaw-runtime/src/ack/ack-route-commit.ts`
- `extensions/octoclaw-runtime/src/ack/execution-transition-notifier.ts`
- `extensions/octoclaw-runtime/src/tools/registration.ts`

改法：

- route=delegate 只是候选时，不发“已委派”。
- 原生 `sessions_spawn` 返回 accepted 且 `octoclaw_dispatch_confirm` 校验 `runId` 后，才发 delegate accepted ACK。
- spawn failed 时发一条诚实失败/降级说明，不伪装成已派发。

验收：

- judge=delegate 但 spawn 失败时，用户不会看到“已交给子 agent”。
- `sessions_spawn` accepted 且 confirm 成功后才出现 delegate ACK。

## 6. Phase 1：0.5.0 `sessions_spawn` planner/confirm path

目标：用 OpenClaw 原生 `sessions_spawn` 作为执行主路径，但不要求 plugin SDK 先暴露 direct spawn API。OctoClaw 在 0.5.0 中实现 planner/confirm 硬协议：OctoClaw 负责 admission 和 spawn plan，主 agent 调原生 `sessions_spawn`，OctoClaw confirm 后写 native refs 和发 ACK。legacy runtime 只做回滚 fallback。

### 6.1 Feature flags

新增：

```text
OCTOCLAW_SPAWN_BACKEND=planner|legacy|off
OCTOCLAW_PLANNER_ALLOWLIST=workspace/session/user allowlist
OCTOCLAW_SPAWN_INTENT_TTL_MS=60000
OCTOCLAW_LEGACY_RUNTIME_LEDGER=on|read_only|off
OCTOCLAW_LEGACY_COMPLETION_FILE=0|1
OCTOCLAW_DISABLE_CHILD_FINALIZER=0|1
OCTOCLAW_DISABLE_DELIVERY_OUTBOX=0|1
```

推荐默认：

- 开发：`OCTOCLAW_SPAWN_BACKEND=planner`，legacy ledger `read_only`。
- 生产灰度：只对 allowlist workspace/session/user 开启 planner。
- planner 稳定后：legacy ledger `off`，child-finalizer/outbox 默认 disabled。
- `api.runtime.subagent.run()` 不作为 0.5.0 主路径；未来如果 OpenClaw 暴露完整 direct SDK spawn API，再新增 `OCTOCLAW_SPAWN_BACKEND=direct`。

### 6.2 新增 NativeSpawnIntent store

建议文件：

- `extensions/octoclaw-runtime/src/delegate/native-spawn-intent.ts`
- `extensions/octoclaw-runtime/src/delegate/native-spawn-intent-store.ts`
- `extensions/octoclaw-runtime/src/delegate/native-spawn-intent.test.ts`

接口：

```ts
type NativeSpawnIntentStatus =
  | "planned"
  | "spawn_call_started"
  | "accepted"
  | "failed"
  | "expired";

interface NativeSpawnIntent {
  spawnIntentId: string;
  workContractId: string;
  sessionKey: string;
  planHash: string;
  status: NativeSpawnIntentStatus;
  sessionsSpawnArgs: SessionsSpawnArgs;
  createdAt: number;
  expiresAt: number;
  confirmedAt?: number;
  openclawRunId?: string;
  childSessionKey?: string;
  error?: string;
}
```

存储口径：

- SQLite metadata store 可以保留这张表，因为它需要 TTL、幂等和审计。
- intent 不是执行状态真相；执行真相仍是 OpenClaw native registry / `runtime.tasks.runs`。
- intent 的 `planHash` 用 canonical JSON 计算，必须覆盖所有将传给 `sessions_spawn` 的字段。

状态机：

- `planned -> spawn_call_started`：只能由 `before_tool_call` 在 `sessions_spawn` args hash、session、TTL 全部匹配时推进。
- `spawn_call_started -> accepted`：只能由 `octoclaw_dispatch_confirm` 在 `sessionsSpawnStatus=accepted` 且 `runId` 非空时推进。
- `planned|spawn_call_started -> failed`：原生 spawn 返回 error、confirm 参数缺失、workContract 不匹配、重复确认不同 runId。
- `planned|spawn_call_started -> expired`：超过 `OCTOCLAW_SPAWN_INTENT_TTL_MS` 还没有 accepted confirm。
- `accepted` 是终态；重复 confirm 同一 `runId` 返回幂等 success，不同 `runId` 返回 conflict。

注意：intent 状态不是任务运行状态。UI/status projection 不能根据 intent 推进 running/succeeded/failed，只能用 `openclawRunId` 查询 OpenClaw native runs/flows/subagent registry。

### 6.3 `octoclaw_dispatch` planner 输出

在 `OCTOCLAW_SPAWN_BACKEND=planner` 且 admission 通过时，`octoclaw_dispatch` 不再 spawn，不写 running，不发“已委派”，只返回极短 JSON：

```json
{
  "status": "requires_native_spawn",
  "route": "delegate",
  "spawnIntentId": "nsp_...",
  "workContractId": "wc_...",
  "nextTool": "sessions_spawn",
  "confirmTool": "octoclaw_dispatch_confirm",
  "sessionsSpawnArgs": {
    "task": "...compact task packet...",
    "label": "OctoClaw delegated task",
    "runtime": "subagent",
    "agentId": "main",
    "model": "zhipu/GLM-5.1",
    "thinking": "medium",
    "runTimeoutSeconds": 600,
    "mode": "run",
    "cleanup": "keep",
    "context": "isolated",
    "lightContext": true
  }
}
```

上下文污染控制：

- 不返回完整 policy decision、judge packet、ledger、route stack。
- planner/native 的主 agent 可以看到当前 OpenClaw run 的完整运行上下文，但 child 默认不继承完整 parent transcript。
- `sessionsSpawnArgs` 默认使用 `context="isolated"` 和 `lightContext=true`；只有 child 确实需要 requester transcript 时才允许显式 `context="fork"`。
- `sessionsSpawnArgs.task` 只放用户目标、expected deliverable、必要上下文引用，目标 800-1500 字以内。
- 大上下文优先用 attachment、workspace reference 或 artifact ref，不塞进主 agent tool result，也不把 raw child transcript 回灌到 parent。
- 返回文本明确要求主 agent 下一步调用 `sessions_spawn`，然后调用 confirm；不要对用户声称已委派。
- before_dispatch fast delegate 的上下文更窄，只能使用 inbound message、Slack/session/thread anchor、policyState/runtime ledger、recent receipts 和 compact summary；强上下文依赖、状态/来源追问、缺 deliverable 的请求必须 pass-through。

### 6.4 `before_tool_call` gate `sessions_spawn`

文件：

- `extensions/octoclaw-runtime/src/extension-entry.ts`
- `extensions/octoclaw-runtime/src/delegate/native-spawn-gate.ts`
- `extensions/octoclaw-runtime/src/delegate/native-spawn-gate.test.ts`

规则：

- 如果 tool 是 `sessions_spawn`，必须存在当前 session 未过期的 pending `NativeSpawnIntent`。
- `sessions_spawn` gate 不能依赖普通 `hook_interface.before_tool_call.enabled`；只要 OpenClaw 对 native `sessions_spawn` 触发了 `before_tool_call` lifecycle，planner mode 就必须先执行 intent gate，再决定是否进入其他 hook 逻辑。
- `sessions_spawn` args canonical hash 必须等于 intent `planHash`。
- 匹配后允许调用，并把 intent 状态改成 `spawn_call_started`。
- 不匹配时阻止调用，返回“先走 `octoclaw_dispatch`”或“spawn plan 已过期/不匹配”。
- status/provenance/execution follow-up 不允许创建 spawn intent，也不允许调用 `sessions_spawn`。

验收：

- 主 agent 不能绕过 OctoClaw policy 直接 `sessions_spawn`。
- 主 agent 不能篡改 model/agentId/task 后调用 `sessions_spawn`。
- intent 过期后不能再 spawn。

### 6.5 新增 `octoclaw_dispatch_confirm`

建议文件：

- `extensions/octoclaw-runtime/src/tools/dispatch-confirm-tool.ts`
- `extensions/octoclaw-runtime/src/delegate/native-spawn-confirm.ts`
- `extensions/octoclaw-runtime/src/delegate/native-spawn-confirm.test.ts`

参数：

```ts
interface DispatchConfirmInput {
  spawnIntentId: string;
  workContractId: string;
  sessionsSpawnStatus: "accepted" | "error";
  runId?: string;
  childSessionKey?: string;
  error?: string;
}
```

规则：

- intent 必须存在、未过期、未确认，且状态必须为 `spawn_call_started`。不能为了绕过 `invalid_status:planned` 允许 confirm 从 `planned -> accepted`，否则会失去 `sessions_spawn` gate 的安全边界。
- `workContractId` 必须匹配。
- `sessionsSpawnStatus=accepted` 时必须有 `runId`；只有 `childSessionKey` 不算成功。
- confirm 成功后写 WorkContract native refs：`openclawRunId`、`childSessionKey`、`spawnBackend: "sessions_spawn_planner"`。
- confirm 成功后才发 delegate accepted ACK。
- 重复 confirm 同一 `spawnIntentId + runId` 返回幂等 success，不重复发 ACK。
- 重复 confirm 但 `runId` 不同返回 conflict，并保留第一次 accepted refs。
- `sessionsSpawnStatus=error` 时记录失败，不发“已委派”，返回诚实失败/降级说明。

确认返回必须短：

```json
{
  "status": "accepted",
  "workContractId": "wc_...",
  "runId": "run_...",
  "userVisibleAckSent": true
}
```

### 6.6 参数映射

| OctoClaw 输入 | `sessions_spawn` 参数 |
| --- | --- |
| WorkContract title / expected deliverable | `task` |
| delegate role | `agentId` 或 `label` |
| model/cost policy | `model` |
| complexity / quality | `thinking`、`runTimeoutSeconds` |
| cheap independent work | `lightContext: true` |
| one-shot child | `mode: "run"`, `cleanup: "keep"` 初期保守 |
| persistent follow-up | 只有 channel 支持 thread binding 时用 `thread: true`, `mode: "session"` |

不要传：

- `target`
- `channel`
- `to`
- `threadId`
- `replyTo`
- `transport`

OpenClaw `sessions_spawn` 源码会拒绝这些参数。投递由 native requester origin / delivery/handoff 处理。

### 6.7 planner path 下线 completion file 协议

当前文件：

- `extensions/octoclaw-runtime/src/tools/registration.ts` 的 `buildSubagentSpawnMessage()`
- `extensions/octoclaw-runtime/src/delegate/child-finalizer.ts`
- `extensions/octoclaw-runtime/src/runtime-ledger/completion-binding.ts`

改法：

- planner path 不调用 `buildSubagentSpawnMessage()`，不要求 child 写 `.completion.json`。
- child 只需要正常完成任务，让 OpenClaw native announce/handoff 捕获结果。
- child/native announce final 或未来 fast_delegate final 应直接投递给用户；主 agent 不读完整 child result、不二次转述，只保留 compact receipt、result hash、短摘要和 artifact refs。
- 如果必须结构化结果，让 child final reply 包含短 JSON block 或 artifact，但不要把“写文件”作为完成协议。
- 后续用户明确要求证据、细节或完整报告时，主 agent 才按需 reopen artifact/ref；默认 follow-up 不把完整 child transcript 塞进上下文。
- legacy path 需要 completion file 时必须显式 `OCTOCLAW_LEGACY_COMPLETION_FILE=1`。

验收：

- planner spawn 后没有 `.completion.json` 文件也能完成回传。
- `child-finalizer.ts` 在 planner path 不启动。
- `completion-binding` 在 planner path 没有新记录。
- native run 完成时 OctoClaw 不重复发送 final message。

### 6.8 WorkContract 保存 native refs

文件：

- `packages/octoclaw-contracts/src/work-contract.ts`
- `extensions/octoclaw-runtime/src/work-contract/store.ts`
- `extensions/octoclaw-runtime/src/work-contract/projectors.ts`

建议字段：

```ts
interface WorkContractNativeRefs {
  openclawRunId?: string;
  openclawTaskId?: string;
  openclawFlowId?: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
  spawnIntentId?: string;
  spawnBackend?: "sessions_spawn_planner" | "legacy" | "direct";
  spawnMode?: "run" | "session";
}
```

验收：

- confirm accepted 后 WorkContract 能查到 `openclawRunId` 和可用的 `childSessionKey`。
- status projection 不从 WorkContract 推进状态，只用 native refs 查询 native truth。

### 6.9 Planner/confirm 验收用例

这些用例需要作为 0.5.0 的核心回归集：

- `octoclaw_dispatch` 在 planner mode 返回 `requires_native_spawn`，不直接调用 legacy spawn，不发 delegate ACK。
- 没有 pending intent 时，主 agent 调 `sessions_spawn` 被 `before_tool_call` 阻止。
- pending intent 过期时，`sessions_spawn` 被阻止，并提示重新 dispatch。
- `sessions_spawn` args hash 不匹配时被阻止，尤其是 model、agentId、task、runTimeoutSeconds 被主模型改写的情况。
- `sessions_spawn` accepted 但 confirm 缺 `runId` 时失败，不写 native refs，不发 ACK。
- confirm 成功后只写一次 native refs，重复 confirm 同一 `runId` 幂等，不重复 ACK。
- confirm 成功后 child completion 不写 `.completion.json`，也能通过 OpenClaw native announce/handoff 回到 requester。
- legacy backend 开启时仍能走旧路径，但 planner allowlist 内不启动 scheduler/finalizer/outbox。

## 7. Phase 2：状态投影切到 native runs/flows

目标：OpenClaw native registry 是执行状态权威。

### 7.1 新增 native status projector

建议文件：

- `extensions/octoclaw-runtime/src/state/native-status-projector.ts`
- `extensions/octoclaw-runtime/src/state/native-status-projector.test.ts`

输入：

- `sessionKey`
- `workContractId`
- `openclawRunId` / `openclawTaskId` / `openclawFlowId`
- `childSessionKey`

读取顺序：

1. `api.runtime.tasks.runs.fromToolContext(ctx).resolve(openclawRunId)`。
2. `api.runtime.tasks.flows.fromToolContext(ctx).resolve(openclawFlowId)`。
3. `findLatest()` 作为 fallback，只用于 status UI，不用于执行授权。
4. `task-state.json` projection cache 只做显示缓存，不作 truth。

状态映射：

| Native | OctoClaw projection |
| --- | --- |
| queued | queued |
| running | running |
| completed/succeeded | succeeded |
| failed | failed |
| timed_out | timed_out |
| cancelled/canceled | cancelled |
| missing but child run known | unknown/lost，不自动补成功 |

验收：

- 重启后可通过 native run/flow 查到最近任务。
- `task-state.json` 损坏时，status 不显示“没有任务”，而是 native fallback 或 degraded state。
- 没有 native id 的 legacy 任务明确标记 legacy/degraded。

## 8. Phase 3：ACK 重构

目标：ACK 只表达真实事实，不和正式回复竞争。

### 8.1 ACK 模式

新增：

```text
OCTOCLAW_NATIVE_ACK_REACTION_MODE=auto|explicit|off
OCTOCLAW_TEXT_ACK_DELAY_MS=2500
```

语义：

- `auto`：依赖 OpenClaw 原生 `ackReaction` / `typingReaction` / `statusReactions`。
- `explicit`：OctoClaw 在需要时用 Slack message anchor 显式 reaction，适合 group `message_tool` 场景。
- `off`：不发 reaction。

### 8.2 Slack auto ACK 适用条件

OpenClaw 原生 auto ACK 需要：

- `messages.ackReaction` 或 `channels.slack.ackReaction` 非空。
- `messages.ackReactionScope` 覆盖当前 chat type。
- Slack app 有 `reactions:write`。
- 当前不是 `sourceRepliesAreToolOnly`，或者宿主版本未来放开该 gate。
- `removeAckAfterReply` 没有太快清理，或者测试时关闭。

### 8.3 Slack explicit ACK 条件

仅在这些条件成立时发 explicit reaction：

- inbound metadata 有原始 Slack `channel` 和 `message.ts`。
- 当前 turn 确认会处理，不是被 mention gate/drop 掉。
- 没有已经由 OpenClaw native auto ACK 处理。
- dedupe key 包含 channel/message.ts/turn/stage。

当前 `SlackAdapter.react()` 已经可直接调 `reactions.add`，可以保留为 explicit reaction backend；但它应使用明确 message anchor，不要从 session key 猜 thread。

### 8.4 Slow text ACK

只在 reply route 且满足全部条件时发：

- 已超过 `OCTOCLAW_TEXT_ACK_DELAY_MS`。
- 没有 first token。
- 没有 visible reply。
- 没有 native delivery pending。
- 没有 reaction ACK 成功或已尝试。

delegate route 不发 reply-style slow ACK。delegate 的可见 ACK 等 `sessions_spawn` accepted + confirm。

### 8.5 Delegate accepted ACK

触发条件：

- WorkContract sealed。
- native spawn 返回 accepted。
- `octoclaw_dispatch_confirm` 已校验非空 `runId`；native task id 可作为辅助证据，但不能替代 `runId`。

推荐文案：

```text
已交给子 agent 处理，完成后会回到这个线程。
```

可选 compact id：短 task label，不展示完整 model/workContract/debug。

验收：

- 快速主回复无文本 ACK。
- 慢主回复最多一条文本 ACK。
- reaction ACK 失败不补文本 ACK0，避免重复噪声。
- delegate accepted ACK 不早于 `sessions_spawn` accepted + confirm。

## 9. Phase 4：footer 改为 debug projection

目标：footer 不再承担路由解释、状态证明、ACK 或可见性控制。

### 9.1 已复现的 native announce footer 误判

2026-05-02 macmini 真实 Slack planner smoke 已复现：planner/native spawn 成功，SQLite `native_spawn_intents` 和 WorkContract 都有 accepted native refs，但最终 Slack footer 仍显示 `route=reply | ... | via=policy`。这不是 spawn 没成功，而是 native child 完成后 OpenClaw 通过 `subagent_announce` 把结果送回 parent session，parent 再发用户可见最终回复；这个 parent delivery turn 会重新走一轮 reply route，当前 footer 只看最新 parent policy route，于是把“由子 agent 产出的最终交付”误标成 `reply`。

修复原则：

- footer 是 projection，不是执行 truth；但 debug footer 不能和已确认 native refs 矛盾。
- 对同一 parent thread，只要存在 accepted `NativeSpawnIntent`、WorkContract `nativeSpawnRefs.openclawRunId`、`childSessionKey`、或 OpenClaw `subagent_announce` provenance，最终可见回复应投影为 `route=delegate`。
- `via` 应显示 `subagent` 或 `native_announce`；如果只是普通 direct reply，才显示 `reply/policy/judge`。
- 最新 parent turn 的 `route=reply` 只能说明“parent 正在把 child result 改写成交付回复”，不能覆盖原任务的 delegate provenance。
- 缺失 native refs 或无法绑定到同一 thread 时，footer 可以保守显示 `reply`，但必须写 debug/replay reason，避免静默误判。

实现：

- `OCTOCLAW_PROJECTION_FOOTER_MODE=off` 为默认。
- `compact` 只显示 `route/model/thread`。
- `debug` 显示 `via/workContractId/native ids/judge source`。
- `renderSlackProjectionFooter()` 保留去重，但受 mode 控制。
- `before_message_write` fallback footer 默认禁用。
- `appendReplyProjectionFooter()` 或其 successor 在计算 route 前，先用 thread/session/workContractId 查 accepted native refs 和 child announce provenance。
- footer route 优先级：`accepted native refs / child announce provenance` > `WorkContract route` > `current policy route_decision` > fallback `reply`。
- debug 模式至少展示短 `workContractId`、`runId` 或 `childSessionKey` 的短 id，便于从 Slack 验收反查 SQLite/WorkContract。

验收：

- 默认 Slack 最终回复没有 `route=... | model=...`。
- debug 模式能显示 route/model/native refs。
- native child final 在 debug 模式显示 `route=delegate | ... | via=subagent` 或 `via=native_announce`，不能显示 `route=reply | via=policy`。
- 同一 thread 后续普通追问如果不是 child result delivery，可以显示 `route=reply`，但不得污染上一次 child final 的 footer。
- ACK、NO_REPLY、delegate accepted ACK 不追加 footer。

## 10. Phase 5：Judge 简化为 router/admission signal

目标：judge 是便宜、结构化、可回放的分类器，不是执行授权器。热路径不要做 local LLM + remote LLM 串行；应做确定性 precheck，只有不确定时才调用一个 cheap LLM judge。remote judge 只做 shadow/eval/offline calibration。

### 10.1 推荐输出

```json
{
  "route": "reply",
  "reply_mode": "answer",
  "delegate_role": null,
  "is_new_work": false,
  "expected_deliverable": null,
  "complexity": "simple",
  "duration_hint": "short",
  "tool_need_hint": "none",
  "confidence": 0.82,
  "abstain_reason": null,
  "reason_codes": []
}
```

删除或降级：

- `ackText`：不进入用户可见路径。
- 太细的 route/source/debug 字段：放 replay，不参与 hot path。
- remote judge escalation：非必要先关掉，避免关键路径变长。

### 10.2 热路径流程

```text
deterministic precheck
  -> 能确定 reply/status/execution_followup/delegate candidate 就直接返回
  -> 不确定才调用 cheap LLM judge
  -> cheap judge timeout/失败则 reply fallback，并允许主模型纠正
  -> normalizer/admission
  -> WorkContract seal
```

admission 规则：

- confidence < minConfidence：reply fallback。
- abstainReason 非空：reply fallback。
- delegate 缺 `is_new_work === true`：reply/status fallback。
- delegate 缺 expected deliverable：reply/clarify fallback。
- execution_followup：禁止 spawn，只允许回答状态/结果/失败原因。

主模型纠正规则：

- judge=reply，但主模型发现需要长工具/执行，可提交 route hint 或调用 OctoClaw 委派入口。
- judge=delegate，但主模型能直接答，可以直接答；前提是还没 native spawn。
- 主模型不能靠自然语言声称“已委派”；必须等 `octoclaw_dispatch_confirm` 确认原生 `sessions_spawn` accepted/runId。
- spawn 永远需要 `is_new_work=true`、非空 `expected_deliverable`、WorkContract/admission 通过。

验收：

- 用户问“刚才那个任务怎么样了”不会重新 spawn。
- judge timeout 有 deterministic fallback。
- cheap judge 失败不会阻塞主 agent 长时间无回应。
- remote judge 不进入热路径。

### 10.3 委派判定规则和主线程预算

0.5.0 的路由目标从“尽量委派”改成“短任务 main fast path，长任务 delegate 不堵”。委派规则必须显式计入 native spawn 冷启动成本：如果一个任务主 agent 在固定 30s main execution budget 内能用当前上下文或一次轻量只读工具完成，delegate 反而会伤害体验。这里的 30s 是 soft runtime budget，不是用户可见端到端 SLA，也不是强抢占 deadline。

这个优化不能实现成“保守到几乎不委派”。正确形态是三段式：

- `must_reply/main_fast_path`：当前上下文或一次轻量只读工具可完成，且无写操作、无长命令、无多步研究。
- `must_delegate`：有硬委派信号，例如用户明确要求子 agent/后台/并行、代码修改/测试/构建、多步工具、大量上下文阅读、review/验证，或明显无法放进固定 30s main execution budget。
- `budgeted_main_then_delegate`：中间地带先让主 agent 在固定 30s soft runtime budget 内尝试；预算超限后进入升级待执行状态，或出现写操作/长命令/第二轮以上真实工具时转 `octoclaw_dispatch`。

rule、local judge、cheap LLM judge 和 prompt 注入必须统一为“judge 两档 route + runtime 成本派生三档”的语义；只改 rule 或只改 prompt 都会导致路由抖动。尤其是 `fresh_live_lookup`、`conversation_control.route_hint=delegate`、`fast_first_response` 这些旧信号需要降级，但不能覆盖 `must_delegate` 硬信号。

默认主 agent 处理：

- 当前上下文能直接回答。
- 简单解释、总结、翻译、改写、判断。
- 状态/来源/“刚才发生了什么”能从 native state、WorkContract refs、SQLite/replay 回答。
- 需要澄清 scope、目标、验收标准。
- 简单版本/状态/配置查询，且可以用一次只读工具或 native status 完成。
- `fresh_live_lookup` 但目标明确、结果短、预计 30 秒内能完成。
- `duration_hint=short`、`tool_need_hint=none`、`scope=local|unknown`、`evidence_required=false`，并且 judge 对 `route=reply` 高置信。

默认委派子 agent：

- 明显无法放进固定 30s main execution budget，或者用户明确接受后台等待。
- 需要代码/文件修改、测试、构建、日志排查、环境探测、长时间命令。
- 需要多步工具链，或者真实工具调用可能超过 1-2 次。
- 需要大量上下文阅读，容易污染主 agent 上下文。
- 可以并行处理，或可拆分给多个 worker。
- 用户明确要求后台、子 agent、并行、不要阻塞、用便宜模型。
- quality/risk 要求隔离执行，例如 review、验证、回归测试。

中间地带用预算控制：

```text
main_fast_path:
  maxWallMs: 30000
  maxToolCalls: 1-2
  allowReadOnlyNativeStatus: true
  allowOneFreshLookup: true
  allowWorkspaceProbe: read-only only
  forbidMutation: true
```

预算计时起点是 `before_prompt_build` 完成、三段式 route/judge bucket 已确定为 `budgeted_main_then_delegate`、主 agent 即将拿到包含 OctoClaw route hint 的 prompt。计时不包含 Slack event、OpenClaw startup、tool bundle、prompt build 或 judge 前置耗时；这些仍通过 `visibleElapsedMs` 单独观测。

30s 到点不是强抢占。如果 OpenClaw/模型运行中没有可靠中断和重新注入能力，OctoClaw 只记录 `budgeted_main_escalated_pending`，不 kill main agent，不 direct spawn，也不发送“任务已启动”。之后的可控边界按以下规则处理：

- main agent 已经产出 final reply：允许正常投递，记录 `budgeted_main_completed_late`，不额外 spawn。
- main agent 下一步要调用普通工具，尤其写操作、长命令、多步工具、测试/build/review/validation：拦截或改写为 `octoclaw_dispatch`，记录 `budgeted_main_escalated`。
- runtime 有下一次 prompt 注入点：注入 route hint，要求本轮停止继续分析并调用 `octoclaw_dispatch`。
- runtime 没有可控边界：只保留 `budgeted_main_escalated_pending`，等下一边界升级。

超预算升级只能进入现有 native planner 链路：`octoclaw_dispatch -> sessions_spawn -> octoclaw_dispatch_confirm`。不能直接调用内部 spawn，不能直接调用 OpenClaw SDK spawn 作为主路径，不能提前发 accepted ACK；“任务已启动”只能在 `sessions_spawn` 返回 accepted 且 `octoclaw_dispatch_confirm` 成功后发送。

需要降级的旧规则：

- `fresh_live_lookup -> delegate` 不再是硬规则；改成 main fast path first。
- `conversation_control.route_hint=delegate` 不能单独强制 delegate；必须同时有 long duration、required tools、explicit delegate、code/test/edit、并行收益等硬信号。
- `fast_first_response` 不再作为 delegate reason code；现在 delegate 不保证更快，只保证不堵主 agent、隔离上下文、可并行、可降成本。
- status/provenance/execution follow-up 永不 spawn；缺证据时诚实回答“没有可验证记录”。

judge 输出要求：

- `route`: 只允许 `reply` 或 `delegate`。judge 不直接决定 SR-P1 三档 bucket。
- `confidence` / `route_confidence`: 低置信 `reply` 不再强行算 `must_reply`，runtime 会派生为 budgeted main。
- `duration_hint`、`tool_need_hint`、`scope`、`evidence_required`、`reason_codes`: 作为 runtime 派生 `decision_bucket` 和 replay 验收依据。
- `decision_bucket`、`startup_cost_policy`、`hard_delegate_signal`: 可记录为 telemetry，但 runtime 不把 judge 给出的 `decision_bucket` 当权威。

验收：

- 简单查版本/状态、单步查证、来源追问不进入 `octoclaw_dispatch`。
- 用户显式要求后台/子 agent、代码修改/测试、多步工具、review/验证仍进入 delegate；新增 false-reply fixture 防止调过头。
- route replay 记录 main fast path 预算和是否超限。
- false delegate rate 在 nightly/Slack smoke 中可见并下降。
- false reply rate 在 nightly/Slack smoke 中可见且不能上升到影响长任务体验。
- 主模型仍可在预算超限后用 route hint/dispatch 转委派。

### 10.4 AGENTS.md / prompt 注入

AGENTS.md 或 system prompt 注入只放短规则，不放完整 judge rubric：

```text
优先直接回答当前上下文能完成的问题。
短任务、简单查证、状态/来源追问默认由主 agent 处理；不要为了查状态或来源启动子 agent。
如果一次轻量只读工具或 native status 能在 30 秒 main execution budget 内完成，可以走主线程 fast path。
如果需要长时间工具执行、代码/文件/环境操作、测试、研究、多步验证、并行处理，使用 octoclaw_dispatch 委派。
不要直接调用 sessions_spawn 绕过 OctoClaw policy。
不要声称已委派，除非 `octoclaw_dispatch_confirm` 已确认原生 `sessions_spawn` 返回 accepted/runId。
状态/来源问题优先用 octoclaw_status/native state 回答，不要重新 spawn。
```

prompt 只负责引导模型，最终副作用仍由 admission、spawn intent gate 和 dispatch confirm 硬校验。

### 10.5 Gate 瘦身清单

可以删除或降级：

- 自建 scheduler queue：交给 OpenClaw native lane/maxChildren/maxDepth。
- completion binding / child-finalizer：交给 native announce。
- delivery outbox：交给 native delivery retry。
- 每轮强制 route hint：只在 judge 不确定或主模型纠正时需要。
- `block_tool_patterns` 扫 params：改成 tool name allow/deny + WorkContract admission。
- 多层 tier ACK / route commit ACK：收敛到 reaction、slow text、confirm accepted ACK。
- observer/session control 特殊分支：尽量合并成 `reply + allowed control tools`。

必须保留：

- status/provenance follow-up 禁止 spawn。
- 没有 `expected_deliverable` 禁止 spawn。
- 没有原生 `sessions_spawn` accepted + confirm runId 不算已委派。
- sandbox、allowedAgents、maxDepth、maxChildren 使用 OpenClaw 原生。
- shared workspace 写冲突保护。
- idempotency / dedupe。

## 11. Phase 6：Slack delivery 切到原生 route/port

目标：只把 OctoClaw 自己发出的 Slack 热路径从 shell out `openclaw message send` 和 stdout/stderr 解析中移出来。普通 main agent final reply 先继续交给 OpenClaw 原生 Slack delivery，OctoClaw 只通过 hook 做 footer projection；不要在本 slice 抢管所有 Slack 回复。

设计保持 channel-neutral，但 0.5.x immediate 只实现 Slack。Feishu、WeChat 和其他 IM 继续走现有 fallback，不做迁移。这个 port 也不要做成新的 broker/outbox/state machine；它只是同步、有界 timeout、可观测的 delivery primitive。

当前风险文件：

- `extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts`
- `extensions/octoclaw-runtime/src/im/send.ts`
- `extensions/octoclaw-runtime/src/delivery/delivery-outbox.ts`
- Slack acceptance/nightly harness 和 report parser

改法：

1. 抽一个轻量 `MessageDeliveryEnvelope` / `MessageDeliveryPort`，接口命名保持 IM 通用，但第一实现只注册 Slack：

```ts
type MessageDeliveryKind =
  | "neutral_ack"
  | "accepted_ack"
  | "native_child_final"
  | "status_reply"
  | "legacy_fallback";

interface MessageDeliveryEnvelope {
  kind: MessageDeliveryKind;
  channel: "slack" | string;
  target: {
    to?: string;
    channelId?: string;
    threadTs?: string;
    replyToMessageId?: string;
    source: "delivery_context" | "inbound_anchor" | "event_metadata" | "session_fallback";
  };
  content: string;
  provenance?: {
    route?: "reply" | "delegate";
    via?: string;
    workContractId?: string;
    runId?: string;
    childSessionKey?: string;
  };
  footerMode?: "off" | "debug";
  dedupeKey?: string;
}

interface MessageDeliveryPort {
  sendText(envelope: MessageDeliveryEnvelope): Promise<{ ok: boolean; messageId?: string; threadTs?: string; error?: string }>;
  react?(envelope: MessageDeliveryEnvelope & { emoji: string }): Promise<{ ok: boolean; error?: string }>;
}
```

2. 第一阶段只接管 OctoClaw 自己发出的可见包：neutral ACK 的文字 fallback、delegate accepted ACK、native announce child final、status/provenance follow-up、legacy fallback。普通 main agent final reply 继续交给 OpenClaw 原生 Slack delivery；OctoClaw 只在 `message_sending` / `before_message_write` hook 做 footer projection。
3. Slack footer 只能从 envelope/provenance 或 accepted native refs 渲染；不要再用最近 policyState、session key、正文 regex 去猜 child final 的 route/via。
4. Slack target 优先级固定为 delivery context > inbound `channel/message.ts/thread_ts` anchor > event metadata > session fallback；`message_received` 没有原始 anchor 时 fail closed 或只记录 observed，不用 history 猜。
5. Slack backend 优先使用公开稳定的 OpenClaw channel delivery API；如果当前版本没有足够 API，就直接用 Slack Web API backend，并借鉴 OpenClaw Slack `sendMessageSlack` 的 DM resolve、threadTs、chunking 语义。不要 private import OpenClaw Slack extension 内部模块。
6. `sendIMMessage()` 对 Slack 走 delivery port；非 Slack 继续走现有 adapter/fallback。
7. CLI adapter 只保留为 `OCTOCLAW_LEGACY_CLI_DELIVERY=1` rollback。
8. Slack explicit reaction 可继续用 Web API backend，但必须使用明确 inbound anchor，并和首 ACK dedupe 共用 receipt。

验收：

- Slack native delivery path 不调用 `runCommand("openclaw", ...)`，也不通过 `openclaw message send` CLI 发送热路径消息。
- Slack thread/reply target 来自 OpenClaw delivery context 或 inbound anchor。
- `OCTOCLAW_LEGACY_CLI_DELIVERY=1` 能回滚到旧 Slack CLI path。
- native announce final 在 Slack 里正常送达，不依赖 completion file/outbox。
- 真实 Slack smoke 中无 `completion_file_timeout`，debug footer 对 child final 不显示 `route=reply | via=policy`。
- 非 Slack IM 验收不纳入本 slice；现有 fallback 不被破坏。

## 12. Legacy 默认路径下线计划

0.5.x immediate 只做默认 planner/native path 下线，不做激进源码删除。目标是让正常 Slack planner/native 流程不再依赖这些轮子，同时保留显式 legacy rollback；等 0.5.x 稳定后，再单独评估真正删除/归档代码。

默认路径下线顺序：

1. `runtime-ledger/scheduler.ts`：OpenClaw native subagent lane/maxChildren/maxDepth 已覆盖大部分用途；如仍需 shared workspace 写保护，抽成窄锁，不保留整套 scheduler queue。
2. `runtime-ledger/completion-binding.ts`：native announce 替代 child completion file；planner/native path 不写新 binding。
3. `delegate/child-finalizer.ts`：native completion delivery 替代轮询；planner/native path 不启动 finalizer recovery。
4. `delivery/delivery-outbox.ts`：Slack/native announce delivery 不写自建 outbox；legacy backend 可以显式回滚。
5. fake detached runtime：不再伪装可执行 backend。
6. `task-state.json` 写路径：降级为 projection cache 后再逐步移除。

保留或迁移：

- WorkContract store。
- OctoClaw metadata store：route seal、judge/replay、expected deliverable、model profile、native refs、IM anchors、ACK receipts。
- replay/eval log。
- model/cost policy。
- status projection renderer。
- IM 文案策略。

如果 metadata 需要关系查询和迁移审计，可以继续用 SQLite；如果只是少量 TTL/keyed 状态，bundled 部署时可 feature-detect `api.runtime.state.openKeyedStore<T>()`，外部/workspace plugin 必须回退 SQLite 或 `resolveStateDir()` 下的 atomic 文件。

## 13. 测试矩阵

### 13.1 Unit tests

- WorkContract：重复 userAsk 不撞 id。
- ACK dedupe：key 包含 stage；ACK0/delegate/progress 不互相误去重。
- Judge schema：missing confidence、abstain、degraded delegate 都不可 actionable。
- Footer mode：默认 off；compact/debug 按预期渲染。
- Planner/confirm：dispatch 只返回 plan；无 intent、过期 intent、hash 不匹配都阻止 `sessions_spawn`；confirm 缺 `runId` 失败；重复 confirm 同一 `runId` 幂等。

### 13.2 Integration tests

- reply fast path：主 agent 快速回复，不发文本 ACK。
- reply slow path：超过阈值只发一条 slow text ACK。
- delegate accepted：`sessions_spawn` accepted 且 confirm 成功后发 ACK；spawn failed 不发“已委派”。
- restart recovery：重启后 status 从 native runs/flows 恢复。
- completion：child 不写 completion file 也能通过 native announce 回传。
- planner isolation：planner mode 下不写 scheduler queue、completion binding、delivery outbox，新任务状态只从 native refs 查询。

### 13.3 Slack manual acceptance

- DM + `ackReactionScope: "direct"`：Slack 可见 reaction。
- channel + `visibleReplies: "automatic"` + `ackReactionScope: "all"`：OpenClaw auto ACK 可见。
- channel + 默认 `message_tool`：auto ACK 被压掉；OctoClaw explicit mode 可见 reaction。
- `removeAckAfterReply: true`：reply 后 reaction 被清理，行为符合预期。
- 缺 `reactions:write`：不崩溃，有 verbose/debug 记录。

### 13.4 Nightly / 回归验收

夜间回测可以和 macmini 的 runtime 改动并行，但只能改 acceptance/nightly config、scenario fixtures、report parser 和 docs evidence。macmini runtime 分支活跃时，不要碰 `extension-entry.ts`、`registration.ts`、judge/router、ACK sender、planner confirm 热路径。

必备案例：

- `main_fast_path_simple_reply`：简单解释/总结直接 reply，不进 `octoclaw_dispatch`。
- `main_fast_path_one_lookup`：一次轻量只读查证在主线程完成，`fresh_live_lookup` 不单独强制 delegate。
- `must_delegate_explicit_subagent`：用户明确要求子 agent/后台/并行时进入 planner/native delegate。
- `must_delegate_code_test_review`：代码修改、测试、review/验证不能被 main fast path 吃掉。
- `budgeted_main_then_delegate`：主线程固定 30s soft runtime budget 超限后先记录 `budgeted_main_escalated_pending`；late final 记录 `budgeted_main_completed_late` 且不 spawn；下一普通工具/注入边界再转 `octoclaw_dispatch` 并记录预算原因。
- `status_provenance_no_spawn`：状态/来源追问只读 native refs/replay，不创建新 spawn intent。
- `native_announce_final`：child 不写 completion file，final 通过 native announce 回到 Slack thread。
- `footer_delegate_provenance`：debug footer 对 child final 显示 `route=delegate` 和 `via=subagent|native_announce`。
- `no_completion_file_timeout`：planner/native path 没有 `completion_file_timeout` 和“任务超时”误报。

报告必须输出这些字段，便于和真实 Slack smoke 对齐：neutral ACK latency、route decision/bucket、`decision_bucket`、`budgetElapsedMs`、`budgetEscalationReason`、`visibleElapsedMs`、spawn allowed latency、confirm ACK latency、child progress/final latency、footer provenance/`footerVia`、PC13 `delivery_transport`/`target_source`/`footer_source`、`duplicateFinalCount`、是否出现 `completion_file_timeout`、是否调用 legacy CLI delivery。

## 14. 发布顺序

0.5.0 不应按“把所有瘦身项一次性做完”的方式发布，而应按 gate 可验证的 slice 发布。推荐顺序：

1. Slice 0 source/deploy guardrail：确认源码、deployed `dist`、OpenSpec 一致；先修会制造假事实的 bug。
2. Slice 1 planner/confirm 主链：灰度开启 `OCTOCLAW_SPAWN_BACKEND=planner`，跑通真实 Slack `dispatch -> sessions_spawn -> confirm -> ACK`。
3. Slice 2 ACK/footer/judge 必要瘦身：footer 默认 off，delegate ACK 只在 confirm 后发，judge 只做 router/admission signal，不重写 judge 主体。
4. Slice 3 metadata/status 收口：SQLite 保留为 metadata/audit store，状态投影逐步以 native runs/flows 为 execution truth。
5. Slice 4 SR-P0/SR-P1/SR-P2：恢复中性首 ACK，完成启动成本感知路由，瘦身 planner/native 热路径和观测。
6. Slice 5 0.5.x immediate legacy default-path removal：planner/native 默认路径关闭 completion file、child-finalizer、delivery outbox；legacy backend 保留显式 rollback。
7. Slice 6 0.5.x immediate Slack delivery port：只替换 Slack CLI/shell 热路径；如果 native port 不足，保留 `OCTOCLAW_LEGACY_CLI_DELIVERY=1` fallback。
8. Slice 7 deferred research：非 Slack IM、managed flow 编排、direct SDK spawn、warm worker pool/A2A、未暴露 tool allowlist/private hook 单独 OpenSpec。

0.5.0 发版 gate 是 Slice 0-4，也就是 Must ship + Should ship。Slice 5-6 是 0.5.x immediate，建议紧跟 0.5.0 做，但不阻塞 0.5.0；Slice 7 不进入当前验收。每个 slice 都必须有：OpenSpec 任务状态、focused tests、真实 Slack 验收记录、回滚开关。

## 15. 最小可交付版本

如果要先做一个最小版本，建议只做：

1. WorkContract id fix。
2. judge missing confidence/abstain fix。
3. footer default off。
4. ACK key 加 stage，并关闭 tier 文本 ACK。
5. planner path：移除 completion file requirement，要求 confirm 有 `runId` 才算 accepted。
6. delegate accepted ACK 等 `sessions_spawn` accepted + confirm。
7. metadata store 和 runtime truth 分离。
8. 文档中标明 Slack native `ackReaction` 的配置和 tool-only 限制。

这些项能先把“不稳、重、容易重复、Slack 看不到 ACK 的误解”解决一大半，然后再逐步把 ledger/outbox/finalizer 下线。

## 16. 二次通读后的文件级落地任务包

这一节把审查结论收敛成可以直接开工的任务包。顺序上先修会导致误派发/重复消息/状态碰撞的 bug，再接 native spawn，最后下线 legacy runtime 轮子。

### 16.1 P0 bugfix 包

目标：不改整体架构，先消除会制造错误事实的点。

| 任务 | 文件 | 改法 | 验收 |
| --- | --- | --- | --- |
| ACK key 加 stage | `extensions/octoclaw-runtime/src/ack/ack-dedupe.ts` | `buildAckKey()` 加入 `ackStage`，最好也加入 surface/target；如果删除 tier ACK，则保留 delegate/progress 独立 key | ACK0、slow text、delegate accepted、progress 不互相误去重 |
| WorkContract id 不碰撞 | `extensions/octoclaw-runtime/src/work-contract/builders.ts` | id 加 `turnId` / inbound message anchor / route seal；无 anchor 时用 UUID 主 id、stable hash 作 fingerprint | 同 session 同一句连续两次生成不同 `workContractId` |
| WorkContract 只 seal 一次 | `extensions/octoclaw-runtime/src/resolve/policy-resolver.ts` | `resolveStatelessPolicyDecision()` 不写 store；`resolvePolicyDecisionForContext()` route seal 后唯一 attach | 单次 policy resolve 只有一次 WorkContract write/revision/replay |
| judge degraded 不可执行 | `extensions/octoclaw-runtime/src/resolve/llm-judge.ts`、`packages/octoclaw-policy/src/judge/judge-schema.ts` | missing confidence 不默认 0.7；`isActionableJudgeResult()` 检查 abstain/degraded/new-work/deliverable | malformed delegate 不会 spawn |
| delegate ACK 不早发 | `extensions/octoclaw-runtime/src/ack/ack-route-commit.ts`、`tools/registration.ts` | route=delegate candidate 阶段不发用户文本；`sessions_spawn` accepted + confirm 后发 delegate accepted | spawn failed 时用户看不到“已委派” |
| spawn evidence 收紧 | `extensions/octoclaw-runtime/src/tools/registration.ts` | `dispatchSpawnEvidence()` 需要 `runId/childRunId/nativeTaskId`；`childSessionKey` 只能作为 ref | 只有 childSessionKey 的记录显示 `spawn_not_confirmed` |
| 模型映射统一 | `extensions/octoclaw-runtime/src/tools/registration.ts`、`model-map.ts` | `octoclaw_spawn` 不再硬编码 map；复用 `getModelMap()` 或删除执行入口 | dispatch/spawn 对同一 complexity 选同一模型 |
| admission 不用 handoff 补证明 | `extensions/octoclaw-runtime/src/tools/registration.ts` | `handoff.summary` 只能展示，不参与 pre-dispatch admission | 缺 expected deliverable 的 delegate 被拒绝 |

### 16.2 0.5.0 planner/confirm 包

目标：让 OctoClaw 的委派入口变薄，只负责 WorkContract/admission/model policy，并通过主 agent 调原生 `sessions_spawn` 使用 OpenClaw native lifecycle。

新增文件：

- `extensions/octoclaw-runtime/src/delegate/native-spawn-intent.ts`
- `extensions/octoclaw-runtime/src/delegate/native-spawn-intent-store.ts`
- `extensions/octoclaw-runtime/src/delegate/native-spawn-gate.ts`
- `extensions/octoclaw-runtime/src/delegate/native-spawn-confirm.ts`
- `extensions/octoclaw-runtime/src/tools/dispatch-confirm-tool.ts`
- `extensions/octoclaw-runtime/src/delegate/spawn-plan.ts`

实现口径：

1. 0.5.0 首选 `sessions_spawn planner/confirm`，不是 plugin direct spawn。
2. `octoclaw_dispatch` 通过 admission 后创建 `NativeSpawnIntent`，返回极短 `sessionsSpawnArgs`。
3. `before_tool_call` 对 `sessions_spawn` 做 intent/hash/TTL gate。
4. 主 agent 调原生 `sessions_spawn`，拿到 `runId/childSessionKey`。
5. 主 agent 调 `octoclaw_dispatch_confirm`。
6. confirm 校验 `runId` 后写 WorkContract native refs，发 delegate accepted ACK。
7. `api.runtime.subagent.run()` 不作为主路径，因为它不等价于 `sessions_spawn` registry/announce 全链路。
8. legacy runtime 只在 `OCTOCLAW_SPAWN_BACKEND=legacy` 或 planner allowlist 外启用。

验收：

- `octoclaw_dispatch` 不直接 spawn，不发“已委派”。
- 没有 pending intent 时，`sessions_spawn` 被 gate 阻止。
- args hash 不匹配时，`sessions_spawn` 被 gate 阻止。
- confirm accepted 必须有 `runId`；缺 runId 返回失败，不发 delegate accepted ACK。
- confirm 重复同一 `runId` 幂等，不同 `runId` conflict。
- planner path 不调用 `buildSubagentSpawnMessage()` 的 completion file 版本。
- 不向 `sessions_spawn` 传 `target/channel/to/threadId/replyTo/transport`。
- WorkContract 保存 `nativeRefs.openclawRunId`、`spawnIntentId`、`spawnBackend=sessions_spawn_planner`。
- child completion 通过 OpenClaw native announce 回传，OctoClaw 不写 completion binding/outbox。

### 16.3 completion/finalizer 下线包

目标：planner path 不再依赖 worker 写文件。

改动：

- `buildSubagentSpawnMessage()` 改成 legacy-only，或拆成 `buildLegacyCompletionFilePrompt()`。
- `delegate/child-finalizer.ts` 只在 `OCTOCLAW_LEGACY_COMPLETION_FILE=1` 时启动。
- `runtime-ledger/completion-binding.ts` planner path 不再写新 binding。
- `extension-entry.ts` 的 `recoverPendingChildCompletionFinalizers()` 在 planner mode 下不注册。

验收：

- child 不写 `.completion.json`，native run 仍能完成并 announce。
- native run 完成时 OctoClaw 不重复发送 final message。
- legacy flag 打开时老 completion file 流程仍能回滚使用。

### 16.4 状态投影包

目标：状态查询和 status panel 不再从 task-state/ledger 猜执行结果。

新增文件：

- `extensions/octoclaw-runtime/src/state/native-status-projector.ts`
- `extensions/octoclaw-runtime/src/state/native-status-projector.test.ts`

读取顺序：

1. 有 `openclawRunId`：`api.runtime.tasks.runs.fromToolContext(ctx).resolve(openclawRunId)`。
2. 有 `openclawFlowId`：`api.runtime.tasks.flows.fromToolContext(ctx).resolve(openclawFlowId)`。
3. 无 token：`findLatest()` 只用于 UI fallback，不用于执行授权。
4. `task-state.json` 只作为 projection cache；读取失败要显示 `corrupt/io_error/degraded`。

验收：

- 删除或损坏 `task-state.json` 后，native run 状态仍能查询。
- status follow-up 不会触发 `octoclaw_dispatch` / `octoclaw_spawn`。
- native missing 但 metadata 有 runId 时显示 `lost/unknown`，不自动补成功。

### 16.5 ACK/footer 包

目标：用户可见消息只表达真实状态。

改动：

- 恢复中性首 ACK：Slack inbound 后 1-5s 内发 reaction 或短文本，只表达“收到/正在判断”，不表达“已委派/已启动”。
- 首 ACK target resolution 必须使用原始 inbound anchor（Slack `channel/message.ts/thread_ts`），不能依赖 route commit 后的 policy state。
- `OCTOCLAW_NATIVE_ACK_REACTION_MODE=auto|explicit|off`。
- `OCTOCLAW_TEXT_ACK_DELAY_MS=2500`。
- `OCTOCLAW_PROJECTION_FOOTER_MODE=off|compact|debug`，默认 `off`。
- route commit ACK 不再说“准备派发”；delegate accepted ACK 只在 `sessions_spawn` accepted + confirm 后发送。
- footer renderer 只在 final visible reply 且 mode 非 off 时运行；ACK、NO_REPLY、delegate accepted/progress 都不追加。
- footer route 在 debug 模式下优先使用 accepted native refs / child announce provenance；不能被 child announce 后 parent 新一轮 `route=reply` 覆盖。

验收：

- neutral 首 ACK p95 <= 5s，且不承诺委派成功。
- 快速 reply 无文本 ACK。
- 慢 reply 最多一条文本 ACK。
- delegate accepted ACK 晚于 `sessions_spawn` accepted + confirm。
- 默认 Slack 消息没有 route/model/footer。
- debug footer 对 native child final 显示 `route=delegate` 和 `via=subagent` 或 `via=native_announce`。
- Slack tool-only 群里，auto ack 被 OpenClaw gate 压掉时，explicit reaction 能用原始 `channel/message.ts` anchor 补上。

### 16.6 Slack delivery port 包

目标：只把 OctoClaw 自己发出的 Slack CLI/stdout 发送路径挪出热路径；普通 main agent final reply 不在本 slice 抢管。接口保持 IM 通用，第一实现只做 Slack；非 Slack IM 保持现有 fallback，不进入 0.5.x immediate。

改动：

- 抽轻量 `MessageDeliveryEnvelope` / `MessageDeliveryPort`，但本 slice 只注册 Slack 实现；`sendIMMessage()` 对 Slack 只依赖 port。
- Slack neutral ACK 文字 fallback、delegate accepted ACK、native announce final、status/provenance follow-up、legacy fallback 走 Slack port 或明确 Slack reaction backend。
- 普通 main final reply 继续由 OpenClaw 原生 Slack delivery 负责；OctoClaw hook 只做 footer projection，不重复投递。
- footer 从 envelope/provenance 或 accepted native refs 渲染，不再靠最近 policyState/session key 猜 child final。
- Slack target 优先 delivery context / inbound anchor；没有明确 anchor 时 fail closed 或只记录 observed。
- backend 优先公开稳定的 OpenClaw channel delivery API；若不可用，则用 Slack Web API backend，借鉴 OpenClaw Slack `sendMessageSlack` 行为，不 private import 内部模块。
- CLI adapter 只保留为 `OCTOCLAW_LEGACY_CLI_DELIVERY=1` fallback。
- 非 Slack 代码只允许做类型兼容和 fallback 保留，不能顺手迁移 Feishu/其他 IM。

验收：

- Slack native delivery path 不调用 `openclaw message send`。
- Slack thread/reply target 来自 `deliveryContext` 或 inbound anchor。
- `OCTOCLAW_LEGACY_CLI_DELIVERY=1` 可以回滚。
- native announce final 在 Slack 正常送达，且不会落回 completion file/outbox timeout。
- delivery 失败由 native retry/fallback 或明确 port error 表达，不写 OctoClaw 自建 outbox。

### 16.7 Gate 瘦身落地规则

删除或降级的 gate：

- 多层 tier ACK gate：默认删除，只保留 reaction、slow text、delegate accepted、terminal/progress。
- 每轮强制 route hint：改成 judge 不确定或主模型纠正时才需要。
- `block_tool_patterns` 参数扫描：收敛成 tool name allow/deny + WorkContract admission。
- 自建 scheduler gate：planner path 关闭，只保留可选 shared workspace write lock。
- observer/session control 分支：能合并成 `reply/status + allowed control tools` 的就合并。

必须保留的硬 gate：

- status/provenance/execution follow-up 禁止 spawn。
- delegate 必须 `is_new_work=true`。
- delegate 必须有 `expected_deliverable`。
- spawn confirmed 必须有 `sessions_spawn` accepted + `octoclaw_dispatch_confirm` 校验的 run id。
- OpenClaw 原生 `allowedAgents/maxDepth/maxChildren/sandbox` 不绕过。
- shared workspace 写冲突保护如果确有并发写风险，需要保留为窄锁，不保留整套 scheduler queue。
- idempotency/dedupe 保留。

## 17. 事实依据和风险口径

这份计划的事实依据以 OpenClaw v2026.4.29 源码为准：

- `src/plugins/runtime/types-core.ts` / `src/plugins/registry.ts` / `docs/plugins/sdk-runtime.md`：`state.openKeyedStore()` 存在，但 4.29 只允许 bundled plugin 使用；外部 OctoClaw 不能依赖它替代 SQLite。
- `src/plugins/runtime/runtime-tasks.types.ts`：`runtime.tasks.runs/flows` 是 status/read/cancel projection API。
- `src/plugins/runtime/types-channel.ts` / `runtime-channel.ts`：channel runtime 是 reply/outbound/routing/reaction helper。
- `src/plugins/runtime/types.ts` / `src/gateway/server-plugins.ts`：`runtime.subagent.run()` 只返回 `runId`，不等价于 `sessions_spawn` 全链路。
- `src/agents/tools/sessions-spawn-tool.ts`：`sessions_spawn` 支持 model/thinking/context/lightContext/runTimeout，拒绝 channel delivery 参数。
- `src/agents/subagent-spawn.ts` / `src/agents/subagent-announce-delivery.ts`：native subagent 注册 run 并支持 auto announce/direct/queue/retry。
- `extensions/slack/src/actions.ts` / `monitor/message-handler/prepare.ts` / `dispatch.ts`：Slack ackReaction 是真实 Slack reaction，但受 scope、tool-only、status reaction、权限和清理策略影响。

主要风险：

- 0.5.0 明确采用“dispatch 返回 spawn plan，主 agent 调 sessions_spawn，再 dispatch_confirm”的 planner/confirm 路径；direct SDK spawn 是未来替换点。
- 如果业务确实需要 shared workspace 并发写保护，不能完全删除 scheduler，需要抽成很窄的 write-scope lock。
- SQLite 不能简单删除；OpenClaw 原生没有 OctoClaw 的全部产品字段，SQLite 应保留为 metadata/audit store。
- Slack explicit reaction 绕过 OpenClaw auto ack gate，必须只在明确配置和明确 anchor 下使用。

### 17.1 OpenClaw 4.29 -> 4.20 release audit 对 0.5.0 的影响

按 release note 倒序核对后，0.5.0 应采纳的是已经有源码支撑、且不会扩大 OctoClaw runtime 职责的能力：

- **2026.4.29**：`messages.queue=steer` 默认、`messages.visibleReplies`、`spawnedBy` 事件、`openKeyedStore`、startup diagnostics timeline。OctoClaw 应复用 queue/visibleReplies/spawnedBy/diagnostics；`openKeyedStore` 只能 bundled plugin 使用，外部插件不得因此删除 SQLite。
- **2026.4.27**：plugin startup manifest-first、channel-route SDK、manifest-backed model catalog、runtime deps lazy loading。OctoClaw 应使用 `openclaw/plugin-sdk/channel-route` 或 runtime routing helper 替换手写 route key；同时减少启动期 side effect，不要把 heavy runtime 在 Gateway 启动时全量加载。
- **2026.4.26**：`sessions_spawn` 的 model alias、`subagents.allowAgents`、requester delivery 保真和 fail-closed 修复。OctoClaw planner/confirm 不应绕过这些原生 guardrail，也不要自己猜 requester route。
- **2026.4.25**：`sessions_yield`、subagent completion direct fallback、`before_agent_finalize`、`model_call_started/ended`、OTEL/outbound diagnostics。OctoClaw 可用 hooks/diagnostics 做 latency/cost/footer 观测；不要把 `before_agent_finalize` 当主要投递机制。
- **2026.4.23**：`sessions_spawn.context=fork`、Slack/MPIM group 处理、shared hook route fields、subagent parent `NO_REPLY` 修复。OctoClaw 默认应传 `context=isolated` + `lightContext=true`，只有强上下文依赖才用 `fork`。
- **2026.4.22**：diagnostics export、Tokenjuice 工具结果压缩、Codex/Pi hook parity、`sessions_list` filter、OpenAI native web_search。OctoClaw 可借 diagnostics 和模型 hooks 做回测，不应依赖只给 bundled/embedded 的扩展缝合点。
- **2026.4.21**：Slack thread alias/outbound send 保留 `threadTs`，plugin runtime deps 修复。它支撑 Slack delivery port，但不能替代 OctoClaw 自己的 IM anchor/ACK receipt。
- **2026.4.20**：detached runtime/TaskFlow、silent `NO_REPLY` policy、cron delivery 修复、status reactions。TaskFlow/runs 可作为状态投影来源，但不是 WorkContract/judge/route seal 的完整替代。

落地取舍：

- 进入 0.5.0：planner/confirm、strict native refs、neutral first ACK、startup-cost-aware judge/router、native status projection、debug footer provenance、diagnostics smoke。
- 进入 0.5.x immediate：Slack delivery port 替换 CLI/shell 热路径、legacy scheduler/finalizer/outbox 从默认 native path 下线。
- 暂缓：direct SDK spawn、warm worker/A2A 常驻 worker、未暴露 tool allowlist/private hook、child start p95 <= 10s 作为发布门槛。

## 18. 并行分工与 OpenSpec 约束

0.5.0 重构可以并行做，但必须先把边界写进 OpenSpec，再按 slice 分工。建议新增并维护：

- `openspec/changes/planner-confirm-0.5.0-refactor/proposal.md`
- `openspec/changes/planner-confirm-0.5.0-refactor/design.md`
- `openspec/changes/planner-confirm-0.5.0-refactor/tasks.md`
- `openspec/changes/planner-confirm-0.5.0-refactor/specs/planner-confirm/spec.md`

这里的 confirm 是技术握手，不是新增用户确认流程：`octoclaw_dispatch` 生成 `NativeSpawnIntent`，主 agent 调 OpenClaw 原生 `sessions_spawn`，再由 `octoclaw_dispatch_confirm` 写回 `runId/childSessionKey`。OpenSpec 的目的，是防止 worker 把 planner 做成另一套 runtime、绕过 native spawn、提前 ACK，或把子 agent transcript 塞回主上下文。

### 18.1 Leader / Worker 分工

Codex leader 负责难点和最终合并：

- `tools/registration.ts` 的 planner 切口和 spawn evidence 语义。
- `extension-entry.ts` / `before_tool_call` 对 `sessions_spawn` 的硬 gate。
- `octoclaw_dispatch_confirm` 的幂等、冲突、失败闭环和 ACK 时机。
- judge admission 的硬边界：follow-up 禁止 spawn、`is_new_work`、`expected_deliverable`。
- 状态真相审查：WorkContract 只能存 metadata，native registry 才是 execution truth。
- legacy runtime 删除顺序：先 flag disable，再灰度验收，最后删除/归档。

GLM-5.1 适合承担高 token、边界清楚的实现包：

- feature flags/config resolver 和测试。
- `NativeSpawnIntent` store、canonical hash、TTL、幂等/conflict 测试。
- WorkContract native refs 和 projector。
- native status projector。
- planner path 下 legacy finalizer/completion binding/delivery outbox 的 disable wiring。
- 大量单测、fixture、文档同步。

便宜模型适合：

- 配置/fixture/文案类小改。
- 单测矩阵补齐。
- Markdown/OpenSpec 同步。
- lint/build 失败后的机械修复。

### 18.2 并行任务包

| 包 | Owner | 写入边界 | 验收 |
| --- | --- | --- | --- |
| PC1 Feature flags/config | GLM-5.1 | `extensions/octoclaw-runtime/src/config/*` | typed resolver + invalid/default/allowlist tests |
| PC2 NativeSpawnIntent store | GLM-5.1，leader review | `delegate/native-spawn-intent*`、metadata migration | hash/TTL/state/idempotency/conflict tests |
| PC3 dispatch planner output | leader | `tools/registration.ts`、`delegate/spawn-plan.ts` | dispatch 只返回 plan，不 spawn、不 ACK、不写 legacy runtime |
| PC4 `sessions_spawn` gate | leader | `extension-entry.ts`、`delegate/native-spawn-gate.ts` | no intent/expired/hash mismatch blocked，match allowed |
| PC5 dispatch confirm | leader | `tools/dispatch-confirm-tool.ts`、`delegate/native-spawn-confirm.ts` | runId required，同 runId 幂等，不同 runId conflict，ACK after confirm |
| PC6 WorkContract native refs | GLM-5.1，leader schema review | `packages/octoclaw-contracts/*`、runtime work-contract store/projectors | refs 可读写，但 status 不从 WorkContract 推进 |
| PC7 legacy runtime disable | GLM-5.1 | finalizer/completion-binding/outbox 启动点 | planner mode 不启动，legacy flag 可回滚 |
| PC8 native status projector | GLM-5.1，leader fallback review | `state/native-status-projector.ts` | runs/flows resolve，missing/corrupt 显示 degraded/lost |
| PC9 ACK/footer guardrail | GLM-5.1，leader review ACK 边界 | `ack/*`、`projection-footer.ts` | delegate ACK 晚于 confirm，footer 默认 off |
| PC10 integration/acceptance tests | leader 定义，GLM-5.1/便宜模型实现 | tests/harness only | no intent、expired、hash mismatch、missing runId、no completion file、no outbox |
| PC11 legacy default-path removal | leader | finalizer/completion-binding/outbox 默认路径下线 | 0.5.0 Must+Should 稳定后做，rollback 可用 |
| PC12 speed/responsiveness | leader 架构，GLM-5.1 补测试 | ACK、启动成本感知路由、planner/native 热路径、footer/status fast path | neutral ACK <=5s，spawn allowed <=30s，child final footer 不误标 reply |
| PC13 Slack delivery port | leader，GLM/便宜模型可补 harness | Slack adapter/send path、Slack acceptance/report parser | Slack 热路径不 shell out CLI，non-Slack unchanged |
| PC14 nightly regression harness | leader 定义案例，GLM/便宜模型实现 fixtures/parser | acceptance/nightly config、fixtures、report parser、docs evidence | route/latency/footer/timeout 指标可回归，可和 macmini runtime 并行 |

### 18.3 防跑偏规则

- 每个 worker 只能领取一个 OpenSpec task slice；不能跨 slice 修改。
- 每个 slice 必须写明 owned files、forbidden files、truth source、expected tests、acceptance evidence。
- `registration.ts`、`extension-entry.ts`、judge admission、delegate ACK sender 这类热路径默认 leader-owned；GLM-5.1 只能在明确授权的窄范围内改。
- worker 不得 import OpenClaw 内部 `spawnSubagentDirect()`，不得把 `api.runtime.subagent.run()` 当 0.5.0 主路径。
- worker 不得让 judge 直接产生副作用；judge 仍只是 proposal，副作用由 admission、intent gate、confirm 决定。
- worker 不得在 confirm 前写 running/succeeded，也不得发“已委派”。
- worker 不得把 raw child transcript、完整 judge packet、ledger dump 塞进 parent tool result。
- 影响 live behavior 的 slice 必须有 real path 测试；纯 helper 测试不能算通过。
- 所有 skipped/failed/unknown 必须 fail closed，并按需要写 replay/telemetry。

### 18.4 推荐执行顺序

1. leader 先合 OpenSpec change，冻结协议和分工。
2. GLM-5.1 并行做 PC1、PC2、PC6 的纯模块部分。
3. leader 做 PC3、PC4、PC5，把热路径连起来。
4. GLM-5.1 做 PC7、PC8、PC9，leader 只 review 语义边界。
5. leader 拉通 PC12 速度专项：先恢复 neutral ACK，再改启动成本感知路由，最后瘦身 planner/native 热路径和 footer/status fast path。
6. GLM-5.1/便宜模型补 PC10 测试矩阵和 PC12 latency/footer acceptance。
7. 0.5.0 Must+Should 通过真实 Slack smoke 后，leader 做 PC11 legacy default-path removal。
8. PC13 Slack delivery port 作为 0.5.x immediate 紧跟执行；只改 Slack，非 Slack 保持 fallback。
9. PC14 nightly regression harness 可以和 macmini runtime 改动并行，但只允许改 fixtures/config/report parser/docs evidence。
10. 非 Slack IM、direct SDK spawn、managed flow 编排另起 future OpenSpec。warm worker pool/A2A 常驻 worker 已有独立设计文档，见 [`octoclaw-dispatch-latency-preload-design-2026-05-03.md`](./octoclaw-dispatch-latency-preload-design-2026-05-03.md)，包含方案 B（投机并行 spawn）和方案 A（预热 session pool）的机制验证、实现细节和可行性验证步骤；进入 roadmap 的前置条件是 0.5.0 Must ship 稳定且完成 Section 6 四项验证。

这样能利用 GLM-5.1 的大 token 和实现能力，但把最容易出事故的执行真相、spawn 授权、ACK 时机和最终集成留给 leader。
