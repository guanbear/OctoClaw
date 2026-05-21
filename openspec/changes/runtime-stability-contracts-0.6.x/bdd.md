# BDD: Runtime Stability Contracts

Date: 2026-05-21

## Naming

- `RSC-SPAWN-*`: native spawn gate contract
- `RSC-STATUS-*`: status panel delivery contract
- `RSC-FOOTER-*`: footer truth contract
- `RSC-SMOKE-*`: acceptance coverage contract

## RSC-SPAWN-001: Planner summary drift does not block valid native spawn

**Given** a stored native spawn intent with a WorkContract ID, delegate task ID, attempt ID, runtime context packet, safety rules, and terminal `Task:` body
**And** the actual `sessions_spawn` args copy the same IDs, packet, safety rules, and terminal `Task:` body
**And** only the non-authoritative expected-deliverable summary text differs
**When** native spawn gate evaluates the call
**Then** the spawn is allowed
**And** the original spawn intent ID is preserved

## RSC-SPAWN-002: Changed terminal task is still blocked

**Given** a stored native spawn intent
**When** the actual `sessions_spawn` args change the terminal `Task:` body
**Then** native spawn gate blocks the call

## RSC-SPAWN-003: Missing safety markers are still blocked

**Given** a stored native spawn intent
**When** the actual `sessions_spawn` args omit runtime context or safety rules
**Then** native spawn gate blocks the call

## RSC-STATUS-001: IM status panel is visible even when the model does not copy tool output

**Given** an IM-backed session and a user asks for the status panel
**When** `octoclaw_status` builds the panel
**Then** runtime sends the panel directly to the inbound thread
**And** the sent text contains task/status/model/elapsed/result fields
**And** the tool result does not require the model to repeat the full panel

## RSC-STATUS-002: Direct status delivery failure falls back to verbatim tool output

**Given** an IM-backed session
**And** the IM adapter fails to send the status panel directly
**When** `octoclaw_status` runs
**Then** the tool result includes the full status panel text
**And** the model is instructed to return it as-is
**And** the tool does not throw

## RSC-STATUS-003: Plain status surfaces preserve CLI-style output

**Given** a plain non-IM session
**When** `octoclaw_status` runs
**Then** the tool returns the existing verbatim text/code-block response
**And** no IM delivery is attempted

## RSC-FOOTER-001: Delegate footer requires actual spawn or dispatch evidence

**Given** policy planned or suggested delegation
**And** no actual spawn/dispatch evidence exists
**When** a reply is delivered
**Then** the footer must not show `route=delegate`

## RSC-FOOTER-002: Native announce footer requires native final delivery

**Given** a child session has not produced a successful native announce final
**When** any interim, timeout, failed, aborted, interrupted, or cancelled event is observed
**Then** the delivered reply must not show `via=native_announce`

## RSC-SMOKE-001: Slack status panel smoke requires visible panel text

**Given** Slack acceptance sends the status panel case
**When** the case passes
**Then** the Slack transcript must contain visible task/status/model/elapsed/result text
**And** success cannot be based only on replay/tool evidence

## RSC-SMOKE-002: Slack delegated work smoke requires native execution evidence

**Given** Slack acceptance sends the delegated work case
**When** the case passes
**Then** replay evidence must include WorkContract, spawn intent, runId, childSession, native announce final, and Slack API delivery
