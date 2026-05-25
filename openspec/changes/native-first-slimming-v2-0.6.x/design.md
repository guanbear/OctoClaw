# Design: Native-First Runtime Slimming V2

## Architectural Boundary

OctoClaw must stay native-first:

- OpenClaw owns session runtime, subagent runtime, tool execution, run lifecycle,
  and native final delivery.
- OctoClaw owns route policy, WorkContract semantics, budget/cost/health policy,
  native spawn intent contracts, audit metadata, and verification surfaces.

The change should make this boundary harder to violate accidentally.

## State Truth Model

| Source | Authority | May decide lifecycle? | Notes |
| --- | --- | --- | --- |
| OpenClaw native status | run/session/task lifecycle | yes | running/completed/failed/timed_out/canceled/native final delivery |
| Native accepted response | run/session accepted evidence | yes for accepted/start only | accepted runId means native accepted, not final completion |
| Runtime ledger | metadata/audit/native refs | no final lifecycle | WorkContract, route seal, spawn intent, replay |
| WorkContract | semantic and delegation truth | no final lifecycle | describes intended work and continuity |
| task-state/policy-state | rebuildable cache | no | ACK, hint, blocked tools, budget observation, display metadata |
| TaskStatusProjection | generated display | no | derived from native truth and metadata |

Existing truth modules to reuse:

- `extensions/octoclaw-runtime/src/state/native-status-projector.ts`
- `extensions/octoclaw-runtime/src/runtime-host/openclaw-adapter.ts`
- `extensions/octoclaw-runtime/src/tools/runtime-status.ts`
- `extensions/octoclaw-runtime/src/state/task-state-store.ts`

V2 may add typed facades around those modules, but must not add a parallel
native status lookup system.

## Default Profile

### Core default-on behavior

The core path remains:

```text
policy resolver
  -> octoclaw_dispatch
  -> WorkContract + native spawn intent
  -> OpenClaw native sessions_spawn/sessions_send
  -> octoclaw_dispatch_confirm after accepted native evidence
  -> OpenClaw native announce/final delivery
  -> OctoClaw projection/footer
```

Budgeted main remains available to keep simple work fast:

```text
reply route
  -> allow no tool or a small number of low-risk read-only tools
  -> risky ordinary tool observed
  -> block that ordinary tool
  -> write budget escalation evidence
  -> tell model to call octoclaw_dispatch
  -> dispatch admission consumes evidence
```

### Advanced default-off behavior

The following must be disabled by default or advisory-only:

| Feature | Default | Advanced behavior |
| --- | --- | --- |
| speculative preload | off | opt-in with explicit config and tests |
| route hint hard precondition | advisory | opt-in hard gate only |
| route hint multi-layer fallback | off | opt-in/debug only |
| retry/amendment automation | explicit manual retry only | opt-in automation only |
| wall-time route mutation | observation-only | opt-in escalation only |

Current `resolveSpeculativePreloadEnabled()` already defaults to off. V2 should
add a guard test for that behavior rather than reworking preload config.

Current footer behavior is split: `hooks/footer-mode.ts` supports
`off | compact | debug`, while IM adapters mostly use `off | debug`. V2's
"footer default-on" means final result compact footer by default. Neutral ACKs,
status cards, onboarding messages, and native delivery internals keep
`footerMode=off` unless a targeted test changes that surface.

Current budgeted-main classification excludes `sessions_spawn`,
`sessions_yield`, and `session_status` as control tools. V2 must also exclude
`sessions_send`. All native session tools are owned by native spawn safety, not
ordinary main-agent budget policy.

Current compact footer projection can see legacy telemetry/cache booleans such
as `dispatchExecuted` and `spawnExecuted`. V2 must require accepted
dispatch/native evidence before compact footer claims `route=delegate`.

## Gate Modules

### `SessionControlGate`

Responsibilities:

- status/provenance/session control requests
- native announce delivery duplicate-work block
- control tool bookkeeping

Hard blocks:

- duplicate dispatch/spawn while native announce completion delivery is active
- new work from status/provenance follow-up

It must not infer completion from task-state.

### `BudgetedMainGate`

Responsibilities:

- ordinary tool risk classification
- budgeted-main state updates
- budget escalation evidence
- block the risky ordinary tool that exceeded budget

It must not block `octoclaw_dispatch`.

It also must not count these control tools as ordinary budgeted-main tools:

- `octoclaw_dispatch`
- `octoclaw_dispatch_confirm`
- `octoclaw_status`
- `octoclaw_task_action`
- `octoclaw_route_hint`
- `sessions_spawn`
- `sessions_send`
- `sessions_yield`
- `session_status`

Default wall-time handling is observation-only. A timer may write a slow-running
observation, but must not mutate route, mark delegate, or claim native work
started.

The current startup cost policy includes `wall_time_over_budget` as metadata.
Implementation must not confuse that metadata with permission to mutate route by
default.

### `NativeSpawnGate` runner

Responsibilities:

- call existing `evaluateNativeSpawnGate`
- call existing `evaluateNativeSessionsSendGate`
- gate `sessions_yield` before child start
- transition pending intents to `spawn_call_started`
- record allowed/blocked replay

This is a hard safety gate and must remain default-on.

### `RouteHintGate`

Responsibilities:

- bind `octoclaw_route_hint` to current context
- record hint submission
- emit advisory/debug replay

Default behavior must not hard-block `octoclaw_dispatch`. If an advanced mode
requires route hint before dispatch, it must have a config flag and BDD coverage
proving no dispatch dead zone.

### `DelegationWorkflowGuard`

Responsibilities:

- prevent ordinary direct tool use on confirmed delegate route
- prevent manual delegation patterns that bypass `octoclaw_dispatch`
- preserve existing safe observer/session-control exceptions

It must never block `octoclaw_dispatch`. Dispatch admission is the single place
that decides reply-to-delegate transition.

## Orchestrator Shape

`before-tool-call.ts` should eventually read like:

```text
resolve context and current policy cache
run SessionControlGate
run NativeSpawnGate runner
run BudgetedMainGate
run RouteHintGate
run DelegationWorkflowGuard
record shared ACK/replay/direct-tool metadata
return allow/block
```

`NativeSpawnGate` must run before ordinary tool budget/workflow logic so native
session tools cannot be misclassified as direct tools. `BudgetedMainGate` must
run before route hint and workflow guards so budget evidence can be created and
the next `octoclaw_dispatch` can reach dispatch admission.

The orchestrator may own shared side effects that genuinely cross gates:

- policy-state lookup and update application
- shared replay emission
- ACK tracking
- logger access
- config snapshot

It should not contain feature-specific strategy blocks.

## Dispatch Admission Rule

`octoclaw_dispatch` is the structured transition point. It may be denied by
dispatch admission, but should not be blocked by route hint, WorkContract
forbidden tools, budgeted-main, or workflow enforcement before admission runs.

Allowed structured evidence:

- already delegate route
- explicit delegate request
- budgeted-main escalation evidence
- accepted route objection
- valid delegate WorkContract
- stale reply WorkContract supersede with structured evidence

Denied cases:

- status/provenance follow-up with no new work
- invalid explicit WorkContract
- no structured delegate evidence

## Projection Rule

Projection must read native lifecycle facts first and cache metadata second.
Examples:

- Native running + cache completed => projection running/running_slow.
- Native completed + cache failed => projection completed.
- Native refs without accepted run evidence => not `spawnExecuted`.
- `dispatchExecuted`, `spawnExecuted`, `resultMaterialized`, and
  `nativeAnnounceDelivered` from task-state/policy-state/telemetry are
  legacy/display markers unless paired with accepted native/runtime evidence.
- Deleted task-state + native/ledger inputs => projection still works.
- `task-state-store.ts` may keep previous status for old display records, but
  that previous status is display compatibility only when native truth exists.

## Footer Rule

Compact footer default applies only to final result replies. Existing final
footer code must keep these distinctions:

- Compact: route/model/status/reason only.
- Debug: WorkContract ID, spawn intent ID, native run ID, worker pool, health.
- Off: neutral ACK, route commit ACK, status card direct sends, onboarding,
  and native delivery internals unless explicitly requested.

Footer truth rules:

- `route=delegate` requires dispatch/spawn evidence or explicit executed
  delegate route evidence.
- `via=native_announce` requires final native delivery evidence.
- Policy suggestion, route hint, or judge preference alone is not footer truth.
- Compact mode must receive a compact-sanitized projection. Debug fields must
  not be sent to compact renderers.

## Failure Modes Prevented

- Main agent is told to dispatch, then dispatch is blocked by stale reply
  contract.
- Route hint missing blocks dispatch even when budget evidence exists.
- Wall-time timer mutates route while the main agent is still producing a valid
  answer.
- Stale task-state terminal status overrides native lifecycle.
- Native spawn happens without matching OctoClaw intent.
- Footer claims delegate/native announce from policy suggestion alone.
- Footer debug IDs leak into compact default replies.

## Rollback

Each phase must be independently revertible:

1. Revert advanced default changes.
2. Revert state truth adapter changes.
3. Revert one gate extraction at a time.
4. Re-enable advanced flags only if targeted BDD shows the feature is needed.

Rollback must not touch WorkContract schema, native spawn intent persistence, or
accepted native refs unless the failing phase edited those areas.
