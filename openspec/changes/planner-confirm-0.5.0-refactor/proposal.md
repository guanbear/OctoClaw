# Change: OctoClaw 0.5.0 sessions_spawn Planner/Confirm Refactor

## Purpose

Make OctoClaw 0.5.0 use OpenClaw native `sessions_spawn` as the execution path while keeping OctoClaw as the policy, WorkContract, model-cost, ACK, and IM experience layer.

The confirm in this change is a technical write-back step: `octoclaw_dispatch` creates a spawn intent, the main agent calls native `sessions_spawn`, and `octoclaw_dispatch_confirm` records accepted run evidence. It is not a new user-facing confirmation workflow.

## Scope

- PC1: Add planner backend feature flags and OpenSpec worker boundaries.
- PC2: Add `NativeSpawnIntent` metadata store with canonical args hash, TTL, idempotency, and conflict handling.
- PC3: Make `octoclaw_dispatch` return a compact `sessionsSpawnArgs` plan in planner mode without spawning.
- PC4: Gate native `sessions_spawn` calls through pending intent, hash, TTL, and session checks.
- PC5: Add `octoclaw_dispatch_confirm` and require accepted `runId` before native refs or delegate ACK.
- PC6: Store native refs on WorkContract without making WorkContract the execution-status truth source.
- PC7: Disable legacy scheduler, completion file, child-finalizer, and delivery outbox on planner path while preserving explicit legacy fallback.
- PC8: Project status from OpenClaw native runs/flows/subagent registry.
- PC9: Keep ACK/footer/judge behavior truthful around planner, spawn, confirm, and completion boundaries.
- PC10: Use OpenSpec task slices to coordinate Codex leader, GLM-5.1 workers, and cheaper test/documentation workers.

## Non-Goals

- No direct import of OpenClaw internal `spawnSubagentDirect()`.
- No assumption that `api.runtime.subagent.run()` is equivalent to tool-level `sessions_spawn`.
- No new task engine, scheduler, completion protocol, delivery outbox, or default multi-agent live path.
- No user-confirmation product flow added by this change.
- No raw child transcript injection into parent context.
- No live policy/model promotion outside explicit evaluation gates.
- No broad rewrite of the existing judge. Judge changes are limited to schema/actionability guardrails needed by planner admission.

## Acceptance Gate

A slice is acceptable only when:

- It names the truth source it uses: `NativeSpawnIntent`, WorkContract metadata, OpenClaw native runs/flows/subagent registry, or replay/telemetry.
- It maps changed files and tests back to one `tasks.md` slice.
- It does not create execution facts before native `sessions_spawn` accepted evidence exists.
- It does not send delegate accepted ACK before `octoclaw_dispatch_confirm` validates a non-empty `runId`.
- It keeps parent-visible planner/confirm packets compact and sanitized.
- It does not broaden judge/live policy beyond this change's scope.
- It preserves explicit legacy fallback until planner path acceptance is complete.
