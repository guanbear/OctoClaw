# Tasks

Each WP is one merge unit. Run `pnpm check && pnpm test` after each WP.

## WP-A — Source weights + fusion (2-3 days)

Owner: implementation, Codex review.

Write scope:

- `packages/octoclaw-router/src/data/source-weights.json` (new)
- `packages/octoclaw-router/src/capability/merge.ts` (extend)
- `packages/octoclaw-router/src/capability/__tests__/fuse-scenario-score.test.ts` (new)
- `packages/octoclaw-router/src/scoring/index.ts` (modify)
- `packages/octoclaw-router/src/decision/contracts.ts` (extend `ModelIntelLite`)

Tasks:

- [ ] Create `source-weights.json` with the three scenarios from supplement §1.3.
- [ ] Add `fuseScenarioScore(contributions, weights, health, now)` to `merge.ts`.
- [ ] Add `computeFreshnessFactor(lastVerifiedAt, now)`: 1.0 / 0.7 / 0.4 / 0.15.
- [ ] Add `computeSourceHealth(recentOutcomes: boolean[])`: 0.0–1.0 from last 4.
- [ ] Add per-model renormalization when sources are missing.
- [ ] Add `confidence` derivation from sum of effective weights.
- [ ] Extend `ModelIntelLite.capability` with optional `scoreByScenario`.
- [ ] Update `capabilityScoreFor()` in `scoring/index.ts` to read `scoreByScenario` first, fall back to tier defaults.
- [ ] Unit tests: 4-source fully fresh, 1 stale source, 1 dead source, 0-source fallback.

Acceptance:

- [ ] `pnpm vitest run packages/octoclaw-router/src/capability/__tests__/fuse-scenario-score.test.ts` green.
- [ ] Existing tests stay green (fallback path covers models without scoreByScenario).
- [ ] Sum of weights per scenario = 1.0 verified at load.

## WP-B — Leaderboard parsers + seed expansion (2-3 days)

Owner: implementation.

Write scope:

- `packages/octoclaw-router/src/capability/leaderboard/aider.ts` (new)
- `packages/octoclaw-router/src/capability/leaderboard/bfcl.ts` (new)
- `packages/octoclaw-router/src/capability/leaderboard/types.ts` (new)
- `packages/octoclaw-router/src/capability/leaderboard/fixtures/aider.sample.yaml` (new)
- `packages/octoclaw-router/src/capability/leaderboard/fixtures/bfcl.sample.json` (new)
- `packages/octoclaw-router/src/capability/__tests__/leaderboard-aider.test.ts` (new)
- `packages/octoclaw-router/src/capability/__tests__/leaderboard-bfcl.test.ts` (new)
- `scripts/refresh-leaderboard-snapshot.mjs` (extend)
- `packages/octoclaw-router/src/data/leaderboard-snapshot.json` (regenerate)

Tasks:

- [ ] Define `LeaderboardSourceRecord` in `leaderboard/types.ts`.
- [ ] Implement `parseAiderLeaderboard()` reading the upstream YAML at `aider/website/_data/edit_leaderboard.yml` (or whatever current path; pin it in the file as a constant).
- [ ] Implement `parseBfclLeaderboard()` reading the upstream JSON.
- [ ] Each parser uses Zod for schema validation; on mismatch return `[]`.
- [ ] Each parser canonicalizes model keys (e.g. `z-ai/glm-…` → `zhipu/glm-…`).
- [ ] Update `scripts/refresh-leaderboard-snapshot.mjs` to call both parsers and write fused `scoreByScenario` per model.
- [ ] Add `--check-seed` flag to the script that exits non-zero when seed has < 30 models.
- [ ] Regenerate the seed; commit the result.

Acceptance:

- [ ] `pnpm vitest run packages/octoclaw-router/src/capability/__tests__/leaderboard-*.test.ts` green.
- [ ] `node scripts/refresh-leaderboard-snapshot.mjs --check-seed` exits 0.
- [ ] `data/leaderboard-snapshot.json` has ≥ 30 models, each with `scoreByScenario.coding_worker`.
- [ ] Schema-mismatch fixtures return `[]` without throwing.

## WP-C — Real probe (2 days)

Owner: implementation.

Write scope:

- `packages/octoclaw-router/src/capability/probe.ts` (new)
- `packages/octoclaw-router/src/capability/openclaw-bridge.ts` (new)
- `packages/octoclaw-router/src/capability/__tests__/probe.test.ts` (new)
- `tools/octoclawctl/src/cli.ts` (rename + add)

Tasks:

- [ ] Implement `resolveProviderForModel(modelKey, openclawConfig)` in `openclaw-bridge.ts`. Read-only.
- [ ] Implement `probeModel(request)` in `probe.ts` with the canary message from supplement §2.4.
- [ ] Enforce `budgetUsdMax` **before** sending: compute estimated cost from snapshot price × token plan; refuse with `PROBE_BUDGET_EXCEEDED`.
- [ ] Capture `latencyMs` (first byte to last byte for non-streaming canary).
- [ ] Set `model.health.lastProbeAt`, `lastProbeOk`, `lastProbeLatencyMs` on snapshot after probe.
- [ ] If `ok === false`, set `cooldown: true` for 30 minutes.
- [ ] **Never** flip `model.configured` from probe.
- [ ] In `cli.ts`: rename existing `capability probe` handler to `capability lookup`; wire new `capability probe` to `probeModel(...)`.
- [ ] Update `--help` text.
- [ ] Tests: budget refusal, 200/401/404/timeout matrix, never modifies `configured`.

Acceptance:

- [ ] `pnpm vitest run packages/octoclaw-router/src/capability/__tests__/probe.test.ts` green.
- [ ] `octoclawctl router capability lookup <model>` prints declared availability without network.
- [ ] `octoclawctl router capability probe <model>` makes one HTTP request; budget guard refuses costly probes.
- [ ] No log line, snapshot file, or error message contains the auth header value.

## WP-D — Proposal/shadow state machine + wizard accept-proposal (2-3 days)

Owner: implementation.

Write scope:

- `packages/octoclaw-router/src/wizard/index.ts` (extend)
- `packages/octoclaw-router/src/__tests__/integration/proposal-shadow-isolation.test.ts` (new)
- `tools/octoclawctl/src/cli.ts` (add `wizard accept-proposal`)

Tasks:

- [ ] Define new states `discovered | probed_ok | proposal_candidate | shadow_candidate | live_candidate` (additive, do not replace `configured`).
- [ ] In wizard config, track per-model state and last transition timestamp.
- [ ] Implement `acceptProposal(modelKey, openclawHome)`:
  - [ ] Confirm probe was successful within last 7 days (else run probe first).
  - [ ] Locate matching provider block in `openclaw.json` by base URL.
  - [ ] Append model id to provider's `models` array (no other field touched).
  - [ ] Write deterministic backup `openclaw.json.octoclaw-bak-<ISO timestamp>` first.
  - [ ] Refuse if no matching provider block exists, with the message from supplement §5.2.
- [ ] Add CLI handler for `octoclawctl router wizard accept-proposal <model>`.
- [ ] Integration test:
  - [ ] discovered → probed_ok → proposal_candidate → shadow_candidate but never live without configured=true.
  - [ ] accept-proposal writes `openclaw.json` correctly with backup.
  - [ ] accept-proposal refuses when provider not configured.
  - [ ] Probe failure does not flip `configured` either way.

Acceptance:

- [ ] `pnpm vitest run packages/octoclaw-router/src/__tests__/integration/proposal-shadow-isolation.test.ts` green.
- [ ] `octoclawctl router wizard accept-proposal nonexistent/model` prints the supplement §5.2 refusal message.
- [ ] `git grep "model.configured = true"` outside `wizard/` returns no live writes.

## WP-E — Slack wizard 7-step flow (3-5 days)

Owner: implementation.

Write scope:

- `extensions/octoclaw-runtime/src/im/slack/wizard/flow.ts` (new)
- `.../wizard/messages.ts` (new)
- `.../wizard/buttons.ts` (new)
- `.../wizard/state-store.ts` (new)
- `.../wizard/index.ts` (new)
- `.../wizard/__tests__/flow.test.ts` (new)
- `.../wizard/__tests__/state-store.test.ts` (new)
- `tools/octoclawctl/src/commands/router-wizard.ts` (new)
- `tools/octoclawctl/src/cli.ts` (register slash route + CLI fallback)
- `packages/octoclaw-router/src/__tests__/integration/wizard-slack-flow.test.ts` (new)

Tasks:

- [ ] State machine in `flow.ts` with 7 steps from supplement §4.3.
- [ ] Message templates in zh + en.
- [ ] Button id encode/decode: `step:<step>:answer:<value>` with HMAC tag to prevent replay.
- [ ] State file at `~/.openclaw/octoclaw/router-wizard.state.json` with atomic write (write to `.tmp`, fsync, rename).
- [ ] Idempotent dup-click handler (30 s window).
- [ ] Out-of-order click → "step already answered" message.
- [ ] 24 h nudge, 7 d auto-finalize with defaults.
- [ ] CLI fallback: `octoclawctl router wizard --cli` runs the same state machine via stdin/stdout.
- [ ] Slash command `/octoclaw wizard` resumes; `/octoclaw wizard reset step-N` resets one step.
- [ ] Tests: happy path, resume from step 4, dup click dropped, out-of-order click handled, 7-day finalize.

Acceptance:

- [ ] `pnpm vitest run extensions/octoclaw-runtime/src/im/slack/wizard/__tests__/` green.
- [ ] Integration test drives end-to-end through 7 steps.
- [ ] State file is atomically written (no partial JSON observed in any test).
- [ ] Auth header / API keys never appear in any wizard message.

## Final Verification

- [ ] `pnpm check && pnpm test` green; baseline failure count unchanged.
- [ ] `git grep "TIER_SCORE\["` shows `capabilityScoreFor` only uses tier defaults as fallback.
- [ ] `git grep "model.configured = true"` outside `wizard/accept-proposal` path returns nothing.
- [ ] Packaged seed has ≥ 30 models with `scoreByScenario.coding_worker`.
- [ ] Manual: `octoclawctl router capability probe openai/gpt-5-mini` returns ok with latency in normal range.
- [ ] Manual: `octoclawctl router wizard --cli` walks 7 steps in headless terminal.

## Hard Invariants

1. Probe never modifies `model.configured`.
2. Unconfigured model in any state cannot enter `live`.
3. Auth credentials never leave `openclaw.json` (read-only via bridge).
4. Probe budget guard enforced **before** sending.
5. Auth header values never logged, snapshotted, or echoed.
6. Wizard never blocks live routing.
7. Source weights sum to 1.0 per scenario.
8. Schema mismatch in parser → `[]` + source health 0.0; never throws to caller.
