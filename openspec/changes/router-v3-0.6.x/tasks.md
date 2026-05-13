# Tasks

Grouped by phase from design §12. Each phase is an independent merge unit.

## Phase A — Package extraction (1-2 weeks)

### A1. Create `@octoclaw/router` package skeleton

- [ ] Create `packages/octoclaw-router/` with `package.json`, `tsconfig.json`, `src/`
- [ ] Add to `pnpm-workspace.yaml`
- [ ] Wire `pnpm build` / `pnpm check` / `pnpm test`
- [ ] Verify empty package builds + publishes to workspace

### A2. Migrate judge into `semantic/`

- [ ] Move `packages/octoclaw-policy/src/judge/` → `packages/octoclaw-router/src/semantic/`
- [ ] Move `extensions/octoclaw-runtime/src/resolve/llm-judge.ts` logic into `semantic/judge.ts`
- [ ] Keep backward-compatible re-exports in old locations (deprecation shim)
- [ ] Adapt imports across `runtime-policy`, `resolve/policy-resolver.ts`
- [ ] Verify `pnpm test` passes

### A3. Migrate router-lite into `decision/`

- [ ] Move `packages/octoclaw-policy/src/router-lite/` → `packages/octoclaw-router/src/decision/`
- [ ] Move `extensions/octoclaw-runtime/src/router-lite/shadow-bridge.ts` logic into integration layer (kept in runtime extension for now)
- [ ] Backward-compatible re-exports
- [ ] Verify `pnpm test` passes

### A4. Reduce judge schema to 3 fields

- [ ] Update `JudgeOutput` type: remove `complexity_confidence`, do not yet add `scenario`
- [ ] Update judge prompt to ask for only 3 fields
- [ ] Update all runtime consumers to not expect `complexity_confidence`
- [ ] Update fixture tests
- [ ] Verify JSON parse success rate > 99% on test corpus

### A5. Phase A smoke

- [ ] Run `pnpm check && pnpm test`
- [ ] Manual end-to-end: Slack turn → judge call → dispatch → footer shows model
- [ ] Confirm shadow events still get written
- [ ] `pnpm check` passes with no new warnings

**Acceptance**: All existing tests pass, no runtime behavior regression, package structure clean.

---

## Phase B — Capability snapshot + scoring (2-3 weeks)

### B1. Leaderboard snapshot packaging

- [ ] Define `LeaderboardSnapshot` type
- [ ] Create `packages/octoclaw-router/src/data/leaderboard-snapshot.json` with initial data from PinchBench / Aider / BFCL / Artificial Analysis
- [ ] Write loader: `LeaderboardLoader` interface + default impl
- [ ] Write updater script: `scripts/refresh-leaderboard-snapshot.mjs` to regenerate from external sources
- [ ] Document how to refresh (for project maintainer)

### B2. Capability snapshot model

- [ ] Define unified `CapabilityRecord` merging leaderboard + OpenRouter + models.dev + catalog
- [ ] Merge logic with conflict detection (>20% price delta → flag)
- [ ] Freshness tracking + source attribution
- [ ] Tests for merge correctness

### B3. Cost / Plan / Health data model

- [ ] SQLite schema at `~/.openclaw/octoclaw/cost.sqlite`
- [ ] Cost event logging (hook into delegate dispatch outcomes)
- [ ] Plan configuration stored from wizard results
- [ ] Real-time health tracking: sliding window failure rate, p50/p95 latency, error codes
- [ ] Cooldown logic: > 20% failure rate → auto-cooldown 30 min

### B4. Scoring engine

- [ ] Implement balanced scoring formula (35/20/20/15/10)
- [ ] Quality floor hard gate
- [ ] Unit tests: same tier cheapest wins, cooldown excludes, quota pressure affects cost score
- [ ] Deterministic: same input → same score

### B5. Recommendation integration

- [ ] Update shadow-bridge to use new scoring engine
- [ ] Recommendation output includes reasonCodes explaining why
- [ ] Integration test: mock snapshot + judge output → recommendation matches expected

**Acceptance**: Scoring engine produces stable recommendations, shadow events carry new reasonCodes, pnpm test green.

---

## Phase C — Shadow + auto-promotion (1-2 weeks)

### C1. Shadow evaluator

- [ ] Read shadow jsonl, aggregate by (model, tier) candidate
- [ ] Compute success_rate_delta, cost_delta, quality_regression metrics
- [ ] Scheduled daily evaluation via CLI or background task

### C2. Auto-promotion gate

- [ ] Implement §5.7 promotion rules (sample thresholds, quality/cost gates)
- [ ] Hard safety: only configured models, max 1 promotion/day, 30-day retry block on failures
- [ ] Emit `router_auto_promotion_decision` event with full evidence

### C3. Decisions CLI

- [ ] `octoclawctl router decisions` — list all promotions with since/reason/evidence
- [ ] `octoclawctl router decisions --since 7d` — filtered view
- [ ] Format: text + json options

### C4. Recommendation error handling

- [ ] Track delegate failures and user retry signals
- [ ] Short/medium/long term score adjustments (§5.8)
- [ ] Dispreferred tagging (30-day soft avoidance)

### C5. Lightweight nightly review

- [ ] Statistics: failure rates, cost comparisons, ignored_reason counts
- [ ] Rule-based alerts: consecutive failures → auto-downrank; cost anomalies → warn
- [ ] Zero LLM cost; always on by default

**Acceptance**: After 30+ shadow samples, auto-promotion triggers; decisions CLI shows full audit.

---

## Phase D — Wizard + override + cost report (1-2 weeks)

### D1. First-run wizard

- [ ] `octoclawctl router wizard` — full 7-step flow
- [ ] `octoclawctl router wizard --incremental` — only asks for new models
- [ ] Auto-trigger on `~/.openclaw/openclaw.json` change (detect new providers/models)
- [ ] Save to `~/.openclaw/octoclaw/router-wizard.json`

### D2. Plan type detection heuristics

- [ ] Model name pattern → plan type suggestion
- [ ] User confirms/overrides in wizard

### D3. Cost report

- [ ] `octoclawctl router cost report [--period 1d|7d|30d|month] [--format text|json]`
- [ ] Groupings: by model / by complexity / by route
- [ ] Trend + prediction (linear regression on 7-day data)
- [ ] Anomaly flagging (high single-day spikes)
- [ ] Savings suggestions from shadow data

### D4. Budget tracking + alerts

- [ ] Budget config via `octoclawctl router cost budget set --monthly <usd>`
- [ ] Every task end: check spend vs budget, warn at 80%, hard action at 100%

### D5. User override CLI

- [ ] `router score override <model> <tier>=<score>`
- [ ] `router model mark <model> --dispreferred-for <tier>`
- [ ] `router model ban <model> --for <tier>`
- [ ] `router score reset <model>`
- [ ] All stored in wizard config under `overrides`

### D6. Plan quota protection

- [ ] Poll provider usage API on interval (where supported)
- [ ] < 10% remaining → switch to non-plan models + light notification
- [ ] Test with mocked provider

**Acceptance**: Wizard completes smoothly, cost report gives actionable insight, all override CLIs work.

---

## Phase E — Polish + release (1 week)

### E1. End-to-end smoke

- [ ] Fresh install → wizard → first task → check cost report shows 1 entry
- [ ] 10 delegate turns → cost report shows breakdown, shadow has data
- [ ] 30+ turns → verify auto-promotion triggers
- [ ] Wizard + override + decisions all work as documented

### E2. Documentation

- [ ] Update `README.md` Auto Router section
- [ ] Update CHANGELOG
- [ ] New doc: `docs/octoclaw-router-user-guide.md` (for end users)
- [ ] Update `SKILL.md` with new CLI commands

### E3. Tests

- [ ] Coverage report on `@octoclaw/router` > 80%
- [ ] Integration tests for full pipeline
- [ ] Fixtures for common scenarios

### E4. Release

- [ ] Bump version to 0.6.0
- [ ] Final `pnpm check && pnpm test`
- [ ] Tag + push + release notes

**Acceptance**: V1 feature-complete, end-to-end working, ready to publicize.

---

## Hard Invariants — Must Be Preserved

Every task must leave these intact:

1. Judge output stays 3 fields
2. No keyword-based routing
3. Unconfigured models never go live
4. `quotaPressure=unknown` never treated as free
5. Sub-agent auto-switch, main agent never silently switched
6. Shadow failure never affects live route
7. Judge failure never blocks main flow
8. User data stays local
9. Footer shows actual delegated model
10. Auto-promotion only between configured models

A task that would violate any of these must be rejected.
