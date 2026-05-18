# BDD: Post-P5 Runtime Slimming

## P6-001: Legacy Runtime Ledger Config Is Gone

**Given** runtime planner config is resolved

**When** `resolvePlannerSpawnConfig()` returns

**Then** it includes `spawnBackend`, `plannerAllowlist`, and `intentTtlMs`

**And** it does not include `legacyRuntimeLedgerMode`

**And** live runtime code does not read `OCTOCLAW_LEGACY_RUNTIME_LEDGER`

## P6-002: Runtime Ledger Enforcement Still Works

**Given** `OCTOCLAW_LEGACY_RUNTIME_LEDGER` is removed

**When** dispatch seals and admits a delegated WorkContract

**Then** delegation ticket enforcement still runs

**And** `task_attempts` and `runtime_events` behavior covered by existing tests
still passes

## P6-003: Legacy Heuristic Env Switch Is Gone

**Given** old-record compatibility remains enabled as read-only behavior

**When** `legacyHeuristicVerdict()` is called with legacy signal and no native
truth

**Then** it returns `source="legacy_heuristic_read_only"`

**And** the result is not controlled by `OCTOCLAW_LEGACY_HEURISTIC_MODE`

## P6-004: Legacy Heuristics Do Not Admit New Tasks

**Given** a new task has no accepted native child evidence

**When** dispatch/session/native announce/status logic sees only text or session
label hints

**Then** legacy heuristics do not create dispatch authority

**And** any fallback event is read-only telemetry only

## P6-005: Slack Delivery Uses Slack API Path

**Given** a Slack delivery envelope has a resolvable target

**When** `sendText()` executes

**Then** it uses Slack API delivery

**And** it does not branch on `OCTOCLAW_LEGACY_CLI_DELIVERY`

**And** no live send result returns `transport="legacy_cli"`

## P6-006: Slack API Failure Still Reports Failure

**Given** Slack API delivery returns an error

**When** `sendText()` handles the result

**Then** it returns `ok=false`

**And** it preserves the existing error code semantics used by ACK/status tests

**And** it does not fall through to an OpenClaw CLI send

## P6-007: ACP Fallback Is Host-Owned

**Given** OpenClaw config includes `acp.fallbacks`

**When** OctoClaw records runtime fallback metadata

**Then** metadata reports the configured primary/fallback runtime ids

**And** OctoClaw does not expose `OCTOCLAW_NATIVE_ACP_FALLBACK_MODE`

**And** OctoClaw does not claim a fallback was attempted unless host status
exposes that fact

## P6-008: Backend Recovery Boundaries Stay Clear

**Given** a worker times out, produces bad output, or violates policy after
output starts

**When** OctoClaw classifies recovery

**Then** it remains task recovery

**And** it is not silently converted into ACP backend failover

## P6-009: Runtime Payload Shape Is Stable

**Given** runtime payload helper boundaries are consolidated

**When** `buildTsRuntimeDispatchPayload()` and `buildTsRuntimeSpawnPayload()`
run for reply and delegate routes

**Then** existing payload fields used by dispatch, planner, and tests remain
stable

**And** native helper actions remain `create-managed-flow` and `run-task`

## P6-010: Deletion Is Measured

**Given** P6 closeout is complete

**When** implementation notes are reviewed

**Then** before/after production LOC is recorded

**And** deleted flags/functions/files are listed

**And** retained legacy helpers have explicit reasons

