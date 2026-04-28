# OctoClaw ACK / Judge / Delegation / Evaluation Harness Plan

Status: implementation design  
Date: 2026-04-26  
Branch: `release/0.3.0-ts-rebuild`

## 1. Purpose

This plan turns the ACK + judge + delegation path into a production-grade,
measurable, and reviewable loop.

The goal is not to create another task engine. The goal is to make the current
P0/P1/P2 truth spine visible to the user and verifiable by nightly/replay/Slack
acceptance.

## 2. Non-negotiable invariants

1. Native TaskFlow remains execution lifecycle truth.
2. WorkContract remains semantic/delegation/handoff/continuity truth.
3. TaskFlow created is not spawn evidence.
4. `dispatchExecuted=true` means materialization/dispatch evidence only.
5. `spawnExecuted=true` requires current TaskRun/session/process evidence.
6. ACK/status/display/grounding are projections, not truth.
7. Status/provenance follow-up with sufficient ExecutionCoverage must answer via `reply`, not spawn.
8. Child continuity uses child session keys/run ids/artifact refs only; raw child transcripts never enter parent context.
9. No default multi-agent, no ClawTeam/tmux core dependency, no online self-tuning.
10. Model/rule changes from harness output are recommendations until an explicit gate passes.

## 3. Production standard

A change is production-ready only if all relevant items are true:

- A user-visible claim has a named truth source.
- ACKs cannot imply execution happened before execution evidence exists.
- Delegate route commit produces an immediate, bounded, user-visible acknowledgement.
- Materialization/spawn anomalies are visible to the user/main agent without waiting for final timeout.
- Status projection can explain route, elapsed time, model/profile, backend, cost, child refs, artifacts, failure, and delivery state.
- Replay/nightly/Slack acceptance can reproduce the behavior without reading raw child transcripts.
- Tests cover at least one success case and one no-lie/failure case.

## 4. Architecture

### 4.1 Three ACK classes

#### Route Commit ACK

Emitted after route decision is sealed and before long work begins.

Truth input:

- route decision
- route seal
- WorkContract compact view
- judge source and route source
- ACK policy/timing state

Allowed claims:

- `reply`: “I will answer directly.”
- `delegate`: “I will dispatch this as delegated work.”
- `status/provenance`: “I will read the control plane/status facts.”

Forbidden claims:

- “The child is running” without spawn evidence.
- “The task completed” without result materialization/delivery evidence.
- Any raw child transcript content.

#### Execution ACK

Emitted when execution state changes after route commit.

Truth input:

- NativeBindingRef
- TaskFlow mutation result
- DelegateTask/DelegateAttempt
- dispatch/spawn evidence
- recovery assessment

Required projections:

- materialized / queued
- materialized_no_spawn
- spawn_started
- spawn_failed
- blocked / stale / timed_out
- result_ready / delivery_pending / completed

#### Progress ACK

Emitted at ETA/deadline checkpoints.

Truth input:

- TaskStatusProjection
- deadline/heartbeat/recovery state
- telemetry timings

Required behavior:

- notify before hard timeout when there is no progress
- notify immediately on dispatch/spawn failure
- do not spam; one notification per state transition and checkpoint class

### 4.2 Judge responsibility

Judge is semantic routing authority when actionable. Deterministic rules remain
fallback and guardrail.

Current route sources:

- `rule`: deterministic policy or no actionable judge
- `judge`: accepted local/remote judge result
- `fallback`: deterministic safety fallback after timeout or hard boundary

Main-agent correction:

- Normal main-agent route hints are advisory.
- Trusted runtime/system sources may force a route.
- If judge is clearly wrong, main agent must submit structured objection:
  - `routeObjection=true`
  - `requestedRoute`
  - `objectionReason`
- Objection decisions are replayed and included in nightly calibration.

### 4.3 Delegation responsibility

Delegate path is a two-step no-lie pipeline:

1. Route/WorkContract commit says what should happen.
2. Native TaskFlow/TaskRun/session/process evidence says what did happen.

State wording:

| Evidence | User-facing state |
| --- | --- |
| WorkContract sealed only | route committed / preparing |
| TaskFlow created, no dispatch evidence | registered / materializing |
| dispatchExecuted, no spawnExecuted | queued / materialized, not running |
| spawnExecuted + heartbeat/progress | running |
| stale heartbeat | blocked / stale |
| deadline exceeded | timed_out |
| result materialized, delivery pending | result_ready / delivery_pending |
| delivery acknowledged | completed |

## 5. Work packages

### D1. Route Commit ACK

Objective: delegated/status/reply routes produce an immediate, truthful ACK at
route commit.

Implementation scope:

- Add route-commit ACK decision/projection packet.
- Route commit ACK reads route decision, route seal, WorkContract, route source,
  and judge source.
- Add delivery target resolution that reuses existing Slack/IM ACK delivery.
- Dedupe by session/thread/turn/routeCommitId.
- Persist route commit ACK telemetry.

Acceptance criteria:

- Delegated route sends one user-visible ACK before dispatch begins.
- Reply route may send a lightweight ACK only if final answer is not already visible.
- Status/provenance route says it is checking control-plane facts, not spawning.
- ACK text never claims `running` before spawn evidence.
- ACK is skipped safely if no valid thread target exists, with replay event.

Tests:

- route commit delegate ACK
- route commit status/provenance ACK
- no duplicate ACK on same turn
- no “running” text without spawn evidence
- no target -> skipped with reason

Commit message:

`feat: add truthful route commit ack`

### D2. Execution ACK and anomaly notification

Objective: dispatch/spawn/result/delivery anomalies are visible quickly.

Implementation scope:

- Add execution transition notifier over DelegateAttempt/NativeBindingRef.
- Emit user/main-agent notification on:
  - dispatch materialized
  - materialized_no_spawn
  - spawn_started
  - spawn_failed
  - queued stale
  - heartbeat stale
  - timed_out
  - result_ready
  - delivery_failed
- Dedupe by taskId/attemptId/stateTransition.
- Tie notification to TaskStatusProjection, not raw transcript.

Acceptance criteria:

- Dispatch success but no spawn evidence is shown as queued/materialized, not running.
- Spawn failure notifies immediately.
- Stale/no-progress notifies before final timeout.
- Result ready but delivery pending is visible.
- Parent context receives compact packet only.

Tests:

- dispatchExecuted=true/spawnExecuted=false notification
- spawn failure notification
- stale heartbeat notification
- result ready/delivery pending notification
- dedupe transition notification

Commit message:

`feat: add execution ack and anomaly notifications`

### D3. Nightly Evaluation Harness

Objective: nightly reports measure route/ACK/delegate quality from real replay
and transcript evidence.

Implementation scope:

- Add TS-first nightly harness CLI.
- Inputs:
  - runtime-policy replay JSONL
  - task/status projection store
  - WorkContract store
  - Slack/OpenClaw session transcript index, if available
- Outputs:
  - `reports/nightly/YYYY-MM-DD.json`
  - `reports/nightly/YYYY-MM-DD.md`
- Classify:
  - protected-lane misroute
  - status/provenance respawn risk
  - direct-path latency risk
  - delegated no-spawn risk
  - ACK missing/late/duplicate/misleading
  - delivery failure or result orphan
  - objection accepted/rejected

Metrics:

- route_source distribution
- judge timeout/fallback count
- objection count and accepted ratio
- ack_ms p50/p95/p99 by lane
- route_commit_ack coverage
- dispatch-to-spawn latency
- materialized_no_spawn count
- spawn failure count
- stale/timed_out count
- result_ready_to_delivery latency
- parent_context_tokens_added
- result_packet_tokens

Acceptance criteria:

- Generates readable markdown and machine-readable JSON.
- Unknown is not treated as pass.
- No online mutation of live rules/models.
- Report names concrete replay/session/task ids for follow-up.

Tests:

- fixture replay -> report with expected metrics
- unknown evidence -> unknown, not pass
- misleading ACK fixture -> failure finding
- accepted objection fixture -> calibration finding

Commit message:

`feat: add nightly evaluation harness reports`

### D4. Real Slack Acceptance Harness

Objective: black-box test real Slack/IM behavior against a dedicated acceptance
session/channel/bot when configured.

Implementation scope:

- Add TS CLI for Slack acceptance.
- Support explicit config:
  - bot token env/config ref
  - target channel/user/thread
  - session key
  - optional isolated OpenClaw home/workspace
- Do not print secrets.
- Cases:
  1. plain chat: “在吗”
  2. fresh lookup
  3. delegated work
  4. status panel
  5. provenance follow-up: “刚才那个任务判定是啥”
  6. route objection correction
  7. no-lie queued/materialized_no_spawn fixture where possible
- Pull Slack replies and measure ACK/final timing.
- Save transcript bundle as acceptance artifact.

Acceptance criteria:

- Can run against explicit target without using production DM by default.
- Fails closed if target/session is not configured.
- Verifies ACK presence/timing and final answer content assertions.
- Verifies status/provenance follow-up does not spawn.
- Stores sanitized report/artifact.

Tests:

- Slack client mocked acceptance cases
- missing config fails closed
- secret redaction test
- content assertion test

Commit message:

`feat: add slack acceptance harness`

### D5. Calibration Gate and Recommendation Report

Objective: convert nightly/acceptance evidence into safe recommendations.

Implementation scope:

- Baseline vs candidate comparison for route rules, ACK timing, model profiles.
- Gate dimensions:
  - latency not worse
  - cost not worse
  - acceptance not worse
  - no-lie violations not worse
  - context pollution not worse
  - fallback/timeout not worse
- Output pass/fail/unknown.
- Unknown cannot pass.
- Recommendations only; no online self-tuning.

Acceptance criteria:

- Candidate report can say “do not promote” with concrete reasons.
- Rollback target is included for any suggested promotion.
- No code path changes live model/rule policy automatically.

Tests:

- pass candidate fixture
- fail candidate fixture
- unknown candidate fixture
- no online mutation assertion

Commit message:

`feat: add calibration gate recommendations`

## 6. OpenCode implementation protocol

Each work package must be implemented separately.

Required per package:

1. Read this document plus:
   - `docs/octoclaw-next-stage-roadmap-and-execution-design-2026-04-25.md`
   - `docs/octoclaw-work-contract-centered-delegation-design-2026-04-25.md`
   - `docs/octoclaw-harness-ownership-map.md`
   - `docs/octoclaw-harness-contract-inventory.md`
   - `docs/octoclaw-judge-ack-policy-spec-2026-04-21.md`
2. Make minimal, architecture-aligned changes.
3. Do not introduce a new task engine.
4. Do not make multi-agent/ClawTeam/tmux default live path.
5. Add targeted tests before or with implementation.
6. Run package-specific build/test.
7. Produce a short implementation report listing files changed, tests, and risks.
8. Wait for Codex review before moving to the next package.

## 7. Review checklist for Codex

For every package, Codex must verify:

- no raw child transcript in parent-visible packets
- no running claim without spawn evidence
- no status/provenance respawn when coverage is sufficient
- ACK text matches available evidence
- replay events and telemetry are emitted
- tests cover failure/no-lie cases
- docs remain aligned
- no P3/P4 live path creep

## 8. Suggested execution order

1. D1 Route Commit ACK
2. D2 Execution ACK and anomaly notification
3. D3 Nightly Evaluation Harness
4. D4 Real Slack Acceptance Harness
5. D5 Calibration Gate and Recommendation Report

D1 and D2 are user-facing reliability fixes and should land first. D3-D5 create
the long-term reasonableness loop without online self-tuning.

## 2026-04-28 Calibration Asset: Route Flip Without Stale Projection

Nightly evaluation should treat `judgeRoute=delegate` followed by `finalRoute=reply` as a calibration sample, not a failure by itself. It becomes a failure only when a user-visible ACK/guard/status projection contradicts the final sealed WorkContract or execution receipt, for example by emitting a delegate-not-dispatched message after the current turn is sealed as reply.

This keeps judge calibration separate from projection correctness: judge may reasonably prefer delegation for fresh lookup, while the projection layer must always read current-turn WorkContract plus execution evidence and must not reuse stale same-target state.
