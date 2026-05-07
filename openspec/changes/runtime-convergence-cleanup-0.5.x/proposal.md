# Change: Runtime Convergence Cleanup 0.5.x

## Purpose

Converge the partially migrated OctoClaw runtime into one clear truth model and delete obsolete runtime paths. The goal is to reduce garbage code, improve stability, and remove hot-path complexity that currently comes from maintaining multiple completion, delivery, status, and recovery mechanisms at the same time.

This is a delete-first cleanup. Legacy runtime paths are removal targets, not compatibility layers.

## Problem

OctoClaw currently has correct planner/native foundations, but several old paths still exist near or inside the runtime:

- `task-state.json` still behaves like a WorkContract read source in some paths.
- SQLite runtime ledger exists but is not the default OctoClaw metadata truth.
- Completion file prompts and child-finalizer recovery still exist.
- Delivery outbox still exists as a recovery/delivery fallback.
- `octoclaw_spawn` still exists as a separate entrypoint and policy/model path.
- `api.runtime.subagent.run()` fallback and fake detached runtime can make capability/status look real without native `sessions_spawn` evidence.

The result is more code, more divergent status inference, more background I/O, and more ways to claim task progress from the wrong source.

## Scope

This change includes:

- Make SQLite metadata ledger the normal store for WorkContract/native refs/spawn intents.
- Make `task-state.json` a generated status projection/read-model cache only.
- Centralize status/details/grounding/watchdog projection reads.
- Remove completion file requirement from the planner/native child prompt.
- Remove planner child-finalizer scheduling and recovery loops.
- Remove delivery outbox writes and flush interval from runtime.
- Remove `octoclaw_spawn` as a public tool.
- Remove direct `runtime.subagent.run()` planner fallback.
- Remove fake detached runtime registration.
- Add invariant tests and smoke evidence for native planner/confirm/announce.
- Record migration/backfill/degraded diagnostics without turning them into permanent runtime fallbacks.

## Non-Goals

- Do not replace OpenClaw native execution lifecycle state with OctoClaw SQLite.
- Do not modify OpenClaw native SQLite schema.
- Do not add a resident runner, warm worker pool, direct SDK spawn main path, or default multi-agent backend.
- Do not add a new scheduler, delivery outbox, completion protocol, or alias for old tools.
- Do not inject raw child transcripts into parent context.
- Do not keep long-lived rollback flags or compatibility modes.
- Do not preserve `task-state.json` as a normal read fallback.

## Truth Model

- OpenClaw native `sessions_spawn`, native runs, flows, and subagent registry own execution lifecycle truth.
- `NativeSpawnIntent` owns the planner/confirm handshake and accepted run evidence.
- WorkContract owns OctoClaw semantic/delegation/handoff/continuity metadata and accepted native refs.
- SQLite runtime ledger owns durable OctoClaw metadata/audit truth.
- `task-state.json` is a generated projection/read-model cache that can be deleted and rebuilt.
- ACK/status/details/grounding/footer/dashboard are projections.
- Replay/runtime events are audit/observability, not execution truth.

## Acceptance Gate

The change is acceptable only when:

- Planner/native delegate path runs end to end without completion file, child-finalizer, delivery outbox, or `octoclaw_spawn`.
- WorkContract/native refs/spawn intents are read from SQLite by default.
- `task-state.json` deletion or corruption does not erase durable task truth.
- Status/details/grounding/watchdog use one projection source.
- `octoclaw_spawn` no longer appears in the tool manifest.
- Fake detached runtime is not registered as real capability.
- SQLite unavailable produces explicit degraded/fail-closed diagnostics.
- Native announce final delivery does not produce `completion_file_timeout`.
- Slack/acceptance smoke shows no duplicate final and no legacy outbox queue.
- Code search confirms planner path no longer imports or calls legacy finalizer/outbox/spawn modules.

## Rollout

Rollout is by PR/work package, not by permanent runtime flag:

1. Add docs/OpenSpec and invariant tests.
2. Default WorkContract/native metadata reads to SQLite.
3. Centralize projection rebuild and task-state quarantine.
4. Delete completion file and child-finalizer planner path.
5. Delete delivery outbox runtime path.
6. Delete legacy entrypoints and fake runtime.
7. Run local tests and live Slack/acceptance smoke.

Rollback is git revert of the affected PR. The runtime must not carry a long-lived environment fallback to the old path.
