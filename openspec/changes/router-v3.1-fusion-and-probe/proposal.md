# Change: Auto Router V3.1 — Real Fusion, Real Probe, Slack Wizard

Date: 2026-05-15
Target release: v0.6.0 (post-stability hardening)
Design reference: `docs/octoclaw-auto-router-v3-supplement-2026-05-15.md`

## Why

Auto Router V3 Phase A+B+C+partial-D shipped, but the implementation has six
honest gaps the supplement document identifies:

1. Capability fusion is a stub (no source-weights, no freshness/health decay,
   live scoring uses fixed tier values 95/80/65/40/30 instead of real
   leaderboard scores).
2. Packaged seed covers 3 models. Should cover ≥ 30.
3. `octoclawctl router capability probe` only reads from snapshot; no real
   API smoke test.
4. Only OpenRouter + models.dev + LiteLLM fetchers exist (price + capability
   metadata only). No leaderboard parser for Aider, BFCL, LiveCodeBench,
   SWE-bench, or LMArena.
5. `unconfigured models never live` invariant vs. "auto-add probed models"
   was a design conflict, now resolved in supplement §3 — but the code does
   not yet enforce the proposal/shadow gating.
6. Slack-driven wizard UX is unspecified.

## Scope

V1.1 of `@octoclaw/router`. Five work-packets:

| WP | What | Owner | Estimate |
|----|------|-------|----------|
| WP-A | Source weights + fusion | implementation | 2-3 d |
| WP-B | Aider + BFCL leaderboard parsers + seed expansion | implementation | 2-3 d |
| WP-C | Real probe (`capability probe` rename, `probe.ts`, budget guard) | implementation | 2 d |
| WP-D | Proposal/shadow state machine + `wizard accept-proposal` writeback | implementation | 2-3 d |
| WP-E | Slack wizard 7-step flow | implementation | 3-5 d |

Optional / V1.2:
- LiveCodeBench, SWE-bench Verified, LMArena parsers
- Plan quota auto-poll (already parked in
  `parking/router-v3-wizard-and-release/`)

## Non-Goals

- No change to judge 3-field schema.
- No change to scoring formula 35/20/20/15/10. Only the input to
  `capability_score` changes (real fused score replaces tier default).
- No change to live route authority (`reply | delegate`).
- No automatic writeback to `~/.openclaw/openclaw.json` other than via the
  explicit `wizard accept-proposal <model>` user action.

## Acceptance Gate

- [ ] `data/source-weights.json` ships, weights sum to 1.0 per scenario, loaded
      at startup without throwing on missing file
- [ ] `fuseScenarioScore()` produces deterministic output; freshness and
      health decay match the supplement table
- [ ] Aider + BFCL parsers exist with Zod validation; schema mismatch returns
      `[]` and marks source health 0.0 instead of throwing
- [ ] Packaged `leaderboard-snapshot.json` ≥ 30 models
- [ ] `router capability lookup <model>` and `router capability probe <model>`
      are separate commands. `lookup` is snapshot read, `probe` hits real API.
- [ ] Probe with `budgetUsdMax` guard never sends a request that would exceed
      the cap. Returns `error.code: PROBE_BUDGET_EXCEEDED` instead.
- [ ] Probe never modifies `model.configured`. Only `wizard accept-proposal`
      can write to OpenClaw config.
- [ ] `unconfigured` model in any state (`discovered`, `probed_ok`,
      `proposal_candidate`, `shadow_candidate`) cannot become `live`. Test in
      `__tests__/integration/proposal-shadow-isolation.test.ts`.
- [ ] Slack wizard finishes a fresh first-run in 7 messages, supports
      `/octoclaw wizard` resume, and writes
      `~/.openclaw/octoclaw/router-wizard.state.json` between steps.
- [ ] `pnpm check && pnpm test` green; no new test failures.

## Out of scope (V1.2 follow-up)

- LiveCodeBench / SWE-bench Verified / LMArena parsers
- Plan quota auto-poll across providers
- 30+ delegate end-to-end smoke that drives auto-promotion
