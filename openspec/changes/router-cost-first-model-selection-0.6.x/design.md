# Design: Cost-first live model map

## Current State

The full router package already models four complexities:

- `simple`
- `normal`
- `complex`
- `deep`

`extensions/octoclaw-runtime/src/router-lite/request-builder.ts` accepts those
four values, and Slack footer rendering can show `difficulty=<complexity>`.

The live child-agent model choice still flows through
`extensions/octoclaw-runtime/src/model-map.ts`. That bridge reads:

1. `openclaw models list --json`
2. optional router model-intel snapshot
3. user overrides

## Phase 1 Algorithm

Phase 1 uses the model-intel snapshot only as a read-only input. A model is
selectable when all conditions are true:

- `configured === true`
- `proposalOnly !== true`
- `available` is not `false` or `"no"`
- `health.cooldown !== true`
- its coding tier meets the lane's quality floor

Quality floors:

| Lane | Minimum tier |
| --- | --- |
| simple | mini |
| normal | standard |
| complex | strong |
| deep | frontier |

For each lane:

1. Filter to selectable models meeting the floor.
2. Sort by effective Phase-1 price.
3. Tie-break by higher tier only when prices are equal or unknown.
4. Tie-break by model key for determinism.

## Phase 1 Price

`marketPrice.blendedUsdPerMTok` is reliable when it is a positive number.

`0` is treated as unknown in Phase 1 when it only represents local
`openclaw_config` subscription/coding-plan state. This avoids treating unknown
quota burn as free.

Unknown price is sorted after reliable positive prices, but before falling back
to the pre-snapshot OpenClaw fallback map. This keeps routing conservative when
no reliable price exists.

## Phase 2 Plan-Aware Effective Cost

Phase 2 can replace Phase-1 price with `effectiveCost` after reliable data is
available:

- provider plan type
- remaining quota
- reset time
- per-model quota burn or equivalent unit cost
- observed gateway usage/cost from OpenClaw or ominiroute-compatible APIs

Until those signals are reliable, coding-plan state is informational only and
must not make a model appear free in live routing.

## Safety

This change does not modify OpenClaw config. It only changes OctoClaw's runtime
model-map projection for sub-agent selection. User overrides still win after
automatic mapping.

