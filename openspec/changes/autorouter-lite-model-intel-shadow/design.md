# Design: AutoRouter Lite A/B/C

## Overview

AutoRouter Lite runs after the existing judge decision and before any future live model-selection gate.

First implementation path:

```text
judge four fields
  + runtime compact signals
  + model-intel snapshot
  -> hard gates
  -> mode scoring
  -> shadow recommendation event
```

The shadow result is observational. It must not mutate route, dispatch, native spawn, WorkContract, ACK, footer, or OpenClaw config.

## Inputs

### Judge

Only the slim judge fields are active:

```text
route, confidence, complexity, complexity_confidence
```

AutoRouter Lite must not depend on removed fields.

### Runtime Signals

The selector may consume compact runtime signals:

- requested route and actual route,
- explicit user/model override,
- main vs delegated lane,
- task scenario if already known,
- estimated prompt/output budget,
- tool/structured/context requirements,
- route source and confidence,
- current selected model.

It must not infer hidden transcript details or raw child context.

### Model Intel Snapshot

Snapshot entries must include:

- `configured`,
- `available`,
- capability gates,
- scenario ability scores,
- market price and estimated task cost,
- plan/quota pressure,
- health, latency, failure, timeout, tool-call failure,
- `source[]`,
- `freshness`,
- `confidence`.

Missing or stale fields must degrade confidence instead of silently becoming defaults.

## Hard Gates

Hard gates run before scoring:

1. Model must be `configured=true` for any live-eligible recommendation.
2. Model must be `available=yes` and `cooldown=false`.
3. `quotaPressure=high` excludes by default.
4. `quotaPressure=unknown` is not free and receives no plan bonus.
5. Tool tasks require `toolUse=yes`.
6. Structured-output tasks require `structuredOutput=yes`.
7. Context requirement must fit known context window.
8. Required scenario ability must meet quality floor.
9. Missing source/freshness/confidence cannot become hard positive evidence.

Proposal-only candidates may bypass live eligibility only as `ignoredReason=not_configured` or `proposal_only`.

## Scoring Modes

Modes are simple weighted sorting, not a policy engine:

- `cost_first`: low-risk/retryable/batch tasks.
- `balanced`: default delegated work.
- `reliable_fast`: high failure cost or user-waiting work.

Score components:

- quality,
- cost,
- speed,
- stability,
- plan/quota.

Health and capability gates always happen before cost scoring.

## Scenario Ability

Use the fixed OctoClaw scenarios:

- `codingWorker`,
- `agenticToolTask`,
- `researchLookup`,
- `dataLogAnalysis`,
- `mainReasoning`,
- `defaultDelegate`.

External leaderboards are cold-start priors only. Local replay/nightly evidence outranks external ranks for live gating.

## Source Handling

Supported source classes:

- local OpenClaw models/config/catalog,
- pricing cache or cost config,
- provider usage/quota status,
- local replay/nightly/health probes,
- OpenRouter/models.dev/provider catalogs,
- PinchBench/Aider/SWE-bench/BFCL/Artificial Analysis and similar external leaderboards,
- operator override.

Conflict handling:

- Price conflicts must set a conflict marker and keep all sources.
- Capability conflicts must lower confidence unless local probe/replay resolves them.
- Stale external data must remain proposal/shadow only.

## Outputs

### Snapshot

Default path:

```text
~/.openclaw/workspace/tmp/octopus/router-lite/model-intel-snapshot.json
```

### Proposal

Default path:

```text
~/.openclaw/workspace/tmp/octopus/router-lite/model-config-proposal.json
```

Each proposal must include:

- base model,
- candidate model,
- same-provider/auth/profile evidence,
- expected use,
- risk,
- required probe or config action,
- `why_not_live`.

### Shadow Event

Default path:

```text
~/.openclaw/workspace/tmp/octopus/router-lite/router-lite-shadow.jsonl
```

Each event should include:

- judge fields,
- route source,
- mode,
- scenario,
- current actual model,
- recommended model when any,
- estimated task cost and delta,
- quality floor,
- hard gate pass/fail summary,
- selected reason or ignored reason,
- snapshot version and freshness.

## Failure Behavior

AutoRouter Lite is fail-open:

- Snapshot refresh failure leaves previous snapshot or disables recommendation.
- Proposal failure reports an error and does not change config.
- Shadow selector failure records a diagnostic event if possible and does not affect current route/model.
- Missing snapshot means no recommendation.

## OpenCode Guardrails

OpenCode must keep the implementation boring:

- pure functions first,
- typed contracts and fixtures before integration,
- no hot-path network,
- no live mutation,
- no broad router rewrite,
- no keyword rules,
- narrow tests for each gate and ignore reason.
