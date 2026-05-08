# ACK Bug Fixes + WeChat/Feishu IM Adapters

## TL;DR

> **Quick Summary**: Fix two ACK delivery bugs (text not randomizing, first message not threading), then add WeChat and Feishu IM adapters following the existing Slack adapter pattern. All adapters route through `openclaw message send --channel <channel>`.
>
> **Deliverables**:
> - ACK template randomization fixed (contextual + random)
> - ACK first-message threading handled for fresh DMs
> - WeChat adapter (text-only, no threading, CLI-based)
> - Feishu adapter (text + threading, CLI-based)
> - Adapter registry updated for all 3 channels
> - `normalizeChannelUserId()` updated for wechat/feishu
> - Unit tests for each fix and adapter
>
> **Estimated Effort**: Medium
> **Parallel Execution**: YES - 4 waves
> **Critical Path**: Task 1-2 (bug fixes) → Task 5-6 (adapters) → Task 7 (registry wiring) → Task 8 (deploy + verify)

---

## Context

### Original Request
User reported two ACK bugs and requested WeChat + Feishu adapter support. WeChat confirmed via OpenClaw WeChat plugin (`openclaw message send --channel wechat`). Feishu path TBD based on CLI support.

### Interview Summary
**Key Discussions**:
- Bug 1: `selectAckTemplate()` uses deterministic logic, never randomizes. `ackStageText()` randomizes but is dead code in timer path.
- Bug 2: First ACK in fresh DM may not thread correctly — `--reply-to` behavior with user's `ts` when no thread exists yet.
- WeChat: text-only, private-chat, no threading, no rich cards. Walks via OpenClaw CLI.
- Feishu: text + threading, potentially cards later. Walks via OpenClaw CLI if supported.
- Both adapters follow Slack adapter pattern per-channel.

**Research Findings**:
- `IMSurfaceAdapter` shared interface exists in `packages/octoclaw-runtime-core/src/im/adapter.ts` but is NOT implemented by SlackAdapter — SlackAdapter has its own types and send signature.
- `channelSupportsThreading("wechat")` already returns `false`, `channelSupportsThreading("feishu")` returns `true`.
- Adapter registry (`im/index.ts`) only matches `:slack:`, returns null for everything else.
- `ack-guard.ts` routes through `getAdapterForSession()` — wiring new adapters there activates ACK delivery.

### Metis Review
**Identified Gaps** (addressed):
- Shared interface not used by SlackAdapter → Decision: Option C (per-channel types, duck-typed send). Refactoring to `IMSurfaceAdapter` is separate work, not in this scope.
- `selectAckTemplate()` has valid contextual logic (Blocked with `{reason}`, ObserveStarted with route-aware) → Must randomize WITHIN contextual subsets, not replace.
- OpenClaw CLI `--channel wechat/feishu` support unvalidated → Task 0 validates this first, blocks adapter tasks.
- Bug 2 exact failure mode unknown → Fix handles both cases (skip `--reply-to` for fresh DM, try it when thread exists).

---

## Work Objectives

### Core Objective
Fix ACK bugs, add WeChat and Feishu adapters, deploy and verify.

### Concrete Deliverables
- Modified: `extensions/octoclaw-runtime/src/ack/ack-templates.ts`
- Modified: `extensions/octoclaw-runtime/src/ack/ack-guard.ts`
- Modified: `extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts`
- Created: `extensions/octoclaw-runtime/src/im/wechat/wechat-adapter.ts`
- Created: `extensions/octoclaw-runtime/src/im/wechat/index.ts`
- Created: `extensions/octoclaw-runtime/src/im/feishu/feishu-adapter.ts`
- Created: `extensions/octoclaw-runtime/src/im/feishu/index.ts`
- Modified: `extensions/octoclaw-runtime/src/im/index.ts`
- Modified: `packages/octoclaw-runtime-core/src/im/adapter.ts`
- Created: test files for each adapter and bug fix

### Definition of Done
- [ ] ACK text randomizes across 10 calls (at least 2 distinct results per stage)
- [ ] ACK text preserves contextual logic (Blocked with reason still interpolates `{reason}`)
- [ ] First ACK in fresh DM sends successfully (top-level if threading unavailable)
- [ ] `getAdapterForSession("...:wechat:...")` returns WeChat adapter
- [ ] `getAdapterForSession("...:feishu:...")` returns Feishu adapter
- [ ] WeChat adapter constructs correct CLI args without `--reply-to` or `--thread-id`
- [ ] Feishu adapter constructs correct CLI args with `--reply-to` when configured
- [ ] `pnpm test` passes
- [ ] Deployed and gateway loads without errors

### Must Have
- ACK randomization must preserve contextual template selection (Blocked reason, ObserveStarted route-aware)
- WeChat adapter must NOT assume threading, cards, or streaming
- Feishu adapter must support text + threading via CLI
- All adapters must follow the per-channel type pattern (Option C)
- Unit tests for every fix and adapter

### Must NOT Have (Guardrails)
- NO refactor of SlackAdapter to implement `IMSurfaceAdapter` (separate scope)
- NO direct WeChat/Feishu HTTP API calls — use OpenClaw CLI only
- NO streaming, card, or interactive action support for WeChat or Feishu in this phase
- NO changes to `IM_SESSION_ORIGINS` set
- NO changes to ACK timing tiers or dedupe logic
- NO new npm dependencies

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** - ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (pnpm test)
- **Automated tests**: YES (tests-after)
- **Framework**: pnpm test

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Unit tests**: pnpm test with mock `runCommand`
- **Integration**: Deploy to local gateway, verify plugin load

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 0 (Validate — blocks Wave 2):
└── Task 0: Validate OpenClaw CLI channel support for wechat/feishu [quick]

Wave 1 (Bug fixes — start immediately, independent):
├── Task 1: Fix ACK template randomization [quick]
└── Task 2: Fix first-ACK threading for fresh DMs [quick]

Wave 2 (Adapters — after Wave 0 + Wave 1):
├── Task 3: WeChat adapter [quick]
├── Task 4: Feishu adapter [quick]
├── Task 5: Update normalizeChannelUserId + capability matrix [quick]

Wave 3 (Integration — after Wave 2):
├── Task 6: Adapter registry wiring + ack-guard routing [unspecified-high]
└── Task 7: Deploy + verify [unspecified-high]

Wave FINAL (After ALL tasks):
├── F1: Plan compliance audit (oracle)
├── F2: Code quality review (unspecified-high)
├── F3: Real QA — run all test scenarios (unspecified-high)
└── F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay

Critical Path: Task 0 → Task 3/4 → Task 6 → Task 7 → F1-F4
Parallel Speedup: Wave 1 parallel with Wave 0; Tasks 3/4/5 parallel in Wave 2
Max Concurrent: 3 (Wave 2)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| 0 | - | 3, 4 | 0 |
| 1 | - | 6 | 1 |
| 2 | - | 6 | 1 |
| 3 | 0 | 6 | 2 |
| 4 | 0 | 6 | 2 |
| 5 | - | 6 | 2 |
| 6 | 1, 2, 3, 4, 5 | 7 | 3 |
| 7 | 6 | F1-F4 | 3 |

### Agent Dispatch Summary

- **Wave 0**: 1 task — T0 → `quick`
- **Wave 1**: 2 tasks — T1, T2 → `quick`
- **Wave 2**: 3 tasks — T3, T4, T5 → `quick`
- **Wave 3**: 2 tasks — T6 → `unspecified-high`, T7 → `unspecified-high`
- **FINAL**: 4 tasks — F1 → `oracle`, F2-F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [x] 0. **Validate OpenClaw CLI channel support for wechat/feishu**

  **What to do**:
  - Run `openclaw message send --channel wechat --target test --message "test" --json` and check response. Does it error with "unsupported channel" or does it attempt delivery?
  - Run `openclaw message send --channel feishu --target test --message "test" --json` same way.
  - Run `openclaw message send --help` and check if `--channel` docs list supported values.
  - Check if `@tencent-weixin/openclaw-weixin` plugin is installed in `~/.openclaw/extensions/` or `~/.openclaw/plugins/`.
  - Record findings: which channels are supported, what CLI flags work, what auth/config is needed.

  **Must NOT do**:
  - Do not attempt actual message delivery to real users
  - Do not install new plugins or dependencies

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 0
  - **Blocks**: Tasks 3, 4
  - **Blocked By**: None

  **References**:
  **Pattern References**:
  - `extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts:98` — How Slack adapter constructs CLI args: `["message", "send", "--channel", "slack", "--target", target, "--json"]`
  - `extensions/octoclaw-runtime/src/resolve/env.ts` — `runCommand()` utility for executing `openclaw` CLI

  **External References**:
  - `~/.openclaw/openclaw.json` — Check `channels` section for wechat/feishu config

  **Acceptance Criteria**:
  - [ ] CLI `--channel wechat` either works or returns a clear error message documented
  - [ ] CLI `--channel feishu` either works or returns a clear error message documented
  - [ ] Findings recorded in task output for Tasks 3 and 4 to consume

  **QA Scenarios**:
  ```
  Scenario: Validate CLI channel support
    Tool: Bash
    Preconditions: openclaw gateway running
    Steps:
      1. Run `openclaw message send --channel wechat --target __test__ --message "probe" --json 2>&1 || true`
      2. Run `openclaw message send --channel feishu --target __test__ --message "probe" --json 2>&1 || true`
      3. Run `openclaw message send --help 2>&1 | head -50`
      4. Check `ls ~/.openclaw/extensions/ ~/.openclaw/plugins/ 2>/dev/null`
    Expected Result: Both commands return a response (success or structured error), not a hang. Help text shows --channel usage.
    Evidence: .sisyphus/evidence/task-0-cli-validation.txt
  ```

  **Commit**: NO (validation only, no code changes)

- [x] 1. **Fix ACK template randomization**

  **What to do**:
  - In `ack-templates.ts`, modify each `select*Template()` function to randomize WITHIN the contextual subset:
    - After contextual logic determines the subset (e.g., `entries[0]` for default, `entries[1]` for short form), instead of returning a single entry, collect ALL matching entries and pick one randomly.
    - Example for `selectReplySoftAckTemplate()`: instead of `return prefersShortForm ? entries[1] : entries[0]`, return a random entry from the full pool, OR if `prefersShortForm`, randomize among short-form entries only.
    - Example for `selectBlockedTemplate()`: if `blockedReason` exists, randomize among entries that contain `{reason}` placeholder; otherwise randomize among entries without `{reason}`.
  - Keep the `ackStageText()` function as-is (already random, used for direct paths).
  - Add unit test: call `templateMessageForStage(AckStage.PreRouteSoftAck, defaultInputs)` 10 times, assert at least 2 distinct results.
  - Add regression test: call `templateMessageForStage(AckStage.Blocked, { blockedReason: "timeout" })` 10 times, assert all results contain "timeout" (via `{reason}` interpolation).
  - Add regression test: call `templateMessageForStage(AckStage.ObserveStarted, { route: "probe_logs" })` 10 times, assert results are probe-appropriate entries.

  **Must NOT do**:
  - Do NOT replace `selectAckTemplate()` with `ackStageText()` — loses contextual logic
  - Do NOT change the template pool entries themselves
  - Do NOT change timing tiers, dedupe, or burst logic
  - Do NOT add new AckStage values

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 2)
  - **Blocks**: Task 6
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `extensions/octoclaw-runtime/src/ack/ack-templates.ts:132-198` — All `select*Template()` functions. Each currently returns a single `AckTemplateEntry` based on deterministic conditions. Change to return random from matching subset.
  - `extensions/octoclaw-runtime/src/ack/ack-templates.ts:200-207` — `ackStageText()` function — the random selection pattern to replicate: `entries[Math.floor(Math.random() * entries.length)]`

  **API/Type References**:
  - `extensions/octoclaw-runtime/src/ack/ack-templates.ts:11-17` — `AckTemplateEntry` interface with `stage`, `text`, `direction`, `defaultAction`, `preferredChannels`
  - `extensions/octoclaw-runtime/src/ack/ack-templates.ts:19-28` — `TemplateSelectionInputs` — the inputs that drive contextual selection

  **Test References**:
  - Look for existing test files in `extensions/octoclaw-runtime/src/ack/__tests__/` or `*.test.ts` for assertion patterns

  **WHY Each Reference Matters**:
  - `select*Template()` functions (line 132-198) are THE code that needs to change — they're the deterministic selectors
  - `ackStageText()` (line 200-207) shows the random selection pattern to copy: `Math.floor(Math.random() * entries.length)`
  - `TemplateSelectionInputs` defines what contextual data is available for subset selection

  **Acceptance Criteria**:
  - [ ] `pnpm test extensions/octoclaw-runtime/src/ack/ack-templates.test.ts` → PASS
  - [ ] Test: 10 calls to `templateMessageForStage(AckStage.PreRouteSoftAck, {})` produce >= 2 distinct results
  - [ ] Test: `templateMessageForStage(AckStage.Blocked, { blockedReason: "timeout" })` always interpolates "timeout"
  - [ ] Test: `templateMessageForStage(AckStage.ObserveStarted, { route: "probe" })` returns probe-appropriate entry

  **QA Scenarios**:
  ```
  Scenario: ACK text randomizes across calls
    Tool: Bash (pnpm test)
    Preconditions: ack-templates.ts modified with randomization
    Steps:
      1. Run `pnpm test extensions/octoclaw-runtime/src/ack/ack-templates.test.ts`
      2. Verify test "randomizes PreRouteSoftAck" passes
      3. Verify test "randomizes ReplySoftAck" passes
    Expected Result: All tests pass, including randomization assertions
    Evidence: .sisyphus/evidence/task-1-random-test.txt

  Scenario: Contextual logic preserved for Blocked stage
    Tool: Bash (pnpm test)
    Preconditions: ack-templates.ts modified
    Steps:
      1. Run test that calls `templateMessageForStage(AckStage.Blocked, { blockedReason: "timeout" })` 10 times
      2. Assert every result contains "timeout"
    Expected Result: All 10 results contain the interpolated reason
    Evidence: .sisyphus/evidence/task-1-contextual-test.txt
  ```

  **Commit**: YES
  - Message: `fix(ack): randomize template selection within contextual subsets`
  - Files: `extensions/octoclaw-runtime/src/ack/ack-templates.ts`, `extensions/octoclaw-runtime/src/ack/ack-templates.test.ts`
  - Pre-commit: `pnpm test extensions/octoclaw-runtime/src/ack/ack-templates.test.ts`

- [x] 2. **Fix first-ACK threading for fresh DMs**

  **What to do**:
  - In `slack-adapter.ts`, modify `send()` method to handle the fresh-DM case:
    - Add a heuristic to detect "fresh DM" — when `replyToMessageId` is present but is the user's inbound message `ts` (not a bot-created thread `ts`), attempt `--reply-to` anyway. Slack API posting with `thread_ts=<user_message_ts>` in a DM should create a threaded reply to that message.
    - If `--reply-to` fails with an error indicating threading isn't available, fall back to sending without `--reply-to` (top-level DM message).
    - Alternative simpler fix: always try `--reply-to` when `shouldUseThread()` is true and `replyToMessageId` exists. If the CLI returns an error, retry without `--reply-to`. This handles both fresh DM (should work with user's `ts`) and edge cases.
  - The simpler approach: Slack DMs DO support threading (replying to specific messages). The `--reply-to <user_ts>` should work in DMs. The actual bug may be that `replyToMessageId` is empty for the first inbound message. Check `extension-entry.ts` line 272-274 — verify that `ctx.inboundMessage` actually has a `ts` field for the first DM message.
  - Add debug logging: when `OCTOCLAW_ACK_DEBUG=1`, log whether `replyToMessageId` was present and whether `--reply-to` was added to CLI args.
  - Add a defensive fallback in `attemptAckSend()` or `sendAckDirectDetailed()`: if adapter returns `sent: false` with threading-related error, retry without `replyToMessageId`.

  **Must NOT do**:
  - Do NOT change ACK timing or dedupe logic
  - Do NOT change `startAckGuard()` signature
  - Do NOT change `extension-entry.ts` lifecycle hooks

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 1)
  - **Blocks**: Task 6
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts:81-154` — `SlackAdapter.send()` method. Line 108: `if (params.replyToMessageId && this.shouldUseThread())` — the threading gate.
  - `extensions/octoclaw-runtime/src/extension-entry.ts:272-276` — Where `replyToMessageId` is extracted: `stringValue(inbound.ts || inbound.messageTs || inbound.messageId)`

  **API/Type References**:
  - `extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts:14-19` — `SlackDeliveryTarget` with optional `replyToMessageId`
  - `extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts:21-27` — `SlackSendResult` with `sent`, `delivered`, `error`

  **WHY Each Reference Matters**:
  - `slack-adapter.ts:108` is the exact line where `--reply-to` is added. Need to understand when `replyToMessageId` is empty vs present.
  - `extension-entry.ts:272-274` is where `replyToMessageId` originates — if `ctx.inboundMessage` has no `ts`, the value would be empty string, which is falsy, so `--reply-to` would be skipped entirely.
  - `SlackSendResult.error` will contain the error if `--reply-to` fails, enabling retry logic.

  **Acceptance Criteria**:
  - [ ] When `replyToMessageId` is present and `shouldUseThread()` is true, `--reply-to` is added to CLI args
  - [ ] When `replyToMessageId` is empty string, `--reply-to` is NOT added
  - [ ] If `--reply-to` fails, message is re-sent without `--reply-to`
  - [ ] Debug logging under `OCTOCLAW_ACK_DEBUG=1` shows threading decision

  **QA Scenarios**:
  ```
  Scenario: ACK threads when replyToMessageId is present
    Tool: Bash (pnpm test)
    Preconditions: slack-adapter.ts modified
    Steps:
      1. Test SlackAdapter.send() with replyToMessageId="1234567890.123456" and shouldUseThread=true
      2. Assert constructed args include "--reply-to" "1234567890.123456"
    Expected Result: --reply-to flag present in CLI args
    Evidence: .sisyphus/evidence/task-2-thread-test.txt

  Scenario: ACK skips threading when replyToMessageId is empty
    Tool: Bash (pnpm test)
    Steps:
      1. Test SlackAdapter.send() with replyToMessageId="" and shouldUseThread=true
      2. Assert constructed args do NOT include "--reply-to"
    Expected Result: --reply-to flag absent from CLI args
    Evidence: .sisyphus/evidence/task-2-no-thread-test.txt
  ```

  **Commit**: YES
  - Message: `fix(ack): handle first-ACK threading for fresh DMs with retry fallback`
  - Files: `extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts`
  - Pre-commit: `pnpm test`

- [ ] ~~3. **WeChat adapter**~~ DEFERRED — user decision to do later
  **Status**: DEFERRED. WeChat CLI not supported (Unknown channel). openclaw-weixin plugin API explored but adapter not implemented.

- [ ] ~~4. **Feishu adapter**~~ DEFERRED — user decision to do later
  **Status**: DEFERRED. Feishu CLI supported but adapter not implemented per user request.

  **What to do**:
  - Create `extensions/octoclaw-runtime/src/im/wechat/wechat-adapter.ts`:
    - `WeChatAdapter` class following `SlackAdapter` pattern but simplified
    - `config`: `WeChatAdapterConfig` with `replyToMode` (always "off" for WeChat since no threading)
    - `resolveTarget(sessionKey)`: parse session key to extract user ID (after `:wechat:` segment). WeChat user IDs are like `wxid_xxx` oropenid — do NOT uppercase.
    - `send()`: call `openclaw message send --channel wechat --target <userId> --message <text> --json`. NO `--reply-to`, NO `--thread-id` (WeChat doesn't support threading per `channelSupportsThreading()`).
    - `shouldUseThread()`: always returns `false`
    - `normalizeUserId()`: strip `user:` prefix if present, do NOT uppercase
    - `extractMessageTs()`: extract from inbound event — WeChat message IDs are typically numeric or XML-based
    - `isStreamingAvailable()`: always returns `false`
  - Create `extensions/octoclaw-runtime/src/im/wechat/index.ts`: barrel export
  - Create test file `extensions/octoclaw-runtime/src/im/wechat/wechat-adapter.test.ts`:
    - Test `resolveTarget()` with session key like `agent:main:wechat:default:direct:wxid_abc123`
    - Test `send()` constructs correct CLI args: `["message", "send", "--channel", "wechat", "--target", "wxid_abc123", "--json", "--message", "test"]`
    - Test `send()` does NOT add `--reply-to` even when `replyToMessageId` is provided
    - Test `shouldUseThread()` returns `false`
    - Test `normalizeUserId()` strips `user:` prefix and does NOT uppercase
    - Use mock `runCommand` that returns `{ code: 0, stdout: '{"ok":true,"ts":"123"}' }`

  **Must NOT do**:
  - Do NOT add threading support
  - Do NOT add card/rich message support
  - Do NOT add streaming support
  - Do NOT implement `IMSurfaceAdapter` interface
  - Do NOT make direct HTTP API calls to WeChat

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 4, 5)
  - **Blocks**: Task 6
  - **Blocked By**: Task 0 (validate CLI support)

  **References**:

  **Pattern References**:
  - `extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts` — Full file to follow as template. Copy structure, simplify for WeChat constraints.
  - `extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts:81-154` — `send()` method pattern: resolve target → build CLI args → runCommand → parse result
  - `extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts:62-68` — Constructor with config merging pattern

  **API/Type References**:
  - `packages/octoclaw-runtime-core/src/im/adapter.ts:2` — `IMChannel` type includes `"wechat"`
  - `packages/octoclaw-runtime-core/src/im/adapter.ts:100-102` — `channelSupportsThreading()` returns `false` for wechat
  - `packages/octoclaw-runtime-core/src/im/adapter.ts:91-97` — `normalizeChannelUserId()` — wechat case needs adding (identity transform, no uppercasing)

  **WHY Each Reference Matters**:
  - `slack-adapter.ts` is the exact template to copy. Same structure, same `runCommand` pattern, same error handling.
  - `channelSupportsThreading("wechat") === false` means `shouldUseThread()` must always return false — no `--reply-to` ever.
  - `normalizeChannelUserId()` needs a wechat case for consistency.

  **Acceptance Criteria**:
  - [ ] `WeChatAdapter` class created with `send()`, `resolveTarget()`, `shouldUseThread()`, `normalizeUserId()`
  - [ ] `shouldUseThread()` always returns `false`
  - [ ] `send()` constructs `openclaw message send --channel wechat --target <id> --message <text> --json`
  - [ ] `send()` never adds `--reply-to` or `--thread-id`
  - [ ] `normalizeUserId()` does NOT uppercase, strips `user:` prefix
  - [ ] `pnpm test extensions/octoclaw-runtime/src/im/wechat/wechat-adapter.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: WeChat adapter sends text message via CLI
    Tool: Bash (pnpm test)
    Preconditions: wechat-adapter.ts created
    Steps:
      1. Instantiate WeChatAdapter with default config
      2. Call send({ sessionKey: "agent:main:wechat:default:direct:wxid_test", message: "收到" })
      3. Assert runCommand called with args: ["message", "send", "--channel", "wechat", "--target", "wxid_test", "--json", "--message", "收到"]
      4. Assert NO "--reply-to" in args
      5. Assert NO "--thread-id" in args
    Expected Result: Correct CLI args constructed, no threading flags
    Evidence: .sisyphus/evidence/task-3-wechat-send.txt

  Scenario: WeChat adapter resolves target from session key
    Tool: Bash (pnpm test)
    Steps:
      1. Call resolveTarget("agent:main:wechat:default:direct:wxid_abc123")
      2. Assert target === "wxid_abc123"
      3. Call normalizeUserId("user:wxid_xyz")
      4. Assert result === "wxid_xyz" (not uppercased)
    Expected Result: Correct ID parsing and normalization
    Evidence: .sisyphus/evidence/task-3-wechat-resolve.txt
  ```

  **Commit**: YES
  - Message: `feat(im): add WeChat adapter via OpenClaw CLI`
  - Files: `extensions/octoclaw-runtime/src/im/wechat/wechat-adapter.ts`, `extensions/octoclaw-runtime/src/im/wechat/index.ts`, `extensions/octoclaw-runtime/src/im/wechat/wechat-adapter.test.ts`
  - Pre-commit: `pnpm test extensions/octoclaw-runtime/src/im/wechat/wechat-adapter.test.ts`

- [ ] 4. **Feishu adapter**

  **What to do**:
  - Create `extensions/octoclaw-runtime/src/im/feishu/feishu-adapter.ts`:
    - `FeishuAdapter` class following `SlackAdapter` pattern
    - `config`: `FeishuAdapterConfig` with `replyToMode` ("off" | "first" | "all"), `streamingMode`, `nativeTransport`
    - `resolveTarget(sessionKey)`: parse session key to extract user ID (after `:feishu:` segment). Feishu user IDs are like `ou_xxx` or `oc_xxx` — do NOT uppercase.
    - `send()`: call `openclaw message send --channel feishu --target <userId> --message <text> --json`. Add `--reply-to <messageId>` when `replyToMessageId` is present and `shouldUseThread()` is true.
    - `shouldUseThread()`: returns `config.replyToMode !== "off"`
    - `normalizeUserId()`: strip `user:` prefix if present, do NOT uppercase
    - `extractMessageTs()`: extract from inbound event — Feishu message IDs are `om_xxx` format
    - `isStreamingAvailable()`: returns `config.streamingMode !== "off" && config.nativeTransport`
  - Create `extensions/octoclaw-runtime/src/im/feishu/index.ts`: barrel export
  - Create test file `extensions/octoclaw-runtime/src/im/feishu/feishu-adapter.test.ts`:
    - Test `resolveTarget()` with session key like `agent:main:feishu:default:direct:ou_abc123`
    - Test `send()` constructs correct CLI args with `--reply-to` when configured
    - Test `send()` without `--reply-to` when `replyToMode` is "off"
    - Test `shouldUseThread()` returns true when `replyToMode !== "off"`
    - Test `normalizeUserId()` strips `user:` prefix, does NOT uppercase
    - Use mock `runCommand` that returns `{ code: 0, stdout: '{"ok":true,"message_id":"om_123"}' }`

  **Must NOT do**:
  - Do NOT add card/interactive message support (L1 scope: text + threading only)
  - Do NOT add streaming card support
  - Do NOT implement `IMSurfaceAdapter` interface
  - Do NOT make direct HTTP API calls to Feishu
  - If Task 0 found that `--channel feishu` is NOT supported, create a minimal stub adapter that returns `{ sent: false, delivered: false, error: "feishu_cli_unsupported" }` from send(). Still register it in Task 6 so `getAdapterForSession()` returns non-null, but ACK delivery will gracefully degrade (error logged, no crash).

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3, 5)
  - **Blocks**: Task 6
  - **Blocked By**: Task 0 (validate CLI support)

  **References**:

  **Pattern References**:
  - `extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts` — Full file to follow as template. Very similar structure — both support threading and reply-to.
  - `extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts:81-154` — `send()` method — copy pattern, change `--channel slack` to `--channel feishu`
  - `extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts:156-158` — `shouldUseThread()` — same pattern for Feishu

  **API/Type References**:
  - `packages/octoclaw-runtime-core/src/im/adapter.ts:2` — `IMChannel` includes `"feishu"`
  - `packages/octoclaw-runtime-core/src/im/adapter.ts:100-102` — `channelSupportsThreading()` returns `true` for feishu (not wechat)
  - `docs/archive/design-notes/octoclaw-display-layer-productization-plan-v1-2026-03-29.md:211` — Feishu row in capability matrix: "Yes (topic/thread)", "Card-driven", "Interactive cards + streaming cards"

  **WHY Each Reference Matters**:
  - `slack-adapter.ts` is the template — Feishu adapter is nearly identical, just different channel name and no uppercasing.
  - Capability matrix confirms Feishu supports threading → `shouldUseThread()` can return true.
  - Feishu message IDs use `om_xxx` format → `extractMessageTs()` needs to handle this.

  **Acceptance Criteria**:
  - [ ] `FeishuAdapter` class created with `send()`, `resolveTarget()`, `shouldUseThread()`, `normalizeUserId()`
  - [ ] `send()` constructs `openclaw message send --channel feishu --target <id> --message <text> --json`
  - [ ] `send()` adds `--reply-to` when `replyToMessageId` present and `shouldUseThread()` true
  - [ ] `shouldUseThread()` returns true when `replyToMode !== "off"`
  - [ ] `normalizeUserId()` does NOT uppercase, strips `user:` prefix
  - [ ] `pnpm test extensions/octoclaw-runtime/src/im/feishu/feishu-adapter.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Feishu adapter sends threaded reply
    Tool: Bash (pnpm test)
    Preconditions: feishu-adapter.ts created, replyToMode="first"
    Steps:
      1. Instantiate FeishuAdapter({ replyToMode: "first" })
      2. Call send({ sessionKey: "agent:main:feishu:default:direct:ou_test", message: "收到", replyToMessageId: "om_abc123" })
      3. Assert args include "--reply-to" "om_abc123"
    Expected Result: --reply-to flag present
    Evidence: .sisyphus/evidence/task-4-feishu-thread.txt

  Scenario: Feishu adapter sends without threading when replyToMode=off
    Tool: Bash (pnpm test)
    Steps:
      1. Instantiate FeishuAdapter({ replyToMode: "off" })
      2. Call send({ sessionKey: "agent:main:feishu:default:direct:ou_test", message: "收到", replyToMessageId: "om_abc123" })
      3. Assert args do NOT include "--reply-to"
    Expected Result: --reply-to flag absent
    Evidence: .sisyphus/evidence/task-4-feishu-no-thread.txt
  ```

  **Commit**: YES
  - Message: `feat(im): add Feishu adapter via OpenClaw CLI`
  - Files: `extensions/octoclaw-runtime/src/im/feishu/feishu-adapter.ts`, `extensions/octoclaw-runtime/src/im/feishu/index.ts`, `extensions/octoclaw-runtime/src/im/feishu/feishu-adapter.test.ts`
  - Pre-commit: `pnpm test extensions/octoclaw-runtime/src/im/feishu/feishu-adapter.test.ts`

- [x] 5. **Update normalizeChannelUserId + capability constants**

  **What to do**:
  - In `packages/octoclaw-runtime-core/src/im/adapter.ts`:
    - Update `normalizeChannelUserId()` to handle `wechat` and `feishu` explicitly:
      - `"wechat"`: return as-is (no uppercasing, no prefix stripping at this layer)
      - `"feishu"`: return as-is (Feishu IDs are case-insensitive but convention is lowercase `ou_xxx`)
    - Add `WECHAT_CAPABILITIES` constant (similar to `SLACK_CAPABILITIES`):
      ```typescript
      export const WECHAT_CAPABILITIES: IMCapabilityMatrix = {
        canUpdateMessage: false,
        canStreamNative: false,
        canReplyInThread: false,
        canTypingIndicator: false,
        messageIdFormat: "message_id",
        userIdCaseSensitive: false,
        maxMessageLength: 2048,
      };
      ```
    - Add `FEISHU_CAPABILITIES` constant:
      ```typescript
      export const FEISHU_CAPABILITIES: IMCapabilityMatrix = {
        canUpdateMessage: false,  // L1 scope: no card editing yet
        canStreamNative: false,   // L1 scope: no streaming yet
        canReplyInThread: true,
        canTypingIndicator: false,
        messageIdFormat: "message_id", // om_xxx format
        userIdCaseSensitive: false,
        maxMessageLength: 40000,
      };
      ```
    - Export both constants

  **Must NOT do**:
  - Do NOT change `channelSupportsThreading()` — already correct
  - Do NOT change `IMChannel` union — already includes both
  - Do NOT change `parseIMChannelFromSessionKey()` — already handles both

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3, 4)
  - **Blocks**: Task 6
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `packages/octoclaw-runtime-core/src/im/adapter.ts:91-97` — `normalizeChannelUserId()` — add `wechat` and `feishu` cases
  - `extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts:41-49` — `SLACK_CAPABILITIES` pattern to follow for new constants

  **API/Type References**:
  - `packages/octoclaw-runtime-core/src/im/adapter.ts:5-20` — `IMCapabilityMatrix` interface — the shape to implement

  **WHY Each Reference Matters**:
  - `normalizeChannelUserId()` currently only handles `slack` — needs explicit wechat/feishu cases
  - `SLACK_CAPABILITIES` shows the pattern for capability constants

  **Acceptance Criteria**:
  - [ ] `normalizeChannelUserId("wxid_abc", "wechat")` returns `"wxid_abc"`
  - [ ] `normalizeChannelUserId("ou_abc", "feishu")` returns `"ou_abc"`
  - [ ] `WECHAT_CAPABILITIES` exported and has `canReplyInThread: false`
  - [ ] `FEISHU_CAPABILITIES` exported and has `canReplyInThread: true`
  - [ ] Both constants follow `IMCapabilityMatrix` interface

  **QA Scenarios**:
  ```
  Scenario: normalizeChannelUserId handles all channels
    Tool: Bash (pnpm test)
    Steps:
      1. Test normalizeChannelUserId("wxid_abc", "wechat") === "wxid_abc"
      2. Test normalizeChannelUserId("ou_abc", "feishu") === "ou_abc"
      3. Test normalizeChannelUserId("U123", "slack") === "U123" (existing, regression)
    Expected Result: All assertions pass
    Evidence: .sisyphus/evidence/task-5-normalize.txt
  ```

  **Commit**: YES
  - Message: `feat(im): add WeChat/Feishu capability constants and normalize support`
  - Files: `packages/octoclaw-runtime-core/src/im/adapter.ts`
  - Pre-commit: `pnpm test`

- [ ] ~~6. **Adapter registry wiring + ack-guard routing**~~ DEFERRED — depends on T3/T4 which are deferred

  **What to do**:
  - In `extensions/octoclaw-runtime/src/im/index.ts`:
    - Import `WeChatAdapter` from `./wechat/index.js`
    - Import `FeishuAdapter` from `./feishu/index.js`
    - Change adapter map type from `Map<string, SlackAdapter>` to `Map<string, SlackAdapter | WeChatAdapter | FeishuAdapter>` (or use a common duck-typed interface)
    - Add `readWeChatConfig()`: read from `~/.openclaw/openclaw.json` → `channels.wechat` (if exists)
    - Add `readFeishuConfig()`: read from `~/.openclaw/openclaw.json` → `channels.feishu.replyToMode`
    - Update `getAdapterForSession()`:
      - If session key contains `:wechat:`, create/return `WeChatAdapter` (always with `replyToMode: "off"`)
      - If session key contains `:feishu:`, create/return `FeishuAdapter` (with config from openclaw.json)
      - Keep existing `:slack:` logic
    - Change return type from `SlackAdapter | null` to a union type or `{ send: (...) => Promise<...> } | null`
  - In `extensions/octoclaw-runtime/src/ack/ack-guard.ts`:
    - Find `sendAckDirectDetailed()` where it calls `adapter.send()`
    - Verify the call site works with the union return type (duck-typed send)
    - If `getAdapterForSession()` return type changes, update the call site type accordingly
    - Ensure `replyToMessageId` is passed through for feishu (same as slack)
    - Ensure `replyToMessageId` is passed through for wechat (adapter will ignore it internally)

  **Must NOT do**:
  - Do NOT refactor SlackAdapter to implement IMSurfaceAdapter
  - Do NOT change ACK timing, dedupe, or burst logic
  - Do NOT change extension-entry.ts lifecycle hooks

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (sequential after Wave 2)
  - **Blocks**: Task 7
  - **Blocked By**: Tasks 1, 2, 3, 4, 5

  **References**:

  **Pattern References**:
  - `extensions/octoclaw-runtime/src/im/index.ts` — Full file — the registry to modify. Currently Slack-only.
  - `extensions/octoclaw-runtime/src/im/index.ts:9-21` — `readSlackReplyToMode()` — pattern to copy for `readFeishuConfig()`

  **API/Type References**:
  - `extensions/octoclaw-runtime/src/im/index.ts:27-36` — `getAdapterForSession()` — add wechat/feishu branches
  - `extensions/octoclaw-runtime/src/ack/ack-guard.ts` — Search for `getAdapterForSession` to find all call sites that need type update

  **WHY Each Reference Matters**:
  - `im/index.ts` is THE registry — all adapter routing goes through here
  - `ack-guard.ts` is THE consumer — need to verify send() call site still works with union type
  - `readSlackReplyToMode()` pattern shows how to read config from `~/.openclaw/openclaw.json`

  **Acceptance Criteria**:
  - [ ] `getAdapterForSession("agent:main:wechat:default:direct:wxid_test")` returns WeChatAdapter
  - [ ] `getAdapterForSession("agent:main:feishu:default:direct:ou_test")` returns FeishuAdapter
  - [ ] `getAdapterForSession("agent:main:slack:default:direct:U123")` returns SlackAdapter (regression)
  - [ ] `getAdapterForSession("agent:main:unknown:default:direct:test")` returns null
  - [ ] ack-guard.ts `sendAckDirectDetailed()` compiles without type errors
  - [ ] `pnpm test` passes

  **QA Scenarios**:
  ```
  Scenario: Registry routes to correct adapter by channel
    Tool: Bash (pnpm test)
    Steps:
      1. Call getAdapterForSession("agent:main:slack:default:direct:U123")
      2. Assert result is SlackAdapter with channel="slack"
      3. Call getAdapterForSession("agent:main:wechat:default:direct:wxid_abc")
      4. Assert result is WeChatAdapter
      5. Call getAdapterForSession("agent:main:feishu:default:direct:ou_abc")
      6. Assert result is FeishuAdapter
      7. Call getAdapterForSession("agent:main:unknown:test")
      8. Assert result is null
    Expected Result: Correct adapter type returned per channel
    Evidence: .sisyphus/evidence/task-6-registry.txt

  Scenario: ACK delivery routes through correct adapter
    Tool: Bash (pnpm test)
    Steps:
      1. Mock runCommand to capture args
      2. Trigger ACK send for wechat session key
      3. Assert captured args include "--channel" "wechat"
      4. Trigger ACK send for feishu session key
      5. Assert captured args include "--channel" "feishu"
    Expected Result: ACK routed through correct channel adapter
    Evidence: .sisyphus/evidence/task-6-ack-routing.txt
  ```

  **Commit**: YES
  - Message: `feat(im): wire WeChat/Feishu adapters into registry and ACK routing`
  - Files: `extensions/octoclaw-runtime/src/im/index.ts`, `extensions/octoclaw-runtime/src/ack/ack-guard.ts`
  - Pre-commit: `pnpm test`

- [x] 7. **Build + Deploy + Verify**

  **What to do**:
  - Build all packages: `pnpm build`
  - Run full test suite: `pnpm test` (runs `vitest run`)
  - Deploy using the install tool: first build tools/install via `pnpm -r --stream run build`, then run `node tools/install/dist/index.js deploy`
  - Verify gateway loads: `openclaw status --deep` — check that `octoclaw-runtime` plugin loads without errors
  - Verify all 3 adapters registered: check gateway logs for adapter initialization
  - If any adapter fails to load due to CLI channel support missing, log the finding but don't fail the deploy (the adapter just won't be used)

  **Must NOT do**:
  - Do NOT push to remote (user decides when to push)
  - Do NOT modify any source files

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (sequential after Task 6)
  - **Blocks**: F1-F4
  - **Blocked By**: Task 6

  **References**:

  **Pattern References**:
  - `tools/install/src/index.ts` — Deploy tool (fixed in previous session to handle extension packages)
  - Previous deploy workflow: build → deploy → verify gateway load

  **WHY Each Reference Matters**:
  - Deploy tool was recently fixed — need to verify it still works with new adapter files
  - Gateway verification confirms end-to-end integration

  **Acceptance Criteria**:
  - [ ] `pnpm test` passes with 0 failures
  - [ ] `pnpm build` succeeds with 0 errors
  - [ ] `node tools/install/dist/index.js deploy` succeeds (exit code 0)
  - [ ] `openclaw status --deep` shows `octoclaw-runtime` loaded
  - [ ] No new errors in gateway log

  **QA Scenarios**:
  ```
  Scenario: Full build and deploy
    Tool: Bash
    Preconditions: All source changes complete
    Steps:
      1. Run `pnpm build`
      2. Run `pnpm test`
      3. Run `node tools/install/dist/index.js deploy`
      4. Run `openclaw status --deep`
      5. Check gateway log for octoclaw-runtime load status
    Expected Result: Build green, tests green, deploy OK, runtime loaded
    Evidence: .sisyphus/evidence/task-7-deploy.txt
  ```

  **Commit**: YES
  - Message: `chore(deploy): rebuild and verify WeChat/Feishu adapter integration`
  - Files: (build artifacts only, no source changes)
  - Pre-commit: `pnpm test` (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `tsc --noEmit` + linter + `pnpm test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names.
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high`
  Run ALL unit tests. Verify ACK randomization with 10-call test. Verify adapter CLI arg construction. Deploy to gateway and verify plugin load.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built, nothing beyond spec. Check "Must NOT do" compliance. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- **Bug fixes**: `fix(ack): randomize template selection within contextual subsets` — ack-templates.ts
- **Bug fixes**: `fix(ack): handle first-ACK threading for fresh DMs` — slack-adapter.ts, ack-guard.ts
- **Adapters**: `feat(im): add WeChat adapter via OpenClaw CLI` — wechat-adapter.ts, wechat/index.ts
- **Adapters**: `feat(im): add Feishu adapter via OpenClaw CLI` — feishu-adapter.ts, feishu/index.ts
- **Registry**: `feat(im): wire WeChat/Feishu adapters into registry` — im/index.ts, adapter.ts, ack-guard.ts
- **Deploy**: `chore(deploy): rebuild and verify adapter integration` — tools/install

---

## Success Criteria

### Verification Commands
```bash
pnpm test                                   # Expected: all tests pass
openclaw status --deep                      # Expected: 6+ plugins loaded, octoclaw-runtime OK
```

### Final Checklist
- [ ] ACK text randomizes (10 calls → >= 2 distinct results)
- [ ] ACK contextual logic preserved (Blocked with reason interpolates `{reason}`)
- [ ] First ACK in fresh DM sends without error
- [ ] WeChat adapter registered and returns non-null
- [ ] Feishu adapter registered and returns non-null
- [ ] All "Must NOT Have" absent
- [ ] All tests pass
