# Proposal: Router capability evidence calibration

## Why

Auto Router currently mixes two different concepts:

- coarse `codingTier` labels (`mini`, `standard`, `strong`, `frontier`)
- optional leaderboard scenario scores
- price/context/tool metadata from catalogs
- name-derived fallback priors

That can mis-rank models when the model name contains words like `mini` even
though benchmark evidence is strong. For example, `gpt-5.4-mini` can have a
high coding benchmark score while being classified as `mini`, causing live
model-map decisions to prefer weaker or less evidence-backed candidates.

The larger problem is trust: low-confidence or single-source scores can look
as precise as real benchmark-backed evidence. Models without reliable external
coverage must not be presented or routed as if we know their exact ordering.

The product goal is still simpler than full scenario routing: choose sub-agent
models by one calibrated capability signal, but make that signal evidence-first,
cross-checked across sources when possible, and honest about confidence.

## Scope

- Add a single internal `capabilityScore` concept derived from benchmark
  evidence, then conservative priors when evidence is missing.
- Move capability scoring to an OctoClaw-maintained official snapshot pipeline.
  End users consume the packaged/GitHub-published snapshot and do not need to
  run private leaderboard refreshes or request vendor leaderboard API keys.
- Separate capability evidence sources from metadata/price sources.
- Add snapshot evidence fields so we can explain which sources contributed.
- Cross-check sources and cap confidence when only weak evidence exists.
- Calibrate source fusion by leaderboard rank/percentile rather than raw
  cross-benchmark scores, and prevent source-local variants from pretending to
  be base-model global evidence.
- Calibrate `codingTier` from that score.
- Use the calibrated score for live complexity floors.
- Add watchlist/smoke coverage for user-important models and OpenRouter top
  models as observation-only drift checks.
- Keep the judge contract unchanged: `route / confidence / complexity`.
- Keep Slack/IM footers simple. Do not expose internal score or price in
  normal footer text.

## Non-goals

- No coding-plan pricing or quota inference.
- No new judge field.
- No scenario-specific live routing in this change.
- No automatic OpenClaw config edits.
- No end-user requirement to configure Artificial Analysis, Hugging Face, or
  other benchmark API keys for normal install/use.
- No OpenRouter popularity ranking as capability evidence. OpenRouter remains
  a metadata, pricing, and discovery source.
- No per-model hardcoded absolute scores. Model-family/version rules may only
  act as conservative fallback priors or tie-breaks when evidence is absent.

## Success Criteria

- A model with strong leaderboard score is not downgraded solely because its
  name contains `mini`.
- A configured model can pass `complex` when its calibrated score reaches the
  `strong` floor.
- Models without benchmark scores still work through conservative tier priors.
- Low-confidence or single-source data cannot promote/demote a model across a
  major tier by itself.
- Snapshot output shows the sources, confidence, and reason codes behind each
  capability score.
- The watchlist flags obvious drift such as compact/flash variants outranking
  their pro/full siblings without reliable evidence.
- The calibrated watchlist ordering satisfies evidence-backed sanity checks:
  Claude Opus 4.7 is above GPT-5.5, GPT-5.5 is above Claude Sonnet 4.6,
  GLM 5.1 is above MiniMax M2.7, DeepSeek V4 Pro is above V4 Flash, and
  GPT-5.4 is above DeepSeek V4 Flash. GPT-5.4 versus GLM 5.1 remains an
  observation, not a hard invariant.
- Existing safety filters still apply: unconfigured, proposal-only,
  unavailable, and cooldown models cannot enter live routing.
