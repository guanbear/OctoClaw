# Tasks: Native-First Runtime Slimming V2

## Baseline

- [ ] Run `git status --short` and note unrelated dirty files.
- [ ] Record current LOC:

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
- [ ] Make final-result compact footer default-on while keeping ACK/status
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

- [ ] Normalize final result footer behavior across outbound guard and IM
      adapters.
- [ ] Keep compact footer free of debug IDs.
- [ ] Build compact footer from a compact-sanitized projection, not from a
      debug-shaped projection with fields hidden by adapter convention.
- [ ] Keep neutral ACK, route commit ACK, status card direct sends, onboarding,
      and native delivery internals on `footerMode=off`.
- [ ] Prove `via=native_announce` appears only after final native delivery.

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

- [ ] Reduce `before-tool-call.ts` to orchestration and shared side effects.
- [ ] Use the intended gate order: `SessionControlGate`,
      `NativeSpawnGate` runner, `BudgetedMainGate`, `RouteHintGate`,
      `DelegationWorkflowGuard`.
- [ ] Record after LOC.
- [ ] Confirm each gate has targeted tests.
- [ ] Confirm no gate imports more broad dependencies than needed.

## Verification

- [ ] Run targeted suites:

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

- [ ] Run full verification:

```bash
pnpm check
pnpm test
git diff --check
npx gitnexus detect-changes --repo OctoClaw
```

## Closeout Criteria

- [ ] BDD scenarios are mapped to tests.
- [ ] No advanced feature became default-on.
- [ ] No second lifecycle engine exists.
- [ ] Native spawn hash gate remains strict.
- [ ] `octoclaw_dispatch` is not blocked by route hint, WorkContract forbidden
      tools, budgeted-main, or workflow enforcement before dispatch admission.
- [ ] Status/projection lifecycle comes from native truth, not stale cache.
- [ ] Implementation notes list changed files, deleted hard gates, and LOC delta.
