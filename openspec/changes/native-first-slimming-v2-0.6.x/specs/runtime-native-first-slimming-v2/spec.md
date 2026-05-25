# runtime-native-first-slimming-v2 Specification

## ADDED Requirements

### Requirement: Native Lifecycle Truth

OctoClaw SHALL use OpenClaw native lifecycle evidence as the authoritative source for run/session/task lifecycle status.

OctoClaw SHALL reuse the existing native status projector and OpenClaw runtime adapter or narrow typed facades over them. It SHALL NOT introduce a separate native status lookup system for this change.

#### Scenario: Cache disagrees with native running

- **GIVEN** native status reports running
- **AND** task-state or policy-state cache reports completed
- **WHEN** OctoClaw builds status projection
- **THEN** projection status SHALL be running or running_slow
- **AND** projection SHALL NOT mark success from cache alone

#### Scenario: Cache disagrees with native completed

- **GIVEN** native status reports completed with result evidence
- **AND** task-state or policy-state cache reports failed
- **WHEN** OctoClaw builds status projection
- **THEN** projection status SHALL be completed

### Requirement: Ledger Metadata Is Not Lifecycle Truth

OctoClaw SHALL treat ledger records and WorkContract native refs as metadata/audit unless paired with native accepted or lifecycle evidence.

#### Scenario: Native refs without accepted run

- **GIVEN** WorkContract native refs exist
- **AND** no native accepted run evidence exists
- **WHEN** execution status is projected
- **THEN** `spawnExecuted` SHALL be false
- **AND** lifecycle status SHALL NOT become running or completed from refs alone

#### Scenario: Legacy execution markers without native evidence

- **GIVEN** task-state, policy-state, or WorkContract telemetry contains `dispatchExecuted=true` or `spawnExecuted=true`
- **AND** no `octoclaw_dispatch_confirm` accepted response or OpenClaw native status evidence exists
- **WHEN** lifecycle status or compact footer evidence is built
- **THEN** lifecycle status SHALL NOT be promoted from those booleans alone
- **AND** compact footer SHALL NOT claim `route=delegate` from those booleans alone

### Requirement: Native Spawn Gate Remains Hard Safety

OctoClaw SHALL block native session tools unless they match a pending native spawn intent.

#### Scenario: Missing pending intent

- **GIVEN** no pending native spawn intent exists
- **WHEN** `sessions_spawn` is called
- **THEN** the call SHALL be blocked

#### Scenario: Argument hash mismatch

- **GIVEN** a pending native spawn intent exists
- **WHEN** `sessions_spawn` args do not match canonical args
- **THEN** the call SHALL be blocked
- **AND** the corrective action SHALL be to retry native spawn with exact args, not to rerun dispatch

### Requirement: Budgeted Main Produces Evidence Not Dispatch Deadlocks

OctoClaw SHALL keep budgeted-main tool-risk escalation, but BudgetedMainGate SHALL NOT block `octoclaw_dispatch`.

#### Scenario: Risky ordinary tool

- **GIVEN** reply route is active
- **WHEN** an ordinary tool exceeds budget or risk thresholds
- **THEN** the ordinary tool SHALL be blocked
- **AND** budget escalation evidence SHALL be recorded
- **AND** the next `octoclaw_dispatch` SHALL be allowed to reach dispatch admission

#### Scenario: Wall-time only

- **GIVEN** reply route is active
- **WHEN** wall-time threshold is exceeded without risky tool use
- **THEN** OctoClaw SHALL record observation by default
- **AND** SHALL NOT mutate route to delegate by default

#### Scenario: Native session tools are budget-neutral control tools

- **GIVEN** budgeted-main tracking is active
- **WHEN** `sessions_spawn`, `sessions_send`, `sessions_yield`, or `session_status` is called
- **THEN** BudgetedMainGate SHALL NOT count it as an ordinary main-agent tool
- **AND** native spawn/session-control gates SHALL own the allow or block decision

### Requirement: Route Hint Is Advisory By Default

OctoClaw SHALL NOT require route hint before `octoclaw_dispatch` by default.

#### Scenario: Missing route hint with structured evidence

- **GIVEN** route hint was not submitted
- **AND** structured delegate evidence exists
- **WHEN** `octoclaw_dispatch` is called
- **THEN** route hint policy SHALL NOT block dispatch by default

### Requirement: Dispatch Admission Owns Reply-To-Delegate Transition

OctoClaw SHALL centralize reply-to-delegate transition decisions in dispatch admission.

#### Scenario: Stale reply WorkContract superseded

- **GIVEN** a stale reply WorkContract exists
- **AND** budget escalation evidence exists
- **WHEN** `octoclaw_dispatch` is called
- **THEN** dispatch admission SHALL allow supersede with reason `budgeted_main_escalation`

### Requirement: Before Tool Call Hook Is An Orchestrator

`before-tool-call.ts` SHALL delegate policy-specific behavior to narrow gate modules.

#### Scenario: Gate extraction complete

- **GIVEN** runtime gate extraction is complete
- **WHEN** maintainers inspect `before-tool-call.ts`
- **THEN** it SHALL primarily load context, call gates, apply state patches, and record shared side effects
- **AND** feature-specific strategies SHALL live in gate modules with targeted tests

### Requirement: Footer Does Not Promote Suggestions

OctoClaw SHALL append compact footer evidence without promoting policy suggestions to execution facts.

Compact footer SHALL be default for final assistant result replies. Non-final sends such as neutral ACK, route commit ACK, status cards, onboarding messages, and native delivery internals SHALL remain footer-free unless explicitly configured.

#### Scenario: Delegate suggested but not executed

- **GIVEN** delegation was suggested
- **AND** no dispatch or spawn evidence exists
- **WHEN** footer is projected
- **THEN** footer SHALL NOT show `route=delegate`

#### Scenario: Final result compact footer

- **GIVEN** a final assistant result has route and model evidence
- **WHEN** no footer override is configured
- **THEN** compact footer SHALL be appended
- **AND** compact footer SHALL NOT include debug IDs
- **AND** compact rendering SHALL receive a compact-sanitized projection without debug-only fields

#### Scenario: Non-final send

- **GIVEN** a neutral ACK or status card is sent
- **WHEN** no debug override is configured
- **THEN** footer mode SHALL remain off

#### Scenario: Native announce not final

- **GIVEN** child work exists
- **AND** native final delivery has not completed
- **WHEN** footer is projected
- **THEN** footer SHALL NOT show `via=native_announce`

### Requirement: Explicit Manual Retry Remains Available

OctoClaw SHALL keep explicit task retry through `octoclaw_task_action retry` while keeping automatic retry/amendment/respawn out of the default path.

#### Scenario: Manual retry command

- **GIVEN** a retry-eligible task exists
- **WHEN** `octoclaw_task_action retry` is called
- **THEN** a ledger retry attempt SHALL be created
- **AND** automatic recovery automation SHALL NOT be required
