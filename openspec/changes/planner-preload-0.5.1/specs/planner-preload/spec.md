# Spec Delta: 0.5.1 Planner Preload

## ADDED Requirements

### Requirement: Budgeted Main Timeout Is Soft

The 30s budget for `budgeted_main_then_delegate` SHALL be a soft main execution budget, not a hard user-visible SLA or forced interrupt.

#### Scenario: timeout reaches a prompt boundary

- WHEN the budget expires before a later prompt-injection boundary
- THEN OctoClaw SHALL inject a soft-budget notice
- AND SHALL NOT immediately convert the route to delegate solely because the prompt boundary occurred
- AND SHALL NOT direct spawn or send accepted ACK.

#### Scenario: late final reply

- WHEN the main agent produces a final reply after the soft budget expires
- THEN OctoClaw SHALL record `budgeted_main_completed_late`
- AND SHALL NOT create a spawn intent.

#### Scenario: one late lightweight read-only tool

- WHEN the soft budget has expired
- AND the next real tool is lightweight and read-only
- THEN OctoClaw MAY allow that single tool to complete the answer
- AND SHALL keep accepted ACK semantics unchanged.

#### Scenario: late dangerous or multi-step work

- WHEN the soft budget has expired
- AND the next work needs write tools, long commands, multi-step tools, tests/build/review/validation, or a second real read-only tool
- THEN OctoClaw SHALL block or rewrite the path to require `octoclaw_dispatch`
- AND escalation SHALL use `octoclaw_dispatch -> sessions_spawn -> octoclaw_dispatch_confirm`.

### Requirement: Speculative Preload Is Feature Flagged

Scheme B speculative preload SHALL be disabled by default and SHALL only run when `OCTOCLAW_SPECULATIVE_PRELOAD=1` (or equivalent enabled value) is set.

#### Scenario: flag disabled

- WHEN speculative preload flag is not enabled
- THEN OctoClaw SHALL NOT inject speculative spawn hints
- AND normal planner/confirm behavior SHALL remain unchanged.

#### Scenario: flag enabled for delegate route

- WHEN the flag is enabled
- AND the backend is planner
- AND the runtime decision route is delegate
- THEN OctoClaw MAY inject `OCTOCLAW_SPECULATIVE_SPAWN_HINT`
- AND the trigger SHALL be the runtime decision, not bare user keywords.

### Requirement: Speculative Standby Spawn Is Strictly Whitelisted

OctoClaw SHALL allow speculative standby `sessions_spawn` only when the tool args match the safe standby shape.

#### Scenario: matching standby spawn

- WHEN `sessions_spawn` args have an `octoclaw-speculative-` label
- AND the task exactly says `Standby worker. Do not execute any task. Await task assignment via sessions_send.`
- AND `mode=session`, `thread=true`, `context=isolated`, and `lightContext=true`
- THEN OctoClaw MAY allow the speculative spawn before `octoclaw_dispatch`
- AND SHALL record `speculative_preload_spawn_allowed`.

#### Scenario: non-matching standby spawn

- WHEN any required standby field does not match
- THEN OctoClaw SHALL treat the call as an ordinary `sessions_spawn`
- AND planner gate rules SHALL require a pending `dispatchMode=new_spawn` intent.

### Requirement: Dispatch Can Send To A Started Speculative Session

`octoclaw_dispatch` MAY return a `sessions_send` plan when a speculative standby session has already reached `spawn_call_started`.

#### Scenario: standby started

- WHEN `octoclaw_dispatch` runs for a delegate route
- AND the policy state has speculative preload status `spawn_call_started`
- THEN dispatch SHALL create a pending intent with `dispatchMode=send_to_speculative`
- AND SHALL return `nextTool=sessions_send`, `sessionsSendArgs`, `spawnIntentId`, `workContractId`, canonical hash, and confirm tool.

#### Scenario: standby missing

- WHEN no usable speculative standby state exists
- THEN dispatch SHALL fall back to normal `dispatchMode=new_spawn`
- AND SHALL return `nextTool=sessions_spawn` and `sessionsSpawnArgs`.

### Requirement: Sessions Send Requires Matching Intent

`sessions_send` in the planner delegate path SHALL be gated by a pending `NativeSpawnIntent` with `dispatchMode=send_to_speculative`.

#### Scenario: matching sessions_send

- WHEN `sessions_send` args match the canonical hash of a pending send-to-speculative intent
- THEN OctoClaw SHALL move the intent to `spawn_call_started`
- AND SHALL record `sessions_send_intent_allowed`.

#### Scenario: missing or mismatched sessions_send

- WHEN no pending send-to-speculative intent exists
- OR the canonical hash differs
- THEN OctoClaw SHALL block `sessions_send`
- AND SHALL not write WorkContract native refs
- AND SHALL not send accepted ACK.

### Requirement: Dispatch Modes Do Not Mask Each Other

Ordinary spawn intents and speculative send intents SHALL be authorized independently.

#### Scenario: mixed pending intents in one session

- WHEN a session has both `dispatchMode=new_spawn` and `dispatchMode=send_to_speculative` planned intents
- THEN `sessions_spawn` gate SHALL only consider the new-spawn intent
- AND `sessions_send` gate SHALL only consider the send-to-speculative intent
- AND one mode SHALL NOT hide or invalidate the other.

### Requirement: Confirm And ACK Semantics Are Unchanged

Speculative preload SHALL NOT relax the native planner/confirm handshake.

#### Scenario: accepted sessions_send result

- WHEN native `sessions_send` returns accepted with a non-empty run id
- AND `octoclaw_dispatch_confirm` receives matching `spawnIntentId`, `workContractId`, and run/session evidence
- THEN OctoClaw SHALL write WorkContract native refs
- AND SHALL mark the intent accepted
- AND SHALL send accepted ACK at most once.

#### Scenario: accepted result without run id

- WHEN a speculative send result is accepted but has no run id
- THEN confirm SHALL fail closed
- AND SHALL NOT write native refs
- AND SHALL NOT send accepted ACK.

### Requirement: Live Validation Gates Rollout

Speculative preload SHALL NOT be enabled by default or broadly allowlisted before real Slack evidence proves it.

#### Scenario: live validation

- WHEN P2 live validation runs
- THEN artifacts SHALL show `speculative_preload_hint_injected`, `speculative_preload_spawn_allowed`, `dispatchMode=send_to_speculative`, `sessions_send_intent_allowed`, `dispatch_confirm_completed ok=true`, accepted native intent with run id, WorkContract native refs, final footer via native announce, no duplicate final, and `completion_file_timeout=0`.

#### Scenario: validation incomplete

- WHEN P2 evidence is missing or fails
- THEN speculative preload SHALL remain default off.
