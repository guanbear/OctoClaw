# Tasks: Runtime Stability Contracts

## Phase A — Contract Documentation

- [x] Add `proposal.md`.
- [x] Add `design.md`.
- [x] Add `tasks.md`.
- [x] Add `bdd.md`.

## Phase B — Native Spawn Gate Stability

- [x] Add a regression where copied planner args differ only in expected-deliverable summary text.
- [x] Allow that bounded planner-envelope drift only when IDs, terminal task, and safety markers match.
- [x] Keep existing blocks for missing runtime packet, changed IDs, changed terminal task, or missing safety rules.
- [x] Run targeted native spawn gate tests.

## Phase C — Status Panel Deterministic IM Delivery

- [x] Add unit coverage proving IM status panel direct delivery succeeds without relying on model-copy behavior.
- [x] Add unit coverage proving failed direct delivery falls back to verbatim model-visible output.
- [x] Implement direct `sendIMMessage()` path inside `octoclaw_status` for IM sessions.
- [x] Record sanitized `status_panel_direct_delivery` replay evidence.
- [x] Run targeted status panel tests.

## Phase D — Acceptance / Smoke Coverage

- [x] Ensure Slack acceptance `status_panel` case catches visible panel delivery, not just tool execution.
- [x] Ensure delegated work case catches spawn intent, WorkContract, runId, childSession, and native announce final evidence.
- [ ] Run real Slack acceptance after deployment.

## Phase E — Verification

- [x] Run `pnpm check`.
- [x] Run `pnpm test`.
- [x] Run `npx gitnexus detect-changes --repo OctoClaw --scope all`.
- [ ] Commit only stability-contract files and related tests.
- [ ] Deploy and rerun real Slack smoke.
