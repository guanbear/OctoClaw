# OctoClaw Router User Guide

Auto Router v3 chooses delegated/sub-agent models from local configuration, local capability snapshots, local health/cost data, and shadow promotion evidence. V1 has one balanced scoring mode. It does not silently switch the main-agent model.

All V1 router state is local:

- `~/.openclaw/octoclaw/router-wizard.json`
- `~/.openclaw/octoclaw/cost.sqlite`
- `~/.openclaw/workspace/tmp/octopus/router-lite/model-intel-snapshot.json`
- `~/.openclaw/workspace/tmp/octopus/router-lite/model-config-proposal.json`
- `~/.openclaw/workspace/tmp/octopus/router-lite/shadow.jsonl`
- `~/.openclaw/workspace/tmp/octopus/router-lite/decisions.log`

## First Run

Run the wizard:

```bash
octoclawctl router wizard
```

The wizard writes the local router config. For scripted setup, pass an answers file:

```bash
octoclawctl router wizard --config answers.json
```

Supported answer fields are:

- `budget.monthly`
- `privacy`
- `language`
- `restrictedModels`
- `modelPlanTypes`
- `sameProviderModels`

When new OpenClaw models are added later, run:

```bash
octoclawctl router wizard --incremental
```

Slack onboarding can also re-prompt when `openclaw.json` contains configured models that are missing from `router-wizard.json`. Slack delivery is an onboarding surface only; the router config remains the local JSON file.

## Model Intelligence

Refresh the local model snapshot:

```bash
octoclawctl router model-intel refresh
```

The refresh merges configured OpenClaw models, local OpenClaw config, packaged/public capability data, observed health signals, usage-cost data when available, and scenario evidence. It fails open: missing external data produces lower-confidence fields instead of blocking routing.

Analyze same-provider configuration opportunities:

```bash
octoclawctl router model-config analyze
```

This writes a proposal file. It does not edit OpenClaw config and does not make proposal-only models live.

Refresh the public capability snapshot cache. By default this downloads the
OctoClaw-maintained official snapshot from GitHub Pages and verifies its
manifest SHA before writing the local cache; users do not need benchmark API
keys.

```bash
octoclawctl router capability refresh
octoclawctl router capability snapshot show
octoclawctl router capability list
octoclawctl router capability show openai/gpt-5-mini
octoclawctl router capability probe openai/gpt-5-mini
```

Install or update the OpenClaw cron job that keeps router capability data fresh:

```bash
octoclawctl router capability install-schedule --schedule-hour 4
octoclawctl router capability install-schedule --schedule-hour 4 --cadence daily
```

The `--cadence` flag accepts `weekly` (default) or `daily`. This creates one managed OpenClaw cron job named `OctoClaw AutoRouter capability refresh`. The job runs a lightweight isolated agent with only `exec` enabled, does not deliver IM messages, and executes:

```bash
octoclawctl router capability refresh --output-dir ~/.openclaw/workspace/tmp/octopus/router-lite --format json
octoclawctl router model-intel refresh --output-dir ~/.openclaw/workspace/tmp/octopus/router-lite --openclaw-home ~/.openclaw --format json
```

Running the install command again updates the existing managed job instead of creating duplicates. Routing still reads local snapshots only; the scheduled refresh downloads the official OctoClaw snapshot and does not recompute benchmark leaderboards locally.

The refresh keeps two local files:

- `model-intel-snapshot.json` is the slim routing snapshot. It keeps configured/default/fallback models, same-provider candidates, and common public candidates.
- `capability-catalog-full.json` is the full discovery catalog. Long-tail providers stay here so the wizard and CLI can still find cold or uncommon models without putting thousands of models on the routing hot path.

Maintainers can regenerate the packaged leaderboard seed or debug a local
source recompute from external sources:

```bash
pnpm router:leaderboard:refresh
octoclawctl router capability refresh --from-sources
```

The refresh script pulls benchmark/catalog sources and writes
`packages/octoclaw-router/src/data/leaderboard-snapshot.json` unless
`OCTOCLAW_ROUTER_SNAPSHOT_OUT` or `--output` is provided. The official
GitHub Pages publisher owns authenticated or expensive sources such as
Artificial Analysis; normal installs consume the published snapshot.

## Shadow And Promotion

Review shadow comparisons:

```bash
octoclawctl router shadow-report
```

Generate promotion audit records from local shadow samples:

```bash
octoclawctl router promotion review --input ~/.openclaw/workspace/tmp/octopus/router-lite/shadow.jsonl
```

Run the lightweight nightly review:

```bash
octoclawctl router promotion nightly-review --input ~/.openclaw/workspace/tmp/octopus/router-lite/shadow.jsonl
```

Inspect decisions:

```bash
octoclawctl router decisions --since 7d
```

Auto-promotion only applies to configured models. It requires enough samples, acceptable quality regression, lower cost, and the daily promotion limit. A failed promoted model is held back before it can be retried.

## Cost And Budget

Show cost grouped by model, complexity, and route:

```bash
octoclawctl router cost report --period 7d
```

The report includes month-end prediction and budget status when a monthly budget is configured.

Set or inspect a monthly budget:

```bash
octoclawctl router cost budget set --monthly 100
octoclawctl router cost budget show
```

At 80% usage the router emits a light warning. At 100% usage it falls back toward plan-included models when available. If no plan-included model is eligible, the router fails open to the primary model instead of forcing an unsafe candidate.

## Overrides

Override a score:

```bash
octoclawctl router score override openai/gpt-5.5 complex=75
```

Soft-avoid a model:

```bash
octoclawctl router model mark openai/gpt-5.5 --dispreferred-for normal
```

Hard-ban a model:

```bash
octoclawctl router model ban openai/gpt-5.5 --for normal
```

List and reset:

```bash
octoclawctl router model list-overrides
octoclawctl router score reset openai/gpt-5.5
```

Overrides are stored in `router-wizard.json`. They affect delegated/sub-agent routing only.

## Validation Workflow

1. Run `octoclawctl router wizard`.
2. Run `octoclawctl router model-intel refresh`.
3. Run `octoclawctl router model-config analyze`.
4. Trigger delegated work so `shadow.jsonl` and `cost.sqlite` receive local observations.
5. Run `octoclawctl router shadow-report`.
6. Run `octoclawctl router promotion review`.
7. Run `octoclawctl router decisions --since 7d`.
8. Run `octoclawctl router cost report --period 7d`.

For package verification during development:

```bash
pnpm --filter @octoclaw/router test
pnpm --filter @octoclaw/router check
```

## Current V1 Boundaries

- Provider quota API polling is not enabled without provider-specific credentials and adapters.
- Local replay is optional evidence; packaged/public capability data and local OpenClaw signals are the main inputs.
- The judge schema stays exactly `route`, `confidence`, and `complexity`.
- Routing decisions use structured signals and scoring, not keyword matching.
- Main-agent model changes are suggestions; delegated/sub-agent choices can be automated.
- User data stays local in V1.
