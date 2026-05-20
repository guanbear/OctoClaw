# Agent Prompts: Stability Smoke v2

Use these prompts for bounded OpenCode/OMO implementation packets. Run one WP at a time and review every diff.

## Shared Instructions

You are implementing OctoClaw OpenSpec change:

`openspec/changes/stability-smoke-v2-0.6.x`

Read in order:

1. `proposal.md`
2. `design.md`
3. `tasks.md`
4. `bdd.md`

Hard constraints:

- Do not change live routing, delegate runtime, ACK runtime, router scoring, or OpenClaw fallback mutation behavior unless a task explicitly says so.
- Stability Smoke v2 is an evaluation/orchestration layer.
- Structured gates decide pass/fail; AI only selects, summarizes, and recommends.
- Do not store secrets, raw transcripts, full prompts, full responses, auth headers, or chain-of-thought in artifacts.
- Use GLM-5.1 as the default AI review/case-selection model and GPT-5.5 only as escalation.
- Fix-draft may create local repair drafts, but must not commit, push, deploy, restart Gateway, or mutate OpenClaw config. User confirmation is required before those actions.
- Run GitNexus impact analysis before editing any function/class/method symbol.
- Add tests for every BDD scenario covered by your WP.

## WP-A Prompt

Implement WP-A from `tasks.md`: case-pack schema and catalog.

Allowed write scope:

- `tools/octoclawctl/src/stability/**`
- tests under `tools/octoclawctl/src/stability/**`
- `tools/octoclawctl/src/cli.ts` only if needed for import/export plumbing

Do not touch Slack live execution yet.

Required BDD:

- SSV2-001
- SSV2-002
- SSV2-003
- SSV2-004

Run:

```bash
pnpm vitest run tools/octoclawctl/src/stability
pnpm check
```

## WP-B Prompt

Implement WP-B from `tasks.md`: Slack evidence assertions.

Allowed write scope:

- `tools/octoclawctl/src/slack-acceptance/**`
- `tools/octoclawctl/src/stability/**`
- tests under those directories

Do not alter runtime ACK or delegate behavior. This WP only changes the acceptance harness and stability evidence mapping.

Required BDD:

- SSV2-010
- SSV2-011
- SSV2-012
- SSV2-013
- SSV2-014
- SSV2-015

Run:

```bash
pnpm vitest run tools/octoclawctl/src/slack-acceptance/slack-acceptance.test.ts tools/octoclawctl/src/stability
pnpm check
```

## WP-C Prompt

Implement WP-C from `tasks.md`: synthetic fixtures and replay stability lanes.

Allowed write scope:

- `tools/octoclawctl/src/stability/**`
- `tools/octoclawctl/src/nightly/**`
- tests under those directories

Reuse existing nightly classifiers where possible. Do not duplicate replay truth logic.

Required BDD:

- SSV2-020
- SSV2-021
- SSV2-022
- SSV2-023
- SSV2-024
- SSV2-025
- SSV2-026

Run:

```bash
pnpm vitest run tools/octoclawctl/src/stability tools/octoclawctl/src/nightly/nightly.test.ts
pnpm check
```

## WP-D Prompt

Implement WP-D from `tasks.md`: router model choice and wizard checks.

Allowed write scope:

- `tools/octoclawctl/src/stability/**`
- read-only helpers in `packages/octoclaw-router/src/**` only if necessary
- tests under relevant modules

Do not promote unconfigured/discovered models into live selection. Do not write OpenClaw config.

Required BDD:

- SSV2-030
- SSV2-031
- SSV2-032
- SSV2-033
- SSV2-034

Run:

```bash
pnpm vitest run tools/octoclawctl/src/stability packages/octoclaw-router/src
pnpm check
```

## WP-E Prompt

Implement WP-E from `tasks.md`: AI case selection and review.

Allowed write scope:

- `tools/octoclawctl/src/stability/**`
- `tools/octoclawctl/src/nightly-eval/**`
- local script generation logic if needed

AI output must be schema-validated before use. Invalid AI output falls back to catalog.

Required BDD:

- SSV2-040
- SSV2-041
- SSV2-042
- SSV2-043
- SSV2-044
- SSV2-045
- SSV2-046

Run:

```bash
pnpm vitest run tools/octoclawctl/src/stability tools/octoclawctl/src/nightly-eval/nightly-eval.test.ts
pnpm check
```

## WP-F Prompt

Implement WP-F from `tasks.md`: CLI orchestration and closeout.

Allowed write scope:

- `tools/octoclawctl/src/cli.ts`
- `tools/octoclawctl/src/stability/**`
- docs under `docs/`
- tests under `tools/octoclawctl/src/cli.test.ts` and stability tests

Add scheduler-friendly commands but do not depend on macOS launchd as the primary mechanism. Full acceptance runs every 3 days, not weekly.

Required BDD:

- SSV2-050
- SSV2-051
- SSV2-052
- SSV2-053
- SSV2-054

Run:

```bash
pnpm vitest run tools/octoclawctl/src/cli.test.ts tools/octoclawctl/src/stability
pnpm check
pnpm test
```
