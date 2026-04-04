# Test Spec — OctoClaw P1 runtime mind convergence

- Date: 2026-04-04
- Scope: observer / patrol / runner / ctl runtime mental-model convergence
- Planning only; no code changes in this artifact

## 1. Test objectives

Prove that P1 converges runtime roles without regressing the currently-landed baseline.

Specifically, the verification suite must prove:
1. observer is the canonical read-model surface
2. patrol remains the recovery/notification executor
3. runner lane semantics are independent from daemon/on-demand mode
4. ctl is the operator command surface, not a duplicate business-state engine
5. status/read-model outputs stay aligned across text/JSON/operator entrypoints

## 2. Acceptance criteria mapped to verification

### AC1 — Role boundaries are explicit and reflected in runtime outputs
- Evidence:
  - updated docs/help text
  - observer payload contract tests
  - no contradictory README/ctl/status wording

### AC2 — Observer and status share the same read-model semantics
- Evidence:
  - `runtime_observer.py` payload snapshots
  - `status.sh` output parity on runner mode, active/final counts, recovery counts

### AC3 — Patrol remains responsible for recovery/notifications, not for sole state definition
- Evidence:
  - patrol tests still pass
  - no regression in anchor retries / notification send paths / stale ownership recovery

### AC4 — Runner lane vs runner mode semantics are stable
- Evidence:
  - daemon mode and on-demand mode both pass smoke tests
  - queued/running/final states still map consistently
  - task records still identify `route=runner` regardless of execution mode

### AC5 — Ctl commands are the operator-facing control surface
- Evidence:
  - `octoclawctl` help/output aligned with docs
  - `observe-once`, `patrol-once`, `runner-status`, `status`, `ps` behave coherently

## 3. Unit / module tests to add or update

### 3.1 Observer contract
- `tests/test_runtime_observer.py`
  - payload schema stability
  - runner state and mode rendering
  - recovery counts / progress hydration reporting

### 3.2 Patrol role protection
- `tests/test_patrol_notifications.py`
- `tests/test_runtime_coordination.py`
  - recovery paths unchanged
  - anchor notification behavior unchanged
  - no accidental removal of recovery hooks

### 3.3 Runner semantics
- `tests/test_runner_runtime.py`
- `tests/test_runtime_task_record.py`
- `tests/test_openclaw_taskflow_adapter.py`
  - runner jobs still bind taskflow substrate correctly
  - daemon vs on-demand does not change lane identity

### 3.4 Status / control surface parity
- `tests/test_status_render.py`
- optional shell smoke around `bin/octoclawctl.sh`
  - status text parity
  - control commands map to correct sub-surfaces

## 4. Integration / smoke plan

### 4.1 Daemon mode
- set runner mode to daemon
- run `octoclawctl up runtime`
- confirm `octoclawctl observe-once` and `status.sh` agree on runner presence and mode

### 4.2 On-demand mode
- set runner mode to ondemand
- confirm observer/status show on-demand mode without claiming resident runner health
- dispatch a runner job and confirm record semantics still show `route=runner`

### 4.3 Patrol loop interaction
- run `octoclawctl patrol-once`
- ensure recovery/notification behavior still works and observer summaries remain coherent

## 5. Observability checks

- observer text output should include:
  - runner state
  - runner mode
  - active/final counts
  - hydration/recovery counts
- status output should expose the same semantic facts, even if formatted differently
- logs/health files should remain readable by operator tooling:
  - `runner-health.json`
  - task-state/runtime surfaces
  - patrol log / runner log where applicable

## 6. Regression risks to watch

1. patrol refactor accidentally drops recovery side effects
2. observer refactor creates divergent counting from `status.sh`
3. runner mode refactor changes task-state semantics
4. ctl becomes a second logic engine instead of delegating to observer/patrol/runtime scripts
5. docs/help are updated but shell defaults still imply old mental model

## 7. Completion evidence required

P1 should not be considered complete without:
- passing targeted tests
- successful daemon/on-demand smoke checks
- role-map doc updated
- README / ctl help / status wording aligned
- explicit verifier signoff that role boundaries match runtime behavior
