# Design: Runtime Extension Entry Slim 0.5.x

## 1. Current state

```text
extension-entry.ts (5234 lines)
├─ imports (~100 lines)
├─ delegation system-context constants (~30 lines)
├─ resolveSlimMainContextEnabled()
├─ LATENCY_ACK_DELAY_MS, pending timer Maps, key helpers (~80 lines)
├─ footerMode helpers (~50 lines)
├─ various hook impls (~4900 lines)
│   ├─ before_prompt_build
│   ├─ before_model_resolve
│   ├─ before_tool_call
│   ├─ after_tool_call
│   └─ agent_end
├─ speculative preload logic (~400 lines, inside before_tool_call)
└─ register(pi)
```

## 2. Target state

```text
extension-entry.ts (<1000 lines)
├─ imports
├─ register(pi) — wires hook factories to plugin interface
└─ small inline helpers that genuinely belong here (none expected)

ack/ack-scheduler.ts (~250 lines)
├─ LATENCY_ACK_DELAY_MS etc.
├─ pending timer Maps (module-scoped)
├─ AckScheduler: schedule/cancel methods
└─ resetForTests()

im/footer-mode.ts (~80 lines)
├─ FooterMode enum
├─ resolveFooterMode(env, config)
└─ relevant env parsing

delegate/system-context.ts (~60 lines)
├─ OCTOCLAW_DELEGATION_SYSTEM_CONTEXT
├─ OCTOCLAW_DELEGATION_SLIM_SYSTEM_CONTEXT
└─ resolveSlimMainContextEnabled()

delegate/speculative-preload-handler.ts (~400 lines)
├─ handleSpeculativePreloadBeforeToolCall(...)
└─ related helpers

hooks/before-prompt-build.ts (~400 lines)
hooks/before-tool-call.ts (~400 lines)
hooks/before-model-resolve.ts (~200 lines)
hooks/after-tool-call.ts (~200 lines)
hooks/agent-end.ts (~200 lines)
```

All under 400 lines. `extension-entry.ts` is now a thin composition root.

## 3. Slice contracts

### Slice A — ACK scheduler

New file: `ack/ack-scheduler.ts`

```ts
import { sendIMMessage } from "../im/send.js";
import { ... } from "./ack-guard.js";

const LATENCY_ACK_DELAY_MS = 3500;

const pendingLatencyAckTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingNeutralInboundAckTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingNeutralInboundAckTextFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingBudgetedMainTimers = new Map<string, ReturnType<typeof setTimeout>>();

function configuredNeutralAckDelayMs(hookName: string, preferReaction: boolean): number { ... }
function configuredNeutralAckTextFallbackDelayMs(): number { ... }
function neutralAckTimerKey(sessionKey: string, replyToMessageId: string): string { ... }
function neutralAckTextFallbackTimerKey(sessionKey: string, replyToMessageId: string): string { ... }

export const AckScheduler = {
  LATENCY_ACK_DELAY_MS,
  scheduleLatencyAck(...),
  cancelLatencyAck(stateKey),
  scheduleNeutralInboundAck(...),
  cancelNeutralInboundAck(sessionKey, replyToMessageId),
  scheduleNeutralInboundTextFallback(...),
  cancelNeutralInboundTextFallback(sessionKey, replyToMessageId),
  scheduleBudgetedMain(...),
  cancelBudgetedMain(stateKey),
  resetForTests(): void,  // clears every Map
};
```

`extension-entry.ts` imports and uses `AckScheduler.schedule*` / `cancel*`.

Acceptance: `pnpm vitest run extensions/octoclaw-runtime/src/ack/` green.

### Slice B — Footer mode

New file: `im/footer-mode.ts`

```ts
export type FooterMode = "off" | "compact" | "debug";

export function resolveFooterMode(pluginConfig?: UnknownRecord): FooterMode {
  // existing env + config parse logic
}
```

Consumer: `extension-entry.ts` calls `resolveFooterMode(...)` once per hook where it used to inline the logic.

### Slice C — Delegation system context

New file: `delegate/system-context.ts`

Exports both constants and `resolveSlimMainContextEnabled`. Read from `extension-entry.ts` same as today.

### Slice D — Speculative preload handler

New file: `delegate/speculative-preload-handler.ts`

Signature:

```ts
export function handleSpeculativePreloadBeforeToolCall(input: {
  pi: PluginInterface;
  ctx: HookCtx;
  toolName: string;
  toolParams: UnknownRecord;
  stateKey: string;
  sessionKey: string;
  decision: UnknownRecord;
}): { handled: boolean; response?: HookResponse };
```

Returns `{ handled: true, response }` when the preload path intercepts the call. Returns `{ handled: false }` when the caller should proceed with the normal branch.

Existing ~400 lines of preload code inside `before_tool_call` become a single delegation to `handleSpeculativePreloadBeforeToolCall()`.

### Slice E — Per-hook files

New files, each exports a factory:

```ts
// hooks/before-prompt-build.ts
export function makeBeforePromptBuildHook(pi: PluginInterface): HookHandler {
  return async (ctx) => { /* old before_prompt_build body */ };
}
```

`extension-entry.ts` shrinks to:

```ts
import { makeBeforePromptBuildHook } from "./hooks/before-prompt-build.js";
// ... other imports

export function register(pi: PluginInterface): void {
  pi.registerHook("before_prompt_build", makeBeforePromptBuildHook(pi));
  pi.registerHook("before_tool_call", makeBeforeToolCallHook(pi));
  pi.registerHook("before_model_resolve", makeBeforeModelResolveHook(pi));
  pi.registerHook("after_tool_call", makeAfterToolCallHook(pi));
  pi.registerHook("agent_end", makeAgentEndHook(pi));
}

// plus small inline helpers if genuinely needed here
```

Shared helpers used by multiple hooks stay in `extension-entry-helpers.ts` or `extension-entry-shared.ts` (already exist).

## 4. Non-refactor items

Out of scope for this change, tracked for later:

- `resolve/policy-resolver.ts` (1868 lines) — W-5 territory
- `tools/registration.ts` (3015 lines) — separate slim
- `conversation-grounding.ts` (1087 lines) — not in current tail
- `ack-guard.ts` (1318 lines) — evaluate after Slice A lands

## 5. Testing strategy

After every slice:

1. `pnpm check` — typecheck must pass with no new errors.
2. `pnpm test` — must match the current baseline (6 pre-existing failures allowed).
3. Inspect `rg "from.*extension-entry"` — must not increase.
4. Slack smoke: one delegated turn, one reply turn.

Before every slice:

1. Snapshot `pnpm test 2>&1 | tail -30` output for the baseline.
2. Ensure slice diff touches only moved lines + minimal edits.

## 6. Risk mitigations

- **Test state leakage**: each moved Map paired with `resetForTests()` and explicit call in `beforeEach` where relevant.
- **Timer leaks**: `AckScheduler.resetForTests()` clears every Map synchronously.
- **Circular deps**: `pnpm check` catches immediately. If hit, extract a type-only file in `ack/types.ts`.
- **Merge conflicts**: because there's an active in-progress change (gate convergence WP-E/F), coordinate slice ordering with that change owner.

## 7. Rollout order

```
1. Slice A (ACK scheduler)            — lowest risk, isolated state
2. Slice B (footer mode)              — tiny, pure functions
3. Slice C (system context)           — tiny, constants only
4. Slice D (speculative preload)      — larger; verify Slack preload acceptance
5. Slice E (per-hook files)           — final slim
```

Each slice = one PR. No skip ahead. If Slice A reveals design issues, halt and redesign before Slice B.

## 8. Hard invariants

- `pnpm check` passes after each slice.
- Test failure count does not increase.
- No change to `openclaw.plugin.json` or public exported types.
- `extension-entry.ts` must still export `register` with an identical signature.
- No ACK timing drift observed in integration tests.
