# Tasks

## Phase 1 — Cost-first live model-map

Write scope:

- `extensions/octoclaw-runtime/src/model-map.ts`
- `extensions/octoclaw-runtime/src/model-map.test.ts`

Tasks:

- [ ] Add tests showing a cheaper `strong` model beats a more expensive `mini`
      model for `simple`.
- [ ] Add tests showing `openclaw_config` zero blended cost is treated as
      unknown and does not beat reliable positive external pricing.
- [ ] Keep the existing guard that proposal-only/unconfigured/cooldown models
      cannot enter live selection.
- [ ] Change snapshot lane selection from exact-tier-first to quality-floor-first
      cost sorting.
- [ ] Keep `deep` restricted to `frontier` floor.
- [ ] Run:
      `pnpm vitest run extensions/octoclaw-runtime/src/model-map.test.ts`
- [ ] Run `pnpm check`.
- [ ] Run `pnpm test`.

## Phase 2 — Plan-aware effective cost design boundary

No live implementation in this change.

Tasks:

- [ ] Keep coding-plan/subscription data out of live cost ranking unless a
      reliable quota burn signal is present.
- [ ] Document future inputs: OpenClaw usage, gateway usage-cost, provider quota,
      reset time, model-specific burn rate, ominiroute-compatible usage data.
- [ ] Do not treat `subscription` or `cost=0` as free by default.

