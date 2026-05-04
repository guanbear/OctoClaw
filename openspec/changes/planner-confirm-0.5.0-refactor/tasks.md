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
- [ ] Fix WorkContract ID collision: ID must include turn/message/route-seal entropy and must not be `stableId(sessionKey, userAsk)` only.
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

## PC11 Legacy Default-Path Removal

Owner: Codex leader after 0.5.0 Must+Should acceptance. This is 0.5.x immediate, not a 0.5.0 release gate.

Tasks:

- [ ] Remove or archive legacy scheduler queue usage from the default planner/native path.
- [ ] Remove completion file prompt requirement from the default planner/native path.
- [ ] Remove child-finalizer/completion-file timeout from native announce final delivery.
- [ ] Remove delivery outbox from the Slack/native completion announce path.
- [ ] Keep explicit legacy backend rollback notes until 0.5.x is stable.
- [ ] Real Slack smoke proves no `completion_file_timeout` after `native_announce_completion_matched`.


## PC12 Speed And Responsiveness

Owner: leader for architecture; GLM-5.1 can implement focused fixtures/tests.

Write scope:

- `extensions/octoclaw-runtime/src/ack/*`
- `extensions/octoclaw-runtime/src/extension-entry.ts`
- `extensions/octoclaw-runtime/src/im/projection-footer.ts`
- `extensions/octoclaw-runtime/src/delegate/native-spawn-intent-store.ts`
- focused tests and Slack acceptance harness config

Tasks:

- [ ] SR-P0 neutral inbound ACK: Slack reaction/text appears within 1-5s and does not claim delegation or spawn success.
- [ ] SR-P0 neutral ACK is route-independent and does not depend on `decision.latency_ack.required`, route commit, or a non-OctoClaw tool name.
- [ ] SR-P0 target resolution uses original inbound Slack anchor (`channel/message.ts/thread_ts`), not post-policy state; `no_valid_thread_target` is covered by tests.
- [ ] SR-P1 startup-cost-aware delegation uses three explicit buckets: `must_reply/main_fast_path`, `must_delegate`, and `budgeted_main_then_delegate`.
- [ ] SR-P1 short tasks, simple status/provenance follow-up, and one-step fresh lookup stay on main fast path by default.
- [ ] SR-P1 `fresh_live_lookup`, `conversation_control.route_hint=delegate`, and `fast_first_response` are downgraded from hard delegate signals; none can force delegate alone.
- [ ] SR-P1 hard delegate signals still win: explicit background/subagent/parallel request, code edits, tests/builds, long commands, multi-step tools, review/validation, or expected duration over 90-120s.
- [ ] SR-P1 explicit-delegate keyword matching does not treat bare mentions of `opencode`, `glm`, model names, or tools as hard delegate unless the user asks them to do work.
- [ ] SR-P1 `budgeted_main_then_delegate` can escalate after 20-30s, after 1-2 read-only tool calls, or when write/long-running work becomes necessary.
- [ ] SR-P1 rule router, local judge, cheap LLM judge, route hints, and AGENTS/system prompt share the same bucket semantics.
- [ ] SR-P1 judge/replay output records `decision_bucket`, `startup_cost_policy`, `duration_hint`, `tool_need_hint`, `reason_codes`, and `hard_delegate_signal`.
- [ ] SR-P1 false-delegate cases are covered by tests/replay fixtures, including `fresh_live_lookup` no longer forcing delegate by itself.
- [ ] SR-P1 false-reply cases are covered by tests/replay fixtures so explicit background work, code/test/edit, multi-step tools, review, and validation are not swallowed by main fast path.
- [ ] SR-P2 planner/native chain is slimmed so real delegated route commit to `sessions_spawn_intent_allowed` is p95 <= 30s in real Slack smoke.
- [ ] SR-P2 hard confirm remains strict: no `planned -> accepted`, no direct spawn, no delegate ACK before confirm.
- [ ] SR-P2 child spawn profile uses only current OpenClaw capabilities: explicit `context=isolated`, `lightContext=true`, bounded child prompt, fast/cheap model defaults, conservative `thinking`/timeout.
- [ ] SR-P2 child-start metrics are recorded for observation, but 0.5.0 does not block on accepted-to-stream-ready <= 10s.
- [ ] SR-P2 SQLite/native refs are used as footer/status fast path; state transitions are atomic or covered by race tests.
- [ ] SR-P2 NativeSpawnIntent authorization/confirm transitions surface SQLite busy/locked retry/backoff/replay evidence and do not silently fall back to no task/no spawn.
- [ ] SR-P2 native child final debug footer shows `route=delegate` and `via=subagent` or `via=native_announce`, not `route=reply | via=policy`.
- [ ] Real Slack smoke records neutral ACK latency, main-fast-path/delegate route decision, spawn allowed latency, accepted latency, child progress/final latency, and footer route/provenance.


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

- [ ] Shared delivery envelope/port is channel-neutral but minimal: kind, target, content, provenance, footer mode, dedupe key, and transport result.
- [ ] Slack neutral ACK text fallback, delegate accepted ACK, native announce final delivery, status/provenance follow-up, and legacy fallback use Slack delivery port instead of CLI/shell hot path.
- [ ] Ordinary main-agent final reply is not re-sent by OctoClaw; it remains on OpenClaw native Slack delivery, with footer projection only through hooks.
- [ ] Slack target comes from delivery context or inbound `channel/message.ts/thread_ts`, not session-key guessing.
- [ ] Slack footer/provenance comes from envelope/native refs, not recent policyState or body regex guessing.
- [ ] Slack native delivery path does not call `openclaw message send` or `runCommand("openclaw", ...)`.
- [ ] `OCTOCLAW_LEGACY_CLI_DELIVERY=1` restores old Slack CLI path for rollback.
- [ ] Non-Slack IM behavior remains unchanged except type-compatible fallback preservation.
- [ ] Real Slack smoke proves native announce final delivery still works and no `completion_file_timeout` appears; report includes delivery transport, target source, and footer source.

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
- [ ] Add `budgeted_main_then_delegate` scenario.
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
- [x] Define PC15-0 feasibility spike: before any implementation, prove `before_dispatch` exposes enough fields, can build a managed ctx, can align stateKey/prompt with lifecycle hooks, can short-circuit with `handled=true`, and has a plausible direct-run backend contract.
- [x] Define `before_dispatch` context parity test slice: prove the constructed managed ctx resolves the same `policyState` key as later `before_model_resolve` / `before_prompt_build` for Slack channel, Slack direct, explicit session, and non-Slack fallback cases.
- [x] Define prompt normalization parity test slice: prove before-dispatch uses the same normalized prompt as lifecycle hooks and avoids cache misses from body/content/thread metadata differences.
- [x] Define no-double-judge test slice: spy/mock `callLlmJudge` or equivalent judge provider and prove one inbound pass-through turn invokes it at most once across before-dispatch, before-model-resolve, and before-prompt-build.
- [x] Define pass-through behavior test slice: when fast admission denies or is disabled, current planner/confirm, reply, route-hint, and footer behavior remains unchanged.
- [x] Define fast admission fixture matrix: high-confidence explicit background/subagent/parallel task is allowed; status follow-up, provenance follow-up, simple reply, one-step lookup, judge timeout/degraded, and bare `opencode`/`glm`/model/tool mentions pass through.
- [x] Define accepted receipt boundary test slice: future direct-run backend must not send `任务已启动。` or delegate accepted ACK before accepted run id exists.
- [x] Define idempotency/dedupe test slice: duplicate Slack retries for the same inbound turn do not start two direct child runs.
- [x] Define observability slice: replay/smoke report records `fast_delegate_evaluated`, `fast_delegate_allowed|passed`, decision cache hit/miss, judge invocation count, accepted run id timing, and footer provenance.
- [x] Define backend contract slice comparing `api.runtime.subagent.run()` vs gateway `agent`: required inputs, returned refs, idempotency, model override authorization, delivery/finalizer gaps, and rollback behavior.
- [ ] Do not implement direct-run backend until the parity/no-double-judge/pass-through tests are written and reviewed.

Implementation pre-gates:

- [x] PC15-0 feasibility probe has unit evidence for Slack channel and Slack direct cases (`extensions/octoclaw-runtime/src/fast-delegate/probe.test.ts`). Live `handled=true` short-circuit and backend evidence remain future gates.
- [ ] PC15-A through PC15-D tests exist and pass.
- [ ] PC15-I backend contract table is filled from code inspection or local smoke.
- [ ] Codex leader explicitly opens a new runtime write slice before any `extension-entry.ts`, direct-run, finalizer, or delivery code is changed.


## PC1-PC5 implementation evidence

- TypeScript: `./node_modules/.bin/tsc --build extensions/octoclaw-runtime/tsconfig.json --pretty false`
- Focused tests: `./node_modules/.bin/vitest run extensions/octoclaw-runtime/src/config/index.test.ts extensions/octoclaw-runtime/src/delegate/native-spawn-intent.test.ts extensions/octoclaw-runtime/src/tools/registration-planner.test.ts extensions/octoclaw-runtime/src/extension-entry.test.ts extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts extensions/octoclaw-runtime/src/runtime-ledger/runtime-ledger-hot-path.test.ts`
- Cross-review patch: `/Users/guanbear/workspace/review-patches/octoclaw-pc345-full.diff` on macmini, sent to opencode with `ulw`. The earlier `octoclaw-pc345.diff` was incomplete and should not be used as review evidence.
- GLM/opencode review follow-up: gate scope was narrowed so planner intent enforcement only runs when `OCTOCLAW_SPAWN_BACKEND=planner` and the session is planner-allowed; legacy/default native `sessions_spawn` is not blocked by the planner gate.
- GLM/opencode final review: P0 cleared and patch considered mergeable. Remaining non-blockers are SQLite open/close performance in `NativeSpawnIntentStore` and documenting that empty planner allowlist means all sessions when planner backend is enabled. The reported gate state-transition concern is covered by `evaluateNativeSpawnGate()` calling `transitionToSpawnCallStarted()` and by the allowed-path test.
