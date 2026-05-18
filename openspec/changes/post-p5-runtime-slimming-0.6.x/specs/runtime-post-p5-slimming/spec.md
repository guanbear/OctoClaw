# Spec: Runtime Post-P5 Slimming

## Purpose

This spec defines the behavior required after removing post-P5 legacy switches
and small compatibility tails.

## Requirements

### Requirement: Dead Legacy Runtime-Ledger Config Is Removed

OctoClaw SHALL NOT expose or read `OCTOCLAW_LEGACY_RUNTIME_LEDGER` in live
runtime code.

#### Scenario: Planner config has no legacy ledger mode

- **GIVEN** planner spawn config is resolved
- **WHEN** the config object is returned
- **THEN** it SHALL NOT include `legacyRuntimeLedgerMode`
- **AND** runtime-ledger ticket enforcement SHALL remain unchanged

### Requirement: Legacy Heuristics Are Always Read-Only

OctoClaw SHALL keep old-record legacy heuristics only as read-only display and
telemetry compatibility.

#### Scenario: Env switch is absent

- **GIVEN** process env contains `OCTOCLAW_LEGACY_HEURISTIC_MODE`
- **WHEN** legacy heuristic verdict is computed
- **THEN** the env var SHALL NOT change the verdict
- **AND** new-task authority SHALL still require native evidence

#### Scenario: Old record can still render

- **GIVEN** an old task record has legacy signal and no native fields
- **WHEN** status is rendered
- **THEN** OctoClaw MAY use read-only legacy compatibility
- **AND** it SHALL emit or preserve `legacy_heuristic_fallback_used` telemetry

### Requirement: Slack CLI Delivery Rollback Is Removed After API Coverage

OctoClaw SHALL use the Slack API delivery path for live Slack sends.

#### Scenario: Slack text send uses API

- **GIVEN** a Slack target and message
- **WHEN** delivery executes
- **THEN** it SHALL call the Slack API path
- **AND** it SHALL NOT call OpenClaw CLI message send

#### Scenario: Slack API error is explicit

- **GIVEN** Slack API returns a delivery error
- **WHEN** delivery result is built
- **THEN** OctoClaw SHALL return a failed delivery result
- **AND** it SHALL NOT retry through a legacy CLI branch

### Requirement: ACP Fallback Is Host-Owned

OctoClaw SHALL read host fallback configuration and facts without exposing a
parallel backend-failover enforcement switch.

#### Scenario: Fallback config is observed

- **GIVEN** OpenClaw config includes `acp.fallbacks`
- **WHEN** OctoClaw builds fallback metadata
- **THEN** primary and fallback runtime ids SHALL be reported
- **AND** OctoClaw SHALL NOT mutate the fallback list

#### Scenario: Fallback attempt is not invented

- **GIVEN** backend failover may have happened inside the host runtime
- **WHEN** host status does not expose a selected fallback runtime
- **THEN** OctoClaw SHALL NOT claim `fallbackAttempted=true`

### Requirement: Runtime Payload Consolidation Preserves Contract

OctoClaw MAY consolidate runtime-only payload helper modules, but public
runtime payload behavior SHALL remain stable.

#### Scenario: Dispatch payload remains compatible

- **GIVEN** `buildTsRuntimeDispatchPayload()` is called for reply or delegate
- **WHEN** helper boundaries have been consolidated
- **THEN** downstream dispatch tests SHALL see the same contract fields
- **AND** native helper action names SHALL remain unchanged

### Requirement: Deletion Evidence Is Recorded

Each phase SHALL record deletion evidence.

#### Scenario: Closeout evidence exists

- **GIVEN** a P6 phase is marked complete
- **WHEN** implementation notes or final report are reviewed
- **THEN** deleted flags/functions/files SHALL be listed
- **AND** before/after production LOC SHALL be recorded
- **AND** targeted tests SHALL be named

