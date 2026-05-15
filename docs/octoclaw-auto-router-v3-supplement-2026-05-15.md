# Auto Router V3 — Design Supplement (2026-05-15)

Status: design supplement. Patches the v3 baseline (now archived at
`docs/archive/design-notes/octoclaw-auto-router-v3-design-2026-05-13.md`) with
decisions that came out of the implementation gap review.

This document **does not replace** v3 baseline §1–§11. It only adds, clarifies,
or corrects the items called out below.

---

## 0. What this supplement covers

Three classes of gap surfaced during V1 implementation:

| Gap | Type | Section |
|-----|------|---------|
| Capability fusion is incomplete (no real leaderboard parsers, no source weights, no freshness/health decay, scoring uses fixed tier values not real scores) | Implementation gap, design partly silent | §1 |
| Probe is only a snapshot read; not a real API smoke test | Implementation gap | §2 |
| `unconfigured models never live` invariant vs. "if probe works, auto-add it" desire | **Design conflict** | §3 |
| Slack-driven 7-step wizard UX is not specified | Design gap | §4 |
| Provider auth / config writeback boundaries are vague | Design gap | §5 |
| Plan quota auto-poll behavior is not implemented | Implementation gap | §6 |

Every section ends with a precise list of what to change and where.

---

## 1. Capability Fusion (§5.1–§5.6 in v3 baseline)

### 1.1 What's actually shipped

- `packages/octoclaw-router/src/data/leaderboard-snapshot.json` — **3 models
  only** (`openai/gpt-5.5`, `zhipu/glm-5.1`, `openai/gpt-5-mini`).
- `capability/sources.ts` — three fetchers: OpenRouter, models.dev, LiteLLM.
  These provide **price + capability metadata only**, not quality scores.
- `capability/refresh.ts` — fuses price across sources with a 20% conflict
  threshold and median fallback. **Tier comes from the first non-`unknown`
  source only**; quality scores are never merged.
- `capability/merge.ts` — `computeFreshness()` exists but is **not used by any
  caller** today.
- `scoring/index.ts` — `capabilityScoreFor(model)` reads
  `TIER_SCORE[model.capability.codingTier]` (fixed values: 95/80/65/40/30) and
  multiplies by a confidence factor. **Never reads a real leaderboard score.**
- `scripts/refresh-leaderboard-snapshot.mjs` — pulls OpenRouter + PinchBench
  only. Other leaderboards listed in v3 §5.2 (Aider, LiveCodeBench, BFCL,
  SWE-bench Verified, LMArena) **have no parser**.

### 1.2 Decision: phase the fusion in, do not skip it

V1 ships with **a thin but honest fusion**. We do **not** wait for full
6-source fusion before going live.

| Phase | Sources required | Source weights | Freshness decay | Health decay | Live score uses real leaderboard |
|-------|------------------|----------------|-----------------|--------------|-----------------------------------|
| **V1.0 (current)** | 1 (PinchBench via packaged seed) | none | none | none | no — uses tier defaults |
| **V1.1 (this supplement target)** | 3 (PinchBench + Aider + BFCL) | yes, packaged | yes (30/90/180-day) | yes (last 4 fetches) | yes for `coding_worker` only |
| **V1.2 (post-launch)** | 6 (+ LiveCodeBench + SWE-bench Verified + LMArena) | yes | yes | yes | yes for all three scenarios |

V1.2 is **not** in this release. V1.1 is the target for the gap-fix.

### 1.3 New file: `data/source-weights.json`

```json
{
  "schemaVersion": "octoclaw.router.source_weights/v1",
  "weights": {
    "coding_worker": {
      "aider":          0.40,
      "pinchbench":     0.30,
      "bfcl":           0.10,
      "artificial_analysis": 0.20
    },
    "research": {
      "artificial_analysis": 0.50,
      "pinchbench":          0.30,
      "lmarena":             0.20
    },
    "agentic": {
      "bfcl":                0.50,
      "pinchbench":          0.30,
      "artificial_analysis": 0.20
    }
  }
}
```

Rules:

- Weights inside one scenario **must sum to 1.0**.
- A source missing from a model's data is dropped, the remaining weights are
  re-normalized for that model.
- Weights are static for V1; we do **not** learn them.

### 1.4 New helpers in `capability/merge.ts`

```ts
export interface ScoredSourceContribution {
  source: string;
  rawScore: number;          // 0–100
  baseWeight: number;        // from source-weights.json
  freshnessFactor: number;   // 1.0 / 0.7 / 0.4 / 0.15
  sourceHealth: number;      // 0.0–1.0
  effectiveWeight: number;   // baseWeight × freshnessFactor × sourceHealth
}

export interface FusedScore {
  score: number;             // 0–100
  confidence: "high" | "medium" | "low" | "unknown";
  contributions: ScoredSourceContribution[];
  reasonCodes: string[];     // e.g. ["aider_stale","bfcl_health_zero"]
}

export function fuseScenarioScore(
  contributions: Array<{ source: string; rawScore: number; lastVerifiedAt?: string }>,
  weights: Record<string, number>,
  health: Record<string, number>,
  now: number,
): FusedScore;
```

Freshness factor (replaces v3 §5.4 table; we keep the same numbers but make it
explicit code):

```
< 30 days:   1.00
30–90 days:  0.70
90–180 days: 0.40
> 180 days:  0.15
```

Source health (the worker's last 4 fetches per source):

```
4/4 successful: 1.00
3/4 successful: 0.75
2/4 successful: 0.50
1/4 successful: 0.25
0/4 successful: 0.00 (source effectively dropped from fusion)
```

Confidence (replaces v3 §5.4 confidence rules):

```
sum(baseWeight × freshnessFactor × sourceHealth) >= 0.7  →  "high"
sum >= 0.4                                               →  "medium"
sum >  0                                                 →  "low"
sum == 0                                                 →  "unknown"
```

### 1.5 Change to `scoring/index.ts`

Replace `capabilityScoreFor(model)`:

```ts
export function capabilityScoreFor(model: ModelIntelLite, complexity: Complexity): number {
  const scenario = scenarioForComplexity(complexity); // simple/normal → coding_worker, deep → coding_worker, complex → coding_worker (V1.1 only does coding_worker)
  const fused = model.capability.scoreByScenario?.[scenario];
  if (fused === undefined || fused.confidence === "unknown") {
    // Fall back to tier defaults so V1.1 still works for models with no
    // leaderboard coverage (e.g. brand-new providers).
    const baseScore = TIER_SCORE[model.capability.codingTier] ?? 30;
    const multiplier = confidenceMultiplier(model.capability.confidence);
    return baseScore * multiplier;
  }
  return fused.score; // confidence already baked in
}
```

The `confidence` field is still surfaced in `reasonCodes` so users can see
why a recommendation has weak data.

### 1.6 `ModelIntelLite` schema addition

```ts
interface ModelIntelLite {
  // ... existing fields
  capability: {
    // ... existing fields
    scoreByScenario?: {
      coding_worker?: FusedScore;
      research?: FusedScore;
      agentic?: FusedScore;
    };
  };
}
```

Field is **optional** so old snapshots stay parseable. When absent, scoring
falls back to tier defaults (1.5).

### 1.7 New leaderboard parsers (Phase V1.1)

Required:

- `packages/octoclaw-router/src/capability/leaderboard/aider.ts`
- `packages/octoclaw-router/src/capability/leaderboard/bfcl.ts`

Optional for V1.1 (acceptable to defer to V1.2):

- `livecodebench.ts`
- `swebench-verified.ts`
- `lmarena.ts`

Each parser exports:

```ts
export interface LeaderboardSourceRecord {
  source: string;        // e.g. "aider"
  modelKey: string;      // canonical, e.g. "anthropic/claude-sonnet-4.6"
  scenario: "coding_worker" | "research" | "agentic";
  rawScore: number;      // 0–100, normalized
  sampleCount?: number;  // for confidence
  lastVerifiedAt: string; // ISO8601
}

export function parseAiderLeaderboard(rawBytes: Buffer | string): LeaderboardSourceRecord[];
```

Parsers must:

- Accept the upstream's native format (JSON for Aider/LiveCodeBench, YAML for
  BFCL, JSONL for SWE-bench, etc.).
- Validate with Zod.
- On schema mismatch, return empty array and **mark source health 0.0** for
  the next fusion cycle. Never throw.

The `scripts/refresh-leaderboard-snapshot.mjs` script is extended to call
each parser, persist `LeaderboardSourceRecord[]` per source, and write a
**fused** `leaderboard-snapshot.json` whose `models[*].scores` are the output
of `fuseScenarioScore(...)`.

### 1.8 Seed expansion (V1.1)

Packaged `leaderboard-snapshot.json` must cover at minimum:

- All models in `DEFAULT_MODEL_IDS` from the refresh script (already 11).
- Plus models that appear in the top 30 of any of the three V1.1 leaderboards.

Target: **≥ 30 models** in seed. Acceptance: `node scripts/refresh-leaderboard-snapshot.mjs --check-seed` returns 0 (a new flag).

---

## 2. Real Provider Probe (§5.9 / §8 in v3 baseline)

### 2.1 Today

`octoclawctl router capability probe <model>` (`tools/octoclawctl/src/cli.ts`
line 2113) **only reads `model.available` from the snapshot** and prints
"ok" or "failed". It is misnamed.

### 2.2 Decision

Rename today's behavior, add a real probe.

| Command | What it does |
|---------|--------------|
| `octoclawctl router capability lookup <model>` (renamed) | Read snapshot, print declared availability + sources. No network. |
| `octoclawctl router capability probe <model>` (new behavior) | Real API smoke test against the configured provider. |

The real probe sends a **minimal-cost canary request** and reports four things:

- `auth_ok` — provider accepted the API key
- `model_exists` — provider knows this model id
- `tool_use_ok` — provider returns a structured tool call when asked
- `latency_ms` — first-token latency on the canary

### 2.3 Probe contract (new file `capability/probe.ts`)

```ts
export interface ProbeRequest {
  modelKey: string;
  providerConfig: ProviderConfig; // resolved from §5
  timeoutMs: number;              // default 5000
  budgetUsdMax: number;           // default 0.001 — refuse to send if exceeded
}

export interface ProbeResult {
  modelKey: string;
  ok: boolean;
  authOk: "yes" | "no" | "unknown";
  modelExists: "yes" | "no" | "unknown";
  toolUseOk: "yes" | "no" | "unknown";
  latencyMs?: number;
  costUsd?: number;
  error?: { code: string; message: string };
  evidence: Array<{ source: "http_status" | "response_body" | "exception"; detail: string }>;
}

export async function probeModel(request: ProbeRequest): Promise<ProbeResult>;
```

### 2.4 Canary request shape (provider-agnostic)

```jsonc
{
  "model": "<modelKey>",
  "messages": [{ "role": "user", "content": "Reply with exactly: pong" }],
  "tools": [{
    "type": "function",
    "function": {
      "name": "echo",
      "description": "echo input",
      "parameters": {
        "type": "object",
        "properties": { "value": { "type": "string" } },
        "required": ["value"]
      }
    }
  }],
  "tool_choice": { "type": "function", "function": { "name": "echo" } },
  "max_tokens": 16,
  "temperature": 0
}
```

Rules:

- `max_tokens: 16` keeps cost ≤ ~$0.0005 even on frontier models.
- If `costUsd > budgetUsdMax` is computed in advance (using market price from
  snapshot), refuse to send and return `error.code: "PROBE_BUDGET_EXCEEDED"`.
- Probe **never** runs automatically without user opt-in. Manual CLI only in
  V1.1; future automatic (re-)probing is out of scope.

### 2.5 What to do with probe results

- Update `model.health.lastProbeAt`, `model.health.lastProbeOk`,
  `model.health.lastProbeLatencyMs` in the snapshot.
- If `ok === false`, set `model.health.cooldown = true` for 30 minutes and
  emit a `router_probe_failure` event for the decisions log.
- **Never** flip `model.configured` from probe alone (see §3).

---

## 3. Unconfigured models — proposal/shadow only, never live

### 3.1 The conflict

v3 baseline (`design-2026-05-13.md` §11 hard invariant 3, also §5.10 hard
rule "unconfigured models never go live"): unconfigured models cannot enter
live routing.

Implementation feedback: "if probe works, auto-add it" — but auto-promoting
unconfigured models to live silently breaks the invariant and the safety
story (a wrong API key, a wrong region, a wrong rate limit can all cause
silent traffic shift).

### 3.2 Decision

**Keep the invariant. Add a controlled discovery and proposal flow.**

```
discovered  →  probed  →  proposal_candidate  →  shadow_candidate
  └ no live route at any of these stages.

shadow_candidate → live  ONLY when:
  - `model.configured === true` (user explicitly authorized in OpenClaw config
    or via the wizard's "approve and add" step), AND
  - the existing promotion gate (sample threshold, quality, cost) passes.
```

Concretely, three new model states (additive, do not replace `configured`):

| State | Eligible for | Set by |
|-------|--------------|--------|
| `discovered` | nothing — known to exist (from leaderboard or models.dev) | Refresh job, on-demand via `wizard discover` |
| `probed_ok` | nothing yet — provider responded successfully | `capability probe <model>` returns `ok: true` |
| `proposal_candidate` | shown in `octoclawctl router model-config analyze` | `probed_ok` + same provider as a configured model |
| `shadow_candidate` | shown in `shadow-report`; collects shadow data | User runs `router wizard accept-proposal <model>` (writes config), or user manually adds in OpenClaw config |
| `live_candidate` | live routing decisions | Promotion gate passes AND `configured === true` |

`router model-config analyze` already exists. It is updated to:

- List proposals from `discovered` and `probed_ok` separately.
- Refuse to surface proposals from `discovered` if probe was never attempted
  for that model.
- Output shows: `"requires user approval to enter shadow"`.

### 3.3 New CLI: `router wizard accept-proposal <model>`

Effect:

1. Confirm probe was successful within last 7 days; if not, run probe first.
2. Write the model into `~/.openclaw/openclaw.json` under the right provider's
   model list.
3. Set `model.configured = true` on the next snapshot refresh.
4. The model now enters `shadow_candidate` and the existing promotion gate.

User can also do step 2 by hand (edit `openclaw.json`); the wizard is just a
helper.

### 3.4 Hard invariants (now explicit)

- A model with `configured === false` **never** appears as `live` in any
  promotion state.
- A model that has only been `probed_ok` cannot be auto-added to OpenClaw
  config; user action is always required.
- The wizard's `accept-proposal` action is the **only programmatic write** to
  OpenClaw config from the router; it is idempotent and reversible.
- If a probe later fails for a `live_candidate`, that model goes to cooldown
  but stays `configured`. User has to remove it manually.

---

## 4. Slack-driven Wizard — UX Spec (replaces v3 §6)

### 4.1 Why Slack

The v3 baseline §6 specified a CLI-driven 7-step prompt. We're switching to a
Slack-first wizard because:

- Most users will be running OctoClaw against a Slack workspace anyway.
- Slack message UX (buttons, multi-selects, modals) handles "pick from a list"
  much better than terminal prompts.
- A user who finishes the wizard in Slack already has a working IM round-trip.

The CLI version is kept as a fallback (`octoclawctl router wizard --cli`) for
headless installs.

### 4.2 Trigger conditions

- **First run**: `octoclawctl router wizard` writes a small bootstrap state to
  `~/.openclaw/octoclaw/router-wizard.state.json` and posts the entry message
  to the configured Slack channel.
- **Re-trigger**: `/octoclaw wizard` slash command, or `octoclawctl router
  wizard --resume`. Both load existing state and resume from the last
  unanswered step.
- **Incremental** (config changed): if `~/.openclaw/openclaw.json` mtime
  changed and a new model id appeared, the runtime posts an "incremental
  wizard" prompt asking only the new model's plan type.

### 4.3 Step-by-step

Each step is one Slack message. A "pending" message is updated in place when
the user answers. All steps support a `Skip & defer` button that records the
default and continues.

#### Step 1 — Greeting + scan summary

> 👋 OctoClaw 配置向导
> 我从你的 OpenClaw 配置里看到 4 个模型：
>  • `openai/gpt-5.5`
>  • `openai/gpt-5-mini`
>  • `zhipu/glm-5.1`
>  • `anthropic/claude-sonnet-4.6`
> 我会一步步问你怎么用它们。每一步都可以跳过，之后用 `/octoclaw wizard` 接着配。
>
> [开始 →]   [换 CLI 模式]   [取消]

#### Step 2 — Per-model plan type (one message per model)

> `openai/gpt-5.5` 是按订阅计费还是按用量计费？
> [📦 订阅 / 套餐]   [💰 按量付费]   [❓ 不确定]   [跳过]

Answer is stored in `routerWizardConfig.models[modelKey].planType`. The wizard
keeps a "queue" of remaining models and updates the same message thread as
each one is answered.

If the user clicks `❓ 不确定`, the wizard saves `planType: "unknown"` and
explains in a follow-up: "我会按按量付费来对待，路由的时候不会把它当免费。"

#### Step 3 — Budget

> 你这个月的总预算上限是多少（美元）？
> [< 20]  [20-100]  [100-500]  [500+]  [不设上限]  [跳过]

#### Step 4 — Privacy

> 子任务能不能用云端模型？
> [✅ 都可以]   [🏠 只能本地 / on-prem]   [我来挑]   [跳过]

#### Step 5 — Restricted models

Only shown if user picked "我来挑" in step 4 OR has > 6 configured models.

> 哪些模型必须禁用？（合规 / 测试隔离）
> 多选菜单：`openai/gpt-5.5`, `openai/gpt-5-mini`, …
> [确认]  [跳过]

#### Step 6 — Same-provider candidate discovery

The wizard scans market prices and surfaces cheaper candidates **from the same
providers the user already authenticated to**. No new API keys requested.

> 我在你已经配置的 OpenAI 下面发现了：
>  • `openai/gpt-5-mini` （已在你的配置里）
>  • `openai/gpt-5-nano` （未配置 - 大约比 gpt-5-mini 便宜 60%）
>  • `openai/gpt-4o-mini` （未配置 - 大约比 gpt-5-mini 便宜 40%）
> 加进 shadow 候选？（不会影响 live 路由）
> [全部加]   [我来选]   [跳过]

If user clicks "我来选", a multi-select. If user accepts, wizard writes the
model into `openclaw.json` (see §5.2 for the writeback rules).

#### Step 7 — Done summary

> ✅ 配置完成
>  • 模型: 4 个 configured + 2 个 shadow proposal
>  • 预算: $100/月
>  • 隐私: 都可以
>  • 禁用: 无
> 之后用 `/octoclaw wizard` 调整，或 `octoclawctl router wizard --incremental` 加新模型。

### 4.4 State machine

```
state file: ~/.openclaw/octoclaw/router-wizard.state.json
{
  "schemaVersion": "octoclaw.router_wizard_state/v1",
  "thread": { "channel": "...", "ts": "..." },
  "step": "step-2-models",
  "remainingModels": ["openai/gpt-5.5","openai/gpt-5-mini",...],
  "answers": { "models": {...}, "budget": null, ... },
  "createdAt": "...",
  "updatedAt": "..."
}
```

Idempotency: any duplicated button click that arrives after `updatedAt` ≤ 30s
ago is silently dropped. Out-of-order clicks (user clicks a previous step's
button) post a message: "这一步已经回答过，要修改请用 `/octoclaw wizard reset
step-N`."

### 4.5 What happens when the user does nothing

- After 24 h with no progress, post a single nudge message: "向导还没完成，
  要继续吗？[继续] [放弃]"
- After 7 days, write defaults for all unanswered steps and finalize.
  The wizard never blocks routing.

### 4.6 Files to touch

```
extensions/octoclaw-runtime/src/im/slack/wizard/
  flow.ts              # state machine
  messages.ts          # message templates (zh/en)
  buttons.ts           # button id encode/decode
  state-store.ts       # load/save router-wizard.state.json
  index.ts

tools/octoclawctl/src/commands/router-wizard.ts
  # CLI fallback + slash command entry

packages/octoclaw-router/src/wizard/index.ts
  # extend with WizardState type, applyWizardAnswer(), ...
```

---

## 5. Provider Auth / Config Writeback

### 5.1 The conflict

Three possible write targets for "I want this model in my router":

1. `~/.openclaw/openclaw.json` (OpenClaw's own config)
2. `~/.openclaw/octoclaw/router-wizard.json` (router-only state)
3. `~/.openclaw/octoclaw/cost.sqlite` (cost tracking only)

Without rules, "approve a proposal in the wizard" could write to (1), (2), or
both. Probe could read auth from (1) or expect users to set env vars.

### 5.2 Decision

Three rules, no exceptions.

**Rule A — Single source of truth for credentials**: API keys, base URLs,
provider tokens **always** come from `~/.openclaw/openclaw.json`. The router
never stores credentials. If a credential is missing for a probe / shadow,
the operation fails with `error.code: "OPENCLAW_PROVIDER_NOT_CONFIGURED"`.

**Rule B — Router config is preferences only**: `router-wizard.json` stores
plan type, budget, privacy, restricted list, score overrides, dispreferred /
banned tags. **Never credentials, never base URLs, never model ids the user
hasn't seen.**

**Rule C — One-line writeback to OpenClaw config**: only the wizard's
`accept-proposal <model>` action writes to `openclaw.json`. The write is:

```
- locate the matching provider block by base URL (provider id is not a stable key)
- append model id to that provider's `models` array if absent
- never modify any other field
- emit a deterministic backup at openclaw.json.octoclaw-bak-<timestamp> first
- if backup write fails, abort with no change
```

If the matching provider block doesn't exist (user wants to add a model from a
provider they haven't configured), the wizard refuses and prints:

> 这个模型属于 `<provider>`，但你的 OpenClaw 还没配置这个 provider。请先在
> OpenClaw 里加 provider 凭证，再回向导。

### 5.3 Probe authorization

Probe uses the same `ProviderConfig` shape OpenClaw uses internally. The router
extracts only the fields it needs (auth header, base URL, request format) by
calling a small adapter:

```ts
// packages/octoclaw-router/src/capability/openclaw-bridge.ts
export interface ProviderConfig {
  providerId: string;
  baseUrl: string;
  authHeader: { name: string; value: string };
  format: "openai_chat" | "anthropic_messages" | "ollama";
}

export function resolveProviderForModel(
  modelKey: string,
  openclawConfig: unknown,
): ProviderConfig | null;
```

This adapter is **read-only**. Tests stub it; production reads
`openclaw.json` once per probe.

### 5.4 What never happens

- The router never calls `openclaw config set` or any other OpenClaw CLI to
  mutate config.
- The router never echoes the auth header value into logs, snapshots, shadow
  events, or error messages.
- The router never sends a probe to a base URL that wasn't read from
  `openclaw.json` or explicitly passed to `--base-url`.

---

## 6. Plan Quota Auto-Poll

Deferred to `parking/router-v3-wizard-and-release/` (already noted there).
This supplement just makes the parking explicit:

- **In V1.1**: `model.plan.quotaPressure` is set from the wizard answer only.
  No background poll. If user picks "subscription" but doesn't tell us when
  they're near the cap, we treat `quotaPressure: "unknown"`.
- **In V1.2 / parking**: provider-specific usage poll where supported
  (OpenAI, Anthropic, Z.AI) on a 1-hour interval. Below 10% remaining, the
  scoring engine adds `quota_low` to `reasonCodes` and demotes the model.

---

## 7. Acceptance for V1.1 (this supplement)

A V1.1 release of `@octoclaw/router` is acceptable when:

- [ ] `data/source-weights.json` exists with weights summing to 1.0 per scenario
- [ ] `capability/leaderboard/aider.ts` and `bfcl.ts` parsers exist with Zod schemas
- [ ] `capability/merge.ts` exports `fuseScenarioScore()` with freshness + health decay
- [ ] `scoring/index.ts` `capabilityScoreFor()` reads `scoreByScenario` first, falls back to tier defaults
- [ ] Packaged seed has ≥ 30 models
- [ ] `router capability lookup <model>` (snapshot read) and `router capability probe <model>` (real API) are separate commands
- [ ] `probe.ts` exists with budget guard and never auto-modifies `configured`
- [ ] `wizard accept-proposal <model>` is the only path that writes to `openclaw.json`
- [ ] Slack wizard 7-step flow exists in `extensions/octoclaw-runtime/src/im/slack/wizard/`
- [ ] `unconfigured` models can be `proposal_candidate` / `shadow_candidate` but never `live_candidate`
- [ ] Hard invariants in §3.4 covered by tests in `__tests__/integration/proposal-shadow-isolation.test.ts`

---

## 8. What this supplement does **not** change

- v3 §1 access decisions (sub-agent auto-switch yes, main agent never silently)
- v3 §2 design principles (judge-then-decision two layers, V1 极简)
- v3 §4 judge schema (`route / confidence / complexity` 3 fields)
- v3 §5.10 scoring formula (35/20/20/15/10) — only the input to `capability_score`
  changes
- v3 §5.11 promotion rules (sample thresholds, quality / cost gates)
- v3 §11 hard invariants 1–10 — they all stand, item 3 (`unconfigured models
  never go live`) is now explicit in §3.4 above
