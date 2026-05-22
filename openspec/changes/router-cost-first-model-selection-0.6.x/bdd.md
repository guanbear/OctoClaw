# BDD: Cost-first live model-map

## AR-COST-001 — Cheap strong beats expensive mini for simple

Given OpenClaw has configured available models:

- `zai/glm-4.7`, tier `strong`, blended price `1.0`
- `cliproxyapi/gpt-5.4-mini`, tier `mini`, blended price `1.6875`

When the runtime builds the model map

Then `complexity.simple` is `zai/glm-4.7`.

## AR-COST-002 — Deep still requires frontier

Given the same models plus:

- `cliproxyapi/gpt-5.5`, tier `frontier`, blended price `11.25`

When the runtime builds the model map

Then `complexity.deep` is `cliproxyapi/gpt-5.5`.

## AR-COST-003 — Zero local config cost is unknown, not free

Given OpenClaw config contributes `zhipu/GLM-5.1` with blended price `0` from
`openclaw_config`

And model-intel contains `zai/glm-4.7` with reliable positive blended price `1.0`
from external sources

When selecting the `complex` lane

Then `zai/glm-4.7` wins over `zhipu/GLM-5.1`.

## AR-COST-004 — Unsafe candidates never go live

Given a snapshot model is proposal-only, unconfigured, unavailable, or cooled
down

When the runtime builds the model map

Then that model is not selected for any complexity lane.

## AR-COST-005 — Plan data is informational in Phase 1

Given a model has subscription/coding-plan metadata but no reliable quota burn
rate

When the runtime ranks model cost

Then the subscription metadata does not make the model free.

