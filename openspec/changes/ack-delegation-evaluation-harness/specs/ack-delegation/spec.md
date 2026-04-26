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

### Requirement: Calibration Gate

OctoClaw SHALL only promote route/judge/model policy recommendations when the gate result is `pass`.

#### Scenario: insufficient evidence

- WHEN any required metric is missing or unknown
- THEN gate result SHALL be `unknown`
- AND SHALL NOT be treated as pass.
