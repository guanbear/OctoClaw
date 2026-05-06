# OpenClaw Prep Performance Upstream Design

Date: 2026-05-06

Status: upstream-facing design draft

Related OctoClaw context:

- `docs/octoclaw-dispatch-latency-preload-design-2026-05-03.md`
- `openspec/changes/planner-preload-0.5.1/`

## 1. Problem Statement

OctoClaw 0.5.0/0.5.1 live Slack evidence shows that warm child sessions are not enough to fix perceived latency. Even simple main-agent replies can spend tens of seconds before model output begins. The repeated cost appears to sit in OpenClaw embedded-run preparation rather than only in child bootstrap.

This design proposes an upstream-friendly sequence:

1. perf trace benchmark;
2. tool schema cache;
3. system prompt lazy/cache.

The order matters. Trace comes first so cache work is driven by measured bottlenecks rather than guesswork. Tool schema cache comes second because it can reduce repeated preparation work without changing prompt semantics. System prompt lazy/cache comes last because it can produce large gains but has the highest behavior risk.

## 2. Goals

- Reduce main-agent reply prep time and delegate child prep time without changing routing semantics.
- Produce benchmark evidence that separates gateway, hook, memory, tool bundle, prompt, model, and delivery latency.
- Make cache keys explicit and reviewable so stale tool or prompt state cannot leak across sessions.
- Keep upstream PRs small enough to review independently.
- Provide feature flags and kill switches for every behavior-affecting cache.

## 3. Non-Goals

- Do not change model selection, judge decisions, or delegate policy.
- Do not introduce persistent worker pools as part of this proposal.
- Do not cache user content, tool results, approvals, or permission decisions.
- Do not make prompt fragments disappear based on keyword matching.
- Do not require OctoClaw-specific code in OpenClaw core.

## 4. Phase 1: Perf Trace Benchmark

### 4.1 Phase 1A: OctoClaw Plugin-Layer Coarse Benchmark

Before changing OpenClaw core, OctoClaw can collect useful coarse timing from existing hook boundaries.

Observed hook sequence:

```text
message received
  -> startAckGuard / inbound observed          T0
  -> before_model_resolve
  -> OpenClaw bundle-tools + system-prompt     not separately visible to plugin
  -> before_prompt_build                       T1
  -> OpenClaw stream setup                     not separately visible to plugin
  -> llm_input                                 T2
  -> llm_output                                T3
  -> agent_end                                 T4
```

The plugin can compute:

| Metric | Formula | Meaning |
| --- | --- | --- |
| `prePromptBuildMs` | `T1 - T0` | coarse `bundle-tools + system-prompt + earlier hooks` |
| `postPromptPreLlmMs` | `T2 - T1` | coarse stream setup / model request preparation |
| `llmMs` | `T3 - T2` | model inference time |
| `agentEndDurationMs` | OpenClaw metadata | existing OpenClaw run duration window |
| `visibleElapsedMs` | `now - inboundObservedAt` | user-visible elapsed, for observation only |

This is not precise enough to prove whether bundle-tools or system prompt is the larger cost, but it is enough to show whether the bottleneck is before model input, inside model inference, or after model output.

Implementation in OctoClaw:

- record `inboundObservedAtMs` when the ACK guard observes the message;
- record `beforePromptBuildAtMs` in `before_prompt_build`;
- record `llmInputAtMs` / `llmOutputAtMs` when those hooks are available;
- write a replay event such as `openclaw_prep_coarse_timing`;
- extend the nightly classifier/report with p50/p95 for the fields above.

This gives immediate production evidence without waiting for an upstream OpenClaw release.

### 4.2 Phase 1B: Upstream Minimal Prep Metrics

After coarse timing confirms that prep is the bottleneck, submit a small upstream OpenClaw PR that exposes prep subspans through existing run metadata/hook payloads.

OpenClaw 2026.4.29 already has the right internal primitive:

- `src/agents/pi-embedded-runner/run/attempt-stage-timing.ts`
  - `createEmbeddedRunStageTracker()`
  - `EmbeddedRunStageSummary`
  - `formatEmbeddedRunStageSummary()`
- `src/agents/pi-embedded-runner/run/attempt.ts`
  - `prepStages.mark("bundle-tools")`
  - `prepStages.mark("system-prompt")`
  - `prepStages.mark("stream-setup")`
  - additional marks for workspace, skills, bootstrap context, session resource loader, and agent session creation.

Therefore the best upstream PR is not to add a parallel timestamp system. It should reuse the existing stage tracker and expose its `snapshot()` in the existing run metadata/hook surface.

Minimal type shape:

```ts
type EmbeddedRunStageTiming = {
  name: string;
  durationMs: number;
  elapsedMs: number;
};

type EmbeddedRunStageSummary = {
  totalMs: number;
  stages: EmbeddedRunStageTiming[];
};

type EmbeddedPiRunMeta = {
  // existing fields...
  prepStages?: EmbeddedRunStageSummary;
};

type PluginHookAgentEndEvent = {
  // existing fields...
  prepStages?: EmbeddedRunStageSummary;
};
```

If upstream prefers named convenience fields, they can be derived from `prepStages.stages` later:

```ts
const bundleToolsMs = findStage(prepStages, "bundle-tools")?.durationMs;
const systemPromptMs = findStage(prepStages, "system-prompt")?.durationMs;
const streamSetupMs = findStage(prepStages, "stream-setup")?.durationMs;
```

The upstream PR should not change behavior, cache anything, or add OctoClaw-specific logic. It should only expose timings that OpenClaw already records internally so downstream plugins and OpenClaw diagnostics can consume them.

Likely code touch points:

- `src/agents/pi-embedded-runner/types.ts`: add optional `prepStages` to `EmbeddedPiRunMeta`.
- `src/plugins/hook-types.ts`: add optional `prepStages` to `PluginHookAgentEndEvent`.
- `src/agents/pi-embedded-runner/run/attempt.ts`: pass `prepStages.snapshot()` into the final meta and `agent_end` event.
- focused tests around `agent_end` payload and `EmbeddedPiRunMeta` propagation.

### 4.3 Future Full Trace

A later full trace can add opt-in structured spans around the embedded run preparation path. The trace should use monotonic timestamps and produce compact JSONL records when enabled by an environment flag such as:

```text
OPENCLAW_PERF_TRACE=1
```

Recommended span names:

| Span | Meaning |
| --- | --- |
| `gateway.event.received` | channel/gateway event accepted |
| `agent.run.created` | OpenClaw agent run object created |
| `plugin.hooks.before_dispatch` | before-dispatch hooks |
| `plugin.hooks.before_model_resolve` | model resolve hooks |
| `plugin.hooks.before_prompt_build` | prompt build hooks |
| `memory.active.load` | active-memory or equivalent context source |
| `context.bootstrap.resolve` | bootstrap/context file resolution |
| `tools.inventory.resolve` | effective tool inventory selection |
| `tools.schema.build` | schema creation from tool definitions |
| `tools.schema.provider_normalize` | provider-specific schema normalization |
| `tools.schema.serialize` | final tool schema serialization |
| `prompt.system.build` | system prompt assembly |
| `prompt.dynamic.build` | per-turn dynamic context assembly |
| `model.request.start` | model request begins |
| `model.first_token` | first model output token observed |
| `model.final` | final model output observed |
| `delivery.message.sent` | visible delivery accepted by channel adapter |

Each event should include:

- `traceId`
- `runId` when available
- `sessionKey` or a hashed/shortened session identity
- `channelKind`
- `agentLane` (`main`, `subagent`, `nested`)
- `span`
- `startMs`
- `durationMs`
- `ok`
- optional `cacheStatus` (`hit`, `miss`, `bypass`, `disabled`)
- optional `size` fields such as tool count, schema bytes, prompt chars/tokens estimate

Do not log raw user text, secrets, full prompts, or full tool schemas.

### 4.4 Benchmark Harness

Add a local benchmark command or script that runs controlled fixtures and summarizes p50/p95:

| Fixture | Purpose |
| --- | --- |
| simple main reply | measures user-visible reply prep |
| one read-only tool turn | measures normal tool inventory/prompt path |
| native delegate spawn | measures parent plus child prep |
| continuation turn | measures whether warm transcript avoids context bootstrap |

Minimum report fields:

- total elapsed;
- embedded prep elapsed;
- tool inventory/schema elapsed;
- prompt build elapsed;
- model first-token elapsed;
- delivery elapsed;
- cache hit/miss counts.

The first benchmark version can be OctoClaw-only and replay-based. The upstream version should add the `prepMetrics` breakdown once OpenClaw exposes it.

### 4.5 Expected Benefit

Perf trace does not speed anything up directly. Its value is correctness: it tells whether the next optimization should target active-memory, tool schema, prompt construction, model first-token, or delivery. It also makes an upstream PR low risk because it is observability-first.

### 4.6 Acceptance

- Trace is disabled by default.
- Trace overhead when disabled is effectively one cheap branch per span site.
- Trace output redacts user content and secrets.
- OctoClaw coarse timing produces p50/p95 for `prePromptBuildMs`, `postPromptPreLlmMs`, and `llmMs`.
- Upstream prep metrics split `bundleToolsMs`, `systemPromptMs`, and `streamSetupMs` without changing run behavior.
- Benchmark produces comparable p50/p95 summaries before and after cache work.

## 5. Phase 2: Tool Schema Cache

### 5.1 What To Cache

Cache the provider-ready tool schema bundle after effective tool selection, schema generation, provider normalization, and serialization.

The cache value may contain:

- effective tool ids and display metadata;
- provider-normalized JSON schemas;
- serialized tool payload ready for model request construction;
- schema byte size and tool count for trace reporting.

The cache must not contain:

- user message content;
- tool execution results;
- approval state;
- per-call permission decisions;
- mutable runtime objects that can be changed by later code.

### 5.2 Cache Key

The key must be conservative. A safe first version should include:

- OpenClaw version/commit;
- schema sanitizer/provider adapter version;
- provider id and provider schema dialect;
- model id or model tool-call mode when it changes schema shape;
- effective tool policy hash;
- enabled core tool ids and versions;
- enabled plugin tool ids and manifest/config hashes;
- MCP server/tool signature hash when MCP tools are present;
- channel capability profile if channel affects available tools;
- sandbox/approval mode when it changes tool exposure;
- relevant feature flags that change tools or schema shape.

If any part of the key cannot be computed safely, bypass the cache and record `cacheStatus=bypass`.

### 5.3 Invalidation

Invalidate on:

- gateway restart;
- plugin install/remove/enable/disable;
- plugin config change;
- tool policy change;
- MCP tool list refresh;
- provider/model/schema dialect change;
- OpenClaw version or schema sanitizer version change.

A memory-only LRU is enough for the first upstream PR. Disk cache can be considered later only after the key is stable.

### 5.4 Safety Rules

- Cache only schema bundles, never authorization results.
- Treat cached values as immutable. Return frozen objects or deep clones if downstream code mutates tool definitions.
- Keep before-tool-call policy checks live. The cache must not bypass runtime guards.
- If provider normalization fails for a cached bundle, evict and rebuild once; if rebuild fails, surface the original error.

### 5.5 Expected Benefit

This should improve both main-agent replies and subagent/native delegate runs because both paths repeatedly prepare the same tool inventory and provider schema. The expected gain depends on tool count and provider schema conversion cost; trace should quantify it. In the current OctoClaw Slack setup, this is likely the highest-confidence optimization after trace.

### 5.6 Acceptance

- Unit tests prove key changes on plugin config, provider dialect, MCP signatures, and tool policy changes.
- Tests prove cached schema does not skip before-tool-call guard behavior.
- Benchmark report shows `tools.schema.*` spans with hit/miss counts and p50/p95 delta.
- A feature flag can disable the cache immediately:

```text
OPENCLAW_TOOL_SCHEMA_CACHE=0
```

## 6. Phase 3: System Prompt Lazy/Cache

### 6.1 What To Cache

Split prompt construction into stable and dynamic fragments.

Stable fragments may include:

- core system policy;
- model/style instructions;
- static tool-use instructions;
- plugin-provided stable system context;
- channel-stable behavior contracts.

Dynamic fragments must remain per-turn:

- current user message and thread context;
- route hint / policy state;
- work contract ids and native run/session refs;
- Slack anchor/delivery metadata;
- current memory retrievals;
- time-sensitive or session-specific context.

### 6.2 Fragment Contract

Introduce a small internal contract for prompt fragments:

```ts
type PromptFragmentStability = "stable" | "session" | "turn";

type PromptFragment = {
  id: string;
  stability: PromptFragmentStability;
  text: string;
  hashInputs: Record<string, string>;
};
```

`stable` fragments are globally cacheable for the same key. `session` fragments may be cached inside one session when their hash inputs are unchanged. `turn` fragments are never cached.

### 6.3 Cache Key

Prompt cache keys should include:

- OpenClaw version/commit;
- model id and provider id;
- prompt style/version;
- AGENTS/system prompt file hashes and mtimes;
- plugin stable prompt fragment hashes;
- enabled tool bundle hash;
- channel kind and capability profile;
- debug/footer/provenance mode when it changes instructions;
- feature flags that affect prompt text.

The key must not include raw user text for stable fragments. Turn fragments are outside this cache.

### 6.4 Lazy Loading

Lazy loading should be implemented as fragment selection, not keyword matching.

Safe examples:

- Include native delegate/planner instructions only when the already-computed route bucket can require delegation.
- Include heavy tool-family instructions only when that tool family is enabled and visible.
- Keep compact references for rarely used subsystems and expand them only when the runtime state explicitly enables that subsystem.

Unsafe examples:

- Hiding safety or tool-use rules because a user message is short.
- Deciding prompt fragments from bare words in the user text.
- Omitting delegate instructions before the runtime has made a route decision that can need them.

### 6.5 Expected Benefit

This can reduce `prompt.system.build` time and reduce prompt tokens, so it can speed main-agent replies and lower the risk that internal routing/provenance text leaks into visible answers. It has higher behavior risk than tool schema cache, so it should ship after trace and schema cache have established a reliable benchmark baseline.

### 6.6 Acceptance

- Golden tests compare prompt output for representative reply, delegate, tool, Slack, and subagent cases.
- Tests prove dynamic route/work-contract/Slack anchor data does not enter stable cache entries.
- Cache can be disabled immediately:

```text
OPENCLAW_SYSTEM_PROMPT_CACHE=0
OPENCLAW_PROMPT_LAZY=0
```

- Benchmark shows p50/p95 change for prompt build and first-token latency.

## 7. Upstream PR Plan

Recommended split:

| PR | Scope | Risk |
| --- | --- | --- |
| 1 | perf trace spans + benchmark report command | low |
| 2 | tool schema cache with memory-only LRU and kill switch | medium-low |
| 3 | prompt fragment stability contract and stable prompt cache | medium |
| 4 | conservative lazy fragment selection behind flag | medium-high |

PR 1 should land before any cache PR. PR 2 can be proposed once trace confirms tool schema work is a major prep span. PR 3/4 should wait until prompt build/token size is measured and golden prompt fixtures exist.

## 8. OctoClaw 0.5.1 Planning Impact

The warm pool line remains recorded as a failed/blocked latency experiment for Slack. The next 0.5.1 performance line should therefore prioritize upstream prep performance:

```text
perf trace benchmark -> tool schema cache -> system prompt lazy/cache
```

This line improves both direct main-agent replies and delegate/subagent paths, while preserving the 0.5.0 planner/native correctness boundary.
