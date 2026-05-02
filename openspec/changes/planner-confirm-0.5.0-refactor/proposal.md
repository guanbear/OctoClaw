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
- PC11: Remove legacy default-path dependencies after planner/native acceptance while keeping rollback flags.
- PC12: Restore responsiveness with neutral inbound ACK, startup-cost-aware routing, compact planner/native hot path, and latency/provenance observability.
- PC13: Move Slack delivery hot path away from CLI/shell into a Slack delivery port. This is 0.5.x immediate and Slack-only.
- PC14: Add nightly regression harness coverage for route buckets, latency, footer provenance, native announce, completion timeout, and legacy CLI usage. This may run in parallel but is not a 0.5.0 release blocker.
- PC15: Establish the before-dispatch fast delegate design baseline. This is 0.5.x performance recovery design work only until the cache/no-double-judge proof and direct-run backend acceptance are split into implementation slices.

## Non-Goals

- No direct import of OpenClaw internal `spawnSubagentDirect()`.
- No assumption that `api.runtime.subagent.run()` is equivalent to tool-level `sessions_spawn`.
- No new task engine, scheduler, completion protocol, delivery outbox, or default multi-agent live path.
- No user-confirmation product flow added by this change.
- No raw child transcript injection into parent context.
- No live policy/model promotion outside explicit evaluation gates.
- No broad rewrite of the existing judge. Judge changes are limited to schema/actionability guardrails needed by planner admission and startup-cost-aware routing semantics.
- No child start p95 <= 10s acceptance target for 0.5.0; child start latency is observed, not a release gate.
- No warm worker pool or A2A persistent worker in 0.5.0/0.5.x immediate.
- No before-dispatch direct-spawn implementation in the 0.5.0 gate. The design may specify it as 0.5.x performance recovery, but implementation requires separate acceptance evidence.

## Release Boundary

0.5.0 acceptance is Must + Should: planner/confirm correctness, truthful ACK, neutral first ACK, startup-cost-aware routing, judge/footer guardrails, metadata/status projection, and real Slack smoke evidence.

0.5.x immediate work is adjacent but not a 0.5.0 blocker: Slack-only delivery port, legacy default-path removal after native announce is stable, nightly regression harness/reporting, and the before-dispatch fast delegate design baseline.

Deferred work needs a separate OpenSpec: non-Slack IM delivery ports, managed flow orchestration, direct SDK spawn backend, warm worker pool/A2A persistent workers, and unexposed OpenClaw tool allowlist/private hooks.

## Acceptance Gate

A slice is acceptable only when:

- It names the truth source it uses: `NativeSpawnIntent`, WorkContract metadata, OpenClaw native runs/flows/subagent registry, or replay/telemetry.
- It maps changed files and tests back to one `tasks.md` slice.
- It does not create execution facts before native `sessions_spawn` accepted evidence exists.
- It does not send delegate accepted ACK before `octoclaw_dispatch_confirm` validates a non-empty `runId`.
- It keeps parent-visible planner/confirm packets compact and sanitized.
- It does not broaden judge/live policy beyond this change's scope.
- It preserves explicit legacy fallback until planner path acceptance is complete.
- It records neutral ACK latency, route bucket, spawn allowed latency, confirm latency, child progress/final latency, footer provenance, completion timeout, and legacy CLI delivery usage when live Slack behavior changes.
