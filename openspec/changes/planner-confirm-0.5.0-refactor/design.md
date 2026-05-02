# Design

## Truth Model

- **OpenClaw native `sessions_spawn`** owns child session creation, run acceptance, subagent registry registration, completion announce, and delivery retry/fallback.
- **OpenClaw native runs/flows/subagent registry** owns execution lifecycle truth: queued/running/succeeded/failed/timed_out/cancelled/lost.
- **WorkContract** owns semantic delegation truth: user goal, expected deliverable, route seal, model/cost profile, and native refs. It does not advance execution status by itself.
- **NativeSpawnIntent** owns the planner/confirm handshake: compact `sessionsSpawnArgs`, canonical args hash, TTL, session binding, and accepted run evidence.
- **ACK/status/footer projections** are read models. They must not invent spawn, running, completion, or delivery facts.
- **Judge** remains a semantic proposal source. WorkContract admission, spawn-intent gate, and dispatch confirm are the hard side-effect boundaries.

## Planner/Confirm Protocol

1. `octoclaw_dispatch` runs judge/admission/model policy.
2. In planner backend, it creates `NativeSpawnIntent` and returns compact `sessionsSpawnArgs` with status `requires_native_spawn`.
3. `octoclaw_dispatch` does not spawn, does not write running state, and does not send delegate accepted ACK.
4. `before_tool_call` allows `sessions_spawn` only when a current pending intent matches session, TTL, and canonical args hash.
5. Matching `sessions_spawn` moves the intent to `spawn_call_started`.
6. The main agent calls native `sessions_spawn`.
7. The main agent calls `octoclaw_dispatch_confirm` with the native result.
8. `octoclaw_dispatch_confirm` requires `sessionsSpawnStatus=accepted` and non-empty `runId` before writing WorkContract native refs.
9. Delegate accepted ACK is sent only after confirm success.
10. Child completion is delivered by OpenClaw native subagent announce/delivery, not by OctoClaw completion files.

## Context Pollution Controls

- Planner tool results are short JSON, not full judge packets, policy traces, ledger rows, or transcripts.
- `sessionsSpawnArgs.task` should contain the user goal, expected deliverable, and necessary context references only; target size is 800-1500 characters.
- Large context uses attachments or workspace refs rather than parent tool-result payloads.
- Child final handoff should be compact; parent context must not receive raw child transcript or worker execution logs.

## Leader / Worker Split

Codex leader owns hard architecture and integration points:

- `registration.ts` planner cut and spawn evidence semantics.
- `extension-entry.ts` / `before_tool_call` gate semantics.
- `octoclaw_dispatch_confirm` conflict/idempotency semantics.
- Judge admission hard boundaries.
- Final merge, truth-source review, and deletion order for legacy runtime wheels.

GLM-5.1 workers own bounded high-token implementation slices after the spec is fixed:

- Feature flag/config parsing.
- `NativeSpawnIntent` store and tests.
- WorkContract native refs and projectors.
- Native status projector.
- Legacy runtime disable flags.
- Large unit-test matrices and fixture updates.

Cheaper workers can handle mechanical tests, fixture generation, docs sync, and lint/build iteration when the write set is narrow.

## OpenSpec Worker Guardrails

- Each worker claims exactly one task slice from `tasks.md`.
- Each slice declares owned files, forbidden files, truth source, tests, and acceptance evidence.
- Workers must not edit hot-path files outside their slice. Hot-path files include `tools/registration.ts`, `extension-entry.ts`, judge admission, and ACK sender logic.
- Workers must not introduce direct SDK spawn as the main path or import OpenClaw internal spawn modules.
- Workers must not mark tasks complete without tests that cover the real live path when live behavior changes.
- Leader review checks that skipped/failed/unknown states fail closed and write replay/telemetry where applicable.

## Rollout

- Default development backend: `OCTOCLAW_SPAWN_BACKEND=planner`.
- Production rollout uses allowlist by workspace/session/user.
- Legacy backend remains available through explicit flags during 0.5.0 rollout.
- After planner acceptance, legacy scheduler, completion binding, child-finalizer, and delivery outbox can be deleted or archived in separate slices.
