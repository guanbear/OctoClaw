# Auto Router V3.2 Health Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the V3.2 model health loop using OpenClaw native model/fallback surfaces and a local per-model health event log.

**Architecture:** Runtime delegated turns and capability probes write sanitized `HealthEvent` records to one JSONL sink. Aggregation derives a deterministic `ModelHealthSnapshot`, model-intel merges that into `RouterLiteHealth`, and scoring/suggestions use OpenClaw native fallback order without mutating it.

**Tech Stack:** TypeScript, Vitest, `@octoclaw/router`, `extensions/octoclaw-runtime`, `tools/octoclawctl`, OpenClaw CLI JSON commands.

---

### Task 1: Health Event Sink

**Files:**
- Create: `packages/octoclaw-router/src/health/event.ts`
- Create: `packages/octoclaw-router/src/health/sink.ts`
- Modify: `packages/octoclaw-router/src/health/index.ts`
- Test: `packages/octoclaw-router/src/health/__tests__/sink.test.ts`

- [ ] Define sanitized `HealthEvent` schema and normalization.
- [ ] Implement append-only JSONL sink with best-effort fsync, no-throw `recordCall`, corrupt-line tolerance, and 7-day retention during aggregation.
- [ ] Export the sink from router health/index.
- [ ] Verify with focused Vitest.

### Task 2: Aggregator And Cooldown

**Files:**
- Create: `packages/octoclaw-router/src/health/cooldown.ts`
- Create: `packages/octoclaw-router/src/health/snapshot.ts`
- Test: `packages/octoclaw-router/src/health/__tests__/cooldown.test.ts`
- Test: `packages/octoclaw-router/src/health/__tests__/snapshot.test.ts`

- [ ] Implement pure cooldown evaluation for `rate_limit_429`, `probe_failure`, `high_failure_rate`, and `high_p95_drift`.
- [ ] Implement deterministic aggregation over last 50 calls / 30 minutes per model.
- [ ] Compute failure, timeout, tool-call failure, p50/p95 latency, top error codes, and last success/failure timestamps.
- [ ] Verify deterministic output and boundary behavior with focused Vitest.

### Task 3: Probe Health Integration

**Files:**
- Modify: `packages/octoclaw-router/src/capability/probe.ts`
- Modify: `tools/octoclawctl/src/cli.ts`
- Test: `packages/octoclaw-router/src/capability/__tests__/probe.test.ts`
- Test: `tools/octoclawctl/src/cli.test.ts`

- [ ] Switch real probe to OpenClaw native `infer model run --model <key> --prompt <text> --json`, keeping mock injection for tests.
- [ ] Emit one probe `HealthEvent` after every probe result, success or failure.
- [ ] Preserve budget guard and auth redaction.
- [ ] Verify probe success does not set cooldown; probe failure can cool down through aggregation.

### Task 4: Model-Intel Health Merge

**Files:**
- Modify: `packages/octoclaw-router/src/decision/contracts.ts`
- Modify: `packages/octoclaw-router/src/decision/model-intel.ts`
- Test: `packages/octoclaw-router/src/__tests__/decision/model-intel.test.ts`

- [ ] Extend `RouterLiteHealth` with cooldown reason/until, last call timestamps, and top errors.
- [ ] Add health snapshot input to `BuildModelIntelSnapshotInput`.
- [ ] Merge `ModelHealthSnapshot` into `ModelIntelLite.health`, including `zai/*` and `zhipu/*` alias matching.
- [ ] Verify populated `recentFailureRate`, latency, timeout, and cooldown fields.

### Task 5: Runtime Recorder Hooks

**Files:**
- Create: `extensions/octoclaw-runtime/src/health/runtime-recorder.ts`
- Test: `extensions/octoclaw-runtime/src/health/runtime-recorder.test.ts`
- Modify: `extensions/octoclaw-runtime/src/hooks/agent-end.ts`

- [ ] Implement no-throw `recordRuntimeCall` with lazy sink creation and duplicate guard.
- [ ] Record delegated turn completion from `agent_end` using final receipt, route, selected/display model, latency, and outcome.
- [ ] Verify missing model and sink failures do not break hooks.

### Task 6: Native Fallback Tie-Break And Suggestions

**Files:**
- Modify: `packages/octoclaw-router/src/decision/contracts.ts`
- Modify: `packages/octoclaw-router/src/decision/shadow-selector.ts`
- Modify: `packages/octoclaw-router/src/scoring/index.ts`
- Create: `packages/octoclaw-router/src/health/suggestions.ts`
- Test: `packages/octoclaw-router/src/__tests__/decision/scoring.test.ts`
- Test: `packages/octoclaw-router/src/__tests__/decision/shadow-selector.test.ts`
- Test: `packages/octoclaw-router/src/health/__tests__/suggestions.test.ts`

- [ ] Add native fallback metadata to snapshot or recommendation context.
- [ ] Tie-break equal scores by native default, then fallback order, then price.
- [ ] Emit suggestion records for cooled-down native fallback models, with command text only.
- [ ] Verify no router code executes OpenClaw fallback mutation commands.

### Task 7: CLI Router Health Commands

**Files:**
- Create: `tools/octoclawctl/src/commands/router-health.ts`
- Modify: `tools/octoclawctl/src/cli.ts`
- Test: `tools/octoclawctl/src/__tests__/router-health.test.ts`

- [ ] Implement `router health aggregate`, `show`, `list`, and `suggest-fallbacks`.
- [ ] Wire model-intel refresh to aggregate health and print health counts.
- [ ] Read OpenClaw `models list` / `fallbacks list` as native ordering input.
- [ ] Verify CLI output and JSON modes.

### Task 8: Final Verification

- [ ] Run focused Vitest suites after each task.
- [ ] Run `pnpm check`.
- [ ] Run `pnpm test`.
- [ ] Run `git grep "openclaw models fallbacks"` and verify no automatic add/remove execution.
- [ ] Run `npx gitnexus detect-changes --repo OctoClaw` before commit.
