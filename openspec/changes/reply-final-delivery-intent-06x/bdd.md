# BDD: Reply Final Delivery Intent

## Scenario: pending final is delivered at agent end

Given a Slack inbound turn has a frozen delivery target
And the main agent writes a non-empty final assistant answer
And no hard delivery evidence exists
When `agent_end` runs
Then OctoClaw sends the final answer through the IM adapter
And the send uses the frozen `sessionKey` and `replyToMessageId`
And the delivery intent is marked `delivered`.

## Scenario: already delivered final is not resent

Given a Slack inbound turn has a frozen delivery target
And the final assistant answer was already delivered by native/OpenClaw evidence
When `agent_end` runs
Then OctoClaw does not call the IM adapter
And the delivery intent records a skipped duplicate reason.

## Scenario: close Slack turns do not share one target

Given Slack DM message A and Slack DM message B arrive close together
And each message has a distinct inbound timestamp
When each run writes a final answer and ends
Then each final answer is delivered to its own frozen thread target
And neither final answer is sent to the other turn's thread.

## Scenario: missing anchor fails closed

Given a Slack session key is present
And no inbound message timestamp or frozen delivery target exists
And the main agent writes a final answer
When `agent_end` runs
Then OctoClaw does not send a top-level fallback message
And it records `missing_inbound_anchor`.
