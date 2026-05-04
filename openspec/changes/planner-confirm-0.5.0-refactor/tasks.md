# Tasks

## PC0 OpenSpec Setup

- [x] Create this change and keep proposal/design/spec/tasks aligned.
- [x] Add every implementation slice to this file before code starts.
- [ ] Do not merge code that cannot point to a task slice and acceptance gate.

## PC1 Feature Flags And Config

Owner: GLM-5.1 worker.

Write scope:

- `extensions/octoclaw-runtime/src/config/*`
- related config tests only

Forbidden scope:

- `extensions/octoclaw-runtime/src/tools/registration.ts`
- `extensions/octoclaw-runtime/src/extension-entry.ts`

Tasks:

- [x] Add typed resolver for `OCTOCLAW_SPAWN_BACKEND=planner|legacy|off`.
- [x] Add planner allowlist and `OCTOCLAW_SPAWN_INTENT_TTL_MS` parsing.
- [x] Add legacy disable flags for completion file, child finalizer, delivery outbox, and runtime ledger mode.
- [x] Unit tests cover defaults, invalid values, allowlist matching, and rollback flags.

## PC2 NativeSpawnIntent Store

Owner: GLM-5.1 worker, leader review required.

Write scope:

- `extensions/octoclaw-runtime/src/delegate/native-spawn-intent.ts`
- `extensions/octoclaw-runtime/src/delegate/native-spawn-intent-store.ts`
- `extensions/octoclaw-runtime/src/delegate/native-spawn-intent.test.ts`
- metadata-store migration files only if needed

Forbidden scope:

- scheduler queue semantics
- completion binding semantics
- delivery outbox semantics

Tasks:

- [x] Define `NativeSpawnIntent` and `NativeSpawnIntentStatus`.
- [x] Implement canonical JSON/hash for the exact `sessions_spawn` args.
- [x] Implement TTL expiration, `planned -> spawn_call_started -> accepted|failed|expired` transitions.
- [x] Implement idempotent same-`runId` confirm and conflict on different `runId`.
- [x] Tests cover hash stability, mismatches, TTL, duplicate confirm, and conflict.

## PC3 Dispatch Planner Output

Owner: Codex leader / strong model.

Write scope:

- `extensions/octoclaw-runtime/src/tools/registration.ts`
- new `extensions/octoclaw-runtime/src/delegate/spawn-plan.ts` if useful
- focused tests for dispatch planner mode

Tasks:

- [x] In planner backend, `octoclaw_dispatch` returns `requires_native_spawn` and compact `sessionsSpawnArgs`.
- [x] It does not call legacy spawn, scheduler queue, completion binding, or child finalizer.
- [x] It does not send delegate accepted ACK.
- [x] It still enforces WorkContract admission: new work, expected deliverable, no execution follow-up spawn.
- [x] Tests cover planner output, admission rejection, and compact payload size.

## PC4 `sessions_spawn` Gate

Owner: Codex leader / strong model.

Write scope:

- `extensions/octoclaw-runtime/src/extension-entry.ts`
- `extensions/octoclaw-runtime/src/delegate/native-spawn-gate.ts`
- `extensions/octoclaw-runtime/src/delegate/native-spawn-gate.test.ts`

Tasks:

- [x] Gate only native tool name `sessions_spawn`.
- [x] Block without pending intent.
- [x] Block expired intent.
- [x] Block canonical args hash mismatch.
- [x] Block status/provenance/execution follow-up spawn.
- [x] On match, move intent to `spawn_call_started` and allow native call.
- [x] Tests cover all block reasons and one allowed path.

## PC5 `octoclaw_dispatch_confirm`

Owner: Codex leader / strong model.

Write scope:

- `extensions/octoclaw-runtime/src/delegate/native-spawn-confirm.ts`
- `extensions/octoclaw-runtime/src/tools/registration.ts` (confirm tool registration only)
- `extensions/octoclaw-runtime/src/delegate/native-spawn-confirm.test.ts`
- tool registration wiring

Tasks:

- [x] Add confirm tool input schema.
- [x] Require matching intent/workContract/session.
- [x] Require non-empty `runId` for accepted confirm.
- [x] Treat `childSessionKey` as ref, not spawn evidence.
- [x] Write WorkContract native refs only after accepted confirm.
- [x] Send delegate accepted ACK only after accepted confirm.
- [x] Tests cover missing runId, error confirm, same-run idempotency, different-run conflict, and ACK timing.

## PC6 WorkContract Native Refs

Owner: GLM-5.1 worker, leader schema review required.

Write scope:

- `packages/octoclaw-contracts/src/work-contract.ts`
- `extensions/octoclaw-runtime/src/work-contract/*`
- projector tests

Tasks:

- [x] Add `openclawRunId`, `childSessionKey`, `spawnIntentId`, `spawnBackend`, and spawn mode refs.
- [x] Fix WorkContract ID collision: ID must include turn/message/route-seal entropy and must not be `stableId(sessionKey, userAsk)` only.
- [x] Ensure refs are metadata, not execution status.
- [x] Tests prove status projection does not advance from WorkContract alone.

## PC7 Legacy Runtime Disable On Planner Path

Owner: GLM-5.1 worker.

Write scope:

- `extensions/octoclaw-runtime/src/delegate/child-finalizer.ts`
- `extensions/octoclaw-runtime/src/runtime-ledger/completion-binding.ts`
- `extensions/octoclaw-runtime/src/delivery/delivery-outbox.ts`
- startup/wiring files needed for flags

Tasks:

- [x] Planner path does not start child finalizer recovery.
- [x] Planner path does not create completion binding.
- [x] Planner path does not write delivery outbox for completion announce.
- [x] Legacy flags restore old path for rollback.
- [x] Tests cover planner disabled behavior and legacy fallback behavior.

## PC8 Native Status Projector

Owner: GLM-5.1 worker, leader fallback review required.

Write scope:

- `extensions/octoclaw-runtime/src/state/native-status-projector.ts`
- related status projector tests

Tasks:

- [x] Resolve status by `openclawRunId` with `runtime.tasks.runs.fromToolContext(ctx).resolve()`.
- [x] Resolve flow status by `openclawFlowId` with `runtime.tasks.flows.fromToolContext(ctx).resolve()`.
- [x] Use `findLatest()` only as UI fallback, not execution authorization.
- [x] Treat missing/corrupt `task-state.json` as degraded display, not empty success.
- [x] Tests cover found, missing, lost/unknown, degraded cache, and no-spawn follow-up.

## PC9 ACK And Footer Guardrails

Owner: GLM-5.1 worker for mechanical pieces; leader reviews delegate ACK boundary.

Write scope:

- `extensions/octoclaw-runtime/src/ack/*`
- `extensions/octoclaw-runtime/src/im/projection-footer.ts`
- focused wiring needed for confirm ACK

Tasks:

- [x] ACK dedupe key includes stage/surface/target where needed.
- [x] Slow reply text ACK is reply-route only.
- [x] Delegate accepted ACK fires only after accepted confirm.
- [x] Footer defaults off and never appends to ACK/progress/no-reply packets.
- [x] Tests cover fast reply, slow reply, failed spawn, accepted confirm, and footer off.

## PC10 Integration And Acceptance Tests

Owner: mixed. Leader defines cases; GLM-5.1/cheap workers can implement fixtures.

Tasks:

- [x] No pending intent blocks `sessions_spawn`.
- [x] Expired intent blocks `sessions_spawn`.
- [x] Args hash mismatch blocks `sessions_spawn`.
- [x] Accepted confirm without runId fails closed.
- [x] Confirm success writes native refs and sends one delegate ACK.
- [x] Child completion without `.completion.json` uses native announce and does not duplicate final message.
- [x] Status follow-up does not spawn.
- [x] Planner path does not write scheduler queue, completion binding, or delivery outbox.

## PC11 Legacy Default-Path Removal

Owner: Codex leader after 0.5.0 Must+Should acceptance. This is 0.5.x immediate, not a 0.5.0 release gate.

Tasks:

- [ ] Remove or archive legacy scheduler queue usage from the default planner/native path.
- [ ] Remove completion file prompt requirement from the default planner/native path.
- [ ] Remove child-finalizer/completion-file timeout from native announce final delivery.
- [ ] Remove delivery outbox from the Slack/native completion announce path.
- [ ] Keep explicit legacy backend rollback notes until 0.5.x is stable.
- [x] Real Slack smoke proves no `completion_file_timeout` after `native_announce_completion_matched`.


## PC12 Speed And Responsiveness

Owner: leader for architecture; GLM-5.1 can implement focused fixtures/tests.

Write scope:

- `extensions/octoclaw-runtime/src/ack/*`
- `extensions/octoclaw-runtime/src/extension-entry.ts`
- `extensions/octoclaw-runtime/src/im/projection-footer.ts`
- `extensions/octoclaw-runtime/src/delegate/native-spawn-intent-store.ts`
- focused tests and Slack acceptance harness config

Tasks:

- [x] SR-P0 neutral inbound ACK: Slack reaction/text appears within 1-5s and does not claim delegation or spawn success.
- [x] SR-P0 neutral ACK is route-independent and does not depend on `decision.latency_ack.required`, route commit, or a non-OctoClaw tool name.
- [x] SR-P0 target resolution uses original inbound Slack anchor (`channel/message.ts/thread_ts`), not post-policy state; `no_valid_thread_target` is covered by tests.
- [x] SR-P1 startup-cost-aware delegation uses runtime-derived buckets: `must_reply/main_fast_path`, `must_delegate`, and `budgeted_main_then_delegate`.
- [x] SR-P1 short tasks, simple status/provenance follow-up, and one-step fresh lookup stay on main fast path by default.
- [x] SR-P1 `fresh_live_lookup`, `conversation_control.route_hint=delegate`, and `fast_first_response` are downgraded from hard delegate signals; none can force delegate alone.
- [x] SR-P1 hard delegate signals still win: explicit background/subagent/parallel request, code edits, tests/builds, long commands, multi-step tools, review/validation, or work that clearly cannot fit the fixed 30s main execution budget.
- [x] SR-P1 explicit-delegate keyword matching does not treat bare mentions of `opencode`, `glm`, model names, or tools as hard delegate unless the user asks them to do work.
- [x] SR-P1 `budgeted_main_then_delegate` uses a fixed 30s soft main execution budget: expiry records `budgeted_main_escalated_pending`, late final records `budgeted_main_completed_late` without spawn, and the next ordinary tool/prompt boundary escalates through `octoclaw_dispatch` with replay metrics.
- [x] SR-P1 rule router, local judge, cheap LLM judge, route hints, and AGENTS/system prompt share the same two-class-judge plus runtime-derived-bucket semantics.
- [x] SR-P1 judge/replay output records runtime-derived `decision_bucket`/`startup_cost_policy` plus judge cost signals `confidence`, `duration_hint`, `tool_need_hint`, `scope`, `evidence_required`, and `reason_codes`; judge-provided `decision_bucket` is telemetry only.
- [x] SR-P1 false-delegate cases are covered by tests/replay fixtures, including `fresh_live_lookup` no longer forcing delegate by itself.
- [x] SR-P1 false-reply cases are covered by tests/replay fixtures so explicit background work, code/test/edit, multi-step tools, review, and validation are not swallowed by main fast path.
- [ ] SR-P2 planner/native chain is slimmed so real delegated route commit to `sessions_spawn_intent_allowed` is p95 <= 30s in real Slack smoke. This remains a 0.5.x performance target, not a 0.5.0 release blocker.
- [x] SR-P2 hard confirm remains strict: no `planned -> accepted`, no direct spawn, no delegate ACK before confirm.
- [x] SR-P2 child spawn profile uses only current OpenClaw capabilities: explicit `context=isolated`, `lightContext=true`, bounded child prompt, fast/cheap model defaults, conservative `thinking`/timeout.
- [ ] SR-P2 child-start metrics are recorded for observation, but 0.5.0 does not block on accepted-to-stream-ready <= 10s.
- [x] SR-P2 SQLite/native refs are used as footer/status fast path; state transitions are atomic or covered by race tests.
- [ ] SR-P2 NativeSpawnIntent authorization/confirm transitions surface SQLite busy/locked retry/backoff/replay evidence and do not silently fall back to no task/no spawn.
- [x] SR-P2 native child final debug footer shows `route=delegate` and `via=subagent` or `via=native_announce`, not `route=reply | via=policy`.
- [x] Real Slack smoke records neutral ACK latency, main-fast-path/delegate route decision, spawn allowed latency, accepted latency, child progress/final latency, and footer route/provenance.

Evidence 2026-05-03:

- Real Slack planner-native smoke artifact: `/tmp/planner-native-neutral-20260503T000851Z/slack-acceptance-2026-05-03-00-18-27.{json,md}`.
- Thread `1777767322.479309`, spawnIntentId `nsp_mop0t3hb_a0f02188`, WorkContract `wc-357d3206b1461735`, runId `d8b58add-079b-4453-bbb4-9cec485d1d14`, childSessionKey `agent:main:subagent:e6172361-6e2f-42ef-9bad-a13414aab216`.
- Harness: overall `pass`; neutralAckMs `5215`; acceptedAckMs `93606`; finalMs `183847`; footer `route=delegate | ... | via=native_announce`.
- Replay: `neutral_inbound_ack` before route commit, `sessions_spawn_intent_allowed`, `spawn_started`, `native_announce_completion_matched`, `native_announce_final_delivered`, and no `completion_file_timeout` for `wc-357d3206b1461735`.
- SQLite native intent row is `accepted` with non-empty runId/childSessionKey; completion binding and scheduler queue have no row for this WorkContract after native announce.
- Latest deployed PC12 neutral ACK smoke artifacts:
  - `/tmp/pc12-neutral-ack-20260503T021244Z-1/slack-acceptance-2026-05-03-04-17-06.{json,md}`
  - `/tmp/pc12-neutral-ack-20260503T041747Z-2/slack-acceptance-2026-05-03-04-21-06.{json,md}`
- Latest two-sample neutral ACK evidence: `3087ms` and `3234ms`; nearest-rank p95/max `3234ms`, both within the 5s SR-P0 target.
- Latest anchors: `anchorSource=ctx`, `fallbackUsed=false` in both runs; unit coverage separately proves event anchor and fallback-history behavior.
- Latest native ids:
  - thread `1777781625.003979`, WorkContract `wc-1c9f06fadf8a7e7c`, spawnIntent `nsp_mop9blwy_04d416f6`, runId `8a6f5cda-e126-4f89-8314-0cee1dc05f54`, childSession `agent:main:subagent:f5d352e7-35fb-4064-8665-eef89ae6d9f8`
  - thread `1777781889.092179`, WorkContract `wc-7e149f9468e61a1e`, spawnIntent `nsp_mop9h8sz_e63c32fe`, runId `70cbff9c-fc70-4f3e-a416-c444b65d6cb5`, childSession `agent:main:subagent:12efc693-989b-4e4d-b34d-970035e6ae43`
- Latest stage timing evidence remains a PC12 follow-up, not a completed optimization: accepted ACK is still `89865ms` / `112168ms`; `sessions_spawn_intent_allowed` is `80844ms` / `80731ms`; `dispatch_confirm` is `90394ms` / `112677ms`.
- Latest final delivery evidence: `completion_file_timeout=0` in both reports, final footer `route=delegate | ... | via=native_announce`, and each transcript has exactly one neutral ACK, one accepted ACK, and one final.
- Focused verification after merging `origin/refactor/0.4.0-stable` through `7015abf`: `git diff --check`, `./node_modules/.bin/tsc --build extensions/octoclaw-runtime/tsconfig.json`, and `./node_modules/.bin/vitest run extensions/octoclaw-runtime/src/delegate/native-spawn-intent.test.ts extensions/octoclaw-runtime/src/extension-entry.test.ts extensions/octoclaw-runtime/src/extension-entry-neutral-ack.test.ts extensions/octoclaw-runtime/src/tools/registration-planner.test.ts extensions/octoclaw-runtime/src/delegate/native-spawn-gate-confirm.test.ts extensions/octoclaw-runtime/src/state/native-status-projector.test.ts extensions/octoclaw-runtime/src/work-contract/projectors.test.ts packages/octoclaw-contracts/src/status-projection.test.ts`; result `8 files / 165 tests passed`.
- Regression verification after the same merge: `policy-resolver-judge-fallback`, `registration-dispatch-honesty`, `runtime-ledger-hot-path`, `execution-transition-integration`, `runtime-ledger`, `operator-diagnostics`, `regression-round4`, and `delegate-packets` all passed (`185 tests` total across the regression slice).

Evidence 2026-05-04:

- Latest planner-native ticket-fix smoke artifact: `/tmp/octoclaw-planner-native-user-20260504-ticket-fix/out/slack-acceptance-2026-05-03-22-36-12.{json,md}`.
- Thread `1777847588.374549`, WorkContract `wc-ab450a65b9afe6f5`, spawnIntent `nsp_moqcltjd_68eac0a0`, runId `0a355aee-aaea-49cd-a768-493cfa5c7d58`, childSessionKey `agent:main:subagent:e01f185d-0aa1-4ee0-b438-6db9461140f3`.
- Harness overall `pass`; neutralAckMs `5201` via Slack reaction `eyes`; acceptedAckMs `102093`; finalMs `182784`; final footer `route=delegate | model=zhipu/GLM-5.1 · thread | via=native_announce | worker=octoclaw-research | wc=wc-ab450`.
- Replay stage timing: `message_received=5057ms`, `before_dispatch=5098ms`, `before_prompt_build=86211ms`, `sessions_spawn_intent_allowed=96922ms`, `sessions_spawn_accepted=102776ms`, `dispatch_confirm=102778ms`, `native_child_final=183504ms`.
- Replay events include `sessions_spawn_intent_allowed`, `execution_transition` with `spawn_started`, `dispatch_confirm_completed ok=true`, `native_announce_completion_matched`, `native_announce_final_delivered`, and a later duplicate replay rejected as `already_delivered`.
- `completionFileTimeoutCount=0`; no duplicate final visible in Slack transcript; SQLite native intent row is `accepted` with non-empty runId/childSessionKey.
- SR-P1 focused verification for commit `2366e4e`: `git diff --check`, `./node_modules/.bin/tsc --build extensions/octoclaw-runtime/tsconfig.json`, and `./node_modules/.bin/vitest run extensions/octoclaw-runtime/src/resolve/policy-resolver-judge-fallback.test.ts extensions/octoclaw-runtime/src/resolve/ticket-dry-run.test.ts extensions/octoclaw-runtime/src/tools/registration-planner.test.ts` passed (`79 tests`).
- Broader SR-P1/planner regression verification: `policy-resolver-judge-fallback`, `llm-judge`, `ticket-dry-run`, `ticket-enforcement`, `registration-planner`, `registration-dispatch-honesty`, `runtime-ledger-hot-path`, `runtime-ledger`, `operator-diagnostics`, and `regression-round4` passed (`206 tests`); `execution-transition-integration` and `delegate-packets` passed (`25 tests`).
- SR-P1 fixed 30s soft runtime budget local verification: `git diff --check`, `./node_modules/.bin/tsc --build extensions/octoclaw-runtime/tsconfig.json`, and `./node_modules/.bin/vitest run extensions/octoclaw-runtime/src/extension-entry.test.ts extensions/octoclaw-runtime/src/resolve/policy-resolver-judge-fallback.test.ts extensions/octoclaw-runtime/src/tools/registration-planner.test.ts extensions/octoclaw-runtime/src/delegate/native-spawn-gate-confirm.test.ts extensions/octoclaw-runtime/src/delegate/native-spawn-intent.test.ts` passed (`191 tests`). Coverage includes `budgeted_main_started`, `budgeted_main_completed`, `budgeted_main_completed_late`, tool-boundary escalation through `octoclaw_dispatch`, and no direct spawn/accepted ACK on timeout.
- SR-P1/PC10 local acceptance closure for the current worker tree: `./node_modules/.bin/vitest run extensions/octoclaw-runtime/src/resolve/policy-resolver-judge-fallback.test.ts extensions/octoclaw-runtime/src/extension-entry.test.ts extensions/octoclaw-runtime/src/delegate/native-spawn-intent.test.ts extensions/octoclaw-runtime/src/delegate/native-spawn-gate-confirm.test.ts extensions/octoclaw-runtime/src/delegate/child-finalizer.test.ts extensions/octoclaw-runtime/src/tools/registration-planner.test.ts extensions/octoclaw-runtime/src/ack/__tests__/route-commit-ack.test.ts extensions/octoclaw-runtime/src/ack/__tests__/execution-transition-notifier.test.ts extensions/octoclaw-runtime/src/im/slack/slack-adapter.test.ts tools/octoclawctl/src/slack-acceptance/slack-acceptance.test.ts packages/octoclaw-policy/src/spec/prompt-builder.test.ts` passed (`345 tests`). Coverage includes SR-P1 false-delegate fixtures for simple Q&A/status/fresh lookup/bare model or tool mentions, false-reply fixtures for explicit subagent/background/code/test/review/validation work, PC10 no-intent/expired/hash-mismatch/missing-runId/confirm-ACK cases, native announce without completion file, no duplicate final, status follow-up no spawn, planner path no legacy queue/binding/outbox, PC13 Slack delivery port adapter/ACK-adjacent behavior, and local judge prompt slimness.
- SR-P1 two-class judge/runtime-derived bucket follow-up: `./node_modules/.bin/vitest run packages/octoclaw-policy/src/spec/prompt-builder.test.ts extensions/octoclaw-runtime/src/resolve/policy-resolver-judge-fallback.test.ts extensions/octoclaw-runtime/src/extension-entry.test.ts` passed (`136 tests`); `./node_modules/.bin/tsc --build packages/octoclaw-policy/tsconfig.json extensions/octoclaw-runtime/tsconfig.json tools/octoclawctl/tsconfig.json` and `git diff --check` passed. Local qwen dry-run after warm start produced `must_reply` for `你好`, `budgeted_main_then_delegate` for the OpenClaw 2026.4.29 vs 2026.4.21 plus PC13 read-only summary prompt, and `must_delegate` for explicit opencode test/fix work. A cold local judge attempt still timed out at 4000ms, so this is not a Slack evidence substitute.
- SQLite/confirm local race evidence: `NativeSpawnIntentStore` now wraps persisted authorize/confirm transitions in `BEGIN IMMEDIATE`, retries `SQLITE_BUSY/SQLITE_LOCKED`, keeps hash-mismatch intents in `planned`, rejects subsequent `planned -> accepted`, and fails closed if accepted confirm cannot be durably written; local tests prove the persisted row remains `spawn_call_started` with empty runId/ackSentAt on permanent busy. `confirmNativeSpawn()` now also fails closed when the intent store read/expire path throws `SQLITE_BUSY`/`SQLITE_LOCKED`/`SQLITE_UNAVAILABLE`, and the confirm tool records `dispatch_confirm_completed ok=false` replay instead of throwing. Live replay evidence for SQLite busy/locked remains pending, so the busy/replay checklist item above is intentionally not checked.
- Confirm rollback race evidence: local tests cover a losing confirm whose post-ref-write accepted transition fails while a racing successful confirm has already written native refs; rollback is CAS-style and skips when current refs no longer match the loser `runId/childSessionKey`, so the winner's WorkContract `nativeSpawnRefs`, `delegate.nativeBinding`, and `telemetry.spawnExecuted` survive. Rollback now restores only native-ref-related fields and preserves unrelated concurrent WorkContract updates.
- Slack acceptance harness/report parser now emits `decisionBucket`, `budgetEvent`, `budgetElapsedMs`, `budgetEscalationReason`, `visibleElapsedMs`, `footerVia`, PC13 `deliveryTransport`/`targetSource`/`footerSource`, and `duplicateFinalCount` in replay evidence.
- Three clean real Slack planner-native smoke artifacts are available under `/tmp/octoclaw-sr-p1-smoke-20260504/run{3,4,5}-clean/`: neutralAckMs `4724`, `4735`, `4722` (nearest-rank p95/max `4735ms`); acceptedAckMs `111112`, `111567`, `110619`; finalMs `208413`, `305340`, `217014`; `completion_file_timeout=0` and `duplicateFinal=0` in all three; final footer via `native_announce` in all three. Latest run5 additionally records PC13 delivery fields `delivery_transport=slack_api`, `target_source=inbound_anchor`, `footer_source=envelope`.
- Latest clean run5 artifact: `/tmp/octoclaw-sr-p1-smoke-20260504/run5-clean/slack-acceptance-2026-05-04-02-07-19.{json,md}`. Thread `1777860220.481439`, WorkContract `wc-8952a8e3a003c912`, spawnIntent `nsp_moqk4odi_c2da90d2`, runId `793c2d86-badc-4c10-bd78-03efe2cb7937`, childSession `agent:main:subagent:afcea35f-6139-41e6-b588-942311844f37`, decision_bucket `must_delegate`, stageMs: message_received `3606`, before_dispatch `3649`, before_prompt_build `87659`, sessions_spawn_intent_allowed `104851`, sessions_spawn_accepted `111138`, dispatch_confirm `111141`, native_child_final `217610`.
- Latest run5 SQLite row is `accepted` with non-empty runId/childSessionKey and `ackSentAt=2026-05-04T02:05:30.630Z`; WorkContract projection has `nativeSpawnRefs.openclawRunId`, `nativeSpawnRefs.childSessionKey`, `nativeSpawnRefs.spawnIntentId`, `telemetry.spawnExecuted=true`, `telemetry.resultMaterialized=true`, and `telemetry.deliveryStatus=delivered`.
- Latest post child-context-sanitizer release smoke artifact: `/tmp/octoclaw-release-smoke-20260504-post-d73c/out/slack-acceptance-2026-05-04-13-51-37.{json,md}` passed. Thread `1777902360.657059`, WorkContract `wc-5dd50a4498dc04df`, spawnIntent `nsp_mor97x55_452403f0`, runId `cc0cc41d-081a-4c37-af55-7e5594969eb0`, childSession `agent:main:subagent:5fbf356a-d39f-4a6e-8ea1-ba32a109b2e6`, decision_bucket `must_delegate`.
- Latest post child-context-sanitizer report fields: neutralAckMs `5215` via Slack reaction `eyes`, `anchor_source=ctx`, `fallback_used=false`; acceptedAckMs `136806`; finalMs `335664`; `delivery_transport=slack_api`, `target_source=inbound_anchor`, `footer_source=envelope`, `footerVia=native_announce`, `completion_file_timeout=0`, and `duplicateFinal=0`. StageMs: message_received `3225`, before_dispatch `3286`, before_model_resolve `16926`, before_prompt_build `85530`, octoclaw_dispatch `98881`, sessions_spawn_intent_allowed `115212`, sessions_spawn_accepted `137493`, dispatch_confirm `137496`, native_child_final `336476`.
- Latest post child-context-sanitizer SQLite row is `accepted` with non-empty runId/childSessionKey and version `3`; WorkContract projection has native refs for `openclawRunId`, `childSessionKey`, `spawnIntentId`, `delegate.nativeBinding.status=succeeded`, `telemetry.spawnExecuted=true`, `telemetry.resultMaterialized=true`, and `telemetry.deliveryStatus=delivered`.
- 2026-05-04 judge timeout follow-up: `octoclawctl` unified config now preserves/projects `judge.local` and `judge.timeoutLocalMs`; deployed macmini config, manifest, `openclaw.json`, legacy `judge-fast.json`, and launchctl env all resolve local judge effective timeout to `4000ms`. This fixes the 2s operational override observed in the rejected budget attempt.
- Fixed 30s soft-budget live evidence now exists: `/tmp/octoclaw-sr-p1-smoke-20260504/run-budget-5/slack-acceptance-2026-05-04-10-33-47.{json,md}` passed. Thread `1777890341.336369`, WorkContract `wc-bef1e786925b1362`, spawnIntent `nsp_mor227uz_654c3072`, runId `0097aad8-bda8-4209-800d-00374bb8c016`, childSession `agent:main:subagent:bf686f36-eb65-4f81-b613-db4ff00e3054`. Replay shows `decision_bucket=budgeted_main_then_delegate`, `budgeted_main_started`, `budgeted_main_escalated` with `budgetElapsedMs=6967` and `budgetEscalationReason=main_agent_called_dispatch`, `sessions_spawn_intent_allowed`, `dispatch_confirm_completed ok=true`, `native_announce_completion_matched`, and `native_announce_final_delivered`.
- Latest budgeted-main live report fields: neutralAckMs `4742`, acceptedAckMs `108601`, finalMs `484283`, `visibleElapsedMs=11`, `delivery_transport=slack_api`, `target_source=inbound_anchor`, `footer_source=envelope`, `footerVia=native_announce`, `completion_file_timeout=0`, and `duplicateFinal=0`. The child returned partial progress after its own tool-call timeout; this is accepted as planner/native runtime evidence, not final product-quality evidence.
- Previous 2026-05-04 real Slack attempts intentionally not accepted as evidence:
  - `/tmp/octoclaw-sr-p1-smoke-20260504/run-budget-1/`: did not produce `budgeted_main_then_delegate`; judge timed out and the turn completed as reply.
  - `/tmp/octoclaw-sr-p1-smoke-20260504/run-budget-2/slack-acceptance-2026-05-04-06-57-24.{json,md}`: thread `1777877599.213359`; normal reply path, final footer `route=reply | via=rule`, no budget replay events.
  - `/tmp/octoclaw-sr-p1-smoke-20260504/run-budget-3/slack-acceptance-2026-05-04-07-09-30.{json,md}`: harness total timeout; runtime replay for thread `1777878030.931209` shows reaction ACK, `dispatch_terminal_failure`, compaction notice, context overflow, and session file lock/fallback, not a clean soft-budget escalation chain.
  SR-P2 latency remains above target because `before_prompt_build` and `sessions_spawn_intent_allowed` dominate accepted ACK time. Per release decision on 2026-05-04, this 30s route-commit target remains tracked as 0.5.x performance recovery and does not block 0.5.0 while neutral ACK, footer/native announce, planner/confirm correctness, and duplicate/timeout gates pass.


## PC13 Slack Delivery Port

Owner: Codex leader after 0.5.0 Must+Should acceptance. GLM/cheap workers may implement Slack fixtures/report parser. This is 0.5.x immediate and Slack-only.

Write scope:

- `extensions/octoclaw-runtime/src/im/*` for shared delivery envelope/port types only
- `extensions/octoclaw-runtime/src/im/slack/*`
- `extensions/octoclaw-runtime/src/im/send.ts`
- Slack acceptance/nightly harness and report parser

Forbidden scope:

- non-Slack IM except type-compatible fallback preservation
- route/judge/planner hot path unless fixing a PC12 regression

Tasks:

- [x] Shared delivery envelope/port is channel-neutral but minimal: kind, target, content, provenance, footer mode, dedupe key, and transport result.
- [x] Slack neutral ACK text fallback, delegate accepted ACK, native announce final delivery, status/provenance follow-up, and legacy fallback use Slack delivery port instead of CLI/shell hot path.
- [x] Ordinary main-agent final reply is not re-sent by OctoClaw; it remains on OpenClaw native Slack delivery, with footer projection only through hooks.
- [x] Slack target comes from delivery context or inbound `channel/message.ts/thread_ts`, not session-key guessing.
- [x] Slack footer/provenance comes from envelope/native refs, not recent policyState or body regex guessing.
- [x] Slack native delivery path does not call `openclaw message send` or `runCommand("openclaw", ...)`.
- [x] `OCTOCLAW_LEGACY_CLI_DELIVERY=1` restores old Slack CLI path for rollback.
- [x] Non-Slack IM behavior remains unchanged except type-compatible fallback preservation.
- [x] Real Slack smoke proves native announce final delivery still works and no `completion_file_timeout` appears; report includes delivery transport, target source, and footer source.

Evidence:

- Implementation landed in `7dfcba4 feat(runtime): add slack delivery port` and is present in the merged worker branch. `extensions/octoclaw-runtime/src/im/delivery-port.ts` defines `MessageDeliveryEnvelope` / `MessageDeliveryPort`; `extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts` sends Slack text via Slack Web API by default and uses the legacy CLI only when `OCTOCLAW_LEGACY_CLI_DELIVERY=1`.
- OctoClaw-owned visible sends call `sendIMMessage()` with explicit `deliveryKind`: neutral ACK (`ack-route-commit.ts` / `ack-guard.ts`), accepted ACK (`execution-transition-notifier.ts`), native child final (`extension-entry.ts`), status replies (`extension-entry.ts` / `ack-delegate-without-dispatch.ts`), and legacy fallback (`child-finalizer.ts` / delivery outbox). Non-Slack adapters still use their existing fallback paths.
- Focused PC13-adjacent tests are included in the 2026-05-04 local acceptance closure (`slack-adapter.test.ts`, `route-commit-ack.test.ts`, `execution-transition-notifier.test.ts`, `extension-entry.test.ts`, `slack-acceptance.test.ts`). `slack-adapter.test.ts` proves default Slack Web API delivery without invoking OpenClaw CLI, inbound-anchor target selection, DM open before send, envelope footer provenance, and internal ACK delivery through the port.
- Real Slack run5 proves the native child final still delivers through the Slack port: `/tmp/octoclaw-sr-p1-smoke-20260504/run5-clean/slack-acceptance-2026-05-04-02-07-19.{json,md}` reports `delivery_transport=slack_api`, `target_source=inbound_anchor`, `footer_source=envelope`, `footerVia=native_announce`, `completion_file_timeout=0`, and `duplicateFinal=0`.

## PC14 Nightly Regression Harness

Owner: leader defines cases; GLM/cheap workers implement fixtures/report parsing. Can run in parallel with macmini runtime work only inside harness/config/docs scope.

Write scope:

- Slack acceptance config and scenario fixtures
- nightly eval config/report parser
- docs/OpenSpec evidence notes

Forbidden while macmini runtime branch is active:

- `extensions/octoclaw-runtime/src/extension-entry.ts`
- `extensions/octoclaw-runtime/src/tools/registration.ts`
- judge/router runtime files
- ACK sender runtime files

Tasks:

- [ ] Add `main_fast_path_simple_reply` scenario.
- [ ] Add `main_fast_path_one_lookup` scenario.
- [ ] Add `must_delegate_explicit_subagent` scenario.
- [ ] Add `must_delegate_code_test_review` scenario.
- [ ] Add `budgeted_main_then_delegate` scenario with fixed 30s soft budget, `budgeted_main_escalated_pending`, late final, and native planner escalation evidence.
- [ ] Add `status_provenance_no_spawn` scenario.
- [ ] Add `native_announce_final` scenario.
- [ ] Add `footer_delegate_provenance` scenario.
- [ ] Add `no_completion_file_timeout` scenario.
- [ ] Report parser outputs neutral ACK latency, route decision/bucket, spawn allowed latency, confirm ACK latency, child progress/final latency, footer provenance, whether `completion_file_timeout` appeared, and whether legacy CLI delivery was used.


## PC15 Before-Dispatch Fast Delegate Design And Test Slices

Owner: Codex leader. This is 0.5.x performance recovery design work and is not a 0.5.0 release gate. Workers may implement mechanical tests only after this section is approved.

Primary doc:

- `docs/octoclaw-fast-delegate-before-dispatch-design-2026-05-02.md`

Allowed write scope for PC15 design-only slice:

- `docs/octoclaw-fast-delegate-before-dispatch-design-2026-05-02.md`
- this OpenSpec change
- new test-only harness files once implementation slices are approved

Forbidden scope until PC15 implementation slices are explicitly opened:

- `extensions/octoclaw-runtime/src/extension-entry.ts`
- `extensions/octoclaw-runtime/src/tools/registration.ts`
- direct child-run/finalizer/delivery runtime code
- judge semantic logic

Tasks:

- [x] Add standalone fast delegate design doc with current judge stage, target flow, no-double-judge requirement, ACK semantics, and acceptance criteria.
- [x] Add OpenSpec proposal/design/spec language making PC15 design-only for the 0.5.0 gate.
- [x] Define PC15-0 feasibility spike: before any implementation, prove `before_dispatch` exposes enough fields, can build a managed ctx, can align stateKey/prompt with lifecycle hooks, can pass through with `handled=false` for native planner acceleration, and has a plausible draft-to-dispatch contract. Direct `handled=true` backend remains deferred.
- [x] Define `before_dispatch` context parity test slice: prove the constructed managed ctx resolves the same `policyState` key as later `before_model_resolve` / `before_prompt_build` for Slack channel, Slack direct, explicit session, and non-Slack fallback cases.
- [x] Define prompt normalization parity test slice: prove before-dispatch uses the same normalized prompt as lifecycle hooks and avoids cache misses from body/content/thread metadata differences.
- [x] Define no-double-judge test slice: spy/mock `callLlmJudge` or equivalent judge provider and prove one inbound pass-through turn invokes it at most once across before-dispatch, before-model-resolve, and before-prompt-build.
- [x] Define pass-through behavior test slice: when fast admission denies or is disabled, current planner/confirm, reply, route-hint, and footer behavior remains unchanged.
- [x] Define fast admission fixture matrix: high-confidence explicit background/subagent/parallel task is allowed; status follow-up, provenance follow-up, simple reply, one-step lookup, judge timeout/degraded, and bare `opencode`/`glm`/model/tool mentions pass through.
- [x] Define accepted receipt boundary test slice: native planner acceleration and any future direct-run backend must not send `任务已启动。` or delegate accepted ACK before accepted run id exists.
- [x] Define idempotency/dedupe test slice: duplicate Slack retries for the same inbound turn do not start two direct child runs.
- [x] Define observability slice: replay/smoke report records `fast_delegate_evaluated`, `fast_delegate_allowed|passed`, decision cache hit/miss, judge invocation count, accepted run id timing, and footer provenance.
- [x] Define backend contract slice comparing native planner acceleration vs `api.runtime.subagent.run()` / gateway `agent`: required inputs, returned refs, idempotency, model override authorization, delivery/finalizer gaps, and rollback behavior.
- [x] Do not implement direct-run backend in PC15 default path. Current proof keeps direct backend untouched and prefers native planner acceleration.

Implementation pre-gates:

- [x] PC15-0 feasibility probe has unit evidence for Slack channel and Slack direct cases (`extensions/octoclaw-runtime/src/fast-delegate/probe.test.ts`). Live native hook registration and direct `handled=true` backend evidence remain future gates.
- [x] PC15-A through PC15-D tests exist and pass in the non-invasive proof slice (`probe.test.ts`, `draft.test.ts`, `no-double-judge.test.ts`).
- [x] PC15-I native planner acceleration contract table is filled from code inspection and unit proof. Local/live smoke remains required before runtime enablement.
- [ ] Codex leader explicitly opens a new runtime write slice before any `extension-entry.ts`, direct-run, finalizer, or delivery code is changed.


## PC1-PC5 implementation evidence

- TypeScript: `./node_modules/.bin/tsc --build extensions/octoclaw-runtime/tsconfig.json --pretty false`
- Focused tests: `./node_modules/.bin/vitest run extensions/octoclaw-runtime/src/config/index.test.ts extensions/octoclaw-runtime/src/delegate/native-spawn-intent.test.ts extensions/octoclaw-runtime/src/tools/registration-planner.test.ts extensions/octoclaw-runtime/src/extension-entry.test.ts extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts extensions/octoclaw-runtime/src/runtime-ledger/runtime-ledger-hot-path.test.ts`
- Cross-review patch: `/Users/guanbear/workspace/review-patches/octoclaw-pc345-full.diff` on macmini, sent to opencode with `ulw`. The earlier `octoclaw-pc345.diff` was incomplete and should not be used as review evidence.
- GLM/opencode review follow-up: gate scope was narrowed so planner intent enforcement only runs when `OCTOCLAW_SPAWN_BACKEND=planner` and the session is planner-allowed; legacy/default native `sessions_spawn` is not blocked by the planner gate.
- GLM/opencode final review: P0 cleared and patch considered mergeable. Remaining non-blockers are SQLite open/close performance in `NativeSpawnIntentStore` and documenting that empty planner allowlist means all sessions when planner backend is enabled. The reported gate state-transition concern is covered by `evaluateNativeSpawnGate()` calling `transitionToSpawnCallStarted()` and by the allowed-path test.
