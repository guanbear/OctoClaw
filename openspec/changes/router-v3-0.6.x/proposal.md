# Change: Auto Router v3 — `@octoclaw/router` V1

Date: 2026-05-13
Target release: v0.6.0
Design reference: `docs/octoclaw-auto-router-v3-design-2026-05-13.md`

## Purpose

Integrate the current `@octoclaw/policy/judge` (Semantic Layer) and `@octoclaw/policy/router-lite` (Decision Layer) into a single independent `@octoclaw/router` package, and ship V1 of the end-to-end Auto Router feature:

- Lightweight judge (3 fields: `route / confidence / complexity`)
- External-data-driven capability snapshot (leaderboards + provider catalog; local replay optional)
- Cost / plan / health tracking with quota pressure detection
- Automatic shadow → live promotion (data-driven with observability)
- First-run wizard (7 steps)
- Cost reports with full granularity (model / complexity / route / trend / prediction)
- User override CLI (score override / mark dispreferred / ban)

The package is designed to be **plugin-friendly** so it can be published as an independent npm package later (`policy-router` or `agent-router`) for non-OctoClaw integrations.

## Problem

Two isolated subsystems:

1. `@octoclaw/policy/judge` — semantic routing (reply/delegate)
2. `@octoclaw/policy/router-lite` — cost-aware model recommendation

are conceptually one pipeline (semantic → decision) but live in separate places. Integration logic is spread across `resolve/policy-resolver.ts`, `resolve/llm-judge.ts`, runtime hooks, and CLI. There's no end-to-end Auto Router yet: shadow events are emitted but no promotion gate, no wizard, no cost reports, no user override mechanism.

Users today:
- Have to manually choose models per task (or eat the cost of using a frontier model for trivial things)
- Can't configure their plan/subscription status, so quota pressure is always "unknown"
- Can't see cost breakdown by model or task type
- Can't tell Auto Router "this model doesn't work well for me"

## Scope

**V1 delivers** (P0+P1+P2 from design doc §11):

1. **New package** `packages/octoclaw-router/` — combining semantic and decision layers
2. **Judge V1 schema**: 3 fields (`route / confidence / complexity`), cache with strict keys, fallback rules
3. **Capability snapshot**: packaged leaderboard data + OpenRouter + models.dev + OpenClaw catalog integration
4. **Cost/plan/health**: SQLite-backed cost log, quota pressure model, real-time health updates
5. **Scoring engine**: single balanced mode (cost 20% + capability 35% + quality floor 20% + stability 15% + speed 10%)
6. **Shadow evaluator + auto-promotion**: data-driven with observability (`octoclawctl router decisions`)
7. **First-run wizard**: 7 steps (model scan / plan confirm / budget / privacy / language / restricted / same-provider discovery)
8. **CLI suite**: status / wizard / capability / shadow / decisions / score / cost / judge
9. **Cost report**: full granularity with prediction (model / complexity / route / trend)
10. **User override**: 3 CLI forms (score override / mark dispreferred / ban)
11. **Config change auto-trigger**: watch `~/.openclaw/openclaw.json`, refresh capability on change
12. **Plan quota protection**: low-quota warnings + auto-switch to non-plan models when depleted
13. **Nightly lightweight review**: stats + rules (zero LLM cost, always on)

## Non-Goals (V1)

- Scenario field (`coding_style / research / agentic`) — V2
- Multi-mode preferences (`cost_first / reliable_fast / balanced`) — V2, V1 is balanced only
- Nightly LLM review deep mode — V2
- Tier 0/1/2 layered judge — explicitly rejected (historical lesson: degrades into keyword patches)
- Community data sharing — V3
- Independent npm publish — V2
- Route rule editing (YAML overrides) — V3
- Complexity confidence field — rejected (small models unreliable on this)

## Target Behaviour

- First-run wizard guides user through config in < 5 minutes
- Judge returns structured JSON in < 1s (p95) with > 99% parse success rate
- Delegated task footer shows actual model used
- Main agent model never silently switched; only recommended
- Sub-agent model auto-switched based on complexity + cost + stability
- `octoclawctl router cost report --period 7d` gives actionable cost breakdown
- Shadow → live promotion happens automatically when data supports it, with full audit trail
- Config changes (new provider / model) trigger incremental capability refresh without user intervention

## Acceptance Gate

V1 is shippable when:

- New package typechecks + tests pass
- Wizard completes end-to-end without crash on a fresh OpenClaw install
- Judge handles 1000 consecutive calls without fallback being triggered (assuming local Qwen3 0.6B available)
- Shadow event count grows as expected during normal usage
- Cost report shows non-empty data after 10+ delegate turns
- `octoclawctl router decisions` shows at least one auto-promotion after 30+ shadow samples
- Override CLI commands all functional
- No behavior regression in existing tests (`pnpm check && pnpm test`)
- Footer correctly shows spawn model (W-5 WP-E already landed this, verify it still works)

## Rollout

Phased by design doc §12:

- **Phase A** (1-2 weeks): Extract `@octoclaw/router` package, migrate judge + router-lite
- **Phase B** (2-3 weeks): Capability snapshot + scoring engine
- **Phase C** (1-2 weeks): Shadow + auto-promotion + decisions CLI
- **Phase D** (1-2 weeks): Wizard + override + cost report
- **Phase E** (1 week): Polish + end-to-end smoke + v0.6.0 release

Total: 5-10 weeks depending on external API integration complexity.

## Risks

- **Judge model availability**: If user's local Ollama or remote judge endpoint is flaky, Auto Router degrades to fallback rules. Mitigation: comprehensive fallback (§4.5), hard-coded conservative rules, cooldown period for failed judge models.
- **Leaderboard data staleness**: Packaged snapshot gets out of date. Mitigation: user can manually refresh; auto-refresh on config change; warning banner if snapshot > 3 months old.
- **Auto-promotion false positives**: Wrongly promote a model that fails at scale. Mitigation: strict sample thresholds (30+), cost delta must be negative, quality regression caps, 30-day retry blocks on failed promotions.
- **Cost SQLite corruption**: Lose cost history. Mitigation: SQLite restore is a no-op for routing; cost reports just show empty until data accumulates again.
- **Migration breaking existing shadow events**: Mitigation: Phase A keeps old APIs functional while new package is imported; shadow event schema backward compatible.

## Hard Invariants (from Design §14)

1. Judge output = 3 fields only. No expansion in V1.
2. No keyword matching. Structured signals + judge only.
3. Unconfigured models never go live.
4. `quotaPressure=unknown` never treated as free.
5. Sub-agent auto-switch; main agent never silently switched.
6. Shadow failure never affects live route.
7. Judge failure never blocks main flow (must have fallback).
8. All user data (cost, shadow, decisions) stays local in V1.
9. Footer must show actual delegated model.
10. Auto-promotion only between configured models.

## References

- Design baseline: `docs/octoclaw-auto-router-v3-design-2026-05-13.md`
- Related (historical): `docs/octoclaw-phase5-auto-router-design-2026-04-30.md`, `docs/octoclaw-auto-router-lite-cost-model-design-2026-05-08.md`
- Current judge: `extensions/octoclaw-runtime/src/resolve/llm-judge.ts`
- Current router-lite: `packages/octoclaw-policy/src/router-lite/`
- Current shadow bridge (wired in Q1 of this conversation): `extensions/octoclaw-runtime/src/router-lite/shadow-bridge.ts`
