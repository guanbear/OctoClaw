# Spec: Runtime Native Slimming

## Purpose

This spec defines the target behavior for reducing OctoClaw runtime complexity
while preserving current user-visible functionality. It is intentionally strict
so future AI agents cannot turn the cleanup into another abstraction layer.

## Requirements

### Requirement: Native Runtime Truth

OctoClaw SHALL treat host-native runtime records as execution truth for new
tasks.

#### Scenario: Native child evidence is authoritative

- **GIVEN** a native runtime record has `kind="spawn-child"`
- **WHEN** OctoClaw builds status, ACK, or dispatch confirmation state
- **THEN** the task SHALL be treated as a native child task
- **AND** string/session/transcript heuristics SHALL NOT override it

#### Scenario: Native missing is degraded

- **GIVEN** a task has native ids but the host runtime record is unavailable
- **WHEN** OctoClaw builds projection
- **THEN** the projection SHALL be `degraded` or `lost`
- **AND** OctoClaw SHALL NOT infer success from cache or text

### Requirement: Legacy Heuristics Are Not New-Task Authority

Legacy heuristics SHALL be read-only compatibility for old records only.

#### Scenario: New task does not use legacy inference

- **GIVEN** a task was created after native truth fields are available
- **WHEN** dispatch, confirm, ACK, status, or delivery logic runs
- **THEN** assistant text, transcript text, session labels, and stale cache
  SHALL NOT affect runtime decisions

#### Scenario: Old record can still display

- **GIVEN** an archived record has no native fields
- **WHEN** status is rendered
- **THEN** legacy display MAY be used
- **AND** the output SHALL mark the source as `legacy_read_only`

### Requirement: Native ACP Backend Failover

OpenClaw native ACP fallback SHALL own backend-unavailable failover before
output starts.

#### Scenario: Clean backend failover

- **GIVEN** the primary ACP backend is unavailable before output
- **WHEN** native ACP fallback is configured and enforcement mode is enabled
- **THEN** OpenClaw SHALL select the fallback runtime
- **AND** OctoClaw SHALL NOT create a second task for the same failover

#### Scenario: Task recovery remains OctoClaw-owned

- **GIVEN** a worker has started output, timed out, returned bad output, or
  violated policy
- **WHEN** recovery is needed
- **THEN** OctoClaw SHALL classify it as task recovery
- **AND** OpenClaw ACP backend failover SHALL NOT be used as a silent retry

### Requirement: Delivery Relay Is Last-Resort

OctoClaw delivery relay SHALL be audit plus fallback, not the primary delivery
path, when native delivery success is proven.

#### Scenario: Native delivery success

- **GIVEN** native delivery reports a successful user-visible final
- **WHEN** delivery relay logic runs in audit-only mode
- **THEN** OctoClaw SHALL write audit metadata
- **AND** OctoClaw SHALL NOT send a duplicate final

#### Scenario: Native delivery missing or failed

- **GIVEN** native delivery is missing, failed, or degraded
- **WHEN** fallback conditions are met
- **THEN** OctoClaw SHALL use fallback delivery
- **AND** status SHALL explain the native delivery problem and fallback result

### Requirement: Minimal RuntimeAdapter Boundary

OctoClaw SHALL isolate host-runtime-specific facts behind a minimal adapter
boundary.

#### Scenario: Adapter normalizes facts only

- **GIVEN** OpenClaw native records are available
- **WHEN** the adapter returns status, delivery, or fallback snapshots
- **THEN** it SHALL normalize native facts
- **AND** it SHALL NOT become a scheduler, task engine, policy engine, or
  persistence authority

#### Scenario: OpenClaw remains the only live host

- **GIVEN** this change is implemented
- **WHEN** runtime host mode is live
- **THEN** OpenClaw SHALL be the only live runtime host
- **AND** Hermes SHALL NOT spawn, deliver, or mutate runtime state

### Requirement: Hermes Migration Foundation

OctoClaw SHALL prepare for a future Hermes migration without coupling current
behavior to Hermes.

#### Scenario: Hermes capability matrix is explicit

- **GIVEN** Hermes support is documented
- **WHEN** capability mapping is read
- **THEN** each capability SHALL be marked `supported` or `unknown`
- **AND** unknown capabilities SHALL NOT be treated as live-compatible

#### Scenario: Hermes dry-run is fail-closed

- **GIVEN** `runtimeHostMode="hermes_dry_run"`
- **WHEN** code attempts live spawn or delivery through Hermes
- **THEN** the operation SHALL fail closed
- **AND** it SHALL report `hermes_live_runtime_not_enabled`

### Requirement: Code Reduction

The final implementation SHALL delete historical code replaced by native host
capabilities.

#### Scenario: Deletion is proven

- **GIVEN** a legacy branch is deleted
- **WHEN** implementation notes are reviewed
- **THEN** the notes SHALL list removed files or branches
- **AND** cite the BDD scenarios and tests proving deletion safe

#### Scenario: Runtime LOC is reported

- **GIVEN** P5 deletion closeout is complete
- **WHEN** final evidence is prepared
- **THEN** before/after production LOC for `extensions/octoclaw-runtime/src`
  SHALL be reported
- **AND** any retained large modules SHALL have a specific reason

