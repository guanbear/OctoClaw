# BDD: Native-First Runtime Slimming V2

Date: 2026-05-24

## Naming

- `NFSV2-TRUTH-*`: lifecycle truth and projection
- `NFSV2-GATE-*`: tool gate behavior
- `NFSV2-BUDGET-*`: budgeted-main behavior
- `NFSV2-HINT-*`: route hint behavior
- `NFSV2-FOOTER-*`: footer truth behavior

## NFSV2-TRUTH-001: Native running beats stale completed cache

**Given** native OpenClaw status reports a child run is running
**And** policy-state or task-state cache says the same task is completed
**When** OctoClaw builds task status projection
**Then** the projected status is running or running_slow
**And** the projection does not mark success from cache alone

## NFSV2-TRUTH-002: Native completed beats stale failed cache

**Given** native OpenClaw status reports a child run completed with final result evidence
**And** policy-state or task-state cache says the same task failed
**When** OctoClaw builds task status projection
**Then** the projected status is completed
**And** stale cache failure is retained only as debug/audit metadata if displayed

## NFSV2-TRUTH-003: Native refs alone do not prove spawn execution

**Given** a WorkContract has native refs copied from metadata
**And** there is no accepted native run evidence
**When** OctoClaw builds execution projection
**Then** `spawnExecuted` is false
**And** status does not become running/completed from refs alone

## NFSV2-TRUTH-004: Projection rebuilds without task-state

**Given** task-state/policy-state cache is deleted
**And** ledger metadata plus native status are still available
**When** OctoClaw builds a status projection
**Then** projection still includes route, WorkContract ID, native run/task refs, and lifecycle status

## NFSV2-TRUTH-005: Legacy execution booleans are not lifecycle truth

**Given** task-state, policy-state, or WorkContract telemetry has `dispatchExecuted=true` or `spawnExecuted=true`
**And** no `octoclaw_dispatch_confirm` accepted response or OpenClaw native status evidence exists
**When** OctoClaw builds lifecycle projection or compact footer evidence
**Then** lifecycle status is not promoted to running/completed from those booleans alone
**And** compact footer does not claim `route=delegate` from those booleans alone

## NFSV2-GATE-001: Native spawn requires pending intent

**Given** the model calls `sessions_spawn`
**And** no pending native spawn intent exists for the session
**When** NativeSpawnGate evaluates the call
**Then** the call is blocked
**And** the block reason tells the model to call `octoclaw_dispatch` first

## NFSV2-GATE-002: Native spawn hash mismatch is blocked

**Given** a pending native spawn intent exists
**When** the model calls `sessions_spawn` with changed canonical arguments
**Then** NativeSpawnGate blocks the call
**And** the block reason tells the model to retry `sessions_spawn` with exact args
**And** it does not tell the model to rerun `octoclaw_dispatch`

## NFSV2-GATE-003: Sessions yield before child start is blocked

**Given** a native spawn intent is pending
**And** no accepted child run/session exists yet
**When** the model calls `sessions_yield`
**Then** NativeSpawnGate blocks the call
**And** the block reason names the required next native tool

## NFSV2-BUDGET-001: Risky ordinary tool escalates but does not execute

**Given** a reply route is active
**When** the main agent calls a write, long, multi-step, or unknown-risk ordinary tool
**Then** BudgetedMainGate records budget escalation evidence
**And** blocks that ordinary tool call
**And** instructs the model to call `octoclaw_dispatch`

## NFSV2-BUDGET-002: Budget escalation admits dispatch

**Given** BudgetedMainGate has recorded budget escalation evidence
**When** the model calls `octoclaw_dispatch` with the original task
**Then** the dispatch admission path is allowed to run
**And** admission reason is `budgeted_main_escalation`
**And** no route hint, WorkContract forbidden-tool, or workflow gate blocks dispatch first

## NFSV2-BUDGET-003: Wall-time alone is observation by default

**Given** a reply route is active
**And** the main agent exceeds the budgeted wall-time threshold
**When** no risky ordinary tool and no explicit dispatch call occurs
**Then** OctoClaw records a slow-running observation
**And** does not mutate route to delegate
**And** does not kill the main reply
**And** does not claim child work started

## NFSV2-BUDGET-004: Native session tools are not ordinary budget tools

**Given** a reply route has budgeted-main tracking active
**When** the model calls `sessions_spawn`, `sessions_send`, `sessions_yield`, or `session_status`
**Then** BudgetedMainGate does not count the call as an ordinary main-agent tool
**And** NativeSpawnGate or session-control logic owns any allow/block decision for the native session tool

## NFSV2-HINT-001: Route hint is advisory by default

**Given** route hint has not been submitted
**When** the model calls `octoclaw_dispatch` with structured delegate evidence
**Then** RouteHintGate does not block dispatch
**And** any missing route hint is recorded only as advisory/debug evidence

## NFSV2-HINT-002: Advanced hard route hint cannot deadlock dispatch

**Given** advanced hard route hint mode is enabled
**And** BudgetedMainGate has recorded budget escalation evidence
**When** the model calls `octoclaw_dispatch`
**Then** dispatch is not blocked by stale reply WorkContract or workflow enforcement
**And** either route hint policy allows dispatch or the advanced mode returns a single clear corrective action

## NFSV2-GATE-004: Delegate route blocks ordinary tools, not dispatch

**Given** a confirmed delegate route requires `octoclaw_dispatch`
**When** the main agent calls an ordinary direct tool
**Then** DelegationWorkflowGuard blocks the ordinary tool
**When** the main agent calls `octoclaw_dispatch`
**Then** DelegationWorkflowGuard allows dispatch to reach dispatch admission

## NFSV2-GATE-005: Status follow-up cannot spawn new work

**Given** the user asks for status or provenance of existing execution
**When** the model attempts `sessions_spawn` or `octoclaw_dispatch` for new work
**Then** SessionControlGate blocks the new work path
**And** the response should use status/provenance tools instead

## NFSV2-FOOTER-001: Delegate footer requires execution evidence

**Given** policy suggested delegation
**And** no dispatch/spawn evidence exists
**When** a reply is delivered
**Then** the footer must not show `route=delegate`

## NFSV2-FOOTER-001B: Final result compact footer is default

**Given** a final assistant result is being delivered
**And** route and model evidence are available
**When** no footer environment override is configured
**Then** OctoClaw appends a compact footer
**And** the compact footer contains route and model
**And** it does not contain WorkContract ID, spawn intent ID, native run ID, worker pool, or health debug fields
**And** compact rendering receives no debug-only fields

## NFSV2-FOOTER-001C: Non-final sends stay footer-free

**Given** OctoClaw sends a neutral ACK, route commit ACK, status card, onboarding message, or native delivery internal message
**When** no explicit debug footer override is configured
**Then** the send uses `footerMode=off`
**And** no compact footer is appended

## NFSV2-FOOTER-002: Native announce footer requires final native delivery

**Given** a child session exists
**And** native final delivery has not completed
**When** a reply is delivered
**Then** the footer must not show `via=native_announce`

## NFSV2-RECOVERY-001: Manual retry remains available

**Given** a task is failed, blocked, or timed out
**When** the user or model calls `octoclaw_task_action retry <task_id>`
**Then** OctoClaw creates an explicit retry attempt record
**And** this does not require automatic retry/amendment automation to be enabled

## NFSV2-GATE-006: Gate extraction preserves native spawn safety

**Given** `before-tool-call.ts` has been slimmed into gate modules
**When** the native spawn regression suite runs
**Then** missing intent, hash mismatch, and accepted-intent cases behave the same as before extraction
