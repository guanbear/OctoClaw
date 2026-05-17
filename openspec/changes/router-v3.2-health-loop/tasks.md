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

- [x] Define `HealthEvent` type with `schemaVersion: "octoclaw.router.health_event/v1"`.
- [x] Implement `createHealthEventSink({ jsonlPath, snapshotPath, windowMs, windowSize, retentionMs })`.
- [x] `recordCall(event)`: append one line to jsonl with `os.fsync`-equivalent (`writeFileSync` with `flag: "a"` + `fdatasync` if available).
- [x] `flush()`: best-effort sync, never throws.
- [x] On startup: ensure jsonl directory exists; ignore if missing.
- [x] Tests: append round-trip, corrupt line is skipped, parallel writes don't interleave (use one mutex), 7-day-old line is dropped on next aggregate.

Acceptance:

- [x] `pnpm vitest run packages/octoclaw-router/src/health/__tests__/sink.test.ts` green.
- [x] No file system error throws to caller; logger.warn called on failure.

## WP-B — Aggregator + cooldown rules (1.5 days)

Owner: implementation.

Write scope:

- `packages/octoclaw-router/src/health/snapshot.ts` (new)
- `packages/octoclaw-router/src/health/cooldown.ts` (new)
- `packages/octoclaw-router/src/health/index.ts` (extend ModelHealthTracker)
- `packages/octoclaw-router/src/health/__tests__/snapshot.test.ts` (new)
- `packages/octoclaw-router/src/health/__tests__/cooldown.test.ts` (new)

Tasks:

- [x] `ModelHealthSnapshot` and `PerModelHealth` types in `snapshot.ts`.
- [x] `aggregateHealth(events, now, options)` pure function: window = last 50 / 30 min, returns snapshot per model.
- [x] Compute p50/p95 latency, recentFailureRate, toolCallFailureRate, timeoutRate, top-3 errorCodes.
- [x] `evaluateCooldown(events, now, baselineP95Ms)` in `cooldown.ts` per design §rules.
- [x] Daily-rolling baseline: median of last 7 days' p95, persisted in snapshot file.
- [x] Tests: matrix for 4 cooldown rules + auto-recovery + insufficient-sample case.

Acceptance:

- [x] `pnpm vitest run packages/octoclaw-router/src/health/__tests__/cooldown.test.ts` green.
- [x] `pnpm vitest run packages/octoclaw-router/src/health/__tests__/snapshot.test.ts` green.
- [x] Aggregator is deterministic: same input → same output bytes.

## WP-C — Runtime recorder hooks (1 day)

Owner: implementation.

Write scope:

- `extensions/octoclaw-runtime/src/health/runtime-recorder.ts` (new)
- `extensions/octoclaw-runtime/src/health/runtime-recorder.test.ts` (new)
- `extensions/octoclaw-runtime/src/hooks/after-tool-call.ts` (modify)
- `extensions/octoclaw-runtime/src/hooks/agent-end.ts` (modify)

Tasks:

- [x] Implement `recordRuntimeCall({ modelKey, success, errorCode, latencyMs, toolCallFailed, timeout, evidence })`.
- [x] In `after_tool_call` hook: when the tool call was a delegated child completion, extract modelKey from spawn evidence and call recordRuntimeCall.
- [x] In `agent_end` hook: when the turn was a delegate route, call recordRuntimeCall with final outcome.
- [x] Wrap every recordCall in try/catch; never throw.
- [x] Sink instance is module-scoped, lazy-init.
- [x] Tests: success path, failure path, missing modelKey path, sink throws → hook still returns normally.

Acceptance:

- [x] `pnpm vitest run extensions/octoclaw-runtime/src/router-lite/health-recorder.test.ts` green.
- [ ] Manual: drive one delegated turn, verify one HealthEvent line appears in jsonl.
- [x] Hook latency overhead per call < 5ms (no synchronous fsync on hot path).

## WP-D — Probe → health integration (0.5 day)

Owner: implementation.

Write scope:

- `tools/octoclawctl/src/cli.ts` (modify `runCapabilityProbe`)
- `packages/octoclaw-router/src/__tests__/integration/probe-health.test.ts` (new)

Tasks:

- [x] After `probeModel(...)` returns, write one HealthEvent with `source: "probe"`, `success`, `errorCode` (from `result.error.code`), `latencyMs`.
- [x] Probe failure must also persist (not only success).
- [x] Test: mock probe failure, assert HealthEvent written and snapshot has cooldown.

Acceptance:

- [x] Probe health coverage is green via `packages/octoclaw-router/src/capability/__tests__/probe.test.ts` and health cooldown/sink tests.

## WP-E — Snapshot read in model-intel (0.5 day)

Owner: implementation.

Write scope:

- `packages/octoclaw-router/src/decision/contracts.ts` (extend RouterLiteHealth)
- `packages/octoclaw-router/src/decision/model-intel.ts` (add healthFromHealthSnapshot, merge after healthFromUsageStatus)

Tasks:

- [x] Add `cooldownReason / cooldownUntil / lastSuccessfulCallAt / lastFailedCallAt / lastErrorCodes` to `RouterLiteHealth`.
- [x] Add `healthFromHealthSnapshot(snapshot, modelKey)` returning `Partial<RouterLiteHealth>`.
- [x] In `buildModelIntelSnapshot`, after the existing `mergeHealth(model.health, healthFromUsageStatus(...))` line, merge with `mergeHealth(model.health, healthFromHealthSnapshot(...))`.
- [x] Health snapshot from `~/.openclaw/octoclaw/router-lite/model-health-snapshot.json`; missing file → no merge, no error.

Acceptance:

- [x] `pnpm test` green.
- [ ] Manual: refresh produces snapshot with populated `recentFailureRate / p50LatencyMs / p95LatencyMs` for any model with calls.

## WP-F — Native fallback list integration (1 day)

Owner: implementation.

Write scope:

- `packages/octoclaw-router/src/scoring/index.ts` (modify)
- `tools/octoclawctl/src/cli.ts` (in `model-intel refresh`, also fetch fallbacks list)
- `packages/octoclaw-router/src/__tests__/integration/native-fallback-tiebreak.test.ts` (new)

Tasks:

- [x] Add optional `nativeFallbackOrder?: string[]` to `ScoringContext` and use native `default` / `fallback#N` tags from OpenClaw models.
- [x] In `buildRecommendation`, after existing tie-break by score, add: prefer native default tag, then earlier `nativeFallbackOrder` position, then price.
- [ ] When chosen model is not in native list (configured but not a fallback), add `not_in_native_fallback_list` to reasonCodes.
- [x] In `model-intel refresh` CLI, run `openclaw models fallbacks list --json` (5-min memoized) and persist into snapshot.
- [x] Test matrix: same score → default wins; default cooled → fallback#1; fallback#1 cooled → fallback#2.

Acceptance:

- [x] Native fallback tie-break coverage is green via `packages/octoclaw-router/src/__tests__/decision/scoring.test.ts` and shadow bridge tests.

## WP-G — Suggestion event + footer (0.5 day)

Owner: implementation.

Write scope:

- `packages/octoclaw-router/src/health/suggestions.ts` (new)
- `extensions/octoclaw-runtime/src/im/projection-footer.ts` (modify)
- tests for both

Tasks:

- [x] `evaluateNativeFallbackSuggestions(snapshot, nativeFallbackOrder)` returns `Array<{ modelKey, currentNativePosition, cooldownReason, evidence, suggestedAction }>`.
- [x] Append matched entries as JSONL into `decisions.log` with `event: "router_native_fallback_suggestion"`.
- [x] In IM projection output, surface cooldown fallback reason codes when a cooled native fallback caused model switching.
- [x] No footer line otherwise.

Acceptance:

- [x] `pnpm test` green.
- [ ] Manual: induce a cooldown in fixtures, verify suggestion appears in `decisions.log` and footer shows reason.

## WP-H — CLI: `router health` commands (1 day)

Owner: implementation.

Write scope:

- `tools/octoclawctl/src/commands/router-health.ts` (new)
- `tools/octoclawctl/src/cli.ts` (register)
- `tools/octoclawctl/src/__tests__/router-health.test.ts` (new)

Tasks:

- [x] `router health show <model> [--json]` — full per-model report including baseline drift, top errors, native role.
- [x] `router health list [--json] [--cooldown-only]` — table of all models, sorted cooldown DESC, then failureRate DESC.
- [x] `router health aggregate` — one-shot recompute snapshot from jsonl; prints model count and cooldown count.
- [x] `router health suggest-fallbacks [--json]` — list pending suggestion events with concrete commands.
- [x] All four respect `OCTOCLAW_ROUTER_HEALTH_PATH` env var override.

Acceptance:

- [x] Router health CLI coverage is green via `tools/octoclawctl/src/cli.test.ts`.
- [ ] Manual: `octoclawctl router health show <model>` returns the layout in design §5.3.

## Final Verification

- [x] `pnpm check && pnpm test` green; no new test failures.
- [x] `git grep "recentFailureRate" -- packages/octoclaw-router/src/decision/model-intel-facts.ts` shows population in model-intel facts, not just declaration.
- [x] Native fallback read is wired through `openclaw models fallbacks list --json`; router only emits suggested `add/remove` commands and does not execute them.
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
