# Change: ACK / Judge / Delegation Evaluation Harness

## Purpose

Make OctoClaw's ACK, judge, delegation, status, and evaluation loop production-grade by making route commitment, execution anomalies, and route-quality calibration observable, testable, and reviewable.

## Scope

- D1: Truthful route-commit ACK after route seal and before long execution.
- D2: Execution transition ACK and anomaly notification from real lifecycle evidence.
- D3: Nightly evaluation harness for route/judge/ACK/delegation quality.
- D4: Real Slack acceptance harness using an explicitly configured test bot/session.
- D5: Calibration gate and recommendation report.

## Non-Goals

- No P3/P4 default live-path multi-agent orchestration.
- No ClawTeam/tmux core dependency.
- No online self-tuning or automatic model/policy promotion.
- No raw child transcript injection into parent context.

## Acceptance Gate

A slice is acceptable only when:

- It names the truth source it uses.
- It has at least one test proving the real production path when the change affects live behavior.
- It records replay/telemetry for sent, skipped, failed, and deduped outcomes when applicable.
- It keeps parent-visible packets compact and sanitized.
- It does not broaden live policy beyond the change scope.
