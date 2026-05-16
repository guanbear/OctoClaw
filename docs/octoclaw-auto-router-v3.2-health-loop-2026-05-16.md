# Auto Router V3.2 — Model Health Loop (2026-05-16)

Status: design supplement. Builds on
`docs/octoclaw-auto-router-v3-supplement-2026-05-15.md` (V3.1).

This document closes the model-health gap identified during V3.1 review. The
big change versus the original V3 baseline is: **we do not build a parallel
health/fallback subsystem. We map our health signals onto OpenClaw's native
fallback list and reuse OpenClaw's runner/auth/cost machinery wherever it
already exists.**

---

## 0. What OpenClaw already gives us (and what we stop building)

Verified against `openclaw 2026.5.5`:

| OctoClaw V3 plan said we need… | OpenClaw native already does it | Decision |
|--------------------------------|--------------------------------|----------|
| One-shot canary call to a model with auth handled | `openclaw infer model run --model <key> --prompt <text> --json` (returns `ok / provider / model / outputs`) | **Reuse.** Probe shells to this. We do not write provider HTTP clients. |
| Provider auth resolution per model | `openclaw models status --json` returns each provider's auth profile, expiry, and source | **Reuse.** `openclaw-bridge.ts` reads this instead of parsing `openclaw.json`. |
| List of fallback models with per-model `tags: ["fallback#1", "configured", ...]` and `available: true/false` | `openclaw models list --json` and `openclaw models fallbacks list --json` | **Reuse.** Our `live` recommendation respects the native fallback list as ground truth. |
| Mutate the fallback list | `openclaw models fallbacks add/remove/clear <model>` | **Reuse.** Our cooldown action is "ask user / auto-shuffle the OpenClaw fallback list", not "maintain a shadow list inside the router". |
| Provider quota / usage windows | `openclaw status --usage --json` returns `{providers:[{provider, windows:[{label,usedPercent,resetAt}]}]}` | **Already wired** in `model-intel.ts:692` (`healthFromUsageStatus`). Keep using it. |
| Aggregate cost / token totals over N days | `openclaw gateway usage-cost --json --days N` | **Reuse.** We do not maintain our own cost SQLite for "what did I spend last week". `cost.sqlite` keeps **router-level** events only (per-decision shadow events, per-probe outcome). |
| Gateway-level stability events (heartbeat, memory pressure, queue depth) | `openclaw gateway stability --json --limit N` returns `{events:[{seq,ts,type,...}], summary:{byType,memory}}` | **Reuse for context.** Stability events are gateway-wide, not per-model, so they go in `degraded` reasoning, not in per-model health scoring. |

What we **still** build (because OpenClaw doesn't):

1. Per-call latency / failure / errorCode aggregation **per model**, with a
   30-min sliding window. (OpenClaw aggregates by gateway, not by model.)
2. Per-model `cooldown` decision policy (when to mark a model as cooled down,
   for how long, on what evidence).
3. The translation layer that takes our per-model verdict and turns it into a
   concrete OpenClaw native action (reorder fallbacks, log a recommendation,
   surface in the IM footer).

That's the entire V3.2 scope. Two thin layers, both informed by OpenClaw's
existing surface.

---

## 1. Goals and non-goals

### 1.1 Goals

1. Every model call (delegated turn or `capability probe`) emits one
   `HealthEvent` to a single sink.
2. The sink aggregates last 50 calls / 30 min per model into a snapshot.
3. `model-intel-snapshot.json` is written with the aggregated snapshot, so
   `scoring/index.ts` can read it on the next decision.
4. Cooldown is enforced **only** by the scorer (already implemented). Our new
   work is to make sure `health.cooldown` is correctly set.
5. When a `live_candidate` is in cooldown and its tier has at least one
   alternative, the runtime emits a `router_native_fallback_suggestion` event
   with a concrete `openclaw models fallbacks add/remove ...` patch the user
   can apply.
6. The CLI (and Slack footer) can answer "why was model X cooled down?" with
   a one-line evidence summary.

### 1.2 Non-goals (V3.2)

- No automatic mutation of `openclaw models fallbacks`. That stays
  user-action-only, same as `wizard accept-proposal`.
- No automatic re-probe loop. Probe stays manual CLI in V3.2; a periodic
  re-probe lands later.
- No global gateway health gating. We surface gateway stability for context
  but do not block routing on it.
- No new web UI. Everything is CLI + IM footer.

---

## 2. Architecture

### 2.1 The single sink

```
┌─────────────────────────────────────────────────┐
│ HealthEventSink                                 │
│   recordCall(modelKey, result)                  │  one-line API
│                                                 │
│   internal:                                     │
│   - in-memory ModelHealthTracker                │  already exists at
│   - persist to ~/.openclaw/octoclaw/             │  packages/octoclaw-router/
│       router-lite/model-health.jsonl            │  src/health/index.ts
│   - on shutdown: flush                          │
└─────────────────────────────────────────────────┘
            ↑                          ↑
            │                          │
   delegated turn                 capability probe
   (after_tool_call,             (tools/octoclawctl/
    agent_end hooks)              src/cli.ts)
            │                          │
            │                          │
            └──────── one shape ───────┘
            HealthEvent {
              ts: number
              modelKey: string
              source: "runtime" | "probe"
              success: boolean
              errorCode?: string
              latencyMs?: number
              toolCallFailed?: boolean
              timeout?: boolean
            }
```

Both runtime delegated turns and probe calls share the **same** event shape
and the **same** sink. There is no "probe-only" path.

### 2.2 The aggregation layer

```
HealthSnapshotter.aggregate(jsonl) →
  ModelHealthSnapshot {
    [modelKey]: {
      sampleCount: number
      windowStartedAt: number
      windowEndedAt: number
      recentFailureRate: number
      toolCallFailureRate: number
      timeoutRate: number
      p50LatencyMs: number
      p95LatencyMs: number
      cooldown: boolean
      cooldownUntil?: number
      cooldownReason?: "rate_limit_429" | "high_failure_rate" | "probe_failure" | "high_p95_drift"
      lastErrorCodes: Array<{ code: string; count: number }>  // top 3
      lastSuccessfulCallAt?: number
      lastFailedCallAt?: number
    }
  }
```

This is the sole input to `model-intel.ts`'s health merge step. Today
`healthFromUsageStatus()` only consumes `openclaw status --usage`. We add
`healthFromHealthSnapshot()` that reads our aggregated jsonl and merges into
the same `ModelIntelLite.health` field.

### 2.3 Layered priority (when health signals disagree)

For a single model in a single snapshot:

```
1. router cooldown (from our recordCall aggregation)         ← highest
2. openclaw status --usage quotaPressure                      ← already wired
3. openclaw models list `available: false`                    ← treated as unavailable
4. openclaw gateway stability degraded modes                  ← context only,
                                                                 no per-model action
```

If our aggregation says cooldown but OpenClaw `available: true`, our cooldown
wins. If OpenClaw `available: false`, both agree. If OpenClaw says
`quotaPressure: high` and our recentFailureRate is low, we still demote (cost
score), but do not cool down.

### 2.4 What runs where

| Component | Process | Runs on |
|-----------|---------|---------|
| `recordCall` from runtime | inside the OctoClaw plugin in OpenClaw gateway | every delegated turn end |
| `recordCall` from probe | inside `octoclawctl` CLI | per probe invocation |
| `aggregate` | inside `octoclawctl router model-intel refresh` and on plugin startup | manually via CLI; auto on plugin boot |
| `health → snapshot merge` | inside `model-intel.ts:buildModelIntelSnapshot` | when refresh writes snapshot |
| Cooldown decision | inside `recordCall` (uses sliding-window state) | per call, no cron |
| Native fallback suggestion | inside the runtime, on next route after a cooldown trip | per route |

No background daemons, no extra processes, no cron. Same posture as V1.

---

## 3. Schema additions

### 3.1 `HealthEvent` (new, shared by runtime and probe)

```ts
// packages/octoclaw-router/src/health/event.ts
export interface HealthEvent {
  schemaVersion: "octoclaw.router.health_event/v1";
  ts: number;                       // epoch ms
  modelKey: string;
  source: "runtime" | "probe";
  success: boolean;
  errorCode?: string;               // raw provider code, e.g. "429", "401", "TIMEOUT"
  latencyMs?: number;
  toolCallFailed?: boolean;         // tool was requested but tool call failed
  timeout?: boolean;                // request hit the configured timeout
  evidence?: {
    runId?: string;
    sessionKey?: string;
    httpStatus?: number;
  };
}
```

### 3.2 `ModelHealthSnapshot` (new, what aggregation produces)

```ts
// packages/octoclaw-router/src/health/snapshot.ts
export type CooldownReason =
  | "rate_limit_429"
  | "high_failure_rate"
  | "probe_failure"
  | "high_p95_drift";

export interface PerModelHealth {
  sampleCount: number;
  windowStartedAt: number;
  windowEndedAt: number;
  recentFailureRate: number;
  toolCallFailureRate: number;
  timeoutRate: number;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  cooldown: boolean;
  cooldownUntil?: number;
  cooldownReason?: CooldownReason;
  lastErrorCodes: Array<{ code: string; count: number }>;
  lastSuccessfulCallAt?: number;
  lastFailedCallAt?: number;
}

export interface ModelHealthSnapshot {
  schemaVersion: "octoclaw.router.health_snapshot/v1";
  generatedAt: number;
  windowMs: number;            // typically 30 * 60 * 1000
  windowSize: number;           // typically 50
  models: Record<string, PerModelHealth>;
}
```

### 3.3 `RouterLiteHealth` extension (modify `decision/contracts.ts`)

```ts
export interface RouterLiteHealth {
  // ... existing fields
  cooldownReason?: CooldownReason;
  cooldownUntil?: number;
  toolCallFailureRate?: number;     // already declared, just unused
  timeoutRate?: number;             // already declared, just unused
  lastSuccessfulCallAt?: string;    // ISO
  lastFailedCallAt?: string;        // ISO
}
```

(Most fields already exist on `RouterLiteHealth`; we're only adding the
cooldown reason/until and timestamps. The whole point is to **stop having
unused fields and start populating them**.)

### 3.4 New file paths

```
~/.openclaw/octoclaw/router-lite/
  model-health.jsonl            # append-only HealthEvent log, rotated daily
  model-health-snapshot.json    # aggregated ModelHealthSnapshot, written by aggregator
```

`model-health.jsonl` retention: **last 7 days**. Older lines are dropped on
the next aggregation pass.

---

## 4. Cooldown policy (replaces today's hard-coded 20% rule)

### 4.1 Triggers

Set `cooldown = true` when **any** of:

| Condition | Cooldown duration | Reason code |
|-----------|-------------------|-------------|
| HTTP 429 / `rate_limit` errorCode in last call | 10 min | `rate_limit_429` |
| `recentFailureRate >= 0.20` over ≥ 10 samples | 30 min | `high_failure_rate` |
| Probe call failed in last 30 min and previously was passing | 30 min | `probe_failure` |
| `p95LatencyMs > 2.5 × baselineP95` over ≥ 10 samples (V3.2: optional, behind feature flag) | 15 min | `high_p95_drift` |

A model with **fewer than 10 samples** in window can only be cooled down by
the rate_limit_429 rule (one-call evidence is enough for explicit 429) or
explicit probe failure.

### 4.2 Recovery

- Cooldown auto-clears at `cooldownUntil`. No manual reset needed.
- The next successful call (latency ≤ baseline, no errorCode) clears the
  cooldown immediately if `cooldownUntil` has not yet been reached.
- An error within 5 minutes after auto-clear extends cooldown by another full
  window (re-cool).

### 4.3 Baseline

Per-model `baselineP95LatencyMs` is the **median p95 across the last 7 daily
windows** before today, persisted in `model-health-snapshot.json`. If fewer
than 3 daily windows are available, the drift rule is skipped (no
`high_p95_drift` cooldown).

### 4.4 What the scorer does (no change to formula)

The existing `scoring/index.ts` already excludes cooled-down models via
`getRejectionReason()`. After V3.2:

- Same exclusion behavior, but `health.cooldown` is now populated by real
  data, not an empty default `false`.
- `reasonCodes` on the recommendation gets one new entry:
  `cooldown:<reason>:<modelKey>` for every excluded model. Surfaces in the
  IM footer and in `router decisions`.

---

## 5. Native fallback integration

### 5.1 Read path: live recommendation respects native fallback list

Today the scorer treats all configured models as equally eligible at their
tier. In V3.2 it reads `openclaw models fallbacks list --json` (cached, 5-min
TTL) and:

- If a model is the user's `default` model (tag `default` from
  `openclaw models list --json`), it's preferred when scores tie.
- If a model has tag `fallback#N`, it's only chosen when the default and
  earlier fallbacks are unavailable / cooled-down. We **respect the user's
  ordering**.
- If our scorer wants to recommend a model that isn't in the native list at
  all, we still surface the recommendation but tag it
  `not_in_native_fallback_list` in `reasonCodes`.

This makes the router transparent on top of OpenClaw native fallback. A user
who never opens the wizard still benefits.

### 5.2 Write path: suggest native fallback edits, never apply

When our aggregation cools a model down and that model is a `fallback#N` in
the native list, the runtime emits one event per cooldown:

```jsonc
{
  "event": "router_native_fallback_suggestion",
  "ts": 1778900000000,
  "modelKey": "openai/gpt-5.5",
  "currentNativePosition": "fallback#1",
  "cooldownReason": "high_failure_rate",
  "evidence": { "recentFailureRate": 0.32, "sampleCount": 24 },
  "suggestedAction": {
    "command": "openclaw models fallbacks remove openai/gpt-5.5",
    "explanation": "Cooldown observed; consider demoting this fallback while it stabilizes"
  }
}
```

The user (or their agent) decides whether to apply. We **never** auto-apply.
This is the same trust posture as `wizard accept-proposal`.

### 5.3 IM footer and CLI surfaces

`octoclawctl router health show <model> [--json]` (new):

```
openai/gpt-5.5
  state:           cooldown   (until 14:32, 28 min)
  reason:          high_failure_rate
  samples:         24 in 30 min
  failureRate:     0.32
  toolCallFail:    0.08
  p50 / p95:       1850ms / 7200ms  (baseline p95: 3100ms, 2.3× drift)
  recent errors:   503 (8x), 502 (3x), TIMEOUT (2x)
  native role:     fallback#1
  suggestion:      openclaw models fallbacks remove openai/gpt-5.5
```

`octoclawctl router health list [--json]` shows all models, sorted by
`cooldown DESC, recentFailureRate DESC`.

IM footer (when a delegated turn picked a non-default model because the
default was cooled down):

```
🤖 spawned: zhipu/glm-5.1 (fallback#1)
   reason: openai/gpt-5.5 cooled down (failure_rate=0.32 / 24 samples)
```

---

## 6. Probe ↔ health integration (closes the V3.1 gap)

V3.1 says probe records `lastProbeAt`, `lastProbeOk`, `lastProbeLatencyMs`
on the **wizard config**. V3.2 changes that:

1. Probe **also** writes a `HealthEvent` with `source: "probe"`.
2. Probe success / failure feeds the same aggregation that runtime calls do.
3. `lastProbeAt` / `lastProbeOk` / `lastProbeLatencyMs` stay on the wizard
   config (they gate `accept-proposal`), but the **health snapshot** owns the
   `cooldown` decision.

This means: a model that probe failed enters cooldown via the same path as a
model that runtime calls failed. There is one cooldown signal, not two.

---

## 7. CLI surface (V3.2)

### 7.1 New commands

```bash
octoclawctl router health show <model> [--json]
octoclawctl router health list [--json] [--cooldown-only]
octoclawctl router health aggregate                        # one-shot recompute snapshot from jsonl
octoclawctl router health suggest-fallbacks                # list pending router_native_fallback_suggestion events
```

### 7.2 Modified commands

`octoclawctl router model-intel refresh`:

- After existing snapshot build, also runs `health.aggregate()` and merges
  result into `model.health.*` fields.
- New output line: `Health: <N> models, <M> in cooldown.`

`octoclawctl router capability probe <model>`:

- Existing real-API probe (V3.1) stays.
- After probe, additionally emits a `HealthEvent` with `source: "probe"`.

`octoclawctl router decisions`:

- Adds optional `--include-cooldown-suggestions` flag that interleaves
  `router_native_fallback_suggestion` events into the decisions log.

---

## 8. File layout

```
packages/octoclaw-router/src/
  health/
    index.ts              # ModelHealthTracker (existing, extend)
    event.ts              # HealthEvent type + writer (new)
    snapshot.ts           # ModelHealthSnapshot type + aggregator (new)
    cooldown.ts           # cooldown decision rules (new)
    sink.ts               # HealthEventSink (new) — writes jsonl + updates tracker
    __tests__/
      cooldown.test.ts
      snapshot.test.ts
      sink.test.ts
  decision/
    contracts.ts          # extend RouterLiteHealth (modify)
    model-intel.ts        # add healthFromHealthSnapshot() (modify)

extensions/octoclaw-runtime/src/
  health/
    runtime-recorder.ts   # hooks into after_tool_call / agent_end (new)
    runtime-recorder.test.ts

tools/octoclawctl/src/
  cli.ts                  # +health show/list/aggregate (modify)
  commands/router-health.ts  # new
```

---

## 9. Interaction with V3.1 supplement

| V3.1 surface | V3.2 change |
|--------------|-------------|
| `capability probe` | Adds one `HealthEvent` write. |
| `wizard accept-proposal` | No change. Still gated by `lastProbeOkAt` on wizard config. |
| Source weights / fusion | No change. Capability score and health score are independent in scoring formula. |
| `unconfigured` flow states | No change. Health applies only to `configured` models that produce real call data. |
| Slack wizard | No change. (V3.2 footer additions are runtime-only, not wizard.) |

---

## 10. Hard invariants

1. Health snapshot is **derived** state. The jsonl event log is the source of
   truth; `model-health-snapshot.json` is regenerable.
2. Cooldown can be set from probe-only evidence, but **only if** the probe
   failed (positive signal). A passing probe never sets cooldown.
3. The router **never** modifies `openclaw models fallbacks`. It emits
   suggestions only.
4. `recordCall` is always called inside a try/catch in the runtime hook.
   Failure to write a HealthEvent must not break the live route.
5. The aggregator is pure: same jsonl → same snapshot, deterministic.
6. `model-health.jsonl` retention is hard-capped at 7 days. Aggregator
   prunes on every run.
7. No HealthEvent ever contains an auth header, API key, or full prompt.
   Only modelKey / errorCode / timing.
8. Gateway stability events (`openclaw gateway stability`) are read-only
   context and never directly trigger per-model cooldown.

---

## 11. Phased delivery

| WP | What | Estimate |
|----|------|----------|
| WP-A | `HealthEvent` type, writer, jsonl sink, retention; tests | 1 day |
| WP-B | Aggregator producing `ModelHealthSnapshot`; cooldown rules; tests | 1.5 days |
| WP-C | `runtime-recorder.ts` hooks into `after_tool_call` / `agent_end`; tests | 1 day |
| WP-D | Probe emits HealthEvent; merge into `recordCall`; tests | 0.5 day |
| WP-E | `model-intel.ts` reads health snapshot, merges into ModelIntelLite | 0.5 day |
| WP-F | Native fallback list read in scorer; tie-break + reasonCodes | 1 day |
| WP-G | `router_native_fallback_suggestion` event + footer rendering | 0.5 day |
| WP-H | CLI: `health show / list / aggregate / suggest-fallbacks` | 1 day |

Total: **~7 days**, single track.

WP-A → WP-B → WP-C / WP-D in parallel → WP-E → WP-F / WP-G / WP-H in parallel.
