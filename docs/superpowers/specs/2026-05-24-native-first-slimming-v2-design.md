# Native-First Runtime Slimming V2 Design

## Goal

Make the OctoClaw runtime smaller and more stable by removing default-on advanced orchestration paths, tightening lifecycle truth to OpenClaw native status, and splitting the `before_tool_call` hot path into deep gate modules with narrow authority.

This is a native-first slimming change, not a new sub-agent runtime. OpenClaw remains responsible for session, subagent, tool execution, run lifecycle, and final native announce delivery. OctoClaw remains responsible for routing policy, cost and health policy, WorkContract semantics, native spawn intent contracts, audit metadata, and verification surfaces.

## Non-Goals

- Do not reimplement OpenClaw TaskFlow, session runtime, subagent runtime, or tool execution.
- Do not remove WorkContract, native spawn intent, `octoclaw_dispatch`, `octoclaw_dispatch_confirm`, or native spawn hash validation.
- Do not remove budgeted-main tool-risk escalation.
- Do not add default multi-agent orchestration.
- Do not default-enable wall-time kill/escalation of a main-agent reply.
- Do not filter local models in this change.
- Do not change router scoring or model leaderboard logic in this change.

## Current Problems

### Advanced paths are too active on the default path

The runtime currently carries several advanced mechanisms that are useful in narrow cases but add hot-path state and blocking combinations:

- speculative preload
- budgeted main then delegate with wall-time pending behavior
- route hint multi-layer fallback
- retry/amendment automation

The desired default is simpler: route once, allow safe native dispatch, let OpenClaw own execution, and display compact proof. Advanced paths should be opt-in or reduced to advisory evidence.

### State truth is documented but not consistently enforced by interfaces

The README and WorkContract comments already define the right model:

- OpenClaw native TaskFlow is lifecycle truth.
- WorkContract is semantic truth.
- ledger stores metadata, audit, and native refs.
- task-state/policy-state is a rebuildable cache.

The code still exposes cache-like fields such as `dispatchExecuted`, `spawnExecuted`, `resultMaterialized`, `latestStatus`, `nativeAnnounceDelivered`, and `budgetedMain` through one broad `PolicyStateEntry`. Those fields are useful for a current turn, but they must not become lifecycle authority.

### `before-tool-call.ts` is an overloaded route intersection

`extensions/octoclaw-runtime/src/hooks/before-tool-call.ts` currently combines native spawn gating, route hint checks, budgeted-main observation/escalation, native announce delivery protection, session control rules, direct tool tracking, WorkContract forbidden-tool checks, manual delegation pattern blocks, workflow enforcement, speculative preload, replay, and ACK tracking.

The problem is not only file length. Multiple sections can block or mutate state, so order becomes hidden semantics. This can create dead zones where one section tells the model to call `octoclaw_dispatch` and another section blocks `octoclaw_dispatch`.

## Default Feature Profile

### Default-on core

- `octoclaw_dispatch` creates or materializes a WorkContract and native spawn intent.
- Native `sessions_spawn` / `sessions_send` must match a pending native spawn intent and argument hash.
- `octoclaw_dispatch_confirm` records native refs only after accepted native evidence.
- Budgeted-main observes ordinary tools and escalates on tool-risk evidence:
  - write/mutation tools
  - long verification/build/deploy commands
  - multi-step shell chains
  - unknown-risk shell commands
  - read-only tools above the configured small budget
- Session/status/provenance follow-ups must not start new work.
- Native announce completion delivery blocks duplicate dispatch/spawn while delivery is active.
- Compact footer becomes default-on for final user-visible result replies and reports route/model/status from evidence available for display.

### Default-off or advisory-only advanced paths

- Speculative preload is default-off.
- Route hint multi-layer fallback is default-off.
- Automatic retry/amendment/respawn is default-off.
- Wall-time budget for main reply is observation-only by default.
- WorkContract forbidden tools should not independently block `octoclaw_dispatch`; dispatch admission explains structured overrides.

Current source anchors:

- Speculative preload already defaults off through `resolveSpeculativePreloadEnabled()` in `extensions/octoclaw-runtime/src/config/index.ts`; V2 should preserve and test that default, not invent a second preload switch.
- Startup cost policy still lists `wall_time_over_budget` in `classifyStartupCost()`; V2 must distinguish policy metadata from default hard route mutation.
- Footer has two current surfaces: `hooks/footer-mode.ts` supports `off | compact | debug`, while IM adapters currently expose mostly `off | debug`. V2 must normalize the final-result footer path carefully instead of blindly setting every IM send to debug.
- Native lifecycle projection already exists in `state/native-status-projector.ts` and `runtime-host/openclaw-adapter.ts`. V2 should deepen those modules or add adapters beside them, not create a parallel lifecycle system.
- Retry currently exists as explicit `octoclaw_task_action retry` plus ledger attempt rows. V2 default-off automation must not remove explicit manual retry.
- `classifyBudgetedMainTool()` currently treats `sessions_spawn`, `sessions_yield`, and `session_status` as control tools, but `sessions_send` needs the same V2 protection. Native session tools must not be counted as ordinary budgeted-main tools.
- `appendReplyProjectionFooter()` currently treats cache/telemetry booleans such as `dispatchExecuted` and `spawnExecuted` as enough to show `route=delegate`. V2 must replace that with accepted native/dispatch evidence so a stale cache cannot promote a footer fact.

### Advanced mode

Advanced mode may opt into speculative preload, wall-time escalation, route hint hard preconditions, and retry/amendment automation. Each advanced feature must have a named flag, targeted tests, and footer/debug evidence. Advanced mode must not weaken `NativeSpawnGate`.

Suggested feature flags for implementation, if equivalent flags do not already exist:

- `OCTOCLAW_SPECULATIVE_PRELOAD`: existing preload flag; keep semantics.
- `OCTOCLAW_ROUTE_HINT_HARD_GATE`: new explicit hard-precondition opt-in if retained.
- `OCTOCLAW_BUDGETED_MAIN_WALL_TIME_ESCALATION`: new explicit wall-time route mutation opt-in if retained.
- `OCTOCLAW_TASK_RECOVERY_AUTOMATION`: new explicit retry/amend/respawn automation opt-in if retained.
- `OCTOCLAW_PROJECTION_FOOTER_MODE`: existing footer mode; V2 changes the final-result default only after tests cover ACK/status/native delivery exclusions.

## State Truth Contract

### OpenClaw native status

OpenClaw native status is the only lifecycle authority for:

- accepted run/session
- running
- completed
- failed
- timed out
- canceled
- native announce final delivery

OctoClaw may cache native observations, but a cache entry is not truth when native evidence disagrees.

Existing modules to reuse:

- `extensions/octoclaw-runtime/src/state/native-status-projector.ts`
- `extensions/octoclaw-runtime/src/runtime-host/openclaw-adapter.ts`
- `extensions/octoclaw-runtime/src/tools/runtime-status.ts`
- `extensions/octoclaw-runtime/src/state/task-state-store.ts`

Do not create a second status projector. If a new type such as `NativeExecutionSnapshot` is added, it must wrap or narrow these existing native projection outputs.

### Runtime ledger

The ledger is metadata and audit authority for:

- WorkContract storage
- route seal
- native spawn intent
- native refs captured after accepted evidence
- replay/audit events
- cost and policy metadata

The ledger can prove that a dispatch was planned, sealed, requested, or accepted by a native call. It cannot prove final lifecycle status without native status or native announce evidence.

Accepted execution evidence means one of:

- `octoclaw_dispatch_confirm` recorded an accepted native response for the WorkContract.
- The OpenClaw runtime adapter reports a found native run/flow/session status.
- Native announce final delivery evidence records the completed result delivery.

Legacy booleans such as `dispatchExecuted`, `spawnExecuted`, `resultMaterialized`, and `nativeAnnounceDelivered` may remain in WorkContract telemetry, task-state, or policy-state for compatibility, but V2 must treat them as `LegacyExecutionMarkers` unless paired with accepted native/runtime evidence.

### Task-state / policy-state cache

Task-state and policy-state are rebuildable caches for:

- current turn policy context
- route hint bookkeeping
- blocked tool history
- ACK state
- footer hints
- recent prompt lookup
- budgeted-main observation
- speculative preload state when enabled

These caches must not decide final lifecycle status. If stale cache says completed but native status says running, projection must show running or running_slow. If stale cache says failed but native status says completed, projection must show completed.

Known current risk to address: `task-state-store.ts` preserves `previous.status` when native ids exist and the WorkContract is not terminal. V2 must keep that as display compatibility only, not lifecycle truth.

### Projection

Status projection is generated output. It may include cached fields as display metadata, but its status must be derived from native lifecycle truth plus explicit materialized result evidence. Projection must be rebuildable after deleting task-state.

## Gate Architecture

`before-tool-call.ts` should become an orchestrator that loads current context once, calls narrow gates in a stable order, applies returned state patches, records replay, and exits.

### NativeSpawnGate

Authority:

- Gate `sessions_spawn`, `sessions_send`, and `sessions_yield`.
- Require a matching pending native spawn intent.
- Validate canonical argument hash.
- Allow only recoverable planner envelope drift already covered by tests.
- Transition native spawn intent to `spawn_call_started`.

Hard block:

- Missing pending intent.
- Args hash mismatch.
- Waiting/yielding before child has started.
- Execution follow-up tries to spawn new work.

Not allowed:

- Decide route.
- Read route hint as lifecycle truth.
- Infer final task status.

### BudgetedMainGate

Authority:

- Observe ordinary main-agent tool calls.
- Classify tool risk using structured tool name, tool params, and parsed shell command signals.
- Emit budget escalation evidence when ordinary tool use exceeds the main fast path.
- Block the risky ordinary tool call and tell the model to call `octoclaw_dispatch`.

Hard block:

- The specific ordinary tool call that caused tool-risk escalation.

Not allowed:

- Block `octoclaw_dispatch`.
- Directly spawn a child.
- Treat wall-time alone as default hard escalation.
- Decide final delegate lifecycle.

Control-tool pass-through:

- `octoclaw_dispatch`
- `octoclaw_dispatch_confirm`
- `octoclaw_status`
- `octoclaw_task_action`
- `octoclaw_route_hint`
- `sessions_spawn`
- `sessions_send`
- `sessions_yield`
- `session_status`

These tools are not ordinary budgeted-main tools. In particular, `sessions_send` must be covered by tests because existing classification did not list it with the other native session tools.

Default wall-time behavior:

- Record `running_slow` or `wall_time_observed` evidence only.
- If the main agent later calls `octoclaw_dispatch`, the time observation may be included as reason metadata.
- No default timer should force route mutation or kill the main reply.

### DispatchAdmission

Authority:

- Lives in the `octoclaw_dispatch` execute path, not as a generic before-tool-call block.
- Decide whether reply can transition to delegate.
- Consume structured evidence:
  - already delegate route
  - explicit delegate request
  - budgeted-main escalation evidence
  - accepted route objection
  - valid delegate WorkContract
- Supersede stale reply WorkContract only when structured evidence exists.

Not allowed:

- Use stale task-state terminal status as final truth.
- Depend on route hint hard preconditions by default.

### DelegationWorkflowGuard

Authority:

- For delegated route, block ordinary/manual delegation patterns that bypass `octoclaw_dispatch`.
- Keep the main agent from using direct tools when a delegate route requires dispatch.

Hard block:

- Direct ordinary tools on a confirmed delegate route when no dispatch/spawn evidence exists.
- Manual `sessions_*` use without NativeSpawnGate approval.

Not allowed:

- Block `octoclaw_dispatch`.
- Duplicate WorkContract forbidden-tool dispatch logic.

### RouteHintGate

Authority:

- Record route hint bookkeeping.
- Preserve compatibility for explicit `octoclaw_route_hint`.
- Produce advisory evidence for debug/replay.

Default behavior:

- No hard precondition before dispatch.
- No multi-layer fallback loop.
- No repeated prompt pressure to route differently.

Advanced behavior:

- May require route hint before selected tools only when an advanced flag is enabled and BDD tests prove no dispatch dead zone.

### SessionControlGate

Authority:

- Status/provenance/session control requests.
- Native announce delivery protection.
- Prevent status follow-up from starting new work.
- Allow `octoclaw_status` and `octoclaw_task_action` bookkeeping.

Hard block:

- New spawn/dispatch while native announce completion is actively delivering.
- Status/provenance follow-up attempting new work.

Not allowed:

- Decide model routing.
- Infer task completion from task-state cache.

### FooterProjection

Authority:

- Append compact display evidence by default.
- Show debug IDs only in debug mode.

Default footer fields:

- `route`
- `model`
- `status`
- optional `reason`

Rules:

- `route=delegate` requires dispatch/spawn evidence or explicit delegated route evidence.
- `via=native_announce` requires native final delivery evidence.
- Footer must not promote policy suggestion to executed fact.
- Neutral ACKs, status cards, onboarding messages, and native delivery internals may keep `footerMode=off`; "default-on footer" means final assistant result surfaces, not every IM send.
- Debug IDs such as WorkContract IDs, spawn intent IDs, native run IDs, worker pool, and health notes stay debug-only unless there is an explicit compact-field decision.
- Compact rendering must use a sanitized compact projection. Do not pass a debug-shaped `IMProjectionFooter` into compact mode and rely on renderers to ignore debug fields.

## Implementation Strategy

### Phase 0: Guardrails and baseline

Add tests before behavior changes. Record current `before-tool-call.ts` LOC and targeted test baseline. Add smoke tests for current critical flows so refactors do not change behavior accidentally.

### Phase 1: Default-off advanced profile

Move advanced feature defaults behind named configuration:

- speculative preload remains default-off and gets a guard test
- route hint hard precondition default-off
- retry/amendment automation default-off
- wall-time escalation default observation-only
- final-result compact footer default-on with ACK/status/native-delivery exclusions

Do not remove code in Phase 1 unless a flag is unused. The goal is lower hot-path risk first.

### Phase 2: State truth guardrails

Introduce narrow helpers that make truth source explicit, reusing the current native status projector:

- `NativeExecutionSnapshot`
- `LedgerAuditSnapshot`
- `PolicyStateCacheSnapshot`
- `TaskProjectionInput`

Change projection/status code so lifecycle status is derived from native truth inputs. Keep policy-state fields as display metadata only.

`NativeExecutionSnapshot` is a typed facade over `NativeStatusProjection` / `RuntimeStatusSnapshot`, not a new source of status.

### Phase 3: Extract gates

Extract deep modules from `before-tool-call.ts` in this order:

1. `SessionControlGate`
2. `NativeSpawnGate` orchestration wrapper around existing native gate helpers
3. `BudgetedMainGate`
4. `RouteHintGate`
5. `DelegationWorkflowGuard`
6. `FooterProjection` if footer logic is still mixed with hooks

Each extracted gate must have a small interface:

```ts
export interface ToolGateInput {
  toolName: string;
  toolParams: Record<string, unknown>;
  ctx: Record<string, unknown>;
  stateKey: string;
  state: Record<string, unknown>;
  decision: Record<string, unknown>;
  config: Record<string, unknown>;
  now: number;
}

export type ToolGateResult =
  | { action: "allow"; statePatch?: Record<string, unknown>; replay?: Record<string, unknown>[] }
  | { action: "block"; reason: string; statePatch?: Record<string, unknown>; replay?: Record<string, unknown>[] }
  | { action: "observe"; statePatch?: Record<string, unknown>; replay?: Record<string, unknown>[] };
```

The exact TypeScript names may differ, but the interface must keep gates from directly owning unrelated replay, ACK, and state lookup logic.

Ordering rule:

- `SessionControlGate` runs first because native announce delivery and status/provenance no-new-work checks are true hard safety.
- `NativeSpawnGate` runs before ordinary tool budget/workflow logic so `sessions_spawn`, `sessions_send`, and `sessions_yield` cannot be reclassified as direct tools.
- `BudgetedMainGate` runs before route hint and workflow guards so a risky ordinary tool can produce structured dispatch evidence and the next `octoclaw_dispatch` can reach dispatch admission.
- `RouteHintGate` and `DelegationWorkflowGuard` may block ordinary tools, but must pass through `octoclaw_dispatch`.

### Phase 4: Remove dead intersections

After gates exist and tests pass:

- remove hard route hint dispatch precondition by default
- remove WorkContract forbidden-tool hard block for `octoclaw_dispatch`
- remove workflow enforcement hard block for `octoclaw_dispatch`
- remove default wall-time timer route mutation
- preserve explicit `octoclaw_task_action retry`; only automatic retry/amend/respawn is default-off
- keep explicit advanced-mode tests for any retained hard behavior

## Required Tests

### Unit tests

- `NativeSpawnGate` allows exact pending intent.
- `NativeSpawnGate` blocks args hash mismatch.
- `NativeSpawnGate` blocks `sessions_yield` before child start.
- `BudgetedMainGate` escalates write tool and blocks that tool.
- `BudgetedMainGate` does not block `octoclaw_dispatch`.
- `BudgetedMainGate` records wall-time observation without default route mutation.
- `RouteHintGate` records hint but does not hard-block dispatch by default.
- `DelegationWorkflowGuard` blocks direct ordinary tools on delegate route but allows `octoclaw_dispatch`.
- `SessionControlGate` prevents status follow-up from new spawn.
- Projection ignores stale task-state terminal cache when native status differs.

### Regression tests

- Budgeted-main escalation cannot deadlock.
- Stale reply WorkContract can be superseded by structured budget evidence.
- Status follow-up does not create new spawn.
- Native announce completion delivery prevents duplicate dispatch.
- Footer does not show delegate without execution evidence.
- Footer does not show native announce without final native delivery.
- Final-result compact footer appears by default, while neutral ACK/status/onboarding sends remain footer-free.

### BDD

BDD scenarios live in `openspec/changes/native-first-slimming-v2-0.6.x/bdd.md` and must pass before the change is complete.

## Rollout

Use feature profile migration:

1. Phase 1 changes defaults but keeps advanced flags available.
2. Phase 2 makes status truth explicit without deleting cache fields.
3. Phase 3 extracts gates without behavior change.
4. Phase 4 deletes or downgrades dead default hard gates.

Each phase must be independently testable and committable. If a phase fails, rollback should revert only that phase.

## Success Criteria

- `before-tool-call.ts` becomes an orchestrator, not a strategy container.
- Runtime code is shorter or flatter in the hot path.
- No new second lifecycle engine appears.
- Native spawn safety remains strict.
- Fewer default-on advanced states are written.
- Stale task-state cannot override native status.
- `octoclaw_dispatch` remains the single structured transition point from reply to delegate.
- The implementation plan, OpenSpec, and BDD are detailed enough for an AI worker to implement without changing architecture direction.
