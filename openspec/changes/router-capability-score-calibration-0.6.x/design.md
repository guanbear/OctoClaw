# Design: Capability evidence calibration

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

There is a second problem: not all sources mean the same thing. OpenRouter,
models.dev, and LiteLLM are useful for discovery, price, context window, and
tool support, but they are not quality leaderboards. A single low-confidence
benchmark row is also not enough to claim precise capability ordering.

## Internal Model

Introduce an internal normalized score:

```ts
interface CapabilityScore {
  score: number; // 0..100
  confidence: "high" | "medium" | "low" | "unknown";
  sources: string[];
  evidenceCount: number;
  reasonCodes: string[];
}
```

This score is internal. It is not shown in normal Slack/IM footer output.

## Source Classes

Sources are classified before fusion:

| Class | Examples | Use |
| --- | --- | --- |
| Capability benchmark | Aider, BFCL, SWE-bench Verified, SWE-bench Pro; later LiveCodeBench, Artificial Analysis, LM Arena when structured feeds are available | May contribute to `capabilityScore` |
| Runtime health | Router health loop probe/delegated-call events | May gate/cooldown and later adjust confidence, not a static capability source |
| Catalog metadata | OpenRouter `/api/v1/models`, models.dev, LiteLLM | Price, context, modalities, tool/JSON/reasoning support |
| Popularity/ranking | OpenRouter rankings/top models | Observation-only smoke/drift signal, not capability evidence |
| Fallback prior | tier/name/family/version rules | Conservative low-confidence prior only |

If a source parser schema does not match, it returns zero rows and source
health `0.0`; refresh must not throw solely because one source changed.

## Evidence Fusion

The score is derived in priority order:

1. Medium/high confidence capability benchmark evidence.
2. Existing fused `capability.scoreByScenario` values that already contain
   evidence metadata.
3. Existing `scenarioAbility.*.score`, when present with source metadata.
4. Tier/family prior fallback.

When multiple benchmark scores are available, use a weighted average by source
coverage and freshness. Missing sources are not counted as zero. Price/catalog
sources are never weighted into capability.

Default source weights:

| Source | coding worker | agentic/tool | general/research |
| --- | ---: | ---: | ---: |
| Aider | 0.25 | 0.00 | 0.00 |
| PinchBench | 0.15 | 0.10 | 1.00 |
| BFCL | 0.10 | 0.60 | 0.00 |
| SWE-bench Verified | 0.25 | 0.15 | 0.00 |
| SWE-bench Pro | 0.25 | 0.15 | 0.00 |

Sources such as LiveCodeBench, Artificial Analysis, and LM Arena remain
approved future capability sources, but are not active weights until refresh
has a structured, tested parser for them. OpenRouter rankings remain
observation-only.

Weights are normalized over sources that are present and healthy. A source may
be absent from a local refresh; absence lowers evidence coverage but does not
fail routing.

Confidence rules:

| Evidence | Confidence cap |
| --- | --- |
| 2+ independent healthy benchmark sources, fresh enough | high |
| 1 healthy benchmark source with adequate samples | medium |
| low-sample, stale, or source-health-degraded benchmark source | low |
| tier/name/family prior only | low |
| no usable evidence or prior | unknown |

Low-confidence data cannot move a model across a major tier. Medium-confidence
single-source data can affect ordering inside the current tier and may lift at
most one floor when it is not stale. High-confidence cross-source data can
calibrate the effective tier.

## Prior Fallback

Tier priors remain coarse:

| Tier | Prior score |
| --- | ---: |
| frontier | 92 |
| strong | 78 |
| standard | 64 |
| mini | 50 |
| unknown | 35 |

Family/version rules are allowed only as generic low-confidence tie-breaks:

- compact modifiers (`mini`, `flash`, `lite`, `haiku`, `small`, `air`) lower
  the prior unless benchmark evidence says otherwise.
- quality modifiers (`opus`, `sonnet`, `pro`, `max`, `plus`) may slightly
  affect same-tier ordering.
- version monotonicity may break ties within the same family, such as a later
  `5.1` variant sorting above `5.0` when there is no contradictory evidence.
- compact variants may be capped below same-series full/pro siblings unless
  there is stronger same-confidence evidence for the compact variant.
- older same-role variants may be capped below newer same-family variants when
  the older score comes from equal-or-weaker confidence evidence.

No fallback prior may assign an exact absolute benchmark-like score to a
specific model.

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
tier only when confidence rules allow promotion. If the score-derived tier is
lower, keep the existing tier when the current tier has explicit configured or
operator evidence. This avoids excessive downgrades from sparse external data
while allowing strong benchmark evidence to correct weak name heuristics.

## Snapshot Evidence

`leaderboard-snapshot.json` should preserve enough evidence for offline
diagnostics:

```json
{
  "models": {
    "provider/model": {
      "capabilityScore": {
        "score": 86.2,
        "confidence": "medium",
        "sources": ["aider"],
        "evidenceCount": 1,
        "reasonCodes": ["single_source_cap:medium"]
      },
      "scoreByScenario": {
        "coding_worker": {
          "score": 86.2,
          "confidence": "medium",
          "contributions": [
            {"source": "aider", "rawScore": 86.2, "effectiveWeight": 1}
          ],
          "reasonCodes": ["fusion_sources:1"]
        }
      }
    }
  },
  "sourceStatus": {
    "aider": {"ok": true, "rows": 120, "health": 1},
    "bfcl": {"ok": false, "rows": 0, "health": 0}
  }
}
```

Existing loaders must tolerate old snapshots. New fields are additive.

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

OpenRouter top models are still useful for smoke: refresh should be able to
produce an observation report for the current top 20 and flag which ones have
no benchmark evidence or surprising ordering. This report is not an input to
the router.

## Official Snapshot Pipeline

Capability scoring is maintained by OctoClaw, not by every installed runtime.
The official package ships a curated `leaderboard-snapshot.json` generated by
the project release workflow or maintainer-triggered GitHub Action. Local users
may still run refresh commands for development diagnostics, but normal install,
deploy, and migration must work without benchmark API keys.

The public distribution endpoint is GitHub Pages:

- `capability/leaderboard-manifest.json`
- `capability/leaderboard-summary.json`
- `capability/leaderboard-snapshot.json`
- `capability/index.html`

`octoclawctl router capability refresh` downloads the manifest by default,
verifies the snapshot SHA-256, and writes the normal local router-lite cache.
Maintainer/debug source recomputation is explicit via `--from-sources`.

Rules:

- Public unauthenticated sources may be refreshed by CI.
- Authenticated sources such as Artificial Analysis are optional maintainer
  inputs. Missing credentials mark the source as `missing_auth` in CI/dev
  refresh output but do not fail package installation.
- The generated snapshot records source status and reason codes so users can
  inspect package provenance, but runtime routing consumes only the packaged
  score fields.
- The CLI schedule should default to checking for official snapshot updates,
  not recomputing private scores locally. Local recompute remains a
  maintainer/debug path.

## Fair Scoring V2

Raw scores from independent leaderboards are not directly comparable. The
refresh pipeline converts each healthy source to a source-local rank score
before fusion:

1. Use only the source's official overall/main split for global capability.
   For LM Arena this means `category=overall`; category-specific rows are not
   mixed into global scoring.
2. Deduplicate per model/source/scenario. A model gets at most one vote from a
   source in a scenario.
3. Convert leaderboard rank to a normalized score with a logarithmic curve so
   top positions separate clearly while long-tail positions do not collapse to
   zero. Missing models are absent, not scored as zero.
4. Scenario-specific sources remain scenario-specific. SWE-bench, Aider,
   LiveCodeBench, and LM Arena webdev primarily influence coding score. BFCL
   primarily influences agentic/tool score. Broad intelligence sources such as
   Artificial Analysis intelligence and LM Arena text/search influence global
   score more heavily.
5. Apply confidence shrinkage toward coarse family/tier priors when source
   family coverage is sparse. One source family cannot create high precision;
   two families can produce medium confidence; three or more independent
   families can produce high confidence.

The global capability score may include a small contribution from coding and
agentic sources because they are useful capability evidence, but they must not
dominate broad capability. This prevents coding-only leaders or flash variants
from being promoted above broader frontier models on the global score while
still allowing coding routes to use their coding scenario score.

## Variant Evidence

Benchmark rows often describe a serving mode rather than a base model, for
example `thinking`, `search`, `codex-harness`, function-calling, or other
task-specific suffixes. The snapshot must preserve this distinction:

- Base rows contribute normally to the base model.
- Variant rows may contribute to the same model family as auxiliary evidence
  only with reduced weight and explicit reason codes.
- A variant row must not be the sole reason a base model becomes frontier on
  global score.
- Search variants should not lift non-search global score beyond the source's
  broad/research contribution.
- Function-calling rows contribute to agentic/tool score unless the source
  explicitly labels them as the provider's default base model.

## Same-Family Smoothing

Generic family/version smoothing is allowed as a guardrail, not a hardcoded
model table. Within the same provider, base family, and role:

- A newer same-role version should not be materially below an older version
  unless at least two independent source families support the older version's
  advantage.
- Older versions may slightly outperform newer versions when evidence supports
  it, but single-source or variant-only evidence is capped near the newer
  version.
- Compact/flash/mini/lite variants may not outrank full/pro siblings on global
  score unless they have equal-or-better independent evidence from broad
  sources, not only coding benchmarks.

This is intended to prevent cases like an older Opus variant being lifted above
the newer Opus release by `thinking`/`search` rows alone, without introducing
per-model absolute score overrides.

## Expected Watchlist Shape

The exact scores are evidence-derived and can move as official snapshots are
refreshed, but the smoke suite should flag these ordering expectations:

- `anthropic/claude-opus-4.7` above `openai/gpt-5.5`.
- `openai/gpt-5.5` above `anthropic/claude-sonnet-4.6`.
- `zhipu/glm-5.1` above `minimax/minimax-m2.7`.
- `deepseek/deepseek-v4-pro` above `deepseek/deepseek-v4-flash`.
- `openai/gpt-5.4` above `deepseek/deepseek-v4-flash`.
- `openai/gpt-5.4` versus `zhipu/glm-5.1` is reported but not a failure.

## Footer Policy

No normal footer change. The footer should continue to show route/model/thread
and existing difficulty information where already implemented. It should not
show price or internal capability score by default.

## Watchlist

Regression tests and smoke should include the following families because they
are frequently configured by users and easy to mis-rank:

- GLM: `glm-5.1`, `glm-5`, `glm-4.7`
- OpenAI: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`
- Google: `gemini-3.5-flash`
- Anthropic: `claude-sonnet-4.6`, `claude-sonnet-4.7`, `claude-opus-4.6`, `claude-opus-4.7`
- DeepSeek: `deepseek-v4-pro`, `deepseek-v4-flash`
- Kimi: `kimi-k2.6`
- Qwen: `qwen-3.7-max`, `qwen-3.6-plus`
- MiniMax: `minimax-m2.7`, `minimax-m2.5`

The watchlist should assert confidence/evidence behavior first. Ordering
assertions are allowed only when backed by adequate evidence or generic
family-version monotonicity.
