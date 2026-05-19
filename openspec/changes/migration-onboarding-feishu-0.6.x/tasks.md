# Tasks: Migration Onboarding, Judge Presets, And Feishu

Run each WP as one OpenCode packet. Codex reviews diff and tests before the next WP.

## Baseline

- [x] Run `git status --short` and note unrelated user changes.
- [x] Run GitNexus impact analysis before editing each function/class/method symbol.
- [x] Run current focused baseline:

```bash
pnpm vitest run \
  tools/octoclawctl/src/__tests__/init/wizard-lang.test.ts \
  extensions/octoclaw-runtime/src/router-onboarding.test.ts \
  extensions/octoclaw-runtime/src/im/feishu/feishu-adapter.test.ts \
  extensions/octoclaw-runtime/src/im-status-renderer.test.ts
```

## WP-A: Judge Preset And Readiness Core

Write scope:

- `tools/octoclawctl/src/commands/init/steps/step-judge-model.ts`
- `tools/octoclawctl/src/commands/init/wizard-state.ts`
- `tools/octoclawctl/src/readiness.ts` or `tools/octoclawctl/src/commands/readiness.ts`
- tests under `tools/octoclawctl/src/__tests__/`

Tasks:

- [x] Add Judge type `remote-gpt-5-4-mini`.
- [x] Add interactive choice labels for Chinese and English.
- [x] Implement conservative provider discovery for existing OpenAI-compatible providers, preferring `cliproxyapi` when present.
- [x] If no provider is found, prompt for base URL/API key.
- [x] Store selected preset as `modelId="gpt-5.4-mini"` and `local=false`.
- [x] Add readiness report types and check functions for OpenClaw, runtime plugin, Judge, IM channels, router wizard, and status panel.
- [x] Ensure readiness redacts secrets.
- [x] Tests: preset is listed; selecting preset stores remote Judge; provider discovery prefers cliproxy; no provider falls back to prompt; missing Judge is warn.

Acceptance:

```bash
pnpm vitest run tools/octoclawctl/src/__tests__/init/wizard-lang.test.ts
pnpm vitest run tools/octoclawctl/src/__tests__/readiness.test.ts
pnpm check
```

## WP-B: CLI Init, Doctor, Install, And Migration Guidance

Write scope:

- `tools/octoclawctl/src/commands/init.ts`
- `tools/octoclawctl/src/commands/doctor.ts`
- `tools/octoclawctl/src/install.ts`
- `tools/octoclawctl/src/cli.ts`
- tests under `tools/octoclawctl/src/__tests__/`

Tasks:

- [x] Print readiness summary after `init`.
- [x] Include readiness summary in `doctor`.
- [x] Add JSON-friendly readiness output if doctor already has JSON mode; otherwise keep human output and add tests for the human summary.
- [x] Print readiness summary after `install`/`deploy` validation.
- [x] Keep non-interactive install/deploy non-prompting.
- [x] Preserve legacy `judge-fast.json` import behavior.
- [x] Tests: no Judge produces actionable warning; runtime plugin missing is fail; deploy summary includes status panel and router wizard.

Acceptance:

```bash
pnpm vitest run tools/octoclawctl/src/__tests__/doctor.test.ts tools/octoclawctl/src/__tests__/install.test.ts
pnpm check
```

## WP-C: Slack Onboarding Judge Guidance

Write scope:

- `extensions/octoclaw-runtime/src/router-onboarding.ts`
- `extensions/octoclaw-runtime/src/router-onboarding.test.ts`
- optional narrow readiness helper under `extensions/octoclaw-runtime/src/`

Tasks:

- [x] Detect missing/unhealthy Judge before rendering router onboarding.
- [x] Prepend Slack onboarding warning with `octoclawctl init` and `gpt-5.4-mini` guidance.
- [x] Ensure warning does not mark router wizard complete.
- [x] Ensure router wizard actions never write Judge config.
- [x] Tests: missing Judge warning appears; healthy Judge suppresses warning; use-defaults still writes only router config.

Acceptance:

```bash
pnpm vitest run extensions/octoclaw-runtime/src/router-onboarding.test.ts
pnpm check
```

## WP-D: Feishu Cards And Actions

Write scope:

- `extensions/octoclaw-runtime/src/im/feishu/**`
- `extensions/octoclaw-runtime/src/router-onboarding.ts`
- `extensions/octoclaw-runtime/src/im-status-renderer.ts`
- tests under `extensions/octoclaw-runtime/src/im/feishu/` and onboarding/status tests

Tasks:

- [x] Add Feishu card renderer for router onboarding start and wizard questions.
- [x] Add Feishu card renderer for status panel projections.
- [x] Add Feishu callback/action decoder at the Feishu edge.
- [x] Route decoded Feishu wizard actions into the same semantic onboarding reducer used by Slack where possible.
- [x] Duplicate answered-step click returns "这一步已经回答过".
- [x] Unknown action does not mutate state.
- [x] Card delivery failure falls back to text guidance.
- [x] Tests: card JSON shape; action id decode; duplicate click; fallback text; Feishu ids are not uppercased.

Acceptance:

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/im/feishu/feishu-adapter.test.ts \
  extensions/octoclaw-runtime/src/router-onboarding.test.ts \
  extensions/octoclaw-runtime/src/im-status-renderer.test.ts
pnpm check
```

## WP-E: Status Panel And Packaging Closeout

Write scope:

- `extensions/octoclaw-status-surface/src/**`
- `extensions/octoclaw-runtime/src/im-status-renderer.ts`
- `tools/octoclawctl/src/install.ts`
- `tools/octoclawctl/src/cli.ts`
- docs under `docs/`

Tasks:

- [x] Confirm status-surface rich/text renderers are included in deploy package discovery.
- [x] Add status panel readiness check.
- [x] Expose status panel output through CLI or existing runtime status command without duplicating execution truth logic.
- [x] Add Feishu status card rendering path.
- [x] Update user docs with install/migration and manual re-run commands.
- [x] Run final grep guards for secrets and forbidden fallback mutations.

Acceptance:

```bash
pnpm vitest run \
  extensions/octoclaw-status-surface/src/index.test.ts \
  extensions/octoclaw-status-surface/src/renderers/rich/index.test.ts \
  extensions/octoclaw-runtime/src/im-status-renderer.test.ts
pnpm check
pnpm test
```

## Final Verification

- [x] `pnpm check && pnpm test` passes.
- [x] `git grep "reasoning_effort.*none" -- extensions/octoclaw-runtime/src/resolve/llm-judge.ts` confirms OpenAI-compatible no-reasoning remains.
- [x] `git grep "glm-4.7" -- tools extensions packages docs | cat` does not show a new preset outside notes explaining non-goal.
- [x] `git grep "openclaw models fallbacks add\\|openclaw models fallbacks remove" -- tools extensions packages | cat` shows no automatic mutation path.
- [x] Manual smoke plan documented for:
  - `octoclawctl init`
  - `octoclawctl doctor`
  - Slack onboarding with missing Judge
  - Feishu onboarding card
  - Status panel card

## Closeout Notes

Record changed files, tests run, manual smoke results, and any feature gaps that remain observe-only.
