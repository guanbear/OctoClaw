# OpenClaw Prep Performance Upstream Design

Date: 2026-05-06

Status: upstream-facing design draft

Related OctoClaw context:

- `docs/octoclaw-dispatch-latency-preload-design-2026-05-03.md`
- `openspec/changes/planner-preload-0.5.1/`

Current local OpenClaw baseline after 2026-05-06 upgrade:

- source: `/Users/guanbear/workspace/openclaw-5.4-src`
- deployed: `/Users/guanbear/.local/lib/node_modules/openclaw`
- version: `2026.5.4`
- commit: `325df3efefe9c0887d9357732e68fc8556e78d79`
- verification: `node scripts/verify-openclaw-baseline.mjs --source /Users/guanbear/workspace/openclaw-5.4-src --deploy-root /Users/guanbear/.local/lib/node_modules/openclaw --require-gateway`

## 1. Problem Statement

OctoClaw 0.5.0/0.5.1 live Slack evidence shows that warm child sessions are not enough to fix perceived latency. Even simple main-agent replies can spend tens of seconds before model output begins. The repeated cost appears to sit in OpenClaw embedded-run preparation rather than only in child bootstrap.

This design proposes an upstream-friendly sequence:

1. perf trace benchmark;
2. `sessions_spawn` worker tool allowlist propagation;
3. tool schema / tool bundle cache;
4. system prompt lazy/cache.

The order matters. Trace comes first so cache work is driven by measured bottlenecks rather than guesswork. Worker tool allowlists come next because OpenClaw already has `toolsAllow` support in the embedded run layer and OctoClaw already has worker role tool profiles; the missing piece is propagation through `sessions_spawn`. Tool schema/cache work follows once data proves the remaining bundle cost. System prompt lazy/cache comes last because it can produce large gains but has the highest behavior risk.

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

Current upstream PR status:

- PR 1 opened: <https://github.com/openclaw/openclaw/pull/78381>
- branch: `guanbear:prep-metrics-pr1`
- commit: `91c20ac1 feat(embedded-runner): expose prep stage timings`
- scope: observability-only exposure of existing embedded prep stage snapshots on run metadata and `agent_end`
- state at filing: `mergeStateStatus=CLEAN`, `size: S`, `proof: supplied`
- validation recorded in PR:
  - focused embedded runner context-engine test: 37 passed
  - focused stage timing test: 4 passed
  - `pnpm tsgo:core`
  - `git diff --check`
  - real behavior proof: patched CLI build/version run returned `OpenClaw 2026.5.6 (91c20ac)`

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

OpenClaw 2026.5.4 already has the right internal primitive and logs slow prep stages:

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

2026.5.4 status:

- `prepStages.snapshot()` is logged by OpenClaw when slow enough.
- `EmbeddedPiRunMeta` does not yet include `prepStages`.
- `agent_end` hook payload currently includes `durationMs` but not the prep stage summary.
- OctoClaw can parse logs for manual evidence, but stable downstream reporting still needs hook/meta exposure.

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

2026-05-06 implementation status:

- Implemented in upstream PR 1: <https://github.com/openclaw/openclaw/pull/78381>
- The implementation keeps `prepStages` optional on public surfaces.
- `PluginHookAgentEndEvent` uses a public structural stage summary type instead of importing embedded-runner internals into the plugin API.
- The PR intentionally does not add convenience fields such as `bundleToolsMs`; downstream consumers can derive those from `prepStages.stages` after upstream agrees on the generic stage summary shape.

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

## 5. Phase 2: PR 2 Worker Tool Allowlist / Pre-Bundle Filtering

### 5.1 Source Finding

OpenClaw 2026.5.4 already supports explicit tool allowlists at the embedded attempt layer:

- `src/agents/pi-embedded-runner/run/params.ts` has `toolsAllow?: string[]`.
- `src/agents/pi-embedded-runner/run/attempt.ts` filters tool registrations with `applyEmbeddedAttemptToolsAllow()`.
- `shouldCreateBundleMcpRuntimeForAttempt()` can skip bundle MCP creation when the allowlist does not include bundle tools.
- When `toolsAllow` is present, `attempt.ts` uses minimal prompt mode and strips the skills catalog.

The current gap is the subagent/native spawn boundary:

- `SpawnSubagentParams` in `src/agents/subagent-spawn.ts` does not expose `toolsAllow`.
- The `sessions_spawn` public tool shape therefore cannot pass a role-specific allowlist into the child `agent` run.
- OctoClaw already has role profiles with `allowedTools` (`worker_research`, `worker_code`, `worker_review`), but current planner `sessionsSpawnArgs` do not include a corresponding OpenClaw-native allowlist.
- This gap is still present in local OpenClaw `2026.5.4`; `sessions-spawn-tool.ts` exposes `context`/`lightContext` but not `toolsAllow`.

### 5.2 PR 2 Design

Upstream OpenClaw PR 2 should be the smallest behavior-affecting performance PR after PR 1. The core idea is not to invent a new filtering layer. OpenClaw already has embedded-run `toolsAllow` handling that filters tools, skips unreachable bundled runtimes, and switches allowlisted runs to minimal prompt mode. PR 2 should make `sessions_spawn` able to pass that existing allowlist into child embedded runs so the current pre-bundle filtering can actually apply to native subagents.

In other words:

```text
sessions_spawn(toolsAllow)
  -> SpawnSubagentParams.toolsAllow
  -> callSubagentGateway({ method: "agent", params: { toolsAllow } })
  -> RunEmbeddedPiAgentParams.toolsAllow
  -> existing embedded attempt filtering / construction plan / minimal prompt path
```

This is upstream-friendly because it reuses existing primitives:

- `RunEmbeddedPiAgentParams.toolsAllow?: string[]`
- `applyEmbeddedAttemptToolsAllow()`
- `resolveEmbeddedAttemptToolConstructionPlan()`
- `shouldCreateBundleMcpRuntimeForAttempt()`
- `shouldCreateBundleLspRuntimeForAttempt()`
- existing minimal prompt behavior when `params.toolsAllow?.length` is set

Likely upstream changes:

- add `toolsAllow?: string[]` to `SpawnSubagentParams`;
- add `toolsAllow` to the `sessions_spawn` tool schema with a description that it applies to `runtime="subagent"` only;
- parse `toolsAllow` as an optional array of strings, preserving existing embedded-run semantics:
  - `undefined`: no restriction, current behavior;
  - `[]`: no tools;
  - `["*"]`: all tools;
  - named tools/groups such as `read`, `exec`, `web_fetch`, `group:plugins`, `bundle-mcp`, or provider/plugin tool ids;
- reject malformed non-string entries fail-closed with a `ToolInputError`;
- for `runtime="acp"`, either reject `toolsAllow` as unsupported or ignore it with explicit diagnostics; prefer rejection because ACP does not use the embedded runner tool construction path;
- pass `toolsAllow` through `spawnSubagentDirect()` into the child `agent` gateway params;
- add tests that `toolsAllow` reaches embedded run params and causes bundle MCP/LSP/runtime tools outside the allowlist to be skipped through the already-existing construction-plan logic.

PR 2 should not:

- add a cache;
- add OctoClaw-specific role names;
- introduce user-text keyword matching;
- change default `sessions_spawn` behavior when `toolsAllow` is omitted;
- weaken before-tool-call policy checks or target-agent allowlist checks;
- bypass existing provider/tool policy, sandbox, owner-only, or channel policy guards.

### 5.2.1 Upstream Code Touch Points

Expected files on OpenClaw `main`:

- `src/agents/tools/sessions-spawn-tool.ts`
  - schema: add optional `toolsAllow`;
  - execute: read/validate the array;
  - pass to `spawnSubagentDirect` for `runtime="subagent"`;
  - keep ACP unsupported or explicitly rejected.
- `src/agents/subagent-spawn.ts`
  - type: add `toolsAllow?: string[]` to `SpawnSubagentParams`;
  - gateway call: include `toolsAllow` in `method: "agent"` params.
- Existing embedded-run files should not need behavior changes unless tests reveal a missing propagation point:
  - `src/agents/pi-embedded-runner/run/params.ts`
  - `src/agents/pi-embedded-runner/run/attempt.ts`
  - `src/agents/pi-embedded-runner/run/attempt-tool-construction-plan.ts`

### 5.2.2 PR 2 Test Matrix

Minimum upstream tests:

- `sessions_spawn` schema exposes `toolsAllow` as an optional string array.
- `sessions_spawn(runtime="subagent", toolsAllow:["read","web_fetch"])` forwards the exact normalized allowlist to `spawnSubagentDirect`.
- `spawnSubagentDirect({ toolsAllow })` passes `toolsAllow` into the child `agent` gateway params.
- `toolsAllow` omitted leaves the child gateway params unchanged versus current behavior.
- `toolsAllow: []` is preserved and reaches the child as an explicit no-tools allowlist.
- malformed values such as `toolsAllow:[123]` fail closed before spawning.
- `runtime="acp"` with `toolsAllow` fails clearly, or the chosen behavior is tested if upstream prefers ignore-with-diagnostics.
- focused embedded-run tests continue to prove:
  - non-bundle allowlists skip bundle MCP startup;
  - non-LSP allowlists skip bundle LSP startup;
  - allowlisted runs use existing minimal prompt behavior;
  - before-tool-call guards remain active.

Recommended validation commands after implementation:

```sh
node scripts/run-vitest.mjs run --config test/vitest/vitest.agents-tools.config.ts src/agents/tools/sessions-spawn-tool.test.ts --reporter=dot
node scripts/run-vitest.mjs run --config test/vitest/vitest.agents-core.config.ts src/agents/subagent-spawn.test.ts src/agents/subagent-spawn.context.test.ts --reporter=dot
node scripts/run-vitest.mjs run --config test/vitest/vitest.agents-pi-embedded.config.ts src/agents/pi-embedded-runner/run/attempt-tool-construction-plan.test.ts --reporter=dot
pnpm tsgo:core
git diff --check
```

Use the exact upstream shard config if these paths have moved by the time PR 2 is implemented.

Downstream OctoClaw changes after the upstream field exists:

- map delegation profile `allowedTools` to `sessionsSpawnArgs.toolsAllow`;
- keep `context: "isolated"` and `lightContext: true`;
- include `toolsAllow` in canonical spawn arg hashing/gate tests;
- record tool allowlist in smoke artifacts without exposing unnecessary internal prompt text.

### 5.3 Expected Benefit

This is likely the best immediate child-agent optimization. It reduces the amount of tool inventory work before cache work exists, and it triggers OpenClaw's existing minimal prompt behavior for allowlisted runs.

Expected impact depends on how many tools are excluded. For worker roles that only need read/search/web or read/edit/bash/LSP, bundle work can plausibly drop from several seconds to near one or two seconds. It also reduces prompt size because the child no longer needs a broad tool catalog.

### 5.4 Safety Rules

- Treat `toolsAllow` as a maximum allowlist, not as an authorization grant.
- Existing before-tool-call guards and provider/tool policy still run.
- Unknown tool names should fail closed or be ignored with diagnostics, matching OpenClaw's existing allowlist semantics.
- Do not remove core safety tools if OpenClaw requires them for runtime integrity.
- Do not use user-text keyword matching to choose the allowlist. Use runtime role/profile state.

### 5.5 Acceptance

- Upstream tests prove `sessions_spawn(..., toolsAllow)` reaches the child embedded run.
- Tests prove disallowed bundle/MCP tools are not materialized.
- Tests prove `toolsAllow` triggers the existing minimal prompt/skills stripping path.
- OctoClaw tests prove role profiles produce stable `toolsAllow` and the planner gate hash includes it.
- Slack/native smoke proves final delivery and confirm semantics are unchanged.
- PR body includes a `Real behavior proof` section if opened from the external fork, following OpenClaw's current PR gate.

## 6. Phase 3: Tool Schema / Tool Bundle Cache

### 6.0 2026-05-07 PR1+PR2 Benchmark Evidence

After PR 1 prep-stage telemetry and PR 2 `sessions_spawn.toolsAllow` propagation were available on the local PR 2 branch, a local mock-provider benchmark was run to decide whether PR 3 is justified.

Benchmark setup:

- OpenClaw source: `/Users/guanbear/workspace/openclaw-5.4-src`
- branch: `sessions-spawn-tools-allow-pr2`
- head at benchmark time: `1d2f44b71331149e1a23f5c829ea16afcf01ba47`
- provider: local `scripts/e2e/mock-openai-server.mjs`
- state isolation: temporary `HOME` and `OPENCLAW_STATE_DIR`
- warmup: 3 runs, excluded from reported samples
- samples:
  - `main-default`: 10 runs
  - `subagent-default`: 7 runs
  - `subagent-allow-read-exec`: 7 runs with `toolsAllow: ["read", "exec"]`
- raw summary artifact: `/tmp/openclaw-prep-bench.klReip/summary.json`

Observed p50 values:

| Fixture | prep total | core-plugin-tools | bundle-tools | system-prompt | session-resource-loader |
| --- | ---: | ---: | ---: | ---: | ---: |
| `main-default` | 498ms | 308ms | 77ms | 54ms | 53ms |
| `subagent-default` | 498ms | 309ms | 76ms | 55ms | 53ms |
| `subagent-allow-read-exec` | 248ms | 136ms | 0ms | 54ms | 53ms |

Observed p95 values:

| Fixture | prep total | core-plugin-tools | bundle-tools | system-prompt | session-resource-loader |
| --- | ---: | ---: | ---: | ---: | ---: |
| `main-default` | 559ms | 365ms | 106ms | 56ms | 55ms |
| `subagent-default` | 505ms | 315ms | 77ms | 57ms | 54ms |
| `subagent-allow-read-exec` | 251ms | 137ms | 1ms | 55ms | 54ms |

Conclusions:

- PR 2 is useful before caching: `toolsAllow: ["read", "exec"]` cuts child prep p50 from about 498ms to about 248ms and skips bundle tool materialization almost entirely.
- PR 2 does not solve the main-agent hot path. `main-default` still spends about 385ms p50 in `core-plugin-tools + bundle-tools`, around 77% of measured prep.
- PR 3 is justified even if its first version mostly benefits the main agent and default subagent path. The measured main-agent default tool path is a clear repeated prep bottleneck.
- The remaining allowlisted child cost is mostly `core-plugin-tools.tool-policy` at about 136ms p50, so PR 3 should consider both provider-ready schema/bundle caching and avoiding repeated static tool-policy/tool-inventory work when the cache key is unchanged.

### 6.0.1 2026-05-07 PR3 Schema Cache Microbenchmark

PR3 was implemented as a clean upstream branch from `origin/main`, not on top of PR2. The first PR3 slice caches only provider-normalized tool schema parameters in memory; it does not cache tool objects, execute closures, approval state, before-tool-call guards, or runtime permission decisions. This keeps the cache useful for repeated main-agent/default-tool turns while avoiding the risk of reusing live mutable tool state.

Microbenchmark setup:

- OpenClaw source: `/Users/guanbear/workspace/openclaw-5.4-src`
- branch: `tool-schema-cache-pr3`
- PR head: `a5874d8ac60cf2974b74cc66b50028db103b390e`
- command shape: `pnpm exec tsx --input-type=module` importing `src/agents/pi-embedded-runner/tool-schema-runtime.ts`
- provider/model: `openai`, `gpt-5.4`, `openai-responses`, `https://api.openai.com/v1`
- provider path: real bundled OpenAI provider hook path, not a mocked provider normalizer
- fixture: 50 freshly-created representative tool objects per iteration, each with nested JSON schema and a fresh `execute` closure
- samples: 100 repeated normalization iterations in one process
- comparison: `OPENCLAW_TOOL_SCHEMA_CACHE=0` versus default cache enabled

Observed results:

| Mode | total | per iteration | RSS delta | cache stats |
| --- | ---: | ---: | ---: | --- |
| cache disabled | 63.625s | 636.250ms | +447.7 MiB | `bypass=100 hit=0 miss=0 store=0 size=0` |
| cache enabled | 26.927s | 269.270ms | -3.1 MiB | `bypass=0 hit=99 miss=1 store=1 size=1` |

Lightweight mock Gateway E2E:

- PR head: `d35031322710757f96212feae00b45be8452b4be` before rebase; same PR code path, used as compatibility proof rather than final-head performance proof
- setup: same Gateway process, mock OpenAI server, five main-agent RPC calls per mode
- model request shape: 27 tools sent per request

| Mode | durations | p50 | model requests | tools per request |
| --- | --- | ---: | ---: | --- |
| cache enabled | `[2105, 496, 471, 465, 470]` ms | 471ms | 5 | 27 |
| cache disabled | `[2002, 482, 472, 474, 470]` ms | 474ms | 5 | 27 |

Conclusions:

- PR3 directly targets the repeated provider tool-schema normalization path that every main/default embedded attempt reaches after tool creation.
- The cache is not only startup-only: in a long-lived Gateway/embedded process, each later turn with the same provider/model/tool schema signature can reuse the normalized schema parameters while keeping fresh execute closures.
- The cache is active (`miss=1 store=1 hit=99`), but the current conservative hit path still pays cache key and original schema signature construction. The realistic current-head microbenchmark is therefore a partial win, not the earlier near-zero hit-path result.
- The mock Gateway E2E confirms the real main-agent path works with the cache enabled, but it does not show a meaningful wall-latency delta in a five-run fixture. Treat the E2E as compatibility proof, not performance proof.
- This first PR3 slice does not remove all `core-plugin-tools` or `bundle-tools` cost. It should be treated as a conservative schema-normalization cache, not a full bundle-materialization cache. A bigger follow-up should cache or reuse static tool inventory descriptors / policy inputs before provider schema normalization.
- The kill switch works for before/after comparison and rollback: `OPENCLAW_TOOL_SCHEMA_CACHE=0`.

### 6.1 What To Cache

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

### 6.2 Cache Key

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

### 6.3 Invalidation

Invalidate on:

- gateway restart;
- plugin install/remove/enable/disable;
- plugin config change;
- tool policy change;
- MCP tool list refresh;
- provider/model/schema dialect change;
- OpenClaw version or schema sanitizer version change.

A memory-only LRU is enough for the first upstream PR. Disk cache can be considered later only after the key is stable.

### 6.4 Safety Rules

- Cache only schema bundles, never authorization results.
- Treat cached values as immutable. Return frozen objects or deep clones if downstream code mutates tool definitions.
- Keep before-tool-call policy checks live. The cache must not bypass runtime guards.
- If provider normalization fails for a cached bundle, evict and rebuild once; if rebuild fails, surface the original error.

### 6.5 Expected Benefit

This should improve both main-agent replies and subagent/native delegate runs because both paths repeatedly prepare the same tool inventory and provider schema. The expected gain depends on tool count and provider schema conversion cost; trace should quantify it. In the current OctoClaw Slack setup, this is likely the highest-confidence optimization after trace.

### 6.6 Acceptance

- Unit tests prove key changes on plugin config, provider dialect, MCP signatures, and tool policy changes.
- Tests prove cached schema does not skip before-tool-call guard behavior.
- Benchmark report shows `tools.schema.*` spans with hit/miss counts and p50/p95 delta.
- A feature flag can disable the cache immediately:

```text
OPENCLAW_TOOL_SCHEMA_CACHE=0
```

## 7. Phase 4: System Prompt Lazy/Cache

### 7.0 2026-05-07 Upstream Recheck

This phase is no longer an immediate implementation PR as originally drafted. Current upstream `origin/main` already contains the stable system prompt prefix cache and internal cache boundary:

- `0f16edf329 fix: cache stable system prompt prep` is contained in `origin/main`.
- `src/agents/system-prompt.ts` has `stablePromptPrefixCache` with `SYSTEM_PROMPT_STABLE_PREFIX_CACHE_LIMIT = 64`.
- `src/agents/system-prompt-cache-boundary.ts` exposes `SYSTEM_PROMPT_CACHE_BOUNDARY` plus stable/dynamic split helpers.
- `docs/concepts/system-prompt.md` documents stable provider prompt contributions and dynamic suffix placement below the cache boundary.

Lightweight local verification was run from `/Users/guanbear/workspace/openclaw-5.4-src` on branch `prep-metrics-pr1` at `f1f607b6e8e3fbf8414f1adc03ad104bf76784e8`; the upstream prompt-cache code under test is already present on `origin/main` at `5ff283cfbba84a630c8e683c6e263720645ac4c4`.

Pure `buildAgentSystemPrompt()` microbenchmark with a main-agent-like 74k character prompt:

| Case | iterations | per iteration | p50 | p95 | prompt chars | stable chars | dynamic chars |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cold single | 1 | 1.437ms | 1.436ms | 1.436ms | 74008 | 69599 | 4373 |
| cache hit, same input | 200 | 0.198ms | 0.185ms | 0.220ms | 74008 | 69599 | 4373 |
| cache hit, changing dynamic turn data | 200 | 0.191ms | 0.182ms | 0.218ms | 73977 | 69599 | 4342 |
| forced stable-key miss | 200 | 0.223ms | 0.216ms | 0.255ms | 74024 | 69615 | 4373 |

`buildAttemptSystemPrompt()` plus `buildSystemPromptReport()` microbenchmark with 50 representative tools and about 45.8k schema characters:

| Case | iterations | per iteration | p50 | p95 | prompt chars | stable chars | dynamic chars |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cache hit, changing dynamic turn data | 200 | 0.159ms | 0.149ms | 0.203ms | 51257 | 47616 | 3605 |
| forced stable-key miss | 200 | 0.182ms | 0.176ms | 0.205ms | 51299 | 47632 | 3631 |

Focused regression coverage also passed:

```sh
OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test src/agents/system-prompt-cache-boundary.test.ts src/agents/system-prompt.test.ts
```

Result: 2 files passed, 78 tests passed.

Conclusion: do not submit a PR whose main claim is "add stable system prompt cache"; upstream already has that mechanism, and the isolated prompt build/report path is well below 1ms per repeated turn in this local fixture. The earlier PR1+PR2 benchmark still shows `system-prompt` around 54-57ms p50/p95 at the embedded prep stage boundary, so any remaining work should first identify which surrounding resolver inside the `system-prompt` stage accounts for that time. Candidate checks are OpenClaw reference path resolution, channel action/message hint lookup, provider contribution resolution, system prompt report inputs, and other stage-boundary work in `attempt.ts`, not a second stable-prefix cache.

Revised Phase 4 gate:

- no PR4 implementation unless new evidence shows stable prefix cache misses, unstable dynamic content above the boundary, or a specific resolver inside the `system-prompt` stage with material p50/p95 cost;
- if evidence appears, PR4 should be a narrow fix to the measured miss/resolver, reusing the existing cache boundary and adding golden prompt tests;
- lazy fragment selection remains a later, higher-risk PR only after token-size and first-token data show a real gain.

### 7.1 What To Cache

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

### 7.2 Fragment Contract

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

### 7.3 Cache Key

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

### 7.4 Lazy Loading

Lazy loading should be implemented as fragment selection, not keyword matching.

Safe examples:

- Include native delegate/planner instructions only when the already-computed route bucket can require delegation.
- Include heavy tool-family instructions only when that tool family is enabled and visible.
- Keep compact references for rarely used subsystems and expand them only when the runtime state explicitly enables that subsystem.

Unsafe examples:

- Hiding safety or tool-use rules because a user message is short.
- Deciding prompt fragments from bare words in the user text.
- Omitting delegate instructions before the runtime has made a route decision that can need them.

### 7.5 Expected Benefit

This can reduce `prompt.system.build` time and reduce prompt tokens, so it can speed main-agent replies and lower the risk that internal routing/provenance text leaks into visible answers. It has higher behavior risk than tool schema cache, so it should ship after trace and schema cache have established a reliable benchmark baseline.

### 7.6 Acceptance

- Golden tests compare prompt output for representative reply, delegate, tool, Slack, and subagent cases.
- Tests prove dynamic route/work-contract/Slack anchor data does not enter stable cache entries.
- Cache can be disabled immediately:

```text
OPENCLAW_SYSTEM_PROMPT_CACHE=0
OPENCLAW_PROMPT_LAZY=0
```

- Benchmark shows p50/p95 change for prompt build and first-token latency.

## 8. Upstream PR Plan

Recommended split:

| PR | Scope | Risk |
| --- | --- | --- |
| 1 | expose existing embedded prep stage summary in run metadata / `agent_end` | low |
| 2 | propagate `toolsAllow` through `sessions_spawn` and let worker roles use narrow tool sets | low-medium |
| 3 | tool schema / bundle cache with memory-only LRU and kill switch | medium-low |
| 4 | prompt-stage gap fix only if measured; reuse existing stable-prefix cache/boundary | medium |
| 5 | conservative lazy fragment selection behind flag | medium-high |

PR 1 should land before any cache PR. PR 2 is useful even before cache because it narrows child worker work with existing OpenClaw primitives. PR 3 can be proposed once stage evidence confirms tool schema / bundle work remains a major prep span after allowlist propagation. PR 4 is not currently justified as a stable prompt cache PR because upstream already contains that mechanism. PR 4/5 should wait until prompt-stage resolver evidence, prompt token-size data, first-token latency data, and golden prompt fixtures exist.

## 9. Upstream Landing Plan

This landing plan belongs in this design doc rather than a separate OctoClaw OpenSpec change. The upstream code changes are OpenClaw changes; OctoClaw OpenSpec should only track the downstream evidence, validation, and rollout decisions.

### 9.1 Local Source Baseline

Before opening an upstream PR, verify that the source tree matches the deployed OpenClaw baseline used for evidence:

```text
source: /Users/guanbear/workspace/openclaw-5.4-src
deployed: /Users/guanbear/.local/lib/node_modules/openclaw
version: 2026.5.4
commit: 325df3efefe9c0887d9357732e68fc8556e78d79
```

Use OctoClaw's baseline verifier before trusting source-level conclusions:

```sh
node scripts/verify-openclaw-baseline.mjs \
  --source /Users/guanbear/workspace/openclaw-5.4-src \
  --deploy-root /Users/guanbear/.local/lib/node_modules/openclaw \
  --require-gateway
```

If source and deployed OpenClaw differ, stop and align the baseline before writing the PR.

### 9.2 PR 1 Implementation Shape

PR 1 should be a minimal observability-only change.

Likely upstream files:

- `src/agents/pi-embedded-runner/types.ts`
- `src/plugins/hook-types.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`
- focused tests near `src/agents/pi-embedded-runner/run/attempt-stage-timing.test.ts`, `src/agents/pi-embedded-runner/run/attempt.test.ts`, or hook payload tests.

Implementation outline:

1. Export or reuse the existing `EmbeddedRunStageSummary` type where `EmbeddedPiRunMeta` and `PluginHookAgentEndEvent` can reference it.
2. Add optional `prepStages?: EmbeddedRunStageSummary` to `EmbeddedPiRunMeta`.
3. Add optional `prepStages?: EmbeddedRunStageSummary` to `PluginHookAgentEndEvent`.
4. In `runEmbeddedAttempt`, take `const prepStageSummary = prepStages.snapshot()` near finalization and pass it into returned meta and `agent_end`.
5. Keep the existing warning log behavior unchanged.

PR 1 must not:

- change prompt text;
- change tool inventory;
- change hook timing;
- add cache behavior;
- emit raw user text, full prompts, secrets, or full tool schemas;
- introduce OctoClaw-specific naming.

### 9.3 PR 1 Verification

Minimum upstream verification:

```sh
pnpm test -- src/agents/pi-embedded-runner/run/attempt-stage-timing.test.ts
pnpm test -- src/plugins/hooks.phase-hooks.test.ts src/plugins/hooks.model-override-wiring.test.ts
```

Add or update focused tests to prove:

- `prepStages` contains stage names and durations when an embedded run reaches `agent_end`;
- existing `durationMs` remains unchanged;
- hooks still run when `prepStages` is absent or empty;
- no prompt text or tool schema content is added to the hook event.

If upstream has a preferred command set, use their contributor docs over these local commands.

### 9.4 PR 1 Description Template

Use a concise upstream-oriented PR description:

```text
Title: Expose embedded run prep stage timings in run metadata

Summary:
- Reuses the existing embedded run stage tracker.
- Adds optional prepStages to embedded run metadata and agent_end hook events.
- Does not change prompt construction, tool inventory, routing, or execution behavior.

Why:
- Downstream plugins and OpenClaw diagnostics need to distinguish bundle-tools, system-prompt, stream-setup, and model latency before proposing cache changes.

Validation:
- focused timing/hook tests
- no prompt/tool behavior changes
```

Avoid mentioning OctoClaw-specific Slack incidents as the main justification. They can be referenced as downstream motivation only if needed.

### 9.5 PR 2: `sessions_spawn` Tool Allowlist

PR 2 should be small and centered on subagent spawn propagation:

- add `toolsAllow` to the public `sessions_spawn` schema and `SpawnSubagentParams`;
- forward it to the child `agent` run;
- rely on existing embedded attempt `toolsAllow` handling for filtering and minimal prompt mode;
- add focused tests around schema, forwarding, and bundle skip behavior.

OctoClaw should not send `toolsAllow` until the deployed OpenClaw build supports the field. Before that, keep role allowlists in the handoff packet only.

### 9.6 PR 3 Gate: Tool Schema Cache

Do not start cache work until PR 1 or OctoClaw coarse benchmark shows a meaningful repeated cost in `bundle-tools`, tool schema normalization, or related prep stages. If PR 2 removes most of the child worker bundle cost, PR 3 should target remaining parent/main-agent prep, not only subagents.

Before coding PR 3, write the cache key tests first. The first cache PR should be memory-only and default-enabled only if the key is complete and the kill switch works; otherwise ship behind an explicit opt-in flag.

### 9.7 PR 4/5 Gate: System Prompt Lazy/Cache

Do not start new prompt lazy/cache implementation until prompt-stage evidence is stable and golden prompt tests exist. Current upstream already has stable prefix caching and the cache boundary, so this work should be split only if new data proves a remaining gap:

1. measured prompt-stage miss/resolver fix that reuses the existing stable prefix cache;
2. lazy fragment selection behind a flag.

The lazy selection rule must be derived from runtime state, provider capabilities, and already-computed route/tool visibility. It must not be based on user-text keyword matching.

### 9.8 Deferred / Not First

Do not prioritize these before PR 1-3:

- `stream-setup` reuse: likely valuable, but it touches provider transport lifecycle, abort handling, fallback paths, and connection ownership.
- `bundle-tools + system-prompt` parallelization: plausible 5-6s win, but only after prep stages prove a serial dependency and tests show no data dependency. It is riskier than allowlist propagation and cache.
- a new `systemPromptMode` parameter: OpenClaw already switches to minimal prompt when `toolsAllow` is set. Reuse that first; add a separate mode only if benchmark evidence shows allowlisted minimal prompt is still too heavy.

### 9.9 Downstream OctoClaw Tracking

OctoClaw should track this upstream line in `openspec/changes/planner-preload-0.5.1/tasks.md` only as downstream evidence:

- coarse replay timing implemented;
- upstream PR 1 drafted/opened/merged;
- local OpenClaw deployment includes PR 1;
- official OpenClaw release rebaseline recorded when upstream capabilities already exist;
- post-PR benchmark artifact collected;
- cache PR gates satisfied or rejected.

Do not mark 0.5.1 performance complete just because a PR is opened. Completion needs local deployment plus measured p50/p95 improvement or a documented no-go result.

## 10. OctoClaw 0.5.1 Planning Impact

The warm pool line remains recorded as a failed/blocked latency experiment for Slack. The next 0.5.1 performance line should therefore prioritize upstream prep performance:

```text
perf trace benchmark -> sessions_spawn toolsAllow -> tool schema/cache -> system prompt lazy/cache
```

This line improves both direct main-agent replies and delegate/subagent paths, while preserving the 0.5.0 planner/native correctness boundary.

After the 2026.5.4 local upgrade, the priority remains the same but the PR shape is narrower:

1. Use 5.4's existing slow prep-stage logs for immediate manual evidence.
2. Upstream PR 1 only needs to expose those existing stage summaries to `EmbeddedPiRunMeta` / `agent_end`.
3. Upstream PR 2 remains necessary because `sessions_spawn` still cannot pass `toolsAllow` to child runs.
4. Re-run Slack simple reply and planner-native delegate baselines on 5.4 before claiming any cache or warm-pool conclusion.
