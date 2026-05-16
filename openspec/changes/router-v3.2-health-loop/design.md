# Design: Auto Router V3.2

This file is the implementation-ready summary. Read
`docs/octoclaw-auto-router-v3.2-health-loop-2026-05-16.md` first for the why
and the full mapping against OpenClaw native commands; this file restates
only the contracts and file layout the implementer needs.

## Native commands we depend on

| Command | What we read | When |
|---------|--------------|------|
| `openclaw infer model run --model <key> --prompt <text> --json` | one-shot canary, returns `{ ok, provider, model, attempts, outputs }` | every probe |
| `openclaw models list --json` | per-model `available`, `tags` (default / fallback#N / configured) | scoring tie-break, fallback ordering |
| `openclaw models fallbacks list --json` | `{ fallbacks: [modelKey, ...] }` ordered list | scoring tie-break, suggestion generation |
| `openclaw status --usage --json` | per-provider quota windows | already wired in `model-intel.ts:692` |
| `openclaw gateway usage-cost --json --days N` | aggregate token + cost totals | already wired (cost report context) |
| `openclaw gateway stability --json --limit N` | gateway-wide stability events | context only, not per-model |

## Files to create

```
packages/octoclaw-router/src/
  health/
    event.ts                          [new]
    snapshot.ts                       [new]
    cooldown.ts                       [new]
    sink.ts                           [new]
    __tests__/
      cooldown.test.ts                [new]
      snapshot.test.ts                [new]
      sink.test.ts                    [new]
extensions/octoclaw-runtime/src/
  health/
    runtime-recorder.ts               [new]
    runtime-recorder.test.ts          [new]
tools/octoclawctl/src/
  commands/
    router-health.ts                  [new]
```

## Files to modify

```
packages/octoclaw-router/src/
  health/index.ts                     # extend ModelHealthTracker
  decision/contracts.ts               # extend RouterLiteHealth
  decision/model-intel.ts             # add healthFromHealthSnapshot
  scoring/index.ts                    # read native fallback list, tie-break
tools/octoclawctl/src/
  cli.ts                              # +router health, +health emit on probe
extensions/octoclaw-runtime/src/
  hooks/after-tool-call.ts            # call recordCall on delegated tool end
  hooks/agent-end.ts                  # call recordCall on delegated turn end
```

## Key contracts

### `HealthEvent`

```ts
export interface HealthEvent {
  schemaVersion: "octoclaw.router.health_event/v1";
  ts: number;
  modelKey: string;
  source: "runtime" | "probe";
  success: boolean;
  errorCode?: string;
  latencyMs?: number;
  toolCallFailed?: boolean;
  timeout?: boolean;
  evidence?: { runId?: string; sessionKey?: string; httpStatus?: number };
}
```

### `ModelHealthSnapshot`

```ts
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
  windowMs: number;
  windowSize: number;
  models: Record<string, PerModelHealth>;
}
```

### `HealthEventSink` (single API)

```ts
export interface HealthEventSink {
  recordCall(event: Omit<HealthEvent, "schemaVersion" | "ts"> & { ts?: number }): void;
  flush(): Promise<void>;       // fsync jsonl
  aggregate(now?: number): Promise<ModelHealthSnapshot>; // reads jsonl, prunes >7d
}

export function createHealthEventSink(options: {
  jsonlPath?: string;            // default ~/.openclaw/octoclaw/router-lite/model-health.jsonl
  snapshotPath?: string;         // default ~/.openclaw/octoclaw/router-lite/model-health-snapshot.json
  windowMs?: number;             // default 30 * 60 * 1000
  windowSize?: number;           // default 50
  retentionMs?: number;          // default 7 * 24 * 60 * 60 * 1000
}): HealthEventSink;
```

### Cooldown rules (`cooldown.ts`)

Pure function:

```ts
export function evaluateCooldown(input: {
  events: HealthEvent[];          // events for one model, in window
  now: number;
  baselineP95Ms?: number;
}): { cooldown: boolean; cooldownUntil?: number; reason?: CooldownReason };
```

Rules (in order; first match wins):

| Condition | Result |
|-----------|--------|
| Most recent event has `errorCode === "429"` or `errorCode === "rate_limit"` | `cooldown=true`, `cooldownUntil = now + 10*60_000`, `reason=rate_limit_429` |
| Most recent event has `source==="probe"` and `success===false` | `cooldown=true`, `cooldownUntil = now + 30*60_000`, `reason=probe_failure` |
| `events.length >= 10` and failure rate `>= 0.20` | `cooldown=true`, `cooldownUntil = now + 30*60_000`, `reason=high_failure_rate` |
| `events.length >= 10`, `baselineP95Ms` known, `currentP95 > 2.5 * baselineP95Ms` | `cooldown=true`, `cooldownUntil = now + 15*60_000`, `reason=high_p95_drift` |
| Otherwise | `cooldown=false` |

Recovery: caller passes `now > cooldownUntil`, function returns `cooldown=false`.

### `RouterLiteHealth` extension

```ts
export interface RouterLiteHealth {
  // existing fields stay
  cooldownReason?: CooldownReason;
  cooldownUntil?: number;
  lastSuccessfulCallAt?: string;     // ISO
  lastFailedCallAt?: string;         // ISO
  lastErrorCodes?: Array<{ code: string; count: number }>;
}
```

### Native fallback integration

```ts
// scoring/index.ts adds one input
export interface ScoringContext {
  // ... existing
  nativeFallbackOrder?: string[];   // from openclaw models fallbacks list
  nativeDefaultModel?: string;      // from openclaw models list (tags includes "default")
}
```

Tie-break rule: when two models have the same final score within 0.01,
prefer in this order:
1. `nativeDefaultModel`
2. earlier position in `nativeFallbackOrder`
3. lower `marketPrice.blendedUsdPerMTok`

### `router_native_fallback_suggestion` event

Written to `~/.openclaw/octoclaw/router-lite/decisions.log` alongside existing
promotion decisions:

```jsonc
{
  "ts": "2026-05-16T...",
  "event": "router_native_fallback_suggestion",
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

## Hard invariants

1. The jsonl is the source of truth; the snapshot is derived and regenerable.
2. `recordCall` failure must never break the live route. Wrap every call site
   in try/catch with a one-time logger.warn.
3. The router never executes `openclaw models fallbacks add/remove` itself.
4. Probe success never sets `cooldown`. Probe failure may set it.
5. Aggregator is pure: same input jsonl → same snapshot bytes.
6. `model-health.jsonl` retention is hard-capped at 7 days; pruning runs on
   every aggregation.
7. No `HealthEvent` ever contains auth header / API key / full prompt /
   response body. Only model id, error code, timing, and ids.
8. Gateway stability events are context only, never trigger per-model
   cooldown.

## Test strategy

| Test | File | Coverage |
|------|------|----------|
| Cooldown rules matrix | `cooldown.test.ts` | 4 triggers + recovery + insufficient samples |
| Aggregator determinism | `snapshot.test.ts` | same jsonl → same snapshot; pruning at 7d boundary; window-size cap |
| Sink atomic write | `sink.test.ts` | jsonl append, fsync, recovery from corrupt line |
| Runtime recorder | `runtime-recorder.test.ts` | success / failure / timeout paths; never throws |
| Probe → health integration | extend existing `probe.test.ts` | probe ok writes success event; probe fail writes fail + sets cooldown |
| Scorer native fallback tie-break | extend existing scoring tests | default wins; fallback#1 over fallback#2; not_in_native_fallback_list reason |
| Suggestion generation | new test | cooled-down fallback#N triggers one suggestion; not-in-list does not |
| End-to-end | `__tests__/integration/health-loop.test.ts` | 30 simulated calls produce expected cooldown + reasonCodes in next route |
