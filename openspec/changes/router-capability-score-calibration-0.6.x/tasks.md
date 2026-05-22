# Tasks

## Phase 1 — Unified score helpers

Write scope:

- `packages/octoclaw-router/src/decision/model-intel-facts.ts`
- `packages/octoclaw-router/src/__tests__/decision/model-intel-facts.test.ts`

Tasks:

- [ ] Add tests showing `scoreByScenario.coding_worker.score=86` calibrates a
      model to `strong` even when the raw tier/name is `mini`.
- [ ] Add tests showing models without benchmark score keep conservative tier
      prior behavior.
- [ ] Implement internal helper logic to derive a unified capability score.
- [ ] Calibrate merged model `capability.codingTier` from the score without
      removing existing evidence/sources.

## Phase 2 — Runtime model-map floors

Write scope:

- `extensions/octoclaw-runtime/src/model-map.ts`
- `extensions/octoclaw-runtime/src/model-map.test.ts`

Tasks:

- [ ] Add tests showing a configured `gpt-5.4-mini` with score 86 can pass the
      `complex` floor despite raw `mini` tier.
- [ ] Add tests showing `deep` still requires score >= 90/frontier.
- [ ] Update floor checks to use calibrated score when present, with raw tier
      fallback.
- [ ] Keep cost-first sorting and native complex preference behavior.

## Phase 3 — Scoring engine consistency

Write scope:

- `packages/octoclaw-router/src/scoring/index.ts`
- `packages/octoclaw-router/src/__tests__/decision/scoring.test.ts`

Tasks:

- [ ] Add tests showing `capabilityScoreFor()` uses unified score first.
- [ ] Keep existing tier-prior fallback for models without score evidence.
- [ ] Do not expose scores in normal IM footer output.

## Verification

- [ ] `pnpm vitest run packages/octoclaw-router/src/__tests__/decision/model-intel-facts.test.ts`
- [ ] `pnpm vitest run extensions/octoclaw-runtime/src/model-map.test.ts`
- [ ] `pnpm vitest run packages/octoclaw-router/src/__tests__/decision/scoring.test.ts`
- [ ] `pnpm check`
- [ ] `pnpm test`
- [ ] `npx gitnexus detect-changes --repo OctoClaw`
