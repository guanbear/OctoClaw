# Tasks

## PC0 OpenSpec Setup

- [ ] Create this change and keep proposal/design/spec/tasks aligned.
- [ ] Add every implementation slice to this file before code starts.
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

- `extensions/octoclaw-runtime/src/tools/dispatch-confirm-tool.ts`
- `extensions/octoclaw-runtime/src/delegate/native-spawn-confirm.ts`
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

- [ ] Add `openclawRunId`, `childSessionKey`, `spawnIntentId`, `spawnBackend`, and spawn mode refs.
- [ ] Ensure refs are metadata, not execution status.
- [ ] Tests prove status projection does not advance from WorkContract alone.

## PC7 Legacy Runtime Disable On Planner Path

Owner: GLM-5.1 worker.

Write scope:

- `extensions/octoclaw-runtime/src/delegate/child-finalizer.ts`
- `extensions/octoclaw-runtime/src/runtime-ledger/completion-binding.ts`
- `extensions/octoclaw-runtime/src/delivery/delivery-outbox.ts`
- startup/wiring files needed for flags

Tasks:

- [ ] Planner path does not start child finalizer recovery.
- [ ] Planner path does not create completion binding.
- [ ] Planner path does not write delivery outbox for completion announce.
- [ ] Legacy flags restore old path for rollback.
- [ ] Tests cover planner disabled behavior and legacy fallback behavior.

## PC8 Native Status Projector

Owner: GLM-5.1 worker, leader fallback review required.

Write scope:

- `extensions/octoclaw-runtime/src/state/native-status-projector.ts`
- related status projector tests

Tasks:

- [ ] Resolve status by `openclawRunId` with `runtime.tasks.runs.fromToolContext(ctx).resolve()`.
- [ ] Resolve flow status by `openclawFlowId` with `runtime.tasks.flows.fromToolContext(ctx).resolve()`.
- [ ] Use `findLatest()` only as UI fallback, not execution authorization.
- [ ] Treat missing/corrupt `task-state.json` as degraded display, not empty success.
- [ ] Tests cover found, missing, lost/unknown, degraded cache, and no-spawn follow-up.

## PC9 ACK And Footer Guardrails

Owner: GLM-5.1 worker for mechanical pieces; leader reviews delegate ACK boundary.

Write scope:

- `extensions/octoclaw-runtime/src/ack/*`
- `extensions/octoclaw-runtime/src/im/projection-footer.ts`
- focused wiring needed for confirm ACK

Tasks:

- [ ] ACK dedupe key includes stage/surface/target where needed.
- [ ] Slow reply text ACK is reply-route only.
- [ ] Delegate accepted ACK fires only after accepted confirm.
- [ ] Footer defaults off and never appends to ACK/progress/no-reply packets.
- [ ] Tests cover fast reply, slow reply, failed spawn, accepted confirm, and footer off.

## PC10 Integration And Acceptance Tests

Owner: mixed. Leader defines cases; GLM-5.1/cheap workers can implement fixtures.

Tasks:

- [ ] No pending intent blocks `sessions_spawn`.
- [ ] Expired intent blocks `sessions_spawn`.
- [ ] Args hash mismatch blocks `sessions_spawn`.
- [ ] Accepted confirm without runId fails closed.
- [ ] Confirm success writes native refs and sends one delegate ACK.
- [ ] Child completion without `.completion.json` uses native announce and does not duplicate final message.
- [ ] Status follow-up does not spawn.
- [ ] Planner path does not write scheduler queue, completion binding, or delivery outbox.

## PC11 Legacy Wheel Removal

Owner: Codex leader after planner path is accepted.

Tasks:

- [ ] Remove or archive legacy scheduler queue usage from default path.
- [ ] Remove completion file prompt requirement from planner path.
- [ ] Remove delivery outbox from completion announce path.
- [ ] Keep explicit rollback notes until 0.5.0 is stable.


## PC1-PC5 implementation evidence

- TypeScript: `./node_modules/.bin/tsc --build extensions/octoclaw-runtime/tsconfig.json --pretty false`
- Focused tests: `./node_modules/.bin/vitest run extensions/octoclaw-runtime/src/config/index.test.ts extensions/octoclaw-runtime/src/delegate/native-spawn-intent.test.ts extensions/octoclaw-runtime/src/tools/registration-planner.test.ts extensions/octoclaw-runtime/src/extension-entry.test.ts extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts extensions/octoclaw-runtime/src/runtime-ledger/runtime-ledger-hot-path.test.ts`
- Cross-review patch: `/Users/guanbear/workspace/review-patches/octoclaw-pc345-full.diff` on macmini, sent to opencode with `ulw`. The earlier `octoclaw-pc345.diff` was incomplete and should not be used as review evidence.
- GLM/opencode review follow-up: gate scope was narrowed so planner intent enforcement only runs when `OCTOCLAW_SPAWN_BACKEND=planner` and the session is planner-allowed; legacy/default native `sessions_spawn` is not blocked by the planner gate.
- GLM/opencode final review: P0 cleared and patch considered mergeable. Remaining non-blockers are SQLite open/close performance in `NativeSpawnIntentStore` and documenting that empty planner allowlist means all sessions when planner backend is enabled. The reported gate state-transition concern is covered by `evaluateNativeSpawnGate()` calling `transitionToSpawnCallStarted()` and by the allowed-path test.
