# Slack Turn Delivery Provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Slack direct replies from inheriting stale delegate state, make ACK/status text task-aware without LLM calls, and keep native child final delivery idempotent.

**Architecture:** Keep OpenClaw as the session/subagent runtime. OctoClaw owns turn-scoped policy state, footer provenance, deterministic ACK/status text, and native final delivery guards.

**Tech Stack:** TypeScript, Vitest, OctoClaw runtime extension hooks, GitNexus impact checks.

---

### Task 1: Turn Boundary Reset

**Files:**
- Modify: `extensions/octoclaw-runtime/src/hooks/message-lifecycle.ts`
- Test: `extensions/octoclaw-runtime/src/extension-entry-neutral-ack.test.ts`

- [ ] Add a regression test where Slack DM message A has an active delegate work contract, then message B arrives with a different Slack timestamp in the same DM session.
- [ ] Verify the test fails because message B still sees stale delegate metadata.
- [ ] Update `message_received` state update so a changed inbound anchor starts a fresh turn-scoped policy state while preserving canonical session, ACK guard, delivery target, tone, and timestamps.
- [ ] Verify the new test passes.

### Task 2: Footer Provenance Guard

**Files:**
- Modify: `extensions/octoclaw-runtime/src/hooks/footer-mode.ts`
- Test: `extensions/octoclaw-runtime/src/__tests__/extension-entry-outbound-guards.test.ts`

- [ ] Add a regression test showing a direct Slack reply for a later message does not render `route=delegate` or the old `workContractId`.
- [ ] Verify the test fails with the current stale state.
- [ ] Tighten delegate footer evidence so delegate provenance is only used when the current outbound turn still matches the delegate state.
- [ ] Verify outbound guard tests pass.

### Task 3: Deterministic Task-Aware ACK Text

**Files:**
- Modify: `extensions/octoclaw-runtime/src/ack/ack-route-commit.ts`
- Modify: `extensions/octoclaw-runtime/src/ack/execution-transition-notifier.ts`
- Test: `extensions/octoclaw-runtime/src/ack/__tests__/route-commit-ack.test.ts`
- Test: `extensions/octoclaw-runtime/src/ack/__tests__/execution-transition-notifier.test.ts`

- [ ] Add tests for delegate route ACK and spawn/progress transition text including the task title/summary.
- [ ] Verify tests fail because current text is generic.
- [ ] Render deterministic task-aware messages from route commit work contract data and task status projection fields.
- [ ] Verify ACK tests pass without adding any LLM call.

### Task 4: Native Final Idempotency Verification

**Files:**
- Test: `extensions/octoclaw-runtime/src/__tests__/extension-entry-outbound-guards.test.ts`

- [ ] Verify existing native completion plus `subagent_ended` tests cover single final delivery.
- [ ] Add or adjust coverage only if the direct completion and backstop completion paths can still send twice.
- [ ] Run targeted native announce tests.

### Task 5: Final Verification

**Files:**
- All modified files

- [ ] Run targeted Vitest files.
- [ ] Run `pnpm test` or the smallest repo-appropriate aggregate if targeted checks pass.
- [ ] Run `npx gitnexus detect-changes --repo OctoClaw --scope all`.
- [ ] Review `git diff --stat` and summarize blast radius before commit/push.
