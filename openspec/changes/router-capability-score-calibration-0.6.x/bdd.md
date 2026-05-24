# BDD: Capability evidence calibration

## CEC-001: Snapshot records source evidence

**Given** Aider returns a coding score for `openai/gpt-5.4-mini`
**And** OpenRouter returns price and context metadata for the same model
**When** the leaderboard snapshot refresh runs
**Then** the generated model record includes `capabilityScore.sources`
containing `aider`
**And** `sourceStatus.aider.health` is greater than `0`
**And** OpenRouter contributes price/context metadata but is not listed as a
capability evidence source.

## CEC-002: Parser mismatch degrades source health

**Given** BFCL returns a schema that does not match the expected parser
**When** the leaderboard snapshot refresh runs
**Then** BFCL contributes zero rows
**And** `sourceStatus.bfcl.health` is `0`
**And** the refresh still writes a usable snapshot.

## CEC-003: Single low-confidence source cannot cross a major tier

**Given** a model has raw tier `standard`
**And** only one stale or low-sample benchmark source reports a frontier-like
score
**When** model intel is merged
**Then** the model does not become `frontier`
**And** the capability score confidence is `low`.

## CEC-004: Strong benchmark evidence corrects a mini name

**Given** a configured model named `cliproxyapi/gpt-5.4-mini`
**And** its raw `capability.codingTier` is `mini`
**And** it has `scoreByScenario.coding_worker.score = 86`
**And** that score has medium or high confidence benchmark evidence
**When** model intel is merged
**Then** its effective `capability.codingTier` is `strong`
**And** existing capability evidence and sources are preserved.

## CEC-005: Missing benchmark score uses conservative prior

**Given** a configured model with raw `capability.codingTier = strong`
**And** it has no benchmark score
**When** model intel is merged
**Then** it remains `strong`
**And** the score evidence is treated as low-confidence prior data only.

## CEC-006: Complex lane accepts score-calibrated strong models

**Given** a configured `gpt-5.4-mini` model has raw tier `mini`
**And** its calibrated score is 86
**When** the runtime model map builds the `complex` lane
**Then** the model is eligible for the `strong` floor
**And** cost/native preference tie-breaks still decide the final model.

## CEC-007: Deep lane remains frontier-only

**Given** a configured model has calibrated score 86
**When** the runtime model map builds the `deep` lane
**Then** that model is not eligible for `deep`
**And** only models with score >= 90 or frontier-equivalent evidence pass.

## CEC-008: Safety filters still win

**Given** a proposal-only, unconfigured, unavailable, or cooldown model has a
high capability score
**When** live model selection runs
**Then** the model is rejected before cost or score sorting.

## CEC-009: Footer remains simple

**Given** a Slack reply footer is rendered
**When** Auto Router selects a model using calibrated score
**Then** the footer does not expose internal capability score
**And** the footer does not expose estimated price.

## CEC-010: OpenRouter top models are observation-only

**Given** OpenRouter rankings or top-model discovery returns a top 20 list
**When** capability smoke runs
**Then** those models are checked for missing evidence and suspicious drift
**But** their OpenRouter rank is not used as a capability score source.

## CEC-011: Watchlist drift is reported, not silently accepted

**Given** watchlist models include GLM, DeepSeek, Kimi, Qwen, MiniMax, OpenAI,
and Claude families
**When** capability smoke runs after refresh
**Then** models with no benchmark evidence are reported as low-confidence
**And** compact/flash variants outranking full/pro siblings without evidence is
reported as suspicious ordering.

## CEC-012: Official snapshot does not require user benchmark keys

**Given** a normal user installs or deploys OctoClaw
**And** the user has not configured Artificial Analysis or Hugging Face
benchmark API keys
**When** router capability data is loaded
**Then** the runtime uses the packaged official snapshot
**And** local missing benchmark credentials do not block install, deploy, or
routing.

## CEC-013: LM Arena global scoring uses only overall rows

**Given** LM Arena returns `overall`, `creative_writing`, `search`, or other
category rows for the same model
**When** the official snapshot refresh computes global capability
**Then** only `category=overall` rows contribute to the global source score
**And** category-specific rows are ignored for global scoring unless mapped to
an explicit scenario.

## CEC-014: Source-local model rows are deduplicated

**Given** a source returns multiple rows for a model or close serving variants
in the same scenario
**When** source fusion runs
**Then** the source contributes at most one effective vote per model/scenario
**And** variant rows are marked as auxiliary evidence rather than counted as
independent source families.

## CEC-015: Variant rows cannot lift a base model above a newer sibling alone

**Given** `claude-opus-4-6-thinking` and `claude-opus-4-6-search` rank highly
on task-specific rows
**And** `claude-opus-4.7` has base-model evidence
**When** global capability is fused
**Then** `claude-opus-4.6` does not outrank `claude-opus-4.7` solely because
of those variant rows
**And** the reason codes show variant evidence was capped or downweighted.

## CEC-016: Coding-only evidence does not dominate global capability

**Given** a model has strong SWE-bench or LM Arena webdev evidence
**And** weaker broad/global evidence
**When** global capability is fused
**Then** coding evidence may support confidence and coding score
**But** it does not dominate the global score enough to promote the model over
broader frontier models by itself.

## CEC-017: Watchlist sanity checks stay data-driven

**Given** the watchlist contains Opus, GPT, GLM, Kimi, MiniMax, and DeepSeek
models
**When** capability smoke runs against the official snapshot
**Then** it flags failures for Opus 4.7 below GPT-5.5, GPT-5.5 below Sonnet
4.6, GLM 5.1 below MiniMax M2.7, DeepSeek V4 Pro below V4 Flash, or GPT-5.4
below DeepSeek V4 Flash
**And** it reports GPT-5.4 versus GLM 5.1 as an observation rather than a
failure.
