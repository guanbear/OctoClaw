# Tasks: Stability Smoke v2

Run one WP at a time. Codex reviews diff and tests before the next WP.

## Baseline

- [ ] Run `git status --short` and note unrelated user changes.
- [ ] Run GitNexus impact analysis before editing any function/class/method symbol.
- [ ] Read current files:
  - `tools/octoclawctl/src/slack-acceptance/**`
  - `tools/octoclawctl/src/nightly/**`
  - `tools/octoclawctl/src/nightly-eval/**`
  - `tools/octoclawctl/src/cli.ts`
  - `/Users/guanbear/.openclaw/octoclaw-nightly-eval-config.json`
  - `/Users/guanbear/.openclaw/octoclaw-slack-acceptance-config.json`
- [ ] Run current baseline:

```bash
pnpm vitest run \
  tools/octoclawctl/src/slack-acceptance/slack-acceptance.test.ts \
  tools/octoclawctl/src/nightly/nightly.test.ts \
  tools/octoclawctl/src/nightly-eval/nightly-eval.test.ts
pnpm check
```

## WP-A: Case-Pack Schema And Catalog

Write scope:

- `tools/octoclawctl/src/stability/**`
- tests under `tools/octoclawctl/src/stability/**`
- `tools/octoclawctl/src/cli.ts` only for command registration if needed

Tasks:

- [ ] Define stability case-pack/report/failure-packet types.
- [ ] Implement schema validation with fail-closed behavior.
- [ ] Add catalog packs for post-deploy, nightly, and every-3-day full acceptance.
- [ ] Enforce live-case caps and provider-probe safety.
- [ ] Add JSON sanitization helpers for prompt hashes and secret stripping.
- [ ] Tests: valid catalog loads; invalid mode/severity fails; live case requires prompt/max runtime; AI pack over live cap fails; secrets are redacted.

Acceptance:

```bash
pnpm vitest run tools/octoclawctl/src/stability
pnpm check
```

BDD:

- SSV2-001
- SSV2-002
- SSV2-003
- SSV2-004

## WP-B: Slack Evidence Assertions

Write scope:

- `tools/octoclawctl/src/slack-acceptance/**`
- `tools/octoclawctl/src/stability/**`
- tests under those directories

Tasks:

- [ ] Add direct assertions for replay evidence fields: `footerVia`, `deliveryTransport`, `targetSource`, duplicate final count, parent echo count, WorkContract, spawn intent, run id, child session.
- [ ] Add footer truth expectation support for route/model/via.
- [ ] Add ACK thread/timing/misleading-text failure-code mapping.
- [ ] Add streaming conflict assertion for native streaming cases.
- [ ] Update default delegated case expectations to require native final evidence.
- [ ] Tests: delegate final requires `via=native_announce`; footer delegate without spawn fails; misleading ACK fails; fast final can satisfy ACK only when configured.

Acceptance:

```bash
pnpm vitest run tools/octoclawctl/src/slack-acceptance/slack-acceptance.test.ts
pnpm check
```

BDD:

- SSV2-010
- SSV2-011
- SSV2-012
- SSV2-013
- SSV2-014
- SSV2-015

## WP-C: Synthetic Fixtures And Replay Stability Lanes

Write scope:

- `tools/octoclawctl/src/stability/**`
- `tools/octoclawctl/src/nightly/**`
- tests under `tools/octoclawctl/src/stability/**` and `tools/octoclawctl/src/nightly/**`

Tasks:

- [ ] Add synthetic fixture runner for ACK/thread/footer/delegate/provider/wizard/restart cases.
- [ ] Convert synthetic results into stability lanes and failure packets.
- [ ] Reuse existing nightly route/ACK/transition/delegation/delivery classifiers.
- [ ] Add known regression fixtures:
  - copied spawn JSON newline escaping
  - delegate ACK later than legacy 90s smoke window
  - footer says delegate without spawn
  - provider 402 raw error
  - previous run still shutting down
  - wizard start immediately ends
- [ ] Tests: each fixture emits the expected normalized failure code.

Acceptance:

```bash
pnpm vitest run tools/octoclawctl/src/stability tools/octoclawctl/src/nightly/nightly.test.ts
pnpm check
```

BDD:

- SSV2-020
- SSV2-021
- SSV2-022
- SSV2-023
- SSV2-024
- SSV2-025
- SSV2-026

## WP-D: Router Model Choice And Wizard Checks

Write scope:

- `tools/octoclawctl/src/stability/**`
- `packages/octoclaw-router/src/**` only if a read-only helper is missing
- tests under relevant modules

Tasks:

- [ ] Implement read-only model expectation resolver from OpenClaw model list, fallback list, router wizard config, health snapshot, and complexity.
- [ ] Add simple/normal/deep router model matrix cases.
- [ ] Add wizard start/resume/idempotency synthetic checks.
- [ ] Add one lightweight live wizard entry/resume case that does not complete or mutate unrelated config.
- [ ] Tests: expected model respects cooldown; native fallback order is tie-break only; unconfigured models never become expected live model; duplicate wizard click is idempotent.

Acceptance:

```bash
pnpm vitest run tools/octoclawctl/src/stability packages/octoclaw-router/src
pnpm check
```

BDD:

- SSV2-030
- SSV2-031
- SSV2-032
- SSV2-033
- SSV2-034

## WP-E: AI Case Selection And Review

Write scope:

- `tools/octoclawctl/src/stability/**`
- `tools/octoclawctl/src/nightly-eval/**`
- local script generation logic if needed
- tests under those directories

Tasks:

- [ ] Add AI case-selection prompt builder using GLM-5.1 by default.
- [ ] Validate generated case packs and fall back to catalog nightly pack on invalid output.
- [ ] Add GPT-5.5 escalation for low-confidence review, not for expanding live volume.
- [ ] Add AI review prompt over failure packets.
- [ ] Classify failures as `runtime_bug`, `smoke_spec_bug`, `environment_issue`, or `unknown`.
- [ ] Add fix-draft guard: only run when blocker/major `runtime_bug` exists.
- [ ] Add confirmation guard: fix-draft never commits, pushes, deploys, restarts Gateway, or mutates OpenClaw config.
- [ ] Add size/risk guard: drafts over 5 files, over 300 changed lines, hot-path touching, or failing validation are marked `needs_human_review`.
- [ ] Tests: invalid AI JSON falls back; low confidence requests escalation; fix-draft skips environment issues; confirmation guard works; secrets are redacted.

Acceptance:

```bash
pnpm vitest run tools/octoclawctl/src/stability tools/octoclawctl/src/nightly-eval/nightly-eval.test.ts
pnpm check
```

BDD:

- SSV2-040
- SSV2-041
- SSV2-042
- SSV2-043
- SSV2-044
- SSV2-045
- SSV2-046

## WP-F: OpenClaw Scheduled Orchestration And Closeout

Write scope:

- `tools/octoclawctl/src/cli.ts`
- `tools/octoclawctl/src/stability/**`
- docs under `docs/`
- tests under `tools/octoclawctl/src/cli.test.ts` and stability tests

Tasks:

- [ ] Add `octoclawctl stability post-deploy`.
- [ ] Add `octoclawctl stability nightly`.
- [ ] Add `octoclawctl stability full --cadence 3d`.
- [ ] Add `octoclawctl stability review-latest`.
- [ ] Add `octoclawctl stability fix-draft`.
- [ ] Add OpenClaw scheduled task install/update guidance.
- [ ] Write migration notes from old nightly/slack acceptance config to Stability Smoke v2.
- [ ] Verify Slack summary posting uses sanitized compact report.
- [ ] Tests: CLI parses commands; missing Slack env skips live cases but runs synthetic/replay; report paths are written; full acceptance cadence defaults to 3 days.

Acceptance:

```bash
pnpm vitest run tools/octoclawctl/src/cli.test.ts tools/octoclawctl/src/stability
pnpm check
pnpm test
```

BDD:

- SSV2-050
- SSV2-051
- SSV2-052
- SSV2-053
- SSV2-054

## Final Verification

- [ ] `pnpm check`
- [ ] `pnpm test`
- [ ] `git diff --check`
- [ ] `npx gitnexus detect-changes -r OctoClaw --scope all`
- [ ] Manual post-deploy smoke in `#octoclaw-acceptance`
- [ ] Manual nightly dry run with live Slack disabled
- [ ] Manual nightly run with selected live Slack enabled
- [ ] Confirm no report contains Slack token/API key/full transcript:

```bash
git grep -n "xox[baprs]-\\|sk-[A-Za-z0-9_-]\\{16,\\}" -- tools extensions packages docs || true
```

## Closeout Notes

Record:

- changed files
- BDD scenarios covered
- commands run
- report artifact paths
- live Slack smoke thread
- AI model used for case selection/review
- remaining gaps and observe-only lanes
