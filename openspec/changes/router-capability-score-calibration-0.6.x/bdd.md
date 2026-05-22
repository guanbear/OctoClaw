# BDD: Capability score calibration

## CSC-001: Strong benchmark evidence corrects a mini name

**Given** a configured model named `cliproxyapi/gpt-5.4-mini`
**And** its raw `capability.codingTier` is `mini`
**And** it has `scoreByScenario.coding_worker.score = 86`
**When** model intel is merged
**Then** its effective `capability.codingTier` is `strong`
**And** existing capability evidence and sources are preserved.

## CSC-002: Missing benchmark score uses conservative prior

**Given** a configured model with raw `capability.codingTier = strong`
**And** it has no benchmark score
**When** model intel is merged
**Then** it remains `strong`
**And** the score evidence is treated as low-confidence prior data only.

## CSC-003: Complex lane accepts score-calibrated strong models

**Given** a configured `gpt-5.4-mini` model has raw tier `mini`
**And** its calibrated score is 86
**When** the runtime model map builds the `complex` lane
**Then** the model is eligible for the `strong` floor
**And** cost/native preference tie-breaks still decide the final model.

## CSC-004: Deep lane remains frontier-only

**Given** a configured model has calibrated score 86
**When** the runtime model map builds the `deep` lane
**Then** that model is not eligible for `deep`
**And** only models with score >= 90 or frontier-equivalent evidence pass.

## CSC-005: Safety filters still win

**Given** a proposal-only, unconfigured, unavailable, or cooldown model has a
high capability score
**When** live model selection runs
**Then** the model is rejected before cost or score sorting.

## CSC-006: Footer remains simple

**Given** a Slack reply footer is rendered
**When** Auto Router selects a model using calibrated score
**Then** the footer does not expose internal capability score
**And** the footer does not expose estimated price.
