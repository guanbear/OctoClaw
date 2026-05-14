# OctoClaw Router User Guide

Auto Router v3 chooses delegated/sub-agent models from local configuration, local cost and health data, and packaged capability snapshots. V1 uses one balanced scoring mode and keeps all router data on the local machine.

## First Run

Run:

```bash
octoclawctl router wizard
```

The wizard writes `~/.openclaw/octoclaw/router-wizard.json`. For scripted setup, pass an answers file:

```bash
octoclawctl router wizard --config answers.json
```

Supported answer fields are `budget.monthly`, `privacy`, `language`, `restrictedModels`, `modelPlanTypes`, and `sameProviderModels`.

When new OpenClaw models are added later, run:

```bash
octoclawctl router wizard --incremental
```

Slack onboarding also re-prompts when `openclaw.json` contains configured models that are missing from `router-wizard.json`.

## Capability And Decisions

Refresh local capability data:

```bash
octoclawctl router model-intel refresh
```

Review promotion audit records:

```bash
octoclawctl router decisions --since 7d
```

Generate promotion audit records from local shadow samples:

```bash
octoclawctl router promotion review --input ~/.openclaw/workspace/tmp/octopus/router-lite/shadow.jsonl
```

Auto-promotion only applies to configured models and is limited by sample count, quality regression, cost benefit, and one promotion per day.

## Cost And Budget

Show cost grouped by model, complexity, and route:

```bash
octoclawctl router cost report --period 7d
```

The report includes month-end prediction and budget status when a monthly budget is configured.

Set a monthly budget:

```bash
octoclawctl router cost budget set --monthly 100
```

At 80% usage the router emits a light warning. At 100% usage it falls back toward plan-included models when available.

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

## Invariants

- Main-agent models are never silently switched.
- Unconfigured models never go live.
- Unknown quota pressure is not treated as free.
- Shadow emission failure never changes the live route.
- User data stays under `~/.openclaw/octoclaw/` in V1.
