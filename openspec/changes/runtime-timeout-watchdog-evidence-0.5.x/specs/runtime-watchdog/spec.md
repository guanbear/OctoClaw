# Spec Delta: Runtime Watchdog Evidence

## ADDED Requirements

### Requirement: Timeout Reconcile Is Deterministic

OctoClaw SHALL use deterministic runtime code, not an LLM agent, to reconcile delegated task timeout/stall/completion state.

#### Scenario: watchdog checks active task

- WHEN the watchdog observes an active delegated task
- THEN it SHALL evaluate ledger, native status, result evidence, deadlines, and optional tmux/process evidence
- AND it SHALL write a canonical status/reason without requiring a main-agent turn.

#### Scenario: main agent asks status later

- WHEN the user asks task status after a missed notification
- THEN the status query SHALL reconcile active/recent tasks before rendering
- AND it SHALL show the canonical state from ledger/reconcile, not stale cache-only state.

### Requirement: Completed Requires Result Evidence

Delegated task status SHALL NOT be `completed` unless result evidence exists.

#### Scenario: native completed without result

- WHEN native status is completed
- AND no completion receipt, artifact ref, report path, result summary, or delivery acknowledgement exists
- THEN status SHALL be degraded
- AND reason SHALL indicate `completed_without_result`.

#### Scenario: native completed with result

- WHEN native status is completed
- AND a linked completion receipt, artifact ref, report path, result summary, or delivery acknowledgement exists
- THEN status MAY be completed.

### Requirement: Expected Deadline Is Not Failure

Expected deadline SHALL be treated as a slow/stalled signal, not a hard failure.

#### Scenario: active work past expected deadline

- WHEN expected deadline has passed
- AND native/tmux/process/heartbeat evidence shows ongoing work
- THEN status SHALL be `running_slow`
- AND status reason SHALL summarize the live evidence.

#### Scenario: idle work past expected deadline

- WHEN expected deadline has passed
- AND a pane/process appears alive but output/heartbeat has not changed
- THEN status SHALL be `stalled`
- AND status reason SHALL summarize idle evidence.

### Requirement: Hard Timeout Requires Live-Evidence Check

Hard timeout SHALL only become `timed_out` after live evidence is checked.

#### Scenario: no live evidence after hard timeout

- WHEN hard timeout has passed
- AND native registry, heartbeat, tmux, process, and result evidence do not show recoverable activity
- THEN status SHALL be `timed_out`.

#### Scenario: live evidence after hard timeout

- WHEN hard timeout has passed
- BUT native/tmux/process evidence still shows active work
- THEN status SHALL be `stalled` or `running_slow`
- AND OctoClaw SHALL surface a suggested action instead of silently marking success or killing the task.

### Requirement: Tmux Evidence Is Optional And Diagnostic

Tmux evidence SHALL be optional and SHALL NOT become execution truth.

#### Scenario: tmux evidence enabled

- WHEN `OCTOCLAW_TMUX_EVIDENCE=1`
- AND a task has a known tmux pane/session mapping
- THEN watchdog MAY capture bounded pane/process evidence
- AND SHALL use it only to distinguish `running_slow`, `stalled`, `timed_out`, or `lost`.

#### Scenario: tmux evidence missing

- WHEN no tmux mapping exists
- THEN watchdog SHALL continue using native/ledger/artifact evidence
- AND SHALL NOT fail solely because tmux is missing.

#### Scenario: tmux shows alive

- WHEN tmux pane/process is alive
- THEN tmux evidence SHALL NOT prove task success
- AND completed status SHALL still require result evidence.

### Requirement: Main Agent Context Is Compact

Runtime status injected into main-agent context SHALL be compact and sanitized.

#### Scenario: abnormal timeout status

- WHEN a task is `running_slow`, `stalled`, `timed_out`, or `degraded`
- THEN the main agent MAY receive a compact packet with ids, status, reason, short summary, result location, and evidence classifications
- AND it SHALL NOT receive raw child transcripts, full tmux output, or long logs by default.

#### Scenario: detailed debug requested

- WHEN a user explicitly asks for debug details
- THEN OctoClaw MAY expose bounded diagnostic details through task detail/status tools
- AND SHALL preserve redaction and length caps.

### Requirement: Startup Reconcile Repairs Unfinished Tasks

Runtime startup SHALL reconcile unfinished tasks without auto-retry.

#### Scenario: runtime restarts with unfinished attempts

- WHEN OctoClaw starts
- AND ledger contains unfinished delegated attempts
- THEN startup reconcile SHALL inspect their current evidence
- AND SHALL update projection/events if status changed
- AND SHALL NOT restart, retry, or kill those tasks automatically.

### Requirement: Notifications Are Best Effort And Deduped

Execution transition notifications SHALL be derived from ledger status changes and deduped.

#### Scenario: timeout transition notification fails

- WHEN a timeout/stalled/degraded notification cannot be delivered
- THEN the ledger SHALL still carry the canonical status
- AND the next status query SHALL show that status.

#### Scenario: repeated watchdog ticks

- WHEN watchdog observes the same status transition repeatedly
- THEN OctoClaw SHALL send at most one notification per transition key.
