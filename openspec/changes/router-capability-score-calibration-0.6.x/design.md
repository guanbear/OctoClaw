# Design: Capability score calibration

## Current State

The router already has enough input data to compute a unified capability
signal:

- `capability.scoreByScenario` from packaged/external leaderboard fusion
- `capability.codingTier` from metadata, catalog, or heuristic inference
- `marketPrice.blendedUsdPerMTok` for cost sorting
- health and configured/proposal-only flags for safety filtering

The problem is precedence. Live selection often treats `codingTier` as the
primary truth, while benchmark score is only used by deeper scoring paths. That
allows name-derived tier guesses to override stronger evidence.

## Internal Model

Introduce an internal normalized score:

```ts
interface CapabilityScore {
  score: number; // 0..100
  confidence: "high" | "medium" | "low" | "unknown";
  sources: string[];
  reasonCodes: string[];
}
```

This score is internal. It is not shown in normal Slack/IM footer output.

## Score Sources

The score is derived in priority order:

1. Existing fused leaderboard values from `capability.scoreByScenario`.
2. Existing `scenarioAbility.*.score`, when present.
3. Tier prior fallback:

| Tier | Prior score |
| --- | ---: |
| frontier | 92 |
| strong | 78 |
| standard | 64 |
| mini | 50 |
| unknown | 35 |

When multiple scores are available, use a simple weighted average:

- `coding_worker`: 0.55
- `agentic`: 0.25
- `research`: 0.10
- other/general scenario scores: 0.10

If only one score exists, use it directly. Missing sources are not counted as
zero. Confidence is capped by the evidence quality: benchmark scores can be
high, tier priors are low.

## Score to Tier

Derive the effective tier from the calibrated score:

| Score | Effective tier |
| ---: | --- |
| >= 90 | frontier |
| >= 75 | strong |
| >= 60 | standard |
| >= 45 | mini |
| < 45 | unknown |

If a score-derived tier is higher than the current tier, use the score-derived
tier. If the score-derived tier is lower, keep the existing tier only when the
existing tier has explicit configured/operator evidence. This avoids excessive
downgrades from sparse external data while allowing strong benchmark evidence
to correct weak name heuristics.

## Live Model-map Use

`extensions/octoclaw-runtime/src/model-map.ts` should evaluate lane floors with
the calibrated score, not only the raw `codingTier`.

Complexity floors:

| Lane | Minimum score | Minimum effective tier |
| --- | ---: | --- |
| simple | 45 | mini |
| normal | 60 | standard |
| complex | 75 | strong |
| deep | 90 | frontier |

After the floor filter, keep the existing behavior:

- filter out proposal-only/unconfigured/unavailable/cooldown models
- simple/normal choose the cheapest passing model
- complex preserves the native configured complex preference when it passes
- deep requires frontier
- user overrides still win

## OpenRouter Role

OpenRouter model ranking or popularity is not capability evidence. It can be
used by future discovery/proposal logic, but it must not promote a model across
capability floors without benchmark, probe, or operator evidence.

## Footer Policy

No normal footer change. The footer should continue to show route/model/thread
and existing difficulty information where already implemented. It should not
show price or internal capability score by default.
