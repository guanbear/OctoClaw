# Tasks

Each WP is one merge unit. Run `pnpm check && pnpm test` after each WP.

Total estimate: 7 days single-track.

## WP-A — HealthEvent + sink + jsonl persistence (1 day)

Owner: implementation, Codex review.

Write scope:

- `packages/octoclaw-router/src/health/event.ts` (new)
- `packages/octoclaw-router/src/health/sink.ts` (new)
- `packages/octoclaw-router/src/health/__tests__/sink.test.ts` (new)

Tasks:

- [ ] Define `HealthEvent` type with `schemaVersion: "octoclaw.router.health_event/v1"`.
- [ ] Implement `createHealthEventSink({ jsonlPath, snapshotPath, windowMs, windowSize, retentionMs })`.
- [ ] `recordCall(event)`: append one line to jsonl with `os.fsync`-equivalent (`writeFileSync` with `flag: "a"` + `fdatasync` if available).
- [ ] `flush()`: best-effort sync, never throws.
- [ ] On startup: ensure jsonl directory exists; ignore if missing.
- [ ] Tests: append round-trip, corrupt line is skipped, parallel writes don't interleave (use one mutex), 7-day-old line is dropped on next aggregate.

Acceptance:

- [ ] `pnpm vitest run packages/octoclaw-router/src/health/__tests__/sink.test.ts` green.
- [ ] No file system error throws to caller; logger.warn called on failure.

## WP-B — Aggregator + cooldown rules (1.5 days)

Owner: implementation.

Write scope:

- `packages/octoclaw-router/src/health/snapshot.ts` (new)
- `packages/octoclaw-router/src/health/cooldown.ts` (new)
- `packages/octoclaw-router/src/health/index.ts` (extend ModelHealthTracker)
- `packages/octoclaw-router/src/health/__tests__/snapshot.test.ts` (new)
- `packages/octoclaw-router/src/health/__tests__/cooldown.test.ts` (new)

Tasks:

- [ ] `ModelHealthSnapshot` and `PerModelHealth` types in `snapshot.ts`.
- [ ] `aggregateHealth(events, now, options)` pure function: window = last 50 / 30 min, returns snapshot per model.
- [ ] Compute p50/p95 latency, recentFailureRate, toolCallFailureRate, timeoutRate, top-3 errorCodes.
- [ ] `evaluateCooldown(events, now, baselineP95Ms)` in `cooldown.ts` per design §rules.
- [ ] Daily-rolling baseline: median of last 7 days' p95, persisted in snapshot file.
- [ ] Tests: matrix for 4 cooldown rules + auto-recovery + insufficient-sample case.

Acceptance:

- [ ] `pnpm vitest run packages/octoclaw-router/src/health/__tests__/cooldown.test.ts` green.
- [ ] `pnpm vitest run packages/octoclaw-router/src/health/__tests__/snapshot.test.ts` green.
- [ ] Aggregator is deterministic: same input → same output bytes.

## WP-C — Runtime recorder hooks (1 day)

Owner: implementation.

Write scope:

- `extensions/octoclaw-runtime/src/health/runtime-recorder.ts` (new)
- `extensions/octoclaw-runtime/src/health/runtime-recorder.test.ts` (new)
- `extensions/octoclaw-runtime/src/hooks/after-tool-call.ts` (modify)
- `extensions/octoclaw-runtime/src/hooks/agent-end.ts` (modify)

Tasks:

- [ ] Implement `recordRuntimeCall({ modelKey, success, errorCode, latencyMs, toolCallFailed, timeout, evidence })`.
- [ ] In `after_tool_call` hook: when the tool call was a delegated child completion, extract modelKey from spawn evidence and call recordRuntimeCall.
- [ ] In `agent_end` hook: when the turn was a delegate route, call recordRuntimeCall with final outcome.
- [ ] Wrap every recordCall in try/catch; never throw.
- [ ] Sink instance is module-scoped, lazy-init.
- [ ] Tests: success path, failure path, missing modelKey path, sink throws → hook still returns normally.

Acceptance:

- [ ] `pnpm vitest run extensions/octoclaw-runtime/src/health/runtime-recorder.test.ts` green.
- [ ] Manual: drive one delegated turn, verify one HealthEvent line appears in jsonl.
- [ ] Hook latency overhead per call < 5ms (no synchronous fsync on hot path).

## WP-D — Probe → health integration (0.5 day)

Owner: implementation.

Write scope:

- `tools/octoclawctl/src/cli.ts` (modify `runCapabilityProbe`)
- `packages/octoclaw-router/src/__tests__/integration/probe-health.test.ts` (new)

Tasks:

- [ ] After `probeModel(...)` returns, write one HealthEvent with `source: "probe"`, `success`, `errorCode` (from `result.error.code`), `latencyMs`.
- [ ] Probe failure must also persist (not only success).
- [ ] Test: mock probe failure, assert HealthEvent written and snapshot has cooldown.

Acceptance:

- [ ] `pnpm vitest run packages/octoclaw-router/src/__tests__/integration/probe-health.test.ts` green.

## WP-E — Snapshot read in model-intel (0.5 day)

Owner: implementation.

Write scope:

- `packages/octoclaw-router/src/decision/contracts.ts` (extend RouterLiteHealth)
- `packages/octoclaw-router/src/decision/model-intel.ts` (add healthFromHealthSnapshot, merge after healthFromUsageStatus)

Tasks:

- [ ] Add `cooldownReason / cooldownUntil / lastSuccessfulCallAt / lastFailedCallAt / lastErrorCodes` to `RouterLiteHealth`.
- [ ] Add `healthFromHealthSnapshot(snapshot, modelKey)` returning `Partial<RouterLiteHealth>`.
- [ ] In `buildModelIntelSnapshot`, after the existing `mergeHealth(model.health, healthFromUsageStatus(...))` line, merge with `mergeHealth(model.health, healthFromHealthSnapshot(...))`.
- [ ] Health snapshot from `~/.openclaw/octoclaw/router-lite/model-health-snapshot.json`; missing file → no merge, no error.

Acceptance:

- [ ] `pnpm test` green.
- [ ] Manual: refresh produces snapshot with populated `recentFailureRate / p50LatencyMs / p95LatencyMs` for any model with calls.

## WP-F — Native fallback list integration (1 day)

Owner: implementation.

Write scope:

- `packages/octoclaw-router/src/scoring/index.ts` (modify)
- `tools/octoclawctl/src/cli.ts` (in `model-intel refresh`, also fetch fallbacks list)
- `packages/octoclaw-router/src/__tests__/integration/native-fallback-tiebreak.test.ts` (new)

Tasks:

- [ ] Add optional `nativeFallbackOrder?: string[]` and `nativeDefaultModel?: string` to `ScoringContext`.
- [ ] In `buildRecommendation`, after existing tie-break by score then price, add: prefer `nativeDefaultModel`, then earlier `nativeFallbackOrder` position.
- [ ] When chosen model is not in native list (configured but not a fallback), add `not_in_native_fallback_list` to reasonCodes.
- [ ] In `model-intel refresh` CLI, run `openclaw models fallbacks list --json` (5-min memoized) and persist into snapshot.
- [ ] Test matrix: same score → default wins; default cooled → fallback#1; fallback#1 cooled → fallback#2.

Acceptance:

- [ ] `pnpm vitest run packages/octoclaw-router/src/__tests__/integration/native-fallback-tiebreak.test.ts` green.

## WP-G — Suggestion event + footer (0.5 day)

Owner: implementation.

Write scope:

- `packages/octoclaw-router/src/health/suggestions.ts` (new)
- `extensions/octoclaw-runtime/src/im/projection-footer.ts` (modify)
- tests for both

Tasks:

- [ ] `evaluateNativeFallbackSuggestions(snapshot, nativeFallbackOrder)` returns `Array<{ modelKey, currentNativePosition, cooldownReason, evidence, suggestedAction }>`.
- [ ] Append matched entries as JSONL into `decisions.log` with `event: "router_native_fallback_suggestion"`.
- [ ] In `projection-footer.ts`, when the recommendation `mode === "live"` and a different model than `nativeDefaultModel` was chosen because the default was cooled down, render a one-line "fallback to X because Y cooled down" footer.
- [ ] No footer line otherwise.

Acceptance:

- [ ] `pnpm test` green.
- [ ] Manual: induce a cooldown in fixtures, verify suggestion appears in `decisions.log` and footer shows reason.

## WP-H — CLI: `router health` commands (1 day)

Owner: implementation.

Write scope:

- `tools/octoclawctl/src/commands/router-health.ts` (new)
- `tools/octoclawctl/src/cli.ts` (register)
- `tools/octoclawctl/src/__tests__/router-health.test.ts` (new)

Tasks:

- [ ] `router health show <model> [--json]` — full per-model report including baseline drift, top errors, native role.
- [ ] `router health list [--json] [--cooldown-only]` — table of all models, sorted cooldown DESC, then failureRate DESC.
- [ ] `router health aggregate` — one-shot recompute snapshot from jsonl; prints model count and cooldown count.
- [ ] `router health suggest-fallbacks [--json]` — list pending suggestion events with concrete commands.
- [ ] All four respect `OCTOCLAW_ROUTER_HEALTH_PATH` env var override.

Acceptance:

- [ ] `pnpm vitest run tools/octoclawctl/src/__tests__/router-health.test.ts` green.
- [ ] Manual: `octoclawctl router health show <model>` returns the layout in design §5.3.

## Final Verification

- [ ] `pnpm check && pnpm test` green; no new test failures.
- [ ] `git grep "model.health.recentFailureRate ="` shows population in `model-intel.ts`, not just declaration.
- [ ] `git grep "openclaw models fallbacks"` returns at least one read in `cli.ts` (model-intel refresh) and one shell-out in suggestion event renderer; no `add` / `remove` writes from the router itself.
- [ ] Manual end-to-end: induce a 429 in a fixture probe → next route shows the cooled-down model excluded with reasonCodes `cooldown:rate_limit_429:<modelKey>`.
- [ ] Hooks add < 5ms p95 to delegated turn end.

## Hard Invariants

1. Jsonl is source of truth; snapshot is derived.
2. `recordCall` never throws.
3. Router never executes `openclaw models fallbacks add/remove`.
4. Probe success never sets cooldown; only failure does.
5. Aggregator is pure (deterministic given inputs).
6. Jsonl retention 7 days, hard cap, pruned on every aggregation.
7. No HealthEvent contains auth, API key, prompt, or response body.
8. Gateway stability is context only, never per-model cooldown trigger.
