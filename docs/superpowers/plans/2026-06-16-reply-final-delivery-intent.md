---
change: reply-final-delivery-intent-06x
design-doc: docs/superpowers/specs/2026-06-16-reply-final-delivery-intent-design.md
base-ref: 6a22323248f775ed8fb96ad8349e4635eac916c3
---

# Reply Final Delivery Intent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver OctoClaw final replies to the frozen Slack inbound thread when OpenClaw 6.6 keeps normal final text private because no message-tool send happened.

**Architecture:** Add a focused reply-final-delivery intent module over `policyState`. Lifecycle hooks create an intent from the Slack inbound anchor, record final text during synchronous `before_message_write`, and run an idempotent `agent_end` backstop only when OpenClaw reports missing message-tool delivery evidence.

**Tech Stack:** TypeScript, Vitest, OpenClaw plugin lifecycle hooks, OctoClaw `policyState`, existing `sendIMMessage` adapter, GitNexus CLI impact checks.

---

## File Structure

- Create `extensions/octoclaw-runtime/src/resolve/reply-final-delivery-intent.ts`: pure-ish state helpers for intent creation, final capture, delivery decision, and delivery result recording.
- Create `extensions/octoclaw-runtime/src/resolve/reply-final-delivery-intent.test.ts`: unit tests for state transitions and idempotency.
- Modify `extensions/octoclaw-runtime/src/hooks/message-lifecycle.ts`: create intent on `message_received` and capture final text on `before_message_write`.
- Modify `extensions/octoclaw-runtime/src/hooks/agent-end.ts`: call the finalizer before compact receipt rewrite, with injectable send dependency.
- Modify `extensions/octoclaw-runtime/src/state/policy-state.ts`: add typed optional fields for `replyFinalDeliveryIntent` aliases.
- Test `extensions/octoclaw-runtime/src/hooks/agent-end.test.ts` or existing hook integration tests: verify backstop send, skip when message-tool delivery exists, skip without Slack anchor.

## Evidence From OpenClaw 2026.6.6

- `openclaw@2026.6.6` was unpacked to `/Users/guanbear/workspace/openclaw-2026.6.6-src`.
- `PluginHookMessageContext.sessionKey` is documented as the same canonical session key used by `agent_end`, so `message_received`, `before_message_write`, and `agent_end` can correlate through `sessionKey`.
- `before_message_write` is synchronous, so OctoClaw must record final text with synchronous state operations only.
- `EmbeddedAgentRunResult` and agent-end event data include `didSendViaMessagingTool`, `messagingToolSentTargets`, and related delivery evidence.
- In `sourceReplyDeliveryMode=message_tool_only`, OpenClaw intentionally keeps normal final text private unless `message(action=send)` committed visible delivery. OctoClaw's finalizer must therefore use this missing-delivery evidence, not `message_sending` hook observation.

## Task 1: Unit-Test Intent State

**Files:**
- Create: `extensions/octoclaw-runtime/src/resolve/reply-final-delivery-intent.test.ts`
- Create: `extensions/octoclaw-runtime/src/resolve/reply-final-delivery-intent.ts`
- Modify: `extensions/octoclaw-runtime/src/state/policy-state.ts`

- [ ] **Step 1: Write failing tests**

Add tests covering:

```ts
it("creates an intent from a frozen Slack inbound anchor");
it("records final text and stable hash without marking it delivered");
it("fails closed when no replyToMessageId exists");
it("keeps the dedupe key stable for same session/thread/final");
```

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm vitest run extensions/octoclaw-runtime/src/resolve/reply-final-delivery-intent.test.ts
```

Expected: FAIL because `reply-final-delivery-intent.ts` does not exist.

- [ ] **Step 3: Implement minimal intent helpers**

Implement exports:

```ts
createReplyFinalDeliveryIntentForState(input)
recordReplyFinalTextForState(input)
shouldBackstopReplyFinalDelivery(input)
recordReplyFinalDeliveryResultForState(input)
replyFinalDeliveryIntentFromState(state)
```

Use SHA-256 hashes and store state under both `replyFinalDeliveryIntent` and `reply_final_delivery_intent`.

- [ ] **Step 4: Verify GREEN**

Run the same Vitest command and expect PASS.

## Task 2: Capture Final Text In Hooks

**Files:**
- Modify: `extensions/octoclaw-runtime/src/hooks/message-lifecycle.ts`
- Test: existing hook integration test or new focused test near lifecycle hooks

- [ ] **Step 1: Write failing hook test**

Simulate `message_received` with a Slack thread anchor, then `before_message_write` with an assistant final. Assert policy state contains the intent with final text/hash and frozen target.

- [ ] **Step 2: Verify RED**

Run the focused hook test and expect missing intent/final fields.

- [ ] **Step 3: Wire hook calls**

Call `createReplyFinalDeliveryIntentForState` after the inbound anchor update and `recordReplyFinalTextForState` after the final message has been footer-projected.

- [ ] **Step 4: Verify GREEN**

Run the focused hook test and the intent unit test.

## Task 3: Agent-End Backstop Delivery

**Files:**
- Modify: `extensions/octoclaw-runtime/src/hooks/agent-end.ts`
- Test: `extensions/octoclaw-runtime/src/hooks/agent-end.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests for:

```ts
it("sends a final reply once when OpenClaw reports didSendViaMessagingTool false");
it("skips backstop when didSendViaMessagingTool is true");
it("skips backstop when messagingToolSentTargets contains the frozen source target");
it("does not send without a frozen replyToMessageId");
it("does not send twice for the same final hash");
```

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm vitest run extensions/octoclaw-runtime/src/hooks/agent-end.test.ts
```

Expected: FAIL because `makeAgentEndHook` has no finalizer dependency or behavior.

- [ ] **Step 3: Implement finalizer**

Add an optional dependency:

```ts
sendFinalReply?: typeof sendIMMessage
```

At `agent_end`, before compact receipt rewrite, decide with `shouldBackstopReplyFinalDelivery`. Send through `sendIMMessage` with the frozen `sessionKey`, `replyToMessageId`, exact final text, `deliveryKind: "reply_final_backstop"`, and the stable dedupe key. Record success/failure in state and replay.

- [ ] **Step 4: Verify GREEN**

Run hook tests and intent tests.

## Task 4: Verification And Commit

**Files:**
- Modify: `openspec/changes/reply-final-delivery-intent-06x/tasks.md`
- No unrelated files.

- [ ] **Step 1: Run targeted tests**

```bash
pnpm vitest run extensions/octoclaw-runtime/src/resolve/reply-final-delivery-intent.test.ts extensions/octoclaw-runtime/src/hooks/agent-end.test.ts
```

- [ ] **Step 2: Run runtime check**

```bash
pnpm --filter @octoclaw/runtime run check
```

- [ ] **Step 3: Run GitNexus change detection**

```bash
npx gitnexus detect-changes --repo OctoClaw --scope all
```

- [ ] **Step 4: Validate OpenSpec**

```bash
openspec validate reply-final-delivery-intent-06x
```

- [ ] **Step 5: Commit relevant files only**

```bash
git add docs/superpowers/plans/2026-06-16-reply-final-delivery-intent.md \
  docs/superpowers/specs/2026-06-16-reply-final-delivery-intent-design.md \
  openspec/changes/reply-final-delivery-intent-06x \
  extensions/octoclaw-runtime/src/resolve/reply-final-delivery-intent.ts \
  extensions/octoclaw-runtime/src/resolve/reply-final-delivery-intent.test.ts \
  extensions/octoclaw-runtime/src/hooks/message-lifecycle.ts \
  extensions/octoclaw-runtime/src/hooks/agent-end.ts \
  extensions/octoclaw-runtime/src/hooks/agent-end.test.ts \
  extensions/octoclaw-runtime/src/state/policy-state.ts
git commit -m "fix(runtime): backstop missing final reply delivery"
```
