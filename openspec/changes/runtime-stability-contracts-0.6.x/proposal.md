# Change: Runtime Stability Contracts

Date: 2026-05-21
Target release: v0.6.x

## Why

Recent Slack smoke and live Slack transcripts exposed a pattern: OctoClaw is too often relying on model-visible text to carry runtime protocol responsibilities. After native runtime slimming, old relay and recovery branches no longer mask these boundary failures, so issues now surface as missing replies, misleading footers, false delegate failures, or status panels hidden in model thinking.

The fix should not be another set of keyword gates. We need a small set of runtime contracts that are generated from structured evidence and enforced at adapter/runtime boundaries.

## Problems

1. A native delegated spawn can be blocked when the model copies planner args with harmless expected-deliverable summary drift, even when WorkContract/task IDs and final task text match.
2. `octoclaw_status` can return the correct status panel to the model, but the model can place it in hidden thinking or summarize it away, so Slack users do not see the panel.
3. Footer values can become confusing when planned route, policy route, and actual execution route are not separated.
4. Smoke coverage historically tested judgement quality more than runtime stability contracts.

## Goals

- Make runtime/adapter own ACK, status panel, footer, native announce final, and delivery receipts.
- Keep route/footer truth tied to actual execution evidence, not intended route text.
- Allow narrow, structured planner-envelope drift without weakening WorkContract safety.
- Convert known instability patterns into BDD and Slack acceptance coverage.
- Keep the implementation simple: no new orchestration layer and no broad gate stack.

## Non-Goals

- Do not rewrite the router or judge.
- Do not reintroduce delivery relay as the primary path.
- Do not remove WorkContract or native spawn intent enforcement.
- Do not add keyword-based allow/deny routing rules.
- Do not make Slack-specific behavior leak into core routing decisions.

## Acceptance Gate

- `octoclaw_status` visible output in IM sessions is delivered by runtime/adapter even if the model does not copy tool output.
- Native spawn gate accepts copied planner args when only non-authoritative expected-deliverable summary text drifts and all structured identity/safety fields match.
- Failed, timed out, cancelled, or interrupted native announce completions are never treated as final delivery.
- Slack acceptance has coverage for delegated work, status panel visibility, footer truth, and stale route correction.
- `pnpm check && pnpm test` pass.
