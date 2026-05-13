# Change: Auto Router Lite Wiring 0.5.x

## Purpose

Wire the existing `packages/octoclaw-policy/src/router-lite/` shadow recommender into the runtime so every delegate/reply decision emits a shadow event comparing the **actualModel** with the **recommendedModel**. This is the **C slice** of the Auto Router Lite plan described in `docs/octoclaw-auto-router-lite-cost-model-design-2026-05-08.md`.

A, B (snapshot refresh + config proposal) are already available via `octoclawctl`. C is written and unit-tested but not imported anywhere in `extensions/octoclaw-runtime/`. This change closes that gap.

## Problem

- `selectShadowRecommendation()`, `writeShadowEvent()`, `buildModelIntelSnapshot()`, `analyzeModelConfig()` exist and have unit tests, but the live runtime never invokes them.
- Operators cannot generate the shadow data needed for the N3 promotion gate (7 days / 100 samples / no quality regression).
- Without shadow data there is no way to evaluate "would we have saved money if we used a cheaper model?"

## Scope

- Add `extensions/octoclaw-runtime/src/router-lite/` module containing:
  - `snapshot-loader.ts` — reads the cached snapshot from disk with TTL, fail-open on any error.
  - `request-builder.ts` — adapts `PolicyDecision` + `JudgeResult` + runtime signals into `RouterLiteRequest`.
  - `shadow-bridge.ts` — entry point `emitRouterLiteShadowEvent(...)`; wraps selector + writer with try/catch.
- Attach one call site in `resolve/policy-resolver.ts` after policy decision is finalized (or inside the replay record path), guarded so only new-route turns emit.
- Extend `tools/octoclawctl/src/cli.ts` with a `router shadow-report` summary sub-command.

## Non-Goals

- Do not change live route authority. `reply | delegate` stays exactly as today.
- Do not extend the judge schema. Only the four existing fields are read.
- Do not introduce a new model configuration writer. Shadow is read-only.
- Do not fetch remote pricing, capability catalogs, or usage APIs on the hot path. Those belong to `octoclawctl router model-intel refresh`.
- Do not promote any recommendation to live routing. Live gating is a separate change packet (W-1-D, not in this proposal).

## Target Behaviour

For each delegated-route turn with a usable judge result and a valid snapshot:

1. `shadow-bridge` loads the cached snapshot.
2. `request-builder` assembles a `RouterLiteRequest` from structured signals only (no transcript).
3. `selectShadowRecommendation()` runs.
4. `writeShadowEvent()` appends a line to `~/.openclaw/workspace/tmp/octopus/router-lite/shadow.jsonl` (default, overridable via `OCTOCLAW_ROUTER_SHADOW_PATH`).

For reply-route turns: shadow **still writes**, so there is a baseline against which delegated-route recommendations can be compared in nightly reports.

For any failure (snapshot missing / corrupt / disk full / selector throw): shadow silently drops, logger.warn records once, live path is never blocked.

## Acceptance Gate

This change is acceptable only when:

- Injecting `OCTOCLAW_ROUTER_SHADOW_PATH=/invalid/path` has **zero** impact on live route decisions, ACK, footer, or dispatch.
- Removing the snapshot file does **not** cause any test or Slack smoke failure.
- After one minute of normal traffic, shadow jsonl accumulates at least one well-formed event per completed turn.
- `octoclawctl router shadow-report` returns a non-zero summary over those events.
- `pnpm check && pnpm test` succeeds (the 6 pre-existing failures tracked in improvement plan appendix B remain acceptable unless this change touches them directly).

## Rollout

1. Slice-1: snapshot loader + request builder with unit tests.
2. Slice-2: shadow bridge wiring in `policy-resolver.ts` with focused tests for fail-open behaviour.
3. Slice-3: CLI `shadow-report` summary.
4. Slice-4: 7-day observation window. Daily review of `ignoredReasonCounts`. No live promotion.

Rollback is git revert. No feature flag needed because shadow is write-only and fail-open by construction.

## Why Now

- A/B shipping without C turns router-lite into shelf-ware.
- N3 promotion gate requires at least one week of shadow data.
- The C path is the smallest slice that produces measurable value without risking live traffic.

See also:

- `docs/octoclaw-improvement-plan-2026-05-12.md` §1 (W-1)
- `docs/octoclaw-auto-router-lite-cost-model-design-2026-05-08.md`
- `docs/octoclaw-phase5-auto-router-design-2026-04-30.md`
