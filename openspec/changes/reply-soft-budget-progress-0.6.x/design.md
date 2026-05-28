# Design: Reply Soft-Budget Progress

## Contract 1: Progress Notice Is Separate From ACK0

ACK0 answers "did runtime notice the user message?" Progress notice answers "is the main reply lane still working after visible silence?"

A Slack reaction ACK may count as ACK0, but it must not:

- cancel reply progress timers;
- mark all latency/progress obligations as complete;
- block later tier progress text from the timer owner.

Text ACK0 remains deduped by message turn. Tier progress remains separately deduped by stage.

## Contract 2: Reply Timers Cover `must_reply`

`must_reply` is still a reply lane decision. It should receive the same elapsed-time progress treatment as other reply decisions.

Timer behavior:

- Start the progress guard when a managed inbound Slack turn is observed.
- Keep timers alive while the route is still unresolved.
- After the route resolves to `reply`, allow timer tiers to fire.
- After the route resolves to `delegate` or `observe`, cancel reply progress timers.

The first visible progress tier should remain delayed enough to avoid noise for normal short replies.

## Contract 3: Route-Commit ACK Does Not Own Reply Progress

Reply route-commit text ACK remains disabled to avoid "ACK plus immediate answer" noise. That suppression only applies to route-commit ACK. It must not suppress later timer-based progress when the main reply lane stays silent.

## Contract 4: Progress Is Not Escalation

Progress notice and delegate escalation use different triggers and evidence:

- Progress: elapsed visible silence on a reply route, no final/streaming/delivered answer.
- Escalation: budgeted-main policy, long or unsafe tool behavior, write/build/test/review work, or too many read-only steps.

For `must_reply`, progress notice is always allowed. Escalation should remain policy/tool-behavior driven and should not happen only because the timer posted progress text.

## Failure Handling

- If the Slack target cannot be resolved, record a skipped/not-attempted ACK result and do not retry blindly.
- If a final reply begins streaming before a timer fires, suppress the timer send.
- If a route later becomes delegate/observe, cancel reply timers.
- If reaction ACK fails, existing delayed neutral text fallback behavior remains unchanged.

## Observability

Existing ACK delivery receipts should show:

- ACK0 reaction/text delivery under the original message turn;
- tier progress text under a later ACK stage;
- skipped route-commit ACK with `reply_route_runtime_text_ack_disabled` when applicable.

Budget escalation replay evidence remains separate from ACK/progress delivery evidence.
