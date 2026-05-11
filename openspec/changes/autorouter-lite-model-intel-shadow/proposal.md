# Change: AutoRouter Lite Model Intel And Shadow Recommendation

## Purpose

Implement the first useful AutoRouter Lite slice without turning OctoClaw into a new routing engine.

This change gives OctoClaw a model intelligence fact plane, same-provider configuration proposals, and shadow model recommendations so we can answer:

- Which configured models are available for delegated work?
- Which cheaper same-provider candidates should be configured or probed?
- Would a cheaper model likely satisfy this task, and why is it not used yet?
- What cost, speed, stability, quota, or capability evidence is missing before live routing?

## Scope

This OpenSpec covers A/B/C only:

- A: `model-intel snapshot` refresh.
- B: `model-config proposal` analysis.
- C: `shadow recommendation` events.

The implementation may add or refine:

- Router Lite contracts and schema validation.
- Snapshot refresh CLI/runtime helpers.
- Config proposal analysis.
- Shadow recommendation pure selector.
- JSONL event writing and report summaries.
- Tests and fixtures for source/freshness/confidence, quota handling, same-provider discovery, and shadow ignore reasons.

## Non-Goals

- No gated live model replacement.
- No new total AutoRouter control plane.
- No judge replacement.
- No restoration of old judge fields such as `role`, `workType`, `scope`, `tool_need_hint`, or `duration_hint`.
- No keyword routing, keyword task classification, or keyword model selection.
- No external catalog/pricing fetches in the Slack or user-message hot path.
- No automatic writes to OpenClaw live config.
- No use of `configured=false` models for live route/model decisions.
- No treating `quotaPressure=unknown` as free or low pressure.
- No changes to WorkContract, native TaskFlow, planner confirm, ACK, footer, or dispatch semantics.

## Acceptance Gate

The change is acceptable when:

- `model-intel-snapshot.json` can be generated from local OpenClaw/config/catalog/usage/cost inputs.
- External sources, if used, are opt-in refresh inputs and cached into snapshot with source/freshness/confidence.
- `model-config-proposal.json` can explain same-provider cheaper candidates and why each is proposal-only.
- Shadow recommendation records actual model, recommended model, mode, task scenario, estimated cost delta, quality floor, and selected/ignored reasons.
- Shadow recommendation failures are fail-open: existing route/dispatch/spawn/ACK/footer behavior remains unchanged.
- Tests prove unknown quota is not treated as free, missing source does not become hard evidence, and `configured=false` cannot enter live.

## Rollout

Default rollout is shadow-only.

Live model selection requires a separate OpenSpec after at least 7 days or 100 shadow samples show:

- quality does not regress,
- estimated cost decreases or stays flat,
- failure and timeout rates do not increase,
- latency does not materially regress,
- rollback to shadow-only is one flag/config change.
