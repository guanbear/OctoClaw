# Tasks: Native-First Runtime Slimming V2

## Baseline

- [x] Run `git status --short` and note unrelated dirty files.
      - Untracked local artifacts remain excluded from commits:
        `.octoclaw-work-packets/`, `.omx/`.
- [x] Record current LOC:
      - V2 baseline `before-tool-call.ts`: 922 lines.
      - After first native-first gate extraction: 769 lines.
      - After `SpeculativePreloadGate`: 722 lines.
      - After `sessions_yield` runner extraction: 706 lines.

```bash
wc -l extensions/octoclaw-runtime/src/hooks/before-tool-call.ts
find extensions/octoclaw-runtime/src/hooks -maxdepth 1 -type f -name '*.ts' -print0 | xargs -0 wc -l
```

- [ ] Run baseline targeted tests:

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/__tests__/extension-entry-policy-route-hint.test.ts \
  extensions/octoclaw-runtime/src/regression-round4.test.ts \
  extensions/octoclaw-runtime/src/delegate/native-spawn-gate-confirm.test.ts \
  packages/octoclaw-contracts/src/status-projection.test.ts
```

## S1: BDD and Regression Guards

- [ ] Add tests for BDD scenarios in `bdd.md`.
- [ ] Confirm tests fail before implementation when they describe changed
      behavior.
- [ ] Do not edit runtime code until the matching failing test exists.

## S2: Default Feature Profile

- [ ] Run GitNexus impact analysis before editing config or resolver symbols.
- [ ] Make speculative preload default-off.
- [ ] Make route hint hard precondition default-off/advisory.
- [ ] Make retry/amendment automation default-off if it is currently automatic.
- [ ] Preserve explicit `octoclaw_task_action retry`.
- [ ] Make wall-time budget route mutation default-off; preserve observation.
- [x] Make final-result compact footer default-on while keeping ACK/status
      cards/onboarding/native delivery internals footer-free.
- [ ] Keep advanced opt-in flags explicit and tested.

## S3: State Truth Contract

- [x] Add native execution snapshot adapter.
- [x] Reuse `state/native-status-projector.ts` and
      `runtime-host/openclaw-adapter.ts`; do not create a parallel native status
      lookup system.
- [x] Add projection input builder that separates native truth from cache.
- [x] Update status/projection callers to treat policy-state as display cache.
- [x] Prove stale terminal task-state cannot override native lifecycle.
- [x] Prove native refs without accepted run evidence do not mean
      `spawnExecuted=true`.
- [x] Prove legacy booleans such as `dispatchExecuted`, `spawnExecuted`,
      `resultMaterialized`, and `nativeAnnounceDelivered` cannot decide
      lifecycle or compact footer truth without accepted native evidence.
- [x] Prove `task-state-store.ts` old-record status preservation is display
      compatibility only when native truth exists.

## S3B: Footer Default Migration

- [x] Normalize final result footer behavior across outbound guard and IM
      adapters.
- [x] Keep compact footer free of debug IDs.
- [x] Build compact footer from a compact-sanitized projection, not from a
      debug-shaped projection with fields hidden by adapter convention.
- [x] Keep neutral ACK, route commit ACK, status card direct sends, onboarding,
      and native delivery internals on `footerMode=off`.
- [x] Prove `via=native_announce` appears only after final native delivery.

## S4: Gate Interface

- [x] Create shared tool gate input/result types.
- [x] Gate results may carry state patches, replay events, and block reason.
- [x] Gate results must not directly commit unrelated state outside their
      authority.

## S5: SessionControlGate

- [x] Extract native announce delivery block.
- [x] Extract status/provenance no-new-work block.
- [x] Preserve control tool bookkeeping.
- [x] Verify status follow-up cannot create new spawn.

## S6: NativeSpawnGate Runner

- [x] Extract hook adapter around existing native spawn gate helpers.
- [x] Preserve missing-intent and args-hash block behavior.
- [x] Preserve pending intent transition to `spawn_call_started`.
- [x] Preserve `sessions_yield` block before child start.

## S7: BudgetedMainGate

- [x] Extract ordinary tool observation and escalation.
- [x] Preserve write/long/multi-step/unknown-risk/read-only-over-budget
      escalation.
- [x] Ensure risky ordinary tool is blocked.
- [x] Ensure `octoclaw_dispatch` is never blocked by BudgetedMainGate.
- [x] Ensure wall-time-only signal is observation by default.
- [x] Ensure `sessions_spawn`, `sessions_send`, `sessions_yield`, and
      `session_status` are budget-neutral control tools.

## S8: RouteHintGate

- [x] Extract route hint binding/bookkeeping.
- [x] Make route hint advisory by default.
- [x] Prove missing route hint cannot block `octoclaw_dispatch` by default.
- [x] Keep advanced hard route hint mode behind explicit config only.

## S9: DelegationWorkflowGuard

- [x] Extract delegate-route ordinary tool block.
- [x] Extract manual delegation pattern block.
- [x] Do not block `octoclaw_dispatch`.
- [x] Remove duplicated dispatch hard blocks from WorkContract forbidden-tool
      and workflow enforcement default path.

## S10: Orchestrator Slimming

- [x] Reduce `before-tool-call.ts` to orchestration and shared side effects.
- [x] Use the intended gate order: `SessionControlGate`,
      `NativeSpawnGate` runner, `BudgetedMainGate`, `RouteHintGate`,
      `DelegationWorkflowGuard`.
- [x] Record after LOC.
      - `before-tool-call.ts` is 469 lines as of the current slimming slice.
      - Net change from V2 baseline: 922 -> 469, down 453 lines.
      - New/expanded gate modules in this slice:
        `speculative-preload-gate.ts`,
        `native-spawn-gate-runner.ts`,
        `reply-direct-tool-runner.ts`,
        `native-session-tool-runner.ts`.
- [x] Confirm each extracted gate has targeted tests.
      - `session-control-gate.test.ts`
      - `native-spawn-gate-runner.test.ts`
      - `budgeted-main-gate.test.ts`
      - `route-hint-gate.test.ts`
      - `delegation-workflow-guard.test.ts`
      - `speculative-preload-gate.test.ts`
      - `reply-direct-tool-runner.test.ts`
      - `native-session-tool-runner.test.ts`
- [x] Confirm no gate imports more broad dependencies than needed.

## Verification

- [x] Run targeted suites:

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/__tests__/extension-entry-outbound-guards.test.ts \
  extensions/octoclaw-runtime/src/im/slack/slack-adapter.test.ts \
  extensions/octoclaw-runtime/src/hooks/session-control-gate.test.ts \
  extensions/octoclaw-runtime/src/hooks/budgeted-main-gate.test.ts \
  extensions/octoclaw-runtime/src/hooks/native-spawn-gate-runner.test.ts \
  extensions/octoclaw-runtime/src/hooks/route-hint-gate.test.ts \
  extensions/octoclaw-runtime/src/hooks/delegation-workflow-guard.test.ts \
  extensions/octoclaw-runtime/src/__tests__/extension-entry-policy-route-hint.test.ts \
  extensions/octoclaw-runtime/src/regression-round4.test.ts \
  extensions/octoclaw-runtime/src/delegate/native-spawn-gate-confirm.test.ts \
  packages/octoclaw-contracts/src/status-projection.test.ts
```

- [x] Run full verification:
      - `pnpm --filter @octoclaw/runtime run check`: passed.
      - Focused slimming regression suite: 10 files, 200 tests passed.
      - `pnpm check`: passed.
      - `pnpm test`: 169 files passed; 2290 passed, 1 skipped, 1 todo.
      - `git diff --check`: passed.
      - `npx gitnexus detect-changes --repo OctoClaw --scope all`: returned
        `No changes detected` despite local diffs; treated as a GitNexus
        detection anomaly, not as proof of no affected scope.
      - Current slice focused tests:
        native session runner/native spawn/route-hint/regression: 168 tests
        passed across the focused commands.
      - Footer migration focused tests:
        outbound guards, Slack adapter, status card, neutral ACK, and onboarding:
        133 tests passed.

```bash
pnpm check
pnpm test
git diff --check
npx gitnexus detect-changes --repo OctoClaw
```

## Closeout Criteria

- [x] BDD scenarios are mapped to tests for the completed slimming slices.
- [ ] No advanced feature became default-on.
- [ ] No second lifecycle engine exists.
- [ ] Native spawn hash gate remains strict.
- [ ] `octoclaw_dispatch` is not blocked by route hint, WorkContract forbidden
      tools, budgeted-main, or workflow enforcement before dispatch admission.
- [ ] Status/projection lifecycle comes from native truth, not stale cache.
- [x] Implementation notes list changed files, deleted hard gates, and LOC delta.
      - Current slice changed:
        `before-tool-call.ts`,
        `native-spawn-gate-runner.ts`,
        `native-spawn-gate-runner.test.ts`,
        `native-session-tool-runner.ts`,
        `native-session-tool-runner.test.ts`,
        `speculative-preload-gate.ts`,
        `speculative-preload-gate.test.ts`,
        `reply-direct-tool-runner.ts`,
        `reply-direct-tool-runner.test.ts`,
        `footer-mode.ts`,
        `im/adapter.ts`,
        `im/delivery-port.ts`,
        `im/send.ts`,
        `im/slack/slack-adapter.ts`,
        `extension-entry-outbound-guards.test.ts`,
        `im/slack/slack-adapter.test.ts`.
      - Removed from `before-tool-call.ts`: speculative preload candidate
        scanning/patching, `sessions_yield` pending-intent block assembly, and
        reply direct-tool latency ACK/replay side-effect assembly, plus native
        `sessions_spawn`/`sessions_send`/`sessions_yield` planner orchestration.
      - Footer migration: final user-visible outbound footer defaults to compact,
        explicit off still disables it, compact mode omits debug IDs, and
        ACK/status/onboarding/internal native delivery sends keep
        `footerMode=off`.
