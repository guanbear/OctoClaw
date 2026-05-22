# Change: Auto Router cost-first model selection

Date: 2026-05-22
Target release: v0.6.0

## Why

Auto Router's core value is cost reduction by assigning sub-agent work to the
cheapest model that is good enough for the judged complexity. The current live
runtime model map does not fully do that:

1. `simple` prefers exact `mini` tier before price, so a more expensive mini
   model can beat a cheaper stronger model.
2. `openclaw_config` cost values of `0` are treated as truly free, but coding
   plan quota burn is unknown. For GLM coding plans, GLM-5.1 and GLM-4.7 can
   both be subscription-backed while consuming different quota.
3. The full router scorer has richer cost/plan concepts, but the live sub-agent
   model map still uses a small bridge in `extensions/octoclaw-runtime/src/model-map.ts`.

## Scope

Phase 1 changes live model-map selection to be cost-first within quality floors:

- `simple`: any configured available model with tier >= `mini`
- `normal`: tier >= `standard`
- `complex`: tier >= `strong`
- `deep`: tier >= `frontier`

Within each lane, select the lowest reliable positive blended price. A zero
price from `openclaw_config` is not treated as free in Phase 1; it is treated as
unknown unless later backed by a reliable plan-aware effective cost.

Phase 2 is design-only in this change: plan-aware effective cost can be added
after OpenClaw/ominiroute usage data exposes reliable quota remaining and model
quota burn rate.

## Non-Goals

- Do not change judge routing or complexity classification.
- Do not infer coding plan quota burn from model names.
- Do not auto-edit OpenClaw model fallback order.
- Do not route proposal-only, unconfigured, cooled-down, or unavailable models.
- Do not unify the live model-map with the full router scorer in this small patch.

## Acceptance Gate

- [ ] Runtime model-map keeps four lanes: `simple`, `normal`, `complex`, `deep`.
- [ ] A cheaper `strong` model can win `simple` over a more expensive `mini` model.
- [ ] A model with only `openclaw_config` zero blended cost does not beat a model
      with a reliable positive external price.
- [ ] `deep` still requires `frontier`.
- [ ] `proposalOnly`, `configured !== true`, unavailable, and cooldown models
      never enter live model-map selection.
- [ ] Targeted tests for `model-map.ts` are green.
- [ ] `pnpm check && pnpm test` are green before release.

