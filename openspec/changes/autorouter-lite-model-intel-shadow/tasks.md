# Tasks

## WP0 Spec And Scope

- [x] Create proposal/design/tasks/spec for AutoRouter Lite A/B/C.
- [x] Link the OpenSpec change from `docs/octoclaw-auto-router-lite-cost-model-design-2026-05-08.md`.
- [x] State that gated live routing is out of scope for this change.
- [x] State that old judge fields and keyword routing are out of scope.

## WP1 Contracts And Fixtures

- [x] Define or refine Router Lite contracts for snapshot, model entry, source evidence, price, plan/quota, health, scenario ability, proposal, and shadow event.
- [x] Add fixture/test coverage for a configured strong model, a same-provider cheaper configured model, and a same-provider proposal-only model.
- [x] Add fixture JSON for unknown quota, high quota pressure, cooldown, stale source, and price conflict.
- [x] Add schema/validator tests that reject missing source evidence for hard positive decisions.

## WP2 Model Intel Snapshot

- [x] Merge local OpenClaw model list/config/catalog inputs into a snapshot.
- [x] Merge structured local usage/cost/health inputs when available.
- [x] Support optional cached external catalog/leaderboard inputs outside the user-message hot path; the refresh job remains future work.
- [x] Preserve source/freshness/confidence per field.
- [x] Record conflicts instead of silently overwriting price or capability facts.
- [x] Ensure snapshot refresh does not write OpenClaw live config.

## WP3 Config Proposal Analyzer

- [x] Detect same-provider cheaper candidates from configured provider/catalog/family evidence.
- [x] Mark `configured=false` candidates as proposal-only.
- [x] Explain missing probe evidence, missing tool/structured capability, quota unknown, or health unknown.
- [x] Emit proposal objects with expected use, risk, required action, and `why_not_live`; file writing remains a caller concern.
- [x] Add tests for same-provider discovery without keyword matching.

## WP4 Shadow Recommendation Selector

- [x] Implement a pure selector that accepts judge four fields, compact runtime signals, and snapshot.
- [x] Apply hard gates before scoring.
- [x] Implement `cost_first`, `balanced`, and `reliable_fast` scoring.
- [x] Emit selected recommendation or ignored reason.
- [x] Keep explicit user/model override as shadow-only comparison.
- [x] Add tests for unknown quota, cooldown, not configured, missing tool support, context too small, stale evidence, and explicit override.

## WP5 Shadow Event Integration

- [x] Add a fail-open JSONL writer helper for router-lite shadow events; runtime path binding remains a caller concern.
- [x] Keep selector/writer pure and fail-open so they do not change route, dispatch, spawn, ACK, footer, or WorkContract state.
- [x] Include actual model, recommended model, estimated cost delta, quality floor, scenario, mode, and reason codes.
- [x] Add a summary helper that answers why a cheaper model was not enabled.

## WP6 Verification

- [x] Run focused unit tests for contracts, snapshot, proposal, and selector.
- [x] No CLI code changed, so focused CLI tests were not applicable.
- [x] Run `git diff --check`.
- [x] Do not mark this change live-ready; create a separate OpenSpec for gated live after shadow evidence exists.
