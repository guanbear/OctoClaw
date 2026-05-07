# OctoClaw Runtime 收口与清理计划

日期：2026-05-07
状态：implementation planning / cleanup roadmap
策略：delete-first convergence，不建立旧 runtime 长期兼容层

相关文档：

- [`octoclaw-openclaw-native-slimming-review-2026-05-01.md`](./octoclaw-openclaw-native-slimming-review-2026-05-01.md)
- [`octoclaw-native-slimming-implementation-plan-2026-05-01.md`](./octoclaw-native-slimming-implementation-plan-2026-05-01.md)
- [`octoclaw-n1-runtime-ledger-implementation-plan-2026-05-01.md`](./octoclaw-n1-runtime-ledger-implementation-plan-2026-05-01.md)
- [`octoclaw-n1-runtime-ledger-repair-packet-2026-05-01.md`](./octoclaw-n1-runtime-ledger-repair-packet-2026-05-01.md)
- [`octoclaw-state-convergence-4-4-design.md`](./octoclaw-state-convergence-4-4-design.md)
- [`octoclaw-ts-rebuild-design-v2.md`](./octoclaw-ts-rebuild-design-v2.md)

---

## 1. 目标

本计划的目标不是继续给 OctoClaw 增加一套更重的 runtime，而是把已经半迁移的执行、状态、投递、恢复路径收口成清晰边界：

```text
OpenClaw native registry / TaskFlow / sessions_spawn
  = 执行生命周期真相

OctoClaw SQLite metadata ledger
  = WorkContract / route seal / native refs / spawn intent / audit truth

task-state.json
  = 可重建 status projection / generated read-model cache

completion file / child-finalizer / delivery outbox / octoclaw_spawn
  = 迁移期删除对象，不进入目标架构
```

用这条边界换取三个结果：

1. **减少垃圾代码**：不再同时维护多套执行恢复、完成判断、投递重试和状态推断。
2. **提升稳定性**：避免 `task-state.json`、SQLite、completion file、native registry 同时争抢执行真相。
3. **提升效率**：减少重复 JSON 读写、后台轮询、finalizer/outbox 恢复、重复 judge/status 推断和异常慢路径。

性能收益的性质需要说清楚：这条线不会直接把子 agent 冷启动减少几十秒；它主要减少 OctoClaw 自己的热路径复杂度、后台 I/O、重复恢复逻辑和状态分叉带来的慢路径。子 agent 冷启动大头仍在 OpenClaw embedded runner / model / tool bundle / stream setup。

本计划采用 delete-first 策略：旧路径如果已经和目标架构冲突，默认删除或停止注册；迁移工具只用于一次性 backfill、诊断和验证，回滚依赖 git revert / feature branch，不在运行时代码里维护双轨。兼容不是目标，收口才是目标。

---

## 2. 当前未收口项

### 2.1 `task-state.json` 仍超过 projection 职责

设计目标：

- `task-state.json` 只做 status/read-model projection。
- 缺失或损坏时可以从 SQLite metadata ledger + OpenClaw native lifecycle snapshot + replay tail 重建。
- 读取失败必须显式 degraded/corrupt，不能当作“没有任务”。

当前问题：

- WorkContract 默认仍以 task-state 为主存储；只有 `OCTOCLAW_RUNTIME_LEDGER=enforce` 时才优先 SQLite。
- ACK watchdog、conversation grounding、status/details 等路径仍直接读 task-state。
- 一些读取路径仍 catch-all 后返回空对象，可能把 projection 损坏误判为无任务。

收口方向：

- 默认 WorkContract read/write 走 SQLite metadata ledger。
- task-state 写入改成 projection writer。
- 所有 user/status/operator surface 通过统一 projection builder 读取，禁止各模块各自解析 task-state。

### 2.2 SQLite ledger 已实现，但不是默认 truth

已实现：

- `work_contracts`
- `delegation_tickets`
- `task_attempts`
- `scheduler_queue`
- `completion_bindings`
- `runtime_events`
- 辅助表 `native_spawn_intents`

当前问题：

- `OCTOCLAW_RUNTIME_LEDGER` 默认 `off`。
- shadow/enforce 能力存在，但 hot path 还没有完全以 SQLite metadata 为 OctoClaw truth。
- projection rebuild 主要是 operator/recovery 工具，不是默认安全路径。
- 文档反复说 N1-MVP 只有六张 canonical 表，但实现还有 `native_spawn_intents` 辅助表，需要明确归类，避免 schema 认知漂移。

收口方向：

- 将 SQLite 定位为 OctoClaw metadata ledger，而不是 OpenClaw 执行状态替代品。
- 默认启用 metadata ledger read path；`task-state.json` 不再作为 read fallback。迁移只允许一次性 backfill/quarantine，并必须产生 degraded event。
- 文档补充 `native_spawn_intents` 是 spawn planner/confirm 辅助表，不属于 N1 六张 canonical runtime tables。

### 2.3 completion file / child-finalizer 仍在 planner 默认路径

设计目标：

- planner/native path 使用 OpenClaw 原生 `sessions_spawn` announce/delivery。
- completion file / finalizer 是删除对象，不承担 runtime rollback 职责。

当前问题：

- planner backend 默认仍启动 child-finalizer recovery。
- `buildSubagentSpawnMessage()` 仍要求 worker 最后写 completion file。
- spawn evidence confirmed 后仍 schedule finalizer。
- finalizer 还会从 child session JSONL 猜结果，并可能推进 task-state / outbox。

收口方向：

- planner path 不再把 completion file 写入 worker prompt。
- planner path 不 schedule child finalizer。
- 删除 child-finalizer recovery 的默认注册和 planner 调用点。
- 删除 completion file prompt builder 在 planner path 的所有依赖。
- `completion_bindings` 不再作为 planner normal completion gate；后续若无独立诊断价值，继续删除或降级为迁移期审计。

### 2.4 delivery outbox 仍残留在 finalizer 路径

设计目标：

- planner/native path 由 OpenClaw channel/native announce delivery 处理投递和 retry。
- OctoClaw 不维护第二套投递 outbox。

当前问题：

- delivery outbox interval 在 planner 默认基本关闭，但 child-finalizer 失败时仍可 queue outbox。
- outbox 仍会写 task-state delivery state。

收口方向：

- planner path 不写 JSON outbox。
- 删除 outbox interval 默认注册。
- 删除 finalizer 失败后 queue outbox 的正常路径。
- delivery status 写 SQLite/replay，再由 projection builder 输出。

### 2.5 `octoclaw_spawn` 与 planner/dispatch 分叉

设计目标：

- `octoclaw_dispatch` 是唯一策略入口。
- native spawn 必须来自 planner intent + `sessions_spawn` + confirm。
- model/cost policy 只维护一套。

当前问题：

- `octoclaw_spawn` 仍作为独立工具注册。
- 它有独立硬编码 model map，可能绕过 `octoclaw_dispatch` 的 model-policy。

收口方向：

- 删除 `octoclaw_spawn` 作为公开工具。
- 删除独立硬编码 model map。
- 不做 alias；旧入口应 fail fast 并指向 `octoclaw_dispatch`，而不是转发后继续维护两套语义。

### 2.6 `api.runtime.subagent.run()` 仍可作为过渡 spawn path

设计目标：

- 0.5.x 主线为 tool-level `sessions_spawn` planner/confirm。
- plugin runtime direct subagent API 只有在上游暴露等价能力后再成为主路径。

当前问题：

- dispatch materialized 但没有 spawn evidence 时，仍会尝试 `runtime.subagent.run()`。
- 这条路径不等价于 `sessions_spawn` 的 registry / announce / requester origin 链路。

收口方向：

- 删除 planner backend 的 `runtime.subagent.run()` fallback。
- 不保留 experimental direct runtime 主线；如果未来 OpenClaw 暴露等价 API，再重新设计新 adapter。

### 2.7 fake detached runtime stub 仍可注册

设计目标：

- 只有真实 host runtime 能力存在时才注册 detached runtime。

当前问题：

- 当前 stub 会返回随机 task id，大量 lifecycle 操作 no-op。
- capability check 可能看似成功，但没有真实执行状态。

收口方向：

- 删除 fake detached runtime stub 注册。
- 如果 host 不提供真实 runtime，delegate 能力 fail closed 到 planner/confirm 或 reply diagnostic。

---

## 3. 非目标

本计划不做这些事：

- 不把 SQLite 变成 OpenClaw native lifecycle 的替代数据库。
- 不私自修改 OpenClaw native SQLite schema。
- 不实现 resident runner / warm worker pool 作为默认 runtime。
- 不把 raw child transcript 注入 parent context。
- 不新增 `delivery_outbox`、`amendments`、`resource_locks` SQLite 表，除非后续有独立验收场景。
- 不在产品代码里维护 legacy rollback。回滚依赖 git revert / feature branch，而不是保留双轨 runtime。
- 不为了兼容旧工具继续暴露已过时入口。

---

## 3.1 删除原则

1. **旧执行路径优先删除**：completion file、child-finalizer、delivery outbox、`octoclaw_spawn`、fake detached runtime、`runtime.subagent.run()` fallback 都是删除对象。
2. **数据迁移工具可以短期存在**：从 `task-state.json` backfill SQLite、projection rebuild、operator diagnostics 只服务迁移和诊断，不成为新的 runtime 路径。
3. **回滚靠版本控制，不靠长期 flag**：flag 只允许用于一个 PR 内灰度或本机 smoke；合并后目标默认必须是单路径。
4. **删除必须有验证替代**：删除 completion/finalizer 前必须有 native announce/status smoke；删除 task-state truth 前必须有 projection rebuild。
5. **不做 alias 掩盖旧接口**：如果用户或主 agent 仍调用旧工具，应 fail fast 并指向新入口，而不是偷偷转发后继续维护两套语义。

---

## 4. 目标架构

### 4.1 Dispatch / Spawn

```text
user turn
  -> judge / policy resolver
  -> WorkContract sealed in SQLite metadata ledger
  -> octoclaw_dispatch returns NativeSpawnIntent + sessionsSpawnArgs
  -> main agent calls sessions_spawn
  -> before_tool_call validates intent hash
  -> octoclaw_dispatch_confirm records runId / childSessionKey / native refs
  -> OpenClaw native announce handles completion delivery
  -> OctoClaw projection builder updates status surface
```

关键规则：

- `dispatchExecuted=true` 只能表示 OctoClaw materialized a native spawn plan or native task binding。
- `spawnExecuted=true` 必须来自 accepted native run evidence。
- `childSessionKey` 只是 ref，不能单独证明 spawn 已执行。
- 不再让 completion file/finalizer 推动 planner 正常完成状态。

### 4.2 State

```text
SQLite metadata ledger
  work_contracts
  native_spawn_intents
  delegation_tickets / task_attempts / scheduler_queue / completion_bindings / runtime_events

OpenClaw native bridge/API
  run / flow / task lifecycle

Projection builder
  -> task-state.json
  -> status/details/queue/timeline
  -> grounding packet
  -> operator diagnostics
```

关键规则：

- SQLite 保存 OctoClaw 自有 metadata 和 native refs。
- OpenClaw 保存执行生命周期。
- task-state 是输出，不是输入真相。
- replay 是 observability/audit，不是行为真相。

### 4.3 Delivery

```text
native subagent end / announce
  -> OpenClaw channel/native delivery
  -> OctoClaw records delivery metadata/replay
  -> projection builder exposes delivered / delivery_pending / degraded
```

目标状态没有旧投递路径：

```text
none
```

历史 completion/outbox 文件只作为一次性 migration/recovery 输入读取，不作为新任务运行协议。

---

## 5. Rollout Plan

### P0: Baseline inventory and guardrails

目标：先防止继续扩大半迁移路径，并把待删除对象列成硬清单。

改动：

1. 新增 architecture invariant tests：
   - planner 默认不注入 completion file requirement。
   - planner 默认不启动 child-finalizer recovery。
   - corrupt task-state 不会被写回空文档覆盖。
   - WorkContract ledger-on 读写不依赖 task-state。
   - `octoclaw_spawn` 不绕过 dispatch/model-policy。
2. 文档补齐：
   - N1 六张 canonical 表之外，`native_spawn_intents` 是辅助表。
   - `delivery_outbox`、`amendments`、`resource_locks` 继续 deferred。
   - completion file、child-finalizer、delivery outbox、`octoclaw_spawn`、fake detached runtime、direct subagent fallback 标记为 delete targets。
3. 增加 runtime metrics/replay events：
   - `ledger_mode`
   - `ledger_degraded`
   - `task_state_projection_rebuilt`
   - `legacy_finalizer_scheduled`
   - `legacy_outbox_queued`
   - `native_announce_delivery_observed`

验收：

- 无行为改动，测试证明当前默认与目标默认的差异被明确标记。
- 新增测试先允许当前差异用 `todo`/`expected current gap` 记录，但后续阶段必须逐项翻绿。
- 每个 delete target 都有 owner PR 和删除验收标准。

### P1: SQLite metadata ledger becomes the normal OctoClaw store

目标：SQLite 接管 OctoClaw metadata truth，task-state 退为 mirror/projection。

改动：

1. `WorkContractStore` 默认走 SQLite metadata ledger。
2. `saveWorkContract()` 写 SQLite 后 best-effort project to task-state。
3. `loadWorkContract()` / `listWorkContractsBySession()` 默认读 SQLite；task-state 只作为 migration backfill/quarantine 输入，不参与正常读取。
4. 启动或首次访问时 best-effort backfill：
   - 从 task-state 中 embedded WorkContract 补入 SQLite。
   - 记录 backfill count / skipped / errors。
5. `OCTOCLAW_RUNTIME_LEDGER=off` 只允许测试/诊断使用，不作为生产 read fallback。

建议默认：

```text
OCTOCLAW_RUNTIME_LEDGER=metadata
```

如果不想新增 mode，可以直接把 `enforce` 作为目标默认；`shadow` 只允许作为一个迁移 PR 内的验证阶段，并随收口 PR 删除。

验收：

- 删除 task-state 后，WorkContract 仍可从 SQLite 读取。
- SQLite unavailable 时不会静默当无任务，而是 degraded diagnostic。
- 不新增 external sqlite dependency。

### P2: Projection builder owns task-state

目标：所有 status/read-model 都从统一 projection 生成。

改动：

1. 新增或收敛 `StatusProjectionBuilder`：
   - 输入：SQLite WorkContract/native refs、OpenClaw native bridge/API、runtime_events/replay tail。
   - 输出：task-state document + status packets。
2. 替换 direct task-state readers：
   - ACK watchdog。
   - conversation grounding。
   - status/details/queue。
   - delivery state display。
3. `readTaskStateDocumentDetailed()` 的 `parse_error/schema_mismatch/io_error` 进入 degraded projection。
4. `OCTOCLAW_TASK_STATE_REBUILD=1` 从手动 operator 变成 safe default：
   - missing: rebuild。
   - corrupt: quarantine + rebuild。
   - IO error: fail closed + degraded，不覆盖。

验收：

- 删除 `tmp/octopus/task-state.json` 后，status 可通过 rebuild 恢复。
- 写坏 task-state 后，不会变成空 task list。
- operator/status 能显示 `task_state_cache_degraded` 或 `projection_rebuilt`。

### P3: Remove completion file from planner path

目标：planner/native path 不再要求 child 写 completion file。

改动：

1. `buildSubagentSpawnMessage()` 删除 completion file requirement。
2. 删除 planner path 的 `scheduleChildCompletionFinalizer()` 调用。
3. 删除 child-finalizer recovery interval 的默认启动逻辑。
4. 删除 `OCTOCLAW_LEGACY_COMPLETION_FILE` 产品开关；迁移 smoke 完成后不再保留开关。
5. `completion_bindings` 改定位：
   - 短期 orphan recovery diagnostic。
   - 不再作为 planner normal completion gate。
   - 如果后续没有诊断价值，继续删除。

验收：

- planner delegate prompt 不再出现 `MUST write the result to this file`。
- planner delegate 不 schedule finalizer。
- native announce final 不产生 completion timeout。
- 旧 completion/finalizer 测试删除；需要读取历史文件的测试改成 migration import tests，且不覆盖 planner runtime path。

### P4: Remove delivery outbox from planner path

目标：删除 JSON delivery outbox 作为 runtime 恢复机制。

改动：

1. 删除 `queueOutboxDelivery()` 正常调用点。
2. 删除 `flushDeliveryOutbox()` interval 注册。
3. Slack/OpenClaw channel delivery result 写 SQLite/replay，由 projection builder 输出。
4. `delivery_outbox_queued` 仅作为历史 replay classifier 的既有事件名存在，不再由新 runtime 产生。

验收：

- planner native smoke 不生成 delivery outbox file entry。
- delivery failure 显示 degraded/pending，不伪装 delivered。
- 新任务不会写 delivery outbox。

### P5: Delete legacy spawn entrypoints

目标：只剩一个策略入口。

改动：

1. 删除 `octoclaw_spawn` tool registration。
2. 删除硬编码 model map。
3. 删除 `runtime.subagent.run()` fallback。
4. 删除 fake detached runtime registration。

验收：

- 普通 tool manifest 不暴露 `octoclaw_spawn`。
- route/model selection 只有一套 policy。
- planner smoke 不调用 `api.runtime.subagent.run()`。
- host missing detached runtime 不注册 fake no-op runtime。

### P6: Delete or move legacy code

目标：减少长期维护面。

删除：

- completion-file prompt builder。
- child-finalizer recovery loop。
- delivery outbox flush loop。
- legacy `octoclaw_spawn` independent model map。
- task-state direct update helpers that are no longer used by projection builder。
- duplicate status inference helpers that bypass native bridge/projection builder。
- fake detached runtime stub。
- direct subagent fallback branch。

迁移/审计例外：

- replay/eval classifiers can read old events but cannot drive runtime behavior。
- migration/backfill tools can exist until the migration PR is complete。

验收：

- 默认 runtime 不 import/start legacy loops。
- `rg` audit shows planner path has no direct `resolveWorkerCompletionPath()` dependency; historical migration modules are outside planner runtime path.
- line count and tool registrations shrink.

---

## 6. Feature Flag End State

建议目标默认：

```text
OCTOCLAW_SPAWN_BACKEND=planner
OCTOCLAW_RUNTIME_LEDGER=metadata/enforce-equivalent default
OCTOCLAW_TASK_STATE_REBUILD=1
```

这些 legacy flags 在目标状态应删除，而不是长期保留：

```text
OCTOCLAW_LEGACY_COMPLETION_FILE
OCTOCLAW_DISABLE_CHILD_FINALIZER
OCTOCLAW_DISABLE_DELIVERY_OUTBOX
OCTOCLAW_LEGACY_CLI_DELIVERY
```

迁移期可以采用三阶段，但 `shadow/off` 这类迁移开关必须随收口 PR 删除或降级为测试专用，不进入生产默认：

1. `shadow`: SQLite write-through + diagnostics，只用于一个迁移 PR 内验证。
2. `metadata`: WorkContract/native intent read path 默认 SQLite，执行生命周期仍 native。
3. `enforce`: SQLite unavailable 时 fail closed，不回退 task-state truth。

---

## 7. Test Matrix

### Unit tests

- `runtime-ledger` migrations are idempotent.
- `node:sqlite` unavailable returns degraded.
- WorkContract save/load/list uses SQLite when enabled.
- task-state corrupt is quarantined and rebuilt.
- projection builder maps native running/succeeded/failed/timed_out correctly.
- planner prompt excludes completion file requirement.
- no planner prompt contains completion file requirement.
- outbox queue is absent from new runtime path.
- `octoclaw_spawn` is not registered.
- fake detached runtime is not registered.
- `runtime.subagent.run()` fallback is unreachable.

### Hot-path tests

```text
octoclaw_dispatch
  -> NativeSpawnIntent persisted
  -> sessions_spawn args returned
  -> octoclaw_dispatch_confirm accepted
  -> WorkContract native refs stored
  -> status projection reads native refs
```

Required cases:

- new delegate task.
- status/provenance follow-up does not spawn.
- spawn accepted then native announce delivered.
- native run missing/degraded produces explicit anomaly.
- SQLite unavailable in enforce mode fails closed.
- task-state missing/corrupt does not erase active task.

### Slack smoke

- inbound reaction ACK still fast.
- no duplicate final.
- no completion timeout after native announce.
- no delivery outbox entry in planner path.
- final footer shows `route=delegate` and `via=native_announce`.

### Recovery tests

- Delete `task-state.json`, rebuild from SQLite/native refs.
- Corrupt `task-state.json`, quarantine + rebuild.
- Expire scheduler lease, crash recovery releases or requeues.
- Historical orphan completion is import-only and does not affect new runtime.

---

## 8. Metrics

Track before/after:

- `task_state_read_count`
- `task_state_write_count`
- `task_state_corrupt_count`
- `task_state_projection_rebuild_count`
- `ledger_open_degraded_count`
- `native_spawn_intent_create_count`
- `legacy_finalizer_scheduled_count`
- `legacy_completion_timeout_count`
- `legacy_outbox_queued_count`
- `planner_native_announce_delivered_count`
- dispatch accepted latency
- status render latency
- duplicate final count

Expected improvements:

- task-state writes drop to projection-only.
- planner finalizer scheduled count drops to zero.
- planner outbox queued count drops to zero.
- duplicate final / completion timeout regressions drop.
- status/grounding code has one projection source instead of several ad-hoc readers.

---

## 9. PR Slicing

### PR A: Docs and invariant tests

Scope:

- Add this plan.
- Document `native_spawn_intents` auxiliary table.
- Add tests that capture target defaults and current gaps.

Risk: low.

### PR B: SQLite metadata store default read path

Scope:

- WorkContract store defaults to SQLite metadata ledger.
- task-state becomes write-through projection.
- backfill from task-state.
- degraded diagnostics.

Risk: medium. Rollback is git revert of this PR; runtime must not carry task-state read fallback controlled by env.

### PR C: Projection builder and task-state rebuild

Scope:

- Central projection builder.
- Replace direct task-state readers in status/grounding/watchdog.
- default safe rebuild/quarantine.

Risk: medium-high because many surfaces read status.

### PR D: Planner no-completion-file path

Scope:

- Remove completion-file requirement from planner child prompt.
- Delete planner finalizer scheduling/recovery calls.
- Delete old completion/finalizer runtime tests or convert them to import-only migration tests.

Risk: medium. Requires native announce smoke.

### PR E: Delete delivery outbox runtime path

Scope:

- Delete outbox writes and interval from runtime path.
- Record delivery through native/channel projection.

Risk: medium. Requires Slack smoke.

### PR F: Legacy entrypoint deletion

Scope:

- Delete `octoclaw_spawn`.
- Delete direct `runtime.subagent.run()` fallback.
- Delete fake detached runtime registration.
- Delete unused legacy modules.

Risk: medium. Mostly breakage of obsolete entrypoints; acceptable only with fail-fast diagnostics and release notes.

---

## 10. Acceptance Criteria

The cleanup is complete when:

1. Planner/native delegate path can run end-to-end without completion file, child-finalizer, or delivery outbox.
2. WorkContract/native refs/spawn intents are stored in SQLite metadata ledger by default.
3. `task-state.json` can be deleted or corrupted without losing durable status truth.
4. Status, grounding, details, queue, and operator surfaces read one projection source.
5. `octoclaw_spawn` no longer exists as an independent policy/model path.
6. Fake detached runtime is not registered as real capability.
7. Legacy completion/outbox paths are deleted from new runtime.
8. Slack smoke shows no duplicate final, no legacy completion timeout, and preserved thread delivery.
9. Tests prove SQLite unavailable is explicit degraded/fail-closed, not silent no-task fallback.
10. Code search confirms planner path no longer imports or calls legacy finalizer/outbox modules.

---

## 11. Recommended First Step

Start with **PR A + PR B**:

1. Add invariant tests and schema documentation.
2. Make SQLite metadata ledger the default WorkContract/native intent store.
3. Keep task-state projection writes only as generated read-model, not compatibility truth.
4. Add backfill and degraded diagnostics.
5. Do not introduce new long-lived compatibility aliases or fallback runtime branches.

This creates the stable base needed for the later cleanup. Removing finalizer/outbox before the metadata/projection layer is reliable would make recovery and status harder to reason about.

---

## 12. OpenCode / GLM-5 执行交付包

本节是给 OpenCode / GLM-5 的直接执行说明。不要只把前面的路线当背景读完后自由发挥；实现必须按这里的工作包切片推进，每个工作包只能改自己的 write scope，并把测试结果回填到 `openspec/changes/runtime-convergence-cleanup-0.5.x/tasks.md`。

### 12.1 必读文件

实现前必须读：

1. 本文档。
2. [`openspec/README.md`](../openspec/README.md)。
3. [`openspec/changes/runtime-convergence-cleanup-0.5.x/proposal.md`](../openspec/changes/runtime-convergence-cleanup-0.5.x/proposal.md)。
4. [`openspec/changes/runtime-convergence-cleanup-0.5.x/design.md`](../openspec/changes/runtime-convergence-cleanup-0.5.x/design.md)。
5. [`openspec/changes/runtime-convergence-cleanup-0.5.x/tasks.md`](../openspec/changes/runtime-convergence-cleanup-0.5.x/tasks.md)。
6. [`openspec/changes/planner-confirm-0.5.0-refactor/design.md`](../openspec/changes/planner-confirm-0.5.0-refactor/design.md)，只作为历史背景；其中关于保留 rollback flags 的旧表述已经被本计划覆盖。
7. [`openspec/changes/planner-confirm-0.5.0-refactor/tasks.md`](../openspec/changes/planner-confirm-0.5.0-refactor/tasks.md)，用于确认 PC11 还有哪些旧路径未删。

### 12.2 不变量

这些是不允许被工作包改坏的硬约束：

1. OpenClaw native `sessions_spawn` / run / flow / subagent registry 是执行生命周期真相。
2. WorkContract 是语义、委派、handoff、continuity、route seal、native refs 的 OctoClaw metadata truth。
3. `NativeSpawnIntent` 是 planner/confirm 握手 truth；`spawnExecuted=true` 必须有 accepted native run evidence。
4. `task-state.json` 是 generated read-model cache，不是执行 truth，也不是 WorkContract 正常 read path。
5. ACK/status/details/grounding/dashboard/footer 都是 projection，不允许创建新的执行事实。
6. Native child completion delivery 由 OpenClaw native announce / channel delivery 处理；OctoClaw 不再用 completion file / child-finalizer / delivery outbox 作为正常 runtime。
7. 不允许把 raw child transcript 注入 parent context。
8. 不新增默认 resident runner、warm worker pool、tmux/ClawTeam core dependency、direct SDK spawn 主路径。
9. 不新增长期 alias / fallback / compatibility flag。迁移工具可以短期存在，但必须在任务里有删除条件。

### 12.3 当前代码锚点

主要修改会集中在这些文件：

```text
extensions/octoclaw-runtime/src/config/index.ts
extensions/octoclaw-runtime/src/runtime-ledger/feature-flags.ts
extensions/octoclaw-runtime/src/runtime-ledger/index.ts
extensions/octoclaw-runtime/src/runtime-ledger/projection-rebuild.ts
extensions/octoclaw-runtime/src/work-contract/store.ts
extensions/octoclaw-runtime/src/state/task-state-store.ts
extensions/octoclaw-runtime/src/state/native-status-projector.ts
extensions/octoclaw-runtime/src/tools/registration.ts
extensions/octoclaw-runtime/src/extension-entry.ts
extensions/octoclaw-runtime/src/delegate/child-finalizer.ts
extensions/octoclaw-runtime/src/delivery/delivery-outbox.ts
extensions/octoclaw-runtime/src/resolve/env.ts
packages/octoclaw-contracts/src/work-contract.ts
tools/octoclawctl/src/**
```

相关测试集中在：

```text
extensions/octoclaw-runtime/src/config/index.test.ts
extensions/octoclaw-runtime/src/runtime-ledger/__tests__/*.test.ts
extensions/octoclaw-runtime/src/runtime-ledger/runtime-ledger-hot-path.test.ts
extensions/octoclaw-runtime/src/work-contract/store.test.ts
extensions/octoclaw-runtime/src/state/task-state-error-handling.test.ts
extensions/octoclaw-runtime/src/state/native-status-projector.test.ts
extensions/octoclaw-runtime/src/tools/registration-planner.test.ts
extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts
extensions/octoclaw-runtime/src/extension-entry.test.ts
extensions/octoclaw-runtime/src/delegate/child-finalizer.test.ts
extensions/octoclaw-runtime/src/delivery/delivery-outbox.test.ts
tools/octoclawctl/src/slack-acceptance/slack-acceptance.test.ts
```

### 12.4 OpenCode 运行方式

建议一次只派一个工作包。给 worker 的通用提示词：

```text
Task: Implement WP-<id> from docs/octoclaw-runtime-convergence-cleanup-plan-2026-05-07.md and openspec/changes/runtime-convergence-cleanup-0.5.x/tasks.md.

Read first:
- docs/octoclaw-runtime-convergence-cleanup-plan-2026-05-07.md
- openspec/README.md
- openspec/changes/runtime-convergence-cleanup-0.5.x/proposal.md
- openspec/changes/runtime-convergence-cleanup-0.5.x/design.md
- openspec/changes/runtime-convergence-cleanup-0.5.x/tasks.md

Constraints:
- Delete-first convergence. Do not preserve old runtime behavior behind permanent flags.
- Native TaskFlow/sessions_spawn owns execution lifecycle truth.
- WorkContract/SQLite owns OctoClaw metadata truth.
- task-state.json is projection only.
- Do not touch files outside the WP write scope without reporting why first.
- Do not commit. Report changed files, tests run, failures, and remaining risks.
```

OpenCode 完成后，Codex/人工 review 必须检查：

1. `git diff --stat` 是否只覆盖对应 write scope。
2. 是否出现新的 `legacy` / `fallback` / `compatibility` / `alias` / `rollback flag`。
3. 是否把 `task-state.json` 又当成 truth 或正常 read fallback。
4. 是否绕过 `octoclaw_dispatch -> sessions_spawn -> octoclaw_dispatch_confirm`。
5. 是否新增 OpenClaw internal import 或 direct SDK spawn 主路径。
6. 是否更新 `openspec/changes/runtime-convergence-cleanup-0.5.x/tasks.md` 中对应 checklist 和测试证据。

### 12.5 工作包 A：Docs + invariant tests

目标：先把删除边界钉死，防止后续 worker 又把旧路径包装成兼容层。

Write scope:

```text
docs/octoclaw-runtime-convergence-cleanup-plan-2026-05-07.md
openspec/changes/runtime-convergence-cleanup-0.5.x/**
extensions/octoclaw-runtime/src/tools/registration-planner.test.ts
extensions/octoclaw-runtime/src/config/index.test.ts
extensions/octoclaw-runtime/src/runtime-ledger/__tests__/feature-flags.test.ts
```

实现要求：

1. 测试证明 planner prompt 默认不要求 completion file。
2. 测试证明 planner backend 默认不 schedule child finalizer。
3. 测试证明 delivery outbox 默认不作为 planner path fallback。
4. 测试证明 `octoclaw_spawn` 被标记为 delete target；如果还没删，测试必须明确记录 current gap。
5. 测试证明 `OCTOCLAW_RUNTIME_LEDGER=off` 不应是生产默认目标。

推荐命令：

```bash
pnpm vitest run extensions/octoclaw-runtime/src/config/index.test.ts extensions/octoclaw-runtime/src/tools/registration-planner.test.ts extensions/octoclaw-runtime/src/runtime-ledger/__tests__/feature-flags.test.ts
pnpm --filter @octoclaw/runtime run check
```

验收：

- OpenSpec change 存在且 proposal/design/tasks 三者一致。
- 所有 delete target 都在 tasks.md 有对应工作包。
- 当前 gap 可以暂时是 failing/todo test，但不能被描述成目标行为。

### 12.6 工作包 B：SQLite metadata ledger 默认化

目标：`WorkContractStore` 默认使用 SQLite metadata ledger，`task-state.json` 只做 projection write 和 migration backfill 输入。

Write scope:

```text
extensions/octoclaw-runtime/src/runtime-ledger/feature-flags.ts
extensions/octoclaw-runtime/src/runtime-ledger/index.ts
extensions/octoclaw-runtime/src/runtime-ledger/shadow.ts
extensions/octoclaw-runtime/src/runtime-ledger/projection-rebuild.ts
extensions/octoclaw-runtime/src/work-contract/store.ts
extensions/octoclaw-runtime/src/state/task-state-store.ts
extensions/octoclaw-runtime/src/runtime-ledger/__tests__/*.test.ts
extensions/octoclaw-runtime/src/work-contract/store.test.ts
```

禁止：

1. 不改 OpenClaw native SQLite schema。
2. 不把 SQLite 当 run lifecycle truth。
3. 不保留 `task-state` 正常 read fallback。
4. 不把 SQLite unavailable 静默转成 no-task。

实现要求：

1. `resolveRuntimeLedgerFlag()` 目标默认从 `off` 变为 `metadata` 或 enforce-equivalent。若不新增枚举，直接让默认行为等价 `enforce`。
2. `saveWorkContract()` 默认写 SQLite，并 best-effort 写 projection。
3. `loadWorkContract()` / `listWorkContractsBySession()` 默认读 SQLite。
4. task-state backfill 只在 migration/import 工具或显式一次性路径运行，且记录 degraded/backfill event。
5. SQLite unavailable 时返回 degraded/fail-closed diagnostic，不返回空任务列表。
6. `native_spawn_intents` 在文档/测试里归类为 spawn planner 辅助表，不是 N1 六张 canonical runtime tables。

推荐命令：

```bash
pnpm vitest run extensions/octoclaw-runtime/src/runtime-ledger/__tests__/runtime-ledger.test.ts extensions/octoclaw-runtime/src/runtime-ledger/__tests__/projection-rebuild.test.ts extensions/octoclaw-runtime/src/runtime-ledger/__tests__/feature-flags.test.ts extensions/octoclaw-runtime/src/work-contract/store.test.ts
pnpm --filter @octoclaw/runtime run check
```

验收：

- 删除或损坏 `task-state.json` 不会导致 WorkContract 丢失。
- SQLite 打不开时有 explicit degraded/fail-closed 结果。
- `rg "loadWorkContractFromTaskState" extensions/octoclaw-runtime/src/work-contract/store.ts` 只能出现在 migration/import 或测试专用路径。

### 12.7 工作包 C：Projection builder owns task-state

目标：status/details/grounding/watchdog 统一从 projection builder 获取 read-model，禁止各模块各自解析 task-state 当真相。

Write scope:

```text
extensions/octoclaw-runtime/src/runtime-ledger/projection-rebuild.ts
extensions/octoclaw-runtime/src/state/task-state-store.ts
extensions/octoclaw-runtime/src/state/native-status-projector.ts
extensions/octoclaw-runtime/src/conversation-grounding.ts
extensions/octoclaw-runtime/src/ack/*
extensions/octoclaw-runtime/src/tools/registration.ts
extensions/octoclaw-runtime/src/im-status-renderer.ts
extensions/octoclaw-runtime/src/runtime-ledger/__tests__/projection-rebuild.test.ts
extensions/octoclaw-runtime/src/state/task-state-error-handling.test.ts
extensions/octoclaw-runtime/src/state/native-status-projector.test.ts
```

实现要求：

1. 新增或收敛一个 `StatusProjectionBuilder`，输入为 SQLite WorkContract/native refs、OpenClaw native bridge/API、runtime_events/replay tail。
2. projection builder 输出 `task-state.json` document、status packet、grounding packet。
3. `readTaskStateDocumentDetailed()` 的 `parse_error/schema_mismatch/io_error` 进入 degraded projection，不覆盖成空文件。
4. status/details/queue/grounding/watchdog 不直接把 task-state 解析结果当 truth。
5. projection rebuild 是 safe default：missing rebuild，corrupt quarantine + rebuild，IO error fail closed。

推荐命令：

```bash
pnpm vitest run extensions/octoclaw-runtime/src/runtime-ledger/__tests__/projection-rebuild.test.ts extensions/octoclaw-runtime/src/state/task-state-error-handling.test.ts extensions/octoclaw-runtime/src/state/native-status-projector.test.ts extensions/octoclaw-runtime/src/ack/ack-guard.test.ts extensions/octoclaw-runtime/src/conversation-grounding.test.ts
pnpm --filter @octoclaw/runtime run check
```

验收：

- 删除 `tmp/octopus/task-state.json` 后 status 可从 SQLite/native refs rebuild。
- 写坏 task-state 后不会变成空 task list。
- projection 标记 `task_state_cache_degraded` 或 `projection_rebuilt`。
- `rg "readTaskStateDocument\\(|readTaskStateRecords\\(" extensions/octoclaw-runtime/src` 不再显示 status/grounding/watchdog 直接 truth 读取。

### 12.8 工作包 D：删除 completion file / child-finalizer planner 路径

目标：planner/native path 不再要求 worker 写 completion file，不 schedule finalizer，不用 completion timeout 判定 native child 完成。

Write scope:

```text
extensions/octoclaw-runtime/src/tools/registration.ts
extensions/octoclaw-runtime/src/delegate/child-finalizer.ts
extensions/octoclaw-runtime/src/resolve/env.ts
extensions/octoclaw-runtime/src/config/index.ts
extensions/octoclaw-runtime/src/config/index.test.ts
extensions/octoclaw-runtime/src/delegate/child-finalizer.test.ts
extensions/octoclaw-runtime/src/tools/registration-planner.test.ts
extensions/octoclaw-runtime/src/extension-entry.test.ts
```

禁止：

1. 不新增 `OCTOCLAW_KEEP_COMPLETION_FILE` / `OCTOCLAW_LEGACY_COMPLETION_FILE` 这种长期开关。
2. 不把 completion file requirement 改成软提示后继续存在。
3. 不让 finalizer 失败继续 queue delivery outbox。

实现要求：

1. `buildSubagentSpawnMessage()` 不再生成 completion file path/template/requirement。
2. planner result 不包含 `expectedPath: resolveWorkerCompletionPath(...)`。
3. planner dispatch path 不调用 `scheduleChildCompletionFinalizer()`。
4. startup 不注册 child-finalizer recovery loop。
5. `OCTOCLAW_LEGACY_COMPLETION_FILE` 从产品配置删除；如果历史 import 测试还需要，可在测试 fixture 内构造文件，不走 runtime config。
6. `completion_bindings` 不再作为 planner normal completion gate；若保留，只能作为 migration/orphan diagnostic。

推荐命令：

```bash
pnpm vitest run extensions/octoclaw-runtime/src/tools/registration-planner.test.ts extensions/octoclaw-runtime/src/delegate/child-finalizer.test.ts extensions/octoclaw-runtime/src/config/index.test.ts extensions/octoclaw-runtime/src/extension-entry.test.ts
pnpm --filter @octoclaw/runtime run check
```

验收：

- `rg "MUST write the result to this file|resolveWorkerCompletionPath|scheduleChildCompletionFinalizer" extensions/octoclaw-runtime/src/tools/registration.ts` 不命中 planner path。
- native announce final 不产生 `completion_file_timeout`。
- planner smoke 不生成 `.octoclaw/completions/*.completion.json`。

### 12.9 工作包 E：删除 delivery outbox runtime path

目标：删除 JSON delivery outbox 作为 runtime 恢复机制；delivery metadata 只进 SQLite/replay/projection。

Write scope:

```text
extensions/octoclaw-runtime/src/delivery/delivery-outbox.ts
extensions/octoclaw-runtime/src/core/delivery/outbox.ts
extensions/octoclaw-runtime/src/delegate/child-finalizer.ts
extensions/octoclaw-runtime/src/extension-entry.ts
extensions/octoclaw-runtime/src/config/index.ts
extensions/octoclaw-runtime/src/delivery/delivery-outbox.test.ts
extensions/octoclaw-runtime/src/core/delivery/outbox.test.ts
extensions/octoclaw-runtime/src/extension-entry.test.ts
extensions/octoclaw-runtime/src/im/slack/slack-adapter.test.ts
```

实现要求：

1. 删除 `flushDeliveryOutbox()` startup interval 注册。
2. 删除 `queueOutboxDelivery()` 正常调用点。
3. delivery failure 进入 SQLite/replay/projection，状态是 `delivery_pending` / `degraded`，不能伪装 delivered。
4. 新 runtime 不再写 delivery outbox 文件。
5. 历史 outbox replay 读取如果还需要，只能放在 migration/import module，不能被 runtime 调用。

推荐命令：

```bash
pnpm vitest run extensions/octoclaw-runtime/src/delivery/delivery-outbox.test.ts extensions/octoclaw-runtime/src/core/delivery/outbox.test.ts extensions/octoclaw-runtime/src/extension-entry.test.ts extensions/octoclaw-runtime/src/im/slack/slack-adapter.test.ts
pnpm --filter @octoclaw/runtime run check
```

验收：

- `rg "flushDeliveryOutbox|queueOutboxDelivery" extensions/octoclaw-runtime/src` 不命中新 runtime path。
- planner native smoke 不生成 outbox file entry。
- Slack smoke 无 duplicate final，footer still says `via=native_announce` when applicable。

### 12.10 工作包 F：删除 legacy entrypoints 和 fake runtime

目标：清理用户/工具可见的旧入口，避免主 agent 或用户继续绕过 planner/dispatch。

Write scope:

```text
extensions/octoclaw-runtime/src/tools/registration.ts
extensions/octoclaw-runtime/src/extension-entry.ts
extensions/octoclaw-runtime/src/adapter/detached-task-runtime.ts
extensions/octoclaw-runtime/src/adapter/detached-task-runtime-host.ts
extensions/octoclaw-runtime/src/adapter/detached-task-runtime.test.ts
extensions/octoclaw-runtime/src/tools/manifest-contracts.test.ts
extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts
extensions/octoclaw-runtime/src/resolve/work-contract-coverage.test.ts
README.zh-CN.md
```

实现要求：

1. 删除 `octoclaw_spawn` tool registration。
2. 删除 `octoclaw_spawn` 独立 model map / policy path。
3. system prompt / tool policy 不再允许 `octoclaw_spawn`。
4. 旧调用应 fail fast，提示使用 `octoclaw_dispatch`，不要 alias 转发。
5. 删除 planner backend 的 `runtime.subagent.run()` fallback。
6. 删除 fake detached runtime stub 注册；host 没有真实 runtime 时 fail closed。

推荐命令：

```bash
pnpm vitest run extensions/octoclaw-runtime/src/tools/manifest-contracts.test.ts extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts extensions/octoclaw-runtime/src/adapter/detached-task-runtime.test.ts extensions/octoclaw-runtime/src/resolve/work-contract-coverage.test.ts
pnpm --filter @octoclaw/runtime run check
```

验收：

- `octoclaw_spawn` 不出现在 tool manifest。
- `rg "octoclaw_spawn" extensions/octoclaw-runtime/src` 只允许出现在 migration/release-note/error-message 测试里。
- `rg "runtime\\.subagent\\.run" extensions/octoclaw-runtime/src` 不命中 planner runtime path。
- fake detached runtime 不注册成可用 capability。

### 12.11 工作包 G：end-to-end smoke 和收口审计

目标：所有删除工作完成后跑一轮本地和 Slack/acceptance smoke，证明不是只删了代码而是 live path 仍可用。

Write scope:

```text
tools/octoclawctl/src/slack-acceptance/**
reports/**
docs/octoclaw-runtime-convergence-cleanup-plan-2026-05-07.md
openspec/changes/runtime-convergence-cleanup-0.5.x/tasks.md
```

推荐命令：

```bash
pnpm vitest run extensions/octoclaw-runtime/src/tools/registration-planner.test.ts extensions/octoclaw-runtime/src/extension-entry.test.ts extensions/octoclaw-runtime/src/state/native-status-projector.test.ts extensions/octoclaw-runtime/src/runtime-ledger/__tests__/projection-rebuild.test.ts
pnpm test
pnpm check
```

如果有真实 Slack 环境，再跑现有 acceptance harness，并记录：

```text
thread ts
WorkContract id
spawnIntentId
runId
childSessionKey
native_announce_completion_matched count
completion_file_timeout count
legacy_outbox_queued count
duplicate final count
footer route/via
```

验收：

- completion file timeout = 0。
- legacy outbox queued = 0。
- duplicate final = 0。
- final delivery provenance 使用 native announce。
- `task-state.json` 删除/损坏后 status 可 rebuild。
- `rg` audit 证明 planner path 不再 import/call legacy finalizer/outbox/spawn modules。

### 12.12 提交边界

建议提交顺序：

1. `docs: add runtime convergence cleanup openspec`
2. `test: add runtime convergence invariant tests`
3. `fix: default work contracts to runtime ledger`
4. `fix: centralize task-state projection rebuild`
5. `fix: remove completion file planner path`
6. `fix: remove delivery outbox runtime path`
7. `fix: remove legacy spawn entrypoints`
8. `test: add runtime convergence smoke evidence`

不要把 B-F 合成一个大提交。每个提交必须能回答：

1. 删除了哪条旧路径？
2. 替代 truth/source 是什么？
3. 哪些测试证明 live path 仍然工作？
4. 如果失败，怎么通过 git revert 单独回滚这个提交？
