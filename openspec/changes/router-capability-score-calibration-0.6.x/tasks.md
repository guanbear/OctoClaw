# Tasks

## Phase 1 — Snapshot evidence and source classes

Write scope:

- `scripts/refresh-leaderboard-snapshot.mjs`
- `packages/octoclaw-router/src/data/source-weights.json`
- refresh/snapshot tests if present, otherwise add focused tests near router
  capability tests

Tasks:

- [x] Separate capability benchmark sources from catalog/price metadata sources.
- [x] Add additive `capabilityScore` and `sourceStatus` fields to generated
      snapshots while preserving old snapshot compatibility.
- [x] Normalize source weights over present healthy benchmark sources only.
- [x] Ensure parser schema mismatch returns `[]` and source health `0.0`.
- [x] Add/extend alias handling for `z-ai`/`zhipu`, Qwen, Kimi, DeepSeek,
      MiniMax, Claude, and OpenAI variants.
- [x] Add SWE-bench Verified/Pro structured source adapters from Hugging Face
      leaderboard APIs, with within-source normalization.
- [x] Add generic same-family sibling calibration so compact/older variants do
      not outrank stronger siblings on equal-or-weaker evidence.
- [x] Add watchlist fixture coverage for user-important models, including
      newly available Gemini 3.5 Flash, and observation-only OpenRouter top
      models.

## Phase 2 — Unified score helpers

Write scope:

- `packages/octoclaw-router/src/decision/model-intel-facts.ts`
- `packages/octoclaw-router/src/__tests__/decision/model-intel-facts.test.ts`

Tasks:

- [x] Add tests showing `scoreByScenario.coding_worker.score=86` calibrates a
      model to `strong` even when the raw tier/name is `mini`.
- [x] Add tests showing models without benchmark score keep conservative tier
      prior behavior.
- [x] Implement internal helper logic to derive a unified capability score from
      evidence first and priors second.
- [x] Calibrate merged model `capability.codingTier` from the score without
      removing existing evidence/sources.
- [x] Assert low-confidence/single-source evidence cannot cross major tier
      boundaries by itself.

## Phase 3 — Runtime model-map floors

Write scope:

- `extensions/octoclaw-runtime/src/model-map.ts`
- `extensions/octoclaw-runtime/src/model-map.test.ts`

Tasks:

- [x] Add tests showing a configured `gpt-5.4-mini` with score 86 can pass the
      `complex` floor despite raw `mini` tier.
- [x] Add tests showing `deep` still requires score >= 90/frontier.
- [x] Update floor checks to use calibrated score when present, with raw tier
      fallback.
- [x] Keep cost-first sorting and native complex preference behavior.

## Phase 4 — Scoring engine consistency

Write scope:

- `packages/octoclaw-router/src/scoring/index.ts`
- `packages/octoclaw-router/src/__tests__/decision/scoring.test.ts`

Tasks:

- [x] Add tests showing `capabilityScoreFor()` uses unified score first.
- [x] Keep existing tier-prior fallback for models without score evidence.
- [x] Keep low-confidence fallback priors coarse; do not expose precise
      benchmark-like scores for no-evidence models.
- [x] Do not expose scores in normal IM footer output.

## Phase 5 — Smoke and diagnostics

Write scope:

- `tools/octoclawctl/src/nightly/*`
- `tools/octoclawctl/src/stability/*`
- related tests

Tasks:

- [x] Add capability evidence smoke covering the watchlist models.
- [x] Add observation-only OpenRouter top20 comparison; do not feed it into
      capability scoring.
- [x] Report missing evidence, low confidence, and suspicious ordering as smoke
      findings.
- [x] Keep Slack/IM footer unchanged: no internal score or estimated price.

## Phase 6 — Official snapshot and fair scoring V2

Write scope:

- `scripts/refresh-leaderboard-snapshot.mjs`
- `tests/scripts/refresh-leaderboard-snapshot.test.ts`
- `tools/octoclawctl/src/nightly/capability-smoke.ts`
- `tools/octoclawctl/src/nightly/nightly.test.ts`
- `packages/octoclaw-router/src/data/source-weights.json`
- docs describing official snapshot refresh/update behavior

Tasks:

- [x] Add tests proving LM Arena global scoring filters to
      `category=overall` and does not mix category-specific rows into global
      scores.
- [x] Add tests proving a source contributes at most one effective
      model/scenario vote after canonicalization and variant grouping.
- [x] Add tests proving `thinking`, `search`, `codex-harness`, and
      function-calling rows are auxiliary evidence and cannot independently
      promote a base model above a newer same-family sibling.
- [x] Replace raw min/max source normalization with source-local rank scoring
      for leaderboard sources that expose rank or sortable values.
- [x] Split global score from scenario scores so SWE-bench, Aider,
      LiveCodeBench, BFCL, and LM Arena webdev primarily affect their scenario
      scores and only lightly support global capability.
- [x] Apply confidence shrinkage by independent source family count.
- [x] Apply generic same-family smoothing without per-model absolute score
      overrides.
- [x] Add official snapshot documentation: packaged snapshot is the runtime
      source of truth, GitHub/maintainer refresh owns expensive or
      authenticated benchmark sources, and local user installs do not require
      benchmark API keys.
- [x] Add GitHub Pages publication files for official capability snapshots and
      make `octoclawctl router capability refresh` consume the official
      manifest/snapshot by default with `--from-sources` reserved for
      maintainer recompute.
- [x] Update capability smoke with the evidence-backed watchlist assertions
      and observation-only GPT-5.4 versus GLM-5.1 comparison.
- [x] Run a real refresh to inspect watchlist rankings before accepting the
      change.

## Verification

- [x] `node scripts/refresh-leaderboard-snapshot.mjs --check-seed`
- [x] `pnpm vitest run packages/octoclaw-router/src/__tests__/decision/model-intel-facts.test.ts`
- [x] `pnpm vitest run extensions/octoclaw-runtime/src/model-map.test.ts`
- [x] `pnpm vitest run packages/octoclaw-router/src/__tests__/decision/scoring.test.ts`
- [x] `pnpm vitest run tools/octoclawctl/src/nightly/nightly.test.ts tools/octoclawctl/src/stability/stability.test.ts`
- [x] `pnpm vitest run tests/scripts/refresh-leaderboard-snapshot.test.ts`
- [x] `node scripts/refresh-leaderboard-snapshot.mjs --check-seed --output /tmp/octoclaw-leaderboard-snapshot-v2-after-global.json`
- [x] `pnpm check`
- [x] `pnpm test`
- [x] `npx gitnexus detect-changes --repo OctoClaw`
