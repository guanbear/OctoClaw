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

## Responsiveness Model

0.5.0 is optimized for short tasks stay fast, long tasks do not block. It SHALL NOT claim that every delegated child starts within 10 seconds. The live path records child-start latency, but the 0.5.0 gate is neutral first ACK, reduced false delegation, and strict planner/confirm correctness.

- SR-P0 neutral inbound ACK: Slack inbound messages should get a route-independent reaction/typing or short text ACK within 1-5s when configured. This ACK is pre-route and must only say `received/deciding`, never `delegated/running/success`.
- SR-P1 startup-cost-aware routing: route candidates use three buckets: `must_reply/main_fast_path`, `must_delegate`, and `budgeted_main_then_delegate`. One-step fresh lookup, status/provenance follow-up, and short explain/summarize/rewrite tasks default to main fast path. Hard delegate signals are explicit background/subagent/parallel requests, code edits, tests/builds, long commands, multi-step tools, review/validation, or expected duration over 90-120s.
- SR-P1 `budgeted_main_then_delegate` runtime budget: the 30s budget is a soft main execution budget, not a user-visible SLA and not a hard interrupt. It starts after `before_prompt_build` has completed and the main agent is about to receive the OctoClaw route hint. If the timer expires without a reliable interrupt/reinjection point, OctoClaw records `budgeted_main_escalated_pending` only. A late final reply is allowed and recorded as `budgeted_main_completed_late` with no spawn. At the next ordinary tool or prompt-injection boundary, OctoClaw escalates through the native planner path (`octoclaw_dispatch -> sessions_spawn -> octoclaw_dispatch_confirm`); it must not direct spawn and must not send accepted ACK before confirm succeeds.
- SR-P2 planner/native hot path: real delegated route commit to `sessions_spawn_intent_allowed` should target p95 <= 30s in Slack smoke, with metrics for route decision, spawn allowed, accepted confirm, child progress/final, and footer provenance.

Rule router, local judge, cheap LLM judge, route hints, and AGENTS/system prompt injection must share the same bucket semantics. `fresh_live_lookup`, `conversation_control.route_hint=delegate`, and `fast_first_response` cannot force delegate alone.

## Spawn Context And OpenClaw Boundary

Planner output SHALL build `sessionsSpawnArgs` using OpenClaw 4.29 public tool parameters only. Default child context is `context=isolated` with `lightContext=true`; `context=fork` is allowed only when the child truly needs requester transcript context. Large context should be passed through compact task text, attachments, or workspace refs.

OctoClaw SHALL NOT import OpenClaw internal spawn modules or depend on plugin SDK direct spawn APIs that are not public. `api.runtime.subagent.run()` remains non-goal for 0.5.0 because it is not equivalent to tool-level `sessions_spawn` registry/announce/delivery behavior.

## Metadata, SQLite, And Projections

SQLite remains an OctoClaw metadata/audit store for WorkContract, route seal, judge/replay, IM anchors, ACK receipts, NativeSpawnIntent, and native refs. It is not the execution lifecycle truth source. OpenClaw native runs/flows/subagent registry owns queued/running/succeeded/failed/timed_out/cancelled/lost.

NativeSpawnIntent transitions that affect authorization or accepted native refs should be atomic or covered by race/idempotency tests. SQLite lock contention must surface as retry/backoff/replay evidence; `SQLITE_BUSY` must not silently become no task/no spawn.

## Footer, Delivery, And Regression Harness

Footer is a debug projection. It defaults off, never appends to ACK/progress/no-reply packets, and for native child final delivery it must prefer accepted native refs or child announce provenance over the parent delivery turn route. This prevents native announce final replies from being mislabeled as `route=reply | via=policy`.

Slack delivery port work is 0.5.x immediate and Slack-only. It should move Slack message hot path away from `openclaw message send` CLI/stdout parsing while keeping `OCTOCLAW_LEGACY_CLI_DELIVERY=1` rollback. Non-Slack IM behavior stays on existing fallback.

Nightly/acceptance reports must include neutral ACK latency, route bucket, spawn allowed latency, confirm ACK latency, child progress/final latency, footer provenance, `completion_file_timeout`, and legacy CLI delivery usage.

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
- After planner acceptance, legacy scheduler, completion binding, child-finalizer, and delivery outbox can be disabled from the default planner/native path; deletion/archive happens in separate slices after Slack smoke evidence.
- PC13 Slack delivery port and PC14 nightly harness are 0.5.x immediate/parallel work, not blockers for 0.5.0 Must + Should.
- Direct SDK spawn, warm worker pool/A2A, non-Slack delivery ports, managed flow orchestration, and unexposed OpenClaw hook work are deferred to separate OpenSpec changes.

## Before-Dispatch Fast Delegate Design Baseline

The planner/confirm chain is correct but cannot be the only responsiveness path because it waits for the main agent run and parent model tool negotiation. The 0.5.x performance recovery baseline is documented in `docs/octoclaw-fast-delegate-before-dispatch-design-2026-05-02.md`.

This baseline is design-only for the 0.5.0 gate. It SHALL NOT block planner/native acceptance, and it SHALL NOT be implemented as an unbounded direct-spawn rewrite inside the current planner/confirm slices.

The design constraints are:

- Reuse existing `resolvePolicyDecisionForContext()` / `resolveStatelessPolicyDecision()` and existing judge outputs. Do not introduce a second judge or a divergent keyword router.
- Move the first policy decision earlier only for the `before_dispatch` experiment. If the turn later proceeds into normal agent lifecycle, `before_model_resolve` and `before_prompt_build` must hit `policyState` cache and must not run LLM judge again.
- Treat `fastDelegateAdmission()` as a deterministic guard over the existing decision, not as semantic judge authority.
- Initially split implementation into proof slices: context/state-key parity, no-double-judge cache proof, fast admission pass/deny fixtures, and direct-run backend contract. Do not start with a monolithic spawn implementation.
- Keep `planner/confirm` as the native truth path for gray cases and for tests that require tool-level `sessions_spawn` registry/announce semantics.
- Do not claim `api.runtime.subagent.run()` is equivalent to tool-level `sessions_spawn`; if used later, it is a fast backend with explicit OctoClaw ledger/finalizer/delivery bridge until OpenClaw exposes an equivalent direct native spawn API.

Before any runtime implementation slice starts, PC15 must produce test plans that prove:

- the same normalized prompt and state key are used across `before_dispatch`, `before_model_resolve`, and `before_prompt_build`;
- LLM judge is invoked at most once for one inbound turn;
- pass-through turns preserve current behavior;
- high-confidence delegate decisions can be identified without sending user-visible delegate ACK before a real accepted run id;
- status/provenance follow-ups, simple replies, and bare model/tool mentions pass through.
