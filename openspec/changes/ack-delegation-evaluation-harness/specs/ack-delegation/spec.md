# Spec Delta: ACK Delegation Reliability

## ADDED Requirements

### Requirement: Truthful Route Commit ACK

After route seal, OctoClaw SHALL emit at most one route-commit ACK per turn when a valid target exists.

#### Scenario: delegated route before execution

- WHEN route is `delegate`
- AND no spawn evidence exists yet
- THEN ACK SHALL say the task is being prepared/dispatched
- AND SHALL NOT say running, completed, or successful.

### Requirement: Execution Transition Notification

OctoClaw SHALL emit execution transition notifications from real lifecycle evidence, not raw transcripts or model claims.

#### Scenario: materialized without spawn

- WHEN dispatch/materialization evidence exists
- AND spawn evidence does not exist
- THEN status SHALL be queued/materialized, not running
- AND parent-visible packet SHALL include compact task facts and no transcript fields.

#### Scenario: stale or timed out task

- WHEN watchdog detects stale queue, stale heartbeat, or timeout
- THEN OctoClaw SHALL record replay/telemetry
- AND SHALL update parent-visible anomaly state even if Slack delivery is skipped.

#### Scenario: result ready but delivery pending

- WHEN final result materializes before delivery acknowledgement
- THEN status SHALL be `deliverable_ready`
- AND notification SHALL expose artifact refs when available.


### Requirement: Real Slack Acceptance Harness

OctoClaw SHALL provide an explicit-config Slack acceptance harness that tests real Slack/IM behavior without using production DM defaults.

#### Scenario: missing or unsafe target config

- WHEN the acceptance command is run without a config, token env var, or target channel
- OR WHEN a DM/direct target is configured without explicit allowlist approval
- THEN the harness SHALL fail closed before sending test messages.

#### Scenario: status or provenance acceptance

- WHEN status, provenance, or no-lie fixture cases are executed
- THEN the harness SHALL verify final content assertions
- AND SHALL use replay evidence to check that no new spawn occurred when no-spawn is expected
- AND malformed or missing replay evidence SHALL be `unknown`, not `pass`.

#### Scenario: acceptance artifacts

- WHEN the harness writes reports
- THEN it SHALL write sanitized JSON and Markdown artifacts
- AND SHALL redact secrets and strip raw child transcripts, worker chain-of-thought, and execution logs.

### Requirement: Calibration Gate

OctoClaw SHALL only promote route/judge/model policy recommendations when the gate result is `pass`.

#### Scenario: insufficient evidence

- WHEN any required metric is missing or unknown
- THEN gate result SHALL be `unknown`
- AND SHALL NOT be treated as pass.

#### Scenario: baseline vs candidate comparison

- WHEN a calibration gate command is run with baseline and candidate report files
- THEN the gate SHALL compare latency, cost, acceptance, no-lie, context pollution, and fallback/timeout dimensions
- AND SHALL produce `pass` only when no dimension regresses and no dimension is unknown
- AND SHALL include an explicit baseline rollback target or baseline report ID when gate passes.

#### Scenario: pure gate function

- WHEN the gate comparison function is invoked
- THEN it SHALL NOT perform I/O, API calls, or state mutation
- AND SHALL NOT change live model/rule policy automatically.
