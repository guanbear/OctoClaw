# Spec Delta: Reply Final Delivery

## ADDED Requirements

### Requirement: Final Reply Uses Frozen Delivery Intent

OctoClaw SHALL create a turn-scoped delivery intent for anchored Slack inbound
turns and SHALL use that intent as the authority for final reply delivery target
selection.

#### Scenario: inbound Slack turn creates intent

- WHEN a Slack inbound message has a session key and inbound message timestamp
- THEN OctoClaw SHALL create a delivery intent with a frozen session key and
  reply-to message id
- AND later prompt, dispatch, final write, and agent-end logic SHALL read the
  same frozen target.

#### Scenario: unanchored Slack turn fails closed

- WHEN a Slack turn has no inbound timestamp and no frozen delivery target
- THEN OctoClaw SHALL NOT send a final reply using a top-level or latest-message
  fallback
- AND SHALL record the reason as `missing_inbound_anchor`.

### Requirement: Final Visibility Is Not Delivery Success

OctoClaw SHALL distinguish final text visibility from user-visible delivery
success.

#### Scenario: final text is written

- WHEN `before_message_write` observes a non-empty assistant final
- THEN OctoClaw SHALL record final text/hash on the delivery intent
- AND SHALL NOT mark the final as delivered solely because the text was written
  or a footer was appended.

#### Scenario: adapter send succeeds

- WHEN OctoClaw sends a pending final through the IM adapter and the adapter
  reports success
- THEN OctoClaw SHALL mark the delivery intent as delivered
- AND SHALL record delivery message evidence when available.

### Requirement: Agent End Backstops Pending Finals

OctoClaw SHALL backstop-deliver a final answer at `agent_end` when a final was
seen and hard delivery evidence is missing.

#### Scenario: pending final at agent end

- WHEN a delivery intent has final text/hash and a frozen Slack target
- AND no hard delivery evidence exists
- THEN `agent_end` SHALL send the final through the IM adapter exactly once
- AND SHALL use the frozen target from the intent.

#### Scenario: hard delivery evidence exists

- WHEN hard native or OpenClaw delivery evidence exists for the same final turn
- THEN `agent_end` SHALL NOT send a duplicate final
- AND SHALL record a skipped duplicate reason.

### Requirement: Delivery Backstop Is Idempotent

OctoClaw SHALL dedupe final reply backstop delivery by final hash and frozen
delivery target.

#### Scenario: repeated agent end

- WHEN `agent_end` runs more than once for the same final hash and target
- THEN OctoClaw SHALL send at most one final reply through the IM adapter.

#### Scenario: close Slack turns

- WHEN multiple Slack DM turns arrive close together with different inbound
  timestamps
- THEN each turn SHALL keep its own delivery intent
- AND final delivery for one turn SHALL NOT use the other turn's target.
