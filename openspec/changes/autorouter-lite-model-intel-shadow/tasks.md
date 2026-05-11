# Tasks

## WP0 Spec And Scope

- [x] Create proposal/design/tasks/spec for AutoRouter Lite A/B/C.
- [x] Link the OpenSpec change from `docs/octoclaw-auto-router-lite-cost-model-design-2026-05-08.md`.
- [x] State that gated live routing is out of scope for this change.
- [x] State that old judge fields and keyword routing are out of scope.

## WP1 Contracts And Fixtures

- [ ] Define or refine Router Lite contracts for snapshot, model entry, source evidence, price, plan/quota, health, scenario ability, proposal, and shadow event.
- [ ] Add fixture JSON for a configured strong model, a same-provider cheaper configured model, and a same-provider proposal-only model.
- [ ] Add fixture JSON for unknown quota, high quota pressure, cooldown, stale source, and price conflict.
- [ ] Add schema/validator tests that reject missing source evidence for hard positive decisions.

## WP2 Model Intel Snapshot

- [ ] Merge local OpenClaw model list/config/catalog inputs into a snapshot.
- [ ] Merge local usage/cost/health/replay inputs when available.
- [ ] Support optional external catalog/leaderboard refresh outside the user-message hot path.
- [ ] Preserve source/freshness/confidence per field.
- [ ] Record conflicts instead of silently overwriting price or capability facts.
- [ ] Ensure snapshot refresh does not write OpenClaw live config.

## WP3 Config Proposal Analyzer

- [ ] Detect same-provider cheaper candidates from configured provider/catalog/family evidence.
- [ ] Mark `configured=false` candidates as proposal-only.
- [ ] Explain missing probe evidence, missing tool/structured capability, quota unknown, or health unknown.
- [ ] Emit `model-config-proposal.json` with expected use, risk, required action, and `why_not_live`.
- [ ] Add tests for same-provider discovery without keyword matching.

## WP4 Shadow Recommendation Selector

- [ ] Implement a pure selector that accepts judge four fields, compact runtime signals, and snapshot.
- [ ] Apply hard gates before scoring.
- [ ] Implement `cost_first`, `balanced`, and `reliable_fast` scoring.
- [ ] Emit selected recommendation or ignored reason.
- [ ] Keep explicit user/model override as shadow-only comparison.
- [ ] Add tests for unknown quota, cooldown, not configured, missing tool support, context too small, stale evidence, and explicit override.

## WP5 Shadow Event Integration

- [ ] Write shadow events to the router-lite JSONL path.
- [ ] Ensure selector errors do not change route, dispatch, spawn, ACK, footer, or WorkContract state.
- [ ] Include actual model, recommended model, estimated cost delta, quality floor, scenario, mode, and reason codes.
- [ ] Add a report command or summary helper that answers why a cheaper model was not enabled.

## WP6 Verification

- [ ] Run focused unit tests for contracts, snapshot, proposal, and selector.
- [ ] Run focused CLI tests for snapshot/proposal commands if CLI code changes.
- [ ] Run `git diff --check`.
- [ ] Do not mark this change live-ready; create a separate OpenSpec for gated live after shadow evidence exists.
