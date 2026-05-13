# Design: Auto Router Lite Wiring 0.5.x

## 1. Architecture

```text
policy-resolver.ts (existing)
  └─ resolvePolicyDecisionForContext()
        ├─ returns PolicyDecision (unchanged)
        └─ emitRouterLiteShadowEvent(…)  ← new side-effect, try/catch guarded
              ├─ loadRouterLiteSnapshot()    → ModelIntelSnapshot | null
              ├─ buildRouterLiteRequest()    → RouterLiteRequest | null
              ├─ selectShadowRecommendation(request, snapshot)  [policy pkg]
              └─ writeShadowEvent(event, path)                  [policy pkg]
```

No change to the live return value of `resolvePolicyDecisionForContext`. The shadow emission runs **after** the decision is finalized and **before** the replay record is written — this ordering ensures that an exception in shadow does not prevent the authoritative policy replay from being recorded.

## 2. Files

### 2.1 New files

- `extensions/octoclaw-runtime/src/router-lite/snapshot-loader.ts`
- `extensions/octoclaw-runtime/src/router-lite/request-builder.ts`
- `extensions/octoclaw-runtime/src/router-lite/shadow-bridge.ts`
- `extensions/octoclaw-runtime/src/router-lite/__tests__/snapshot-loader.test.ts`
- `extensions/octoclaw-runtime/src/router-lite/__tests__/request-builder.test.ts`
- `extensions/octoclaw-runtime/src/router-lite/__tests__/shadow-bridge.test.ts`

### 2.2 Modified files

- `extensions/octoclaw-runtime/src/resolve/policy-resolver.ts` — one call site at end of decision path.
- `tools/octoclawctl/src/cli.ts` — new `router shadow-report` sub-command dispatch.
- `tools/octoclawctl/src/cli.test.ts` — test for the new sub-command.

### 2.3 Contract surface

No new exports from `@octoclaw/contracts`. All new types are internal to the runtime.

## 3. Snapshot Loader

```ts
const DEFAULT_SNAPSHOT_PATH_ENV = "OCTOCLAW_ROUTER_SNAPSHOT_PATH";
const SNAPSHOT_CACHE_TTL_MS = 60_000;

interface CachedSnapshot {
  snapshot: ModelIntelSnapshot;
  loadedAt: number;
  mtimeMs: number;
  path: string;
}

let cached: CachedSnapshot | null = null;

export function resolveSnapshotPath(workspaceRoot?: string): string {
  const override = process.env[DEFAULT_SNAPSHOT_PATH_ENV];
  if (override) return override;
  const root = workspaceRoot || resolveWorkspaceRoot();
  return path.join(root, "tmp", "octopus", "router-lite", "model-intel-snapshot.json");
}

export function loadRouterLiteSnapshot(workspaceRoot?: string): ModelIntelSnapshot | null {
  const targetPath = resolveSnapshotPath(workspaceRoot);
  try {
    const stat = fsSync.statSync(targetPath);
    const now = Date.now();
    if (cached && cached.path === targetPath && cached.mtimeMs === stat.mtimeMs && (now - cached.loadedAt) < SNAPSHOT_CACHE_TTL_MS) {
      return cached.snapshot;
    }
    const raw = fsSync.readFileSync(targetPath, "utf-8");
    const parsed = JSON.parse(raw) as ModelIntelSnapshot;
    if (!isValidSnapshot(parsed)) return null;
    cached = { snapshot: parsed, loadedAt: now, mtimeMs: stat.mtimeMs, path: targetPath };
    return parsed;
  } catch {
    return null;
  }
}
```

**Contract**: fail-open. Any exception returns `null`. The caller interprets `null` as "no snapshot available; skip shadow emission entirely".

**Validation**: `isValidSnapshot()` checks `schemaVersion === "octoclaw.router_lite.model_intel_snapshot/v1"` and that `models` is an array. Any mismatch returns null.

## 4. Request Builder

```ts
export interface RouterLiteRuntimeSignals {
  channel?: "slack" | "feishu" | "wechat" | "cli" | "unknown";
  contextTokens?: number;
  needsTools?: boolean;
  needsReasoning?: boolean;
  needsStructuredOutput?: boolean;
  minContextTokens?: number;
  statusOrProvenanceRequest?: boolean;
  sessionControlRequest?: boolean;
  explicitOverride?: string;
}

export function buildRouterLiteRequest(input: {
  sessionKey: string;
  turnId: string;
  liveRoute: RouterLiteRoute;
  actualModel: string | undefined;
  judge: {
    route?: string;
    confidence?: number;
    complexity?: string;
    complexityConfidence?: number;
  } | null;
  runtimeSignals: RouterLiteRuntimeSignals;
  snapshotId: string;
}): RouterLiteRequest | null {
  // Required: judge present with all four fields and valid enum values.
  if (!input.judge?.route) return null;
  if (typeof input.judge.confidence !== "number") return null;
  if (!input.judge.complexity) return null;
  if (typeof input.judge.complexityConfidence !== "number") return null;
  ...
}
```

**Contract**: returns `null` when judge data is incomplete. Never throws.

## 5. Shadow Bridge

```ts
export interface ShadowBridgeInput {
  sessionKey: string;
  turnId: string;
  decision: PolicyDecision;
  judgeResult: LLMJudgeResult | null;
  actualModel: string | undefined;
  runtimeSignals: RouterLiteRuntimeSignals;
  logger?: LoggerLike;
}

export function emitRouterLiteShadowEvent(input: ShadowBridgeInput): void {
  try {
    const snapshot = loadRouterLiteSnapshot();
    if (!snapshot) return;

    const request = buildRouterLiteRequest({
      sessionKey: input.sessionKey,
      turnId: input.turnId,
      liveRoute: normalizeLiveRoute(input.decision),
      actualModel: input.actualModel,
      judge: extractJudgeSignalsFromDecision(input.decision, input.judgeResult),
      runtimeSignals: input.runtimeSignals,
      snapshotId: snapshot.snapshotId,
    });
    if (!request) return;

    const recommendation = selectShadowRecommendation(request, snapshot);
    const estimatedCostDeltaUsd = computeCostDelta(snapshot, input.actualModel, recommendation.recommendedModel);

    const event: RouterLiteShadowEvent = {
      event: "router_lite_recommendation",
      turnId: input.turnId,
      snapshotId: snapshot.snapshotId,
      liveRoute: request.liveRoute,
      actualModel: input.actualModel,
      recommendation,
      estimatedCostDeltaUsd,
      qualityGate: "unknown",
      judge: request.judge,
      scenario: recommendation.scenario,
    };

    writeShadowEvent(event, resolveShadowEventPath(), {
      onError: (err) => input.logger?.warn?.(`[router-lite] shadow event write failed: ${String(err)}`),
    });
  } catch (error) {
    input.logger?.warn?.(`[router-lite] shadow bridge error: ${String(error)}`);
  }
}
```

## 6. Call Site

In `policy-resolver.ts`, at the end of `resolvePolicyDecisionForContext()`, **after** the policy state is set and **before** / **after** `recordPolicyReplay()` (order TBD during implementation — whichever keeps replay authoritative):

```ts
try {
  emitRouterLiteShadowEvent({
    sessionKey,
    turnId: stableId(normalizedPrompt, Date.now()),
    decision,
    judgeResult: latestJudgeResult,
    actualModel: resolveActualModel(decision),
    runtimeSignals: buildRuntimeSignalsFromContext(context, decision),
    logger,
  });
} catch {
  // belt-and-suspenders; shadow-bridge already try/catch.
}
```

`resolveActualModel(decision)` reads `decision.model_profile.final_model_id` or equivalent. If unavailable, passes `undefined`.

## 7. Cost Delta

First implementation uses a fixed assumed token footprint:

```ts
const ASSUMED_TOKENS_PER_TASK_MILLIONS = 0.013; // 10k input + 3k output

function computeCostDelta(snapshot, actualModel, recommendedModel): number | undefined {
  if (!actualModel || !recommendedModel || actualModel === recommendedModel) return 0;
  const actual = snapshot.models.find(m => m.modelKey === actualModel);
  const rec = snapshot.models.find(m => m.modelKey === recommendedModel);
  const actualPrice = actual?.marketPrice.blendedUsdPerMTok;
  const recPrice = rec?.marketPrice.blendedUsdPerMTok;
  if (actualPrice === undefined || recPrice === undefined) return undefined;
  return (recPrice - actualPrice) * ASSUMED_TOKENS_PER_TASK_MILLIONS;
}
```

This is **order-of-magnitude** only. A later slice can replace it with runtime token accounting once telemetry is wired. Negative deltas mean recommendation is cheaper.

## 8. Shadow Event Path

Default: `~/.openclaw/workspace/tmp/octopus/router-lite/shadow.jsonl`

Override: `OCTOCLAW_ROUTER_SHADOW_PATH` env var.

Directory creation is handled by `writeShadowEvent` (already in policy pkg).

Rotation: out of scope for this change. Operators can truncate or move the file. A later change can add daily rotation if needed.

## 9. CLI `router shadow-report`

```bash
octoclawctl router shadow-report [--path <jsonl>] [--format text|json]
```

Output (text):

```text
OctoClaw router-lite shadow report
==================================
total events            : 347
unique models actual    : openai/gpt-5.5, zhipu/glm-5.1
unique models recommended: openai/gpt-5.x-mini, openai/gpt-5.4-mini, zhipu/glm-5.1
ignoredReason counts:
  low_confidence       : 41
  not_configured       : 88
  status_or_provenance : 62
  (live)               : 156
estimated cost delta   : $-0.87 USD (negative = recommendation would save)
quality gate           : 0 pass / 0 fail / 347 unknown
time range             : turn-2026-05-05T00:13:22 → turn-2026-05-12T22:58:11
```

Delegates to `generateShadowReport()` already in `@octoclaw/policy/router-lite`.

## 10. Testing

### 10.1 Unit tests

- `snapshot-loader.test.ts`
  - missing file → `null`
  - corrupt JSON → `null`
  - wrong schemaVersion → `null`
  - valid file → snapshot returned; second call within TTL uses cache (spy fs.readFileSync)
  - mtime change → cache invalidated
  - env override works

- `request-builder.test.ts`
  - missing judge → null
  - partial judge (missing complexityConfidence) → null
  - valid judge → request with all fields mapped
  - statusOrProvenanceRequest flag propagates

- `shadow-bridge.test.ts`
  - snapshot missing → no throw, no write
  - snapshot + valid request → write called once with expected shape
  - snapshot + low judge confidence → recommendation.ignoredReason === "low_confidence"
  - selector throws → no throw, logger.warn called once
  - writeShadowEvent throws → no throw, logger.warn called once

### 10.2 Integration

- `policy-resolver.shadow.test.ts`
  - reply route + valid judge → shadow event emitted
  - delegate route + valid judge → shadow event emitted
  - delegate route + missing judge → no event
  - snapshot path unset → live path unaffected

### 10.3 CLI

- `cli.test.ts` adds a test that calls `router shadow-report` on a fixture jsonl and asserts key summary lines.

## 11. Logging

All shadow-bridge failures emit exactly one `logger.warn` per call with prefix `[router-lite]`. No stderr. No stdout. No user-facing footer change.

## 12. Hard Invariants

1. Live route authority stays `reply | delegate`. Shadow never influences it.
2. `configured === false` models never appear in `recommendation.recommendedModel` — the policy package already enforces this; bridge does not re-check.
3. `quotaPressure === "unknown"` is never treated as free — enforced by selector.
4. No remote network call on the request hot path.
5. Any bridge failure mode returns silently; the main turn proceeds unchanged.

## 13. Rollout and Rollback

Rollout is two commits:

1. Slice-1 + Slice-2: new files + call site + tests.
2. Slice-3: CLI command + tests.

Rollback is `git revert <slice-2-sha>` to silence shadow emission. Fast, no data migration, no runtime state.

## 14. Observation Plan

Days 1–3: watch `logger.warn` for bridge errors. Expected: none after warmup.

Days 4–7: run `octoclawctl router shadow-report` nightly. Review `ignoredReasonCounts`:

- Very high `low_confidence` → judge is under-confident; tune confidence threshold in selector.
- Very high `not_configured` → snapshot has too many proposal-only models; tighten `octoclawctl router model-config analyze`.
- Very high `no_eligible_model` → selector hard gates are too strict; revisit.

Day 7 outcome: proposal-level decision on whether to pursue W-1-D (gated live). That is a separate change packet.
