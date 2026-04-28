# OctoClaw Receipt Projection Follow-up Fix (2026-04-28)

## Problem

Morning Slack/DM incidents showed three distinct failure modes:

1. A direct main-session lookup (`reply` route with tools such as `exec` / `web_fetch`) produced a correct answer, but follow-up provenance questions could not reliably see that direct-tool execution fact.
2. Follow-up questions mentioning subagents could be rewritten by the assistant-message guard because the guard inferred dispatch truth from natural-language prose.
3. `spawn_not_confirmed` and direct-reply provenance were mixed in user-facing answers, causing the main agent to say a direct lookup "had not dispatched" even when no delegation was expected.

## Design Rule

Execution truth must come from receipts and projections, not text matching:

- `TurnExecutionReceipt` is the compact per-turn execution truth for both `reply` and `delegate` routes.
- `ExecutionCoveragePacket` is the provenance/status follow-up projection derived from receipts.
- The assistant-message guard is a safety guard only. It may block raw internal context leaks or ungrounded direct-tool claims, but it must not infer dispatch state from natural-language mentions of "subagent", "delegate", or "route".

## Implemented Behavior

- On `agent_end`, OctoClaw retains a compact receipt-only policy-state entry for completed direct replies and materialized/attempted delegated work.
- `buildExecutionCoverageLayer(...)` reads `latestExecutionReceipt` even when the full policy decision has been compacted away.
- Provenance follow-ups can now answer from direct-tool facts such as `route=reply; tools=[exec, web_fetch]`.
- Natural-language subagent wording is not rewritten by keyword-style guard rules.
- Raw internal spawn API leaks such as `sessions_spawn` are still blocked.

## Non-goals

- No new task engine.
- No fake TaskFlow for direct replies.
- No keyword-based router or judge rules.
- No raw child transcript injection into parent context.
- No P3/P4 live-path changes.

## Acceptance Examples

- "刚才是你查的还是子 agent 查的？" should be answered from `ExecutionCoveragePacket` as direct main-session lookup when the previous turn used `reply` with tools.
- "为什么任务面板没有刚才那个任务？" should distinguish direct reply receipts from delegated/native tasks.
- A `spawn_not_confirmed` delegated task remains truthful: dispatch/materialization can be true while spawn is false.
