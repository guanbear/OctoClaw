# Design: Auto Router V3.1

This file pulls the implementation-relevant parts of
`docs/octoclaw-auto-router-v3-supplement-2026-05-15.md` into change-package
shape. Read the supplement first; this file only restates the contracts and
file layout the implementer needs.

## Files to create

```
packages/octoclaw-router/src/
  data/source-weights.json                    [new]
  capability/leaderboard/                     [new dir]
    aider.ts
    bfcl.ts
    types.ts
    fixtures/
      aider.sample.yaml
      bfcl.sample.json
  capability/probe.ts                         [new]
  capability/openclaw-bridge.ts               [new]
  capability/__tests__/
    fuse-scenario-score.test.ts               [new]
    leaderboard-aider.test.ts                 [new]
    leaderboard-bfcl.test.ts                  [new]
    probe.test.ts                             [new]
  __tests__/integration/
    proposal-shadow-isolation.test.ts         [new]
    wizard-slack-flow.test.ts                 [new]

extensions/octoclaw-runtime/src/im/slack/wizard/  [new dir]
  flow.ts
  messages.ts
  buttons.ts
  state-store.ts
  index.ts
  __tests__/
    flow.test.ts
    state-store.test.ts

tools/octoclawctl/src/commands/
  router-wizard.ts                            [new — CLI entry + slash route]
```

## Files to modify

```
packages/octoclaw-router/src/
  capability/merge.ts                         [add fuseScenarioScore + apply in models]
  capability/refresh.ts                       [call leaderboard parsers, write fused scores]
  capability/sources.ts                       [no change — keep existing 3 metadata fetchers]
  scoring/index.ts                            [capabilityScoreFor reads scoreByScenario]
  decision/contracts.ts                       [add ModelIntelLite.capability.scoreByScenario]
  wizard/index.ts                             [add accept-proposal writeback, new states]
  index.ts                                    [export new public API]

scripts/refresh-leaderboard-snapshot.mjs      [extend with leaderboard parsers + seed check]

tools/octoclawctl/src/cli.ts
  - rename current "capability probe" to "capability lookup"
  - add new "capability probe" → real API call
  - add "router wizard accept-proposal <model>"
  - register Slack slash route /octoclaw wizard
```

## Key contracts

### `FusedScore`

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
  score: number;
  confidence: "high" | "medium" | "low" | "unknown";
  contributions: ScoredSourceContribution[];
  reasonCodes: string[];
}
```

Freshness factor tiers:

```
< 30 days  → 1.00
30–90 days → 0.70
90–180 days → 0.40
> 180 days → 0.15
```

Source health (last 4 fetch outcomes per source):

```
4/4 ok → 1.00
3/4 ok → 0.75
2/4 ok → 0.50
1/4 ok → 0.25
0/4 ok → 0.00 (effectively dropped)
```

Confidence:

```
sum(effectiveWeight) >= 0.7 → high
sum >= 0.4                  → medium
sum > 0                     → low
sum == 0                    → unknown
```

### `ProbeRequest` / `ProbeResult`

```ts
export interface ProbeRequest {
  modelKey: string;
  providerConfig: ProviderConfig;
  timeoutMs: number;       // default 5000
  budgetUsdMax: number;    // default 0.001
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
  evidence: Array<{
    source: "http_status" | "response_body" | "exception";
    detail: string;
  }>;
}
```

Probe canary message (`max_tokens: 16`, `temperature: 0`, single tool):

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

### Model state additions

`ModelIntelLite.capability.scoreByScenario` (optional). When absent, scoring
falls back to `TIER_SCORE[codingTier] × confidenceMultiplier`.

```ts
interface ModelIntelLite {
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

New non-`configured` flow states (none of which are eligible for live):

```
discovered  →  probed_ok  →  proposal_candidate  →  shadow_candidate

shadow_candidate → live ONLY when configured === true AND promotion gate
  passes.
```

### Provider bridge (read-only)

```ts
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

### Wizard state file

```
~/.openclaw/octoclaw/router-wizard.state.json
{
  "schemaVersion": "octoclaw.router_wizard_state/v1",
  "thread": { "channel": "...", "ts": "..." },
  "step": "step-2-models",
  "remainingModels": ["openai/gpt-5.5", ...],
  "answers": { "models": {...}, "budget": null, "privacy": null, ... },
  "createdAt": "...",
  "updatedAt": "..."
}
```

Idempotency: duplicate clicks within 30 s are dropped; out-of-order clicks
post a "step already answered" message. After 24 h idle, single nudge; after
7 d idle, defaults are written.

## Hard invariants

1. Probe **never** modifies `model.configured`. Only `wizard accept-proposal`
   writes to OpenClaw config.
2. `unconfigured` model in any flow state cannot enter `live` promotion state.
3. The router never stores credentials. All auth comes from
   `~/.openclaw/openclaw.json` via `resolveProviderForModel()`.
4. Probe `budgetUsdMax` is enforced **before** sending the request (using
   market price from snapshot). Refuse if cost would exceed cap.
5. Auth header values never appear in logs, snapshots, shadow events, or
   error messages.
6. Slack wizard never blocks live routing. After 7 d idle, defaults are
   written and the wizard finalizes itself.
7. Source weights inside one scenario must sum to 1.0; renormalization happens
   per-model when sources are missing.
8. Schema mismatch in any leaderboard parser returns `[]` and marks that
   source's health as 0.0 for the next cycle. Never throws to caller.

## Test strategy

| Test | Where | Coverage |
|------|-------|----------|
| `fuse-scenario-score.test.ts` | `capability/__tests__/` | freshness × health × weight matrix; renormalization; 0-source case; 4-source case |
| `leaderboard-aider.test.ts` | same | sample fixture parses; bad fixture returns []; tier inference correct |
| `leaderboard-bfcl.test.ts` | same | YAML fixture parses; agentic vs coding_worker scenario routing |
| `probe.test.ts` | same | budget guard refuses overspend; 200 ok → tool call detected; 401 → authOk=no; 404 → modelExists=no; timeout → ok=false |
| `proposal-shadow-isolation.test.ts` | `__tests__/integration/` | discovered → probed_ok → proposal_candidate → shadow_candidate, but never live without configured=true |
| `wizard-slack-flow.test.ts` | same | 7-step happy path; resume from step 4; idempotent dup clicks; 7-day timeout finalize |
| `wizard-state-store.test.ts` | `im/slack/wizard/__tests__/` | atomic write; corrupt file recovery |
