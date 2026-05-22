# Proposal: Router capability score calibration

## Why

Auto Router currently mixes two different concepts:

- coarse `codingTier` labels (`mini`, `standard`, `strong`, `frontier`)
- optional leaderboard scenario scores

That can mis-rank models when the model name contains words like `mini` even
though benchmark evidence is strong. For example, `gpt-5.4-mini` can have a
high coding benchmark score while being classified as `mini`, causing live
model-map decisions to prefer weaker or less evidence-backed candidates.

The immediate product goal is simpler than full scenario routing: choose
sub-agent models by a single calibrated capability score, then apply the
existing complexity floor and cost sorting.

## Scope

- Add a single internal `capabilityScore` concept derived from existing
  `scoreByScenario` data or tier priors.
- Calibrate `codingTier` from that score.
- Use the calibrated score for live complexity floors.
- Keep the judge contract unchanged: `route / confidence / complexity`.
- Keep Slack/IM footers simple. Do not expose internal score or price in
  normal footer text.

## Non-goals

- No coding-plan pricing or quota inference.
- No new judge field.
- No scenario-specific live routing in this change.
- No automatic OpenClaw config edits.
- No OpenRouter popularity ranking as capability evidence. OpenRouter remains
  a metadata, pricing, and discovery source.

## Success Criteria

- A model with strong leaderboard score is not downgraded solely because its
  name contains `mini`.
- A configured model can pass `complex` when its calibrated score reaches the
  `strong` floor.
- Models without benchmark scores still work through conservative tier priors.
- Existing safety filters still apply: unconfigured, proposal-only,
  unavailable, and cooldown models cannot enter live routing.
