# Design: Runtime Stability Contracts

## Contract 1: Runtime Owns Protocol Output

Model output is not a reliable carrier for protocol-critical UI. The runtime must deterministically produce:

- ACK messages and reactions
- status panels
- footer/provenance metadata
- native child final delivery
- delivery receipts

For `octoclaw_status`, the tool continues returning text for plain/CLI surfaces. For IM sessions, the tool also sends the rendered panel directly through `sendIMMessage()` with `deliveryKind = "status_reply"` and `footerMode = "off"`. If direct delivery succeeds, the tool result tells the model that the panel has already been sent and should not be repeated. If direct delivery fails, the tool falls back to the previous verbatim-return instruction so the model can still surface the panel.

## Contract 2: Footer Mirrors Actual Execution

Footer route is an execution fact, not a planning hint.

- `route=delegate` requires actual spawn/dispatch evidence.
- `via=native_announce` requires native announce final delivery evidence.
- Reply/tool-only status surfaces use `route=reply` or no delegate footer.
- Planned escalation, budget pressure, or route hint alone must not produce delegate footer.

This change does not create a new footer subsystem. It documents the invariant that existing footer sources must follow.

## Contract 3: Native Spawn Gate Is Strict on Identity, Tolerant on Non-Authoritative Summary

The native spawn gate continues to reject mutated or incomplete planner packets. It may recover only this bounded case:

- both expected and actual tasks start with `[OctoClaw delegated work]`;
- both contain a `## Runtime Context Packet`;
- `workContractId`, `delegateTaskId`, and `attemptId` match exactly;
- terminal `Task:` text matches exactly;
- actual task still contains required safety markers;
- only the planner envelope expected-deliverable summary differs.

This avoids false negatives from model copying/truncation while preserving WorkContract identity and runtime safety.

## Contract 4: Smoke Classifies Stability Failures

Slack acceptance should classify failures by contract area:

- ACK/thread placement
- delegate spawn evidence
- native announce final delivery
- status panel visible delivery
- footer execution truth
- provider fallback/error surfacing
- wizard/model selection correctness

Real Slack smoke remains the end-to-end gate. Unit tests protect each contract so failures are localized before live smoke.

## Data Flow

### Status Panel

1. User asks for status.
2. Router allows `octoclaw_status`.
3. Tool builds native status output.
4. If session is IM-backed, runtime sends output directly to the inbound thread using IM adapter.
5. Tool returns a compact model instruction:
   - direct delivery succeeded: "status panel already delivered";
   - direct delivery failed/plain surface: previous verbatim panel response.

### Delegated Spawn

1. Planner stores canonical sessions spawn args in native spawn intent.
2. Model calls `sessions_spawn`.
3. Native spawn gate compares actual args with stored args.
4. Exact match is accepted.
5. Bounded planner-envelope drift is accepted only when identity, terminal task, and safety markers match.
6. All other drift remains blocked.

## Failure Handling

- Direct IM status delivery failures are recorded in replay but do not throw.
- Spawn gate recovery is local to planner-envelope drift; it does not bypass missing packet, missing IDs, changed task, or missing safety rules.
- Native announce terminal failure statuses are ignored as final completions.

## Observability

Add replay events for deterministic status delivery:

- `status_panel_direct_delivery`
  - `sessionKey`
  - `stateKey`
  - `imType`
  - `replyToMessageId`
  - `sent`
  - `error`
  - `transport`
  - `targetSource`

The event must not contain auth headers, prompts, or raw private transcripts.
