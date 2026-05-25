# Change: Native-First Runtime Slimming V2

Date: 2026-05-24
Target release: v0.6.x
Depends on: `runtime-gate-convergence-0.5.x`, `post-p5-runtime-slimming-0.6.x`, `runtime-stability-contracts-0.6.x`

## Purpose

Slim the OctoClaw runtime default path while preserving native execution safety.
This change aligns runtime code with the architecture already documented in the
README:

1. OpenClaw native TaskFlow is lifecycle truth.
2. WorkContract is semantic and delegation truth.
3. Runtime ledger stores metadata, audit, route seals, and native refs.
4. Task-state/policy-state is a rebuildable cache.

The implementation should make the hot path easier to reason about by moving
advanced orchestration out of the default profile and by splitting
`before-tool-call.ts` into deep gate modules with narrow authority.

## Problem

The runtime has accumulated several useful but expensive default-path mechanisms:

- speculative preload
- route hint multi-layer fallback
- wall-time budget escalation
- retry/amendment automation
- WorkContract/tool-policy/workflow hard blocks in `before_tool_call`

Individually these mechanisms are defensible. Together they create hidden
intersections where one gate can tell the model to call `octoclaw_dispatch` and
another gate can block that same dispatch. The file
`extensions/octoclaw-runtime/src/hooks/before-tool-call.ts` has become the place
where nearly every policy meets every tool call.

The result is a runtime that is harder for AI workers to modify safely. It also
increases bug risk because cache fields can look authoritative even when native
status should be the only lifecycle truth.

## Scope

### S1: Default feature profile

Default-on:

- native dispatch and confirm path
- native spawn intent hash gate
- budgeted-main tool-risk escalation
- status/provenance no-new-work protection
- native announce delivery duplicate-work protection
- compact footer for final user-visible result replies

Default-off or advisory-only:

- speculative preload
- route hint hard precondition and multi-layer fallback
- automatic retry/amendment/respawn
- wall-time route mutation for main reply

Explicit manual retry through `octoclaw_task_action retry` is not automation and
is not removed by this change.

### S2: State truth contract

Add code and tests that separate:

- native lifecycle truth
- ledger audit metadata
- policy-state cache
- generated projection

Projection/status must not treat task-state/policy-state terminal fields as
final lifecycle truth when native status disagrees.

Legacy execution markers such as `dispatchExecuted`, `spawnExecuted`,
`resultMaterialized`, and `nativeAnnounceDelivered` remain compatibility
metadata unless paired with accepted native/runtime evidence. They must not
independently prove lifecycle or compact footer execution facts.

### S3: Gate extraction

Refactor `before-tool-call.ts` into an orchestrator over:

- `SessionControlGate`
- `NativeSpawnGate` runner
- `BudgetedMainGate`
- `RouteHintGate`
- `DelegationWorkflowGuard`

The extraction is successful only if each gate has a narrow interface and
targeted tests. Moving code without reducing cross-gate authority does not count.
Native session tools (`sessions_spawn`, `sessions_send`, `sessions_yield`) stay
under native spawn/session-control authority and must not be counted as ordinary
budgeted-main tools.

### S4: Dead hard-block removal

After tests exist and gates are extracted, downgrade or remove default hard
blocks that can create dispatch dead zones:

- route hint precondition for `octoclaw_dispatch`
- WorkContract forbidden-tool block for `octoclaw_dispatch`
- workflow enforcement block for `octoclaw_dispatch`
- default wall-time route mutation

## Non-Goals

- No new OpenClaw replacement runtime.
- No second task-state machine.
- No default multi-agent topology.
- No local model filtering.
- No router scoring or leaderboard changes.
- No removal of native spawn intent, WorkContract, or dispatch confirm.
- No weakening of `sessions_spawn` / `sessions_send` hash validation.
- No replacement native status projector; reuse existing native status projector
  and OpenClaw runtime adapter.

## Acceptance Gate

- [ ] BDD scenarios in `bdd.md` are covered by tests.
- [ ] `before-tool-call.ts` is an orchestrator with gate calls, not a strategy
      container.
- [ ] `NativeSpawnGate` still blocks missing or mismatched pending intents.
- [ ] `BudgetedMainGate` escalates risky tools but does not block
      `octoclaw_dispatch`.
- [ ] Route hint is advisory by default and cannot deadlock dispatch.
- [ ] Wall-time budget is observation-only by default.
- [ ] Final-result compact footer is default-on, while ACK/status/onboarding
      sends remain footer-free unless explicitly configured.
- [ ] Projection/status ignores stale task-state lifecycle claims when native
      status disagrees.
- [ ] No advanced orchestration path becomes default-on.
- [ ] `pnpm check`, targeted tests, and relevant regression tests pass.
- [ ] `npx gitnexus detect-changes --repo OctoClaw` confirms expected scope
      before commit.
