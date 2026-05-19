# Migration Onboarding, Judge Presets, And Feishu Design

Date: 2026-05-19
Target release: v0.6.x
OpenSpec: `openspec/changes/migration-onboarding-feishu-0.6.x`

## Goal

Make OctoClaw usable after migration to a fresh environment without relying on hidden local state: the installer and IM onboarding should detect missing Judge/router/status prerequisites, guide the user through explicit setup, and support Feishu with card-based interactions. Add `gpt-5.4-mini` as the first curated remote no-reasoning Judge preset because it has been tested; do not add `glm-4.7` because it cannot reliably disable reasoning.

## Existing Baseline

- `octoclawctl init` already checks OpenClaw, asks for a Judge model, asks for IM tokens, and writes unified config.
- Judge runtime already sends `reasoning_effort: "none"` for OpenAI-compatible endpoints and `think: false` for Ollama native.
- Slack router onboarding has a 7-step interactive flow for Auto Router preferences, but it does not configure Judge.
- Feishu adapter can send text, thread replies, files, images, and `feishu_card` payloads, but it does not have a full interactive wizard action handler.
- `@octoclaw/status-surface` has read/view/rich renderer pieces, but status cards are not fully wired as an install/onboarding verification surface.
- `octoclawctl install/deploy` builds and syncs workspace packages/extensions, but the post-install user-facing readiness report is incomplete.

## Product Shape

There are three distinct setup surfaces:

1. **Install/readiness**: verifies that OctoClaw, runtime plugin, Judge, IM channels, status panel, and router wizard are usable.
2. **Judge setup**: configures a lightweight routing Judge. It may reuse an existing OpenClaw-compatible provider, but it must not silently create new provider credentials or mutate model fallbacks.
3. **Router setup**: configures delegated/sub-agent model preferences, budgets, privacy, disabled models, and same-provider model proposals.

These surfaces can link to each other, but they must not silently write each other's configuration. In particular, router onboarding may warn that Judge is missing and offer a setup action, but Judge configuration remains explicit.

## Architecture

Add a small readiness layer shared by CLI and IM:

- `tools/octoclawctl` owns install/init/doctor commands and writes config.
- `extensions/octoclaw-runtime` owns IM onboarding delivery and channel-specific action handling.
- `@octoclaw/status-surface` owns status card view models and renderers.
- Feishu stays an IM adapter; it should not become a second router wizard implementation with divergent rules. Instead, use channel-specific renderers/actions over the same wizard state transitions where possible.

The preferred implementation is thin adapters around existing primitives:

- Extend `runStepJudgeModel()` with a `gpt-5.4-mini` preset.
- Add a helper that discovers OpenClaw configured providers/models enough to suggest a compatible base URL for the preset.
- Add readiness checks that classify missing Judge, unreachable Judge, missing IM token, incomplete router wizard, and status panel availability.
- Render readiness and router wizard prompts as Slack blocks or Feishu cards from a neutral intermediate action model.
- Route Feishu card button callbacks into the same onboarding action reducer used by Slack, with Feishu-specific action id decoding only at the edge.

## Judge Preset Rules

The new preset is:

- Label: `远端 OpenAI-compatible - gpt-5.4-mini (cheap, fast, no reasoning)`
- Model id: `gpt-5.4-mini` by default.
- Provider: first compatible existing OpenClaw provider that can serve the model; prefer configured providers whose id or base URL suggests `cliproxyapi` when present.
- If no compatible provider can be inferred, prompt for base URL and API key using the same safe path as `remote-custom`.
- Runtime payload keeps `reasoning_effort: "none"`.
- Do not add `glm-4.7` or any other unverified remote preset in this change.

## Feishu Interaction Rules

- Feishu supports card-first onboarding and status display.
- Feishu does not support streaming or in-place message editing in this change.
- Card button ids must be deterministic and decode to the same semantic actions as Slack onboarding.
- Duplicate or out-of-order button clicks must be idempotent and return a short Feishu reply.
- If card delivery fails, fall back to text with CLI instructions.
- Feishu action handling must not uppercase user ids or rewrite Feishu message ids.

## Status Panel Rules

- Status panel output is a projection. It must not become execution truth.
- The panel should show OpenClaw/native task truth where available, plus OctoClaw WorkContract/router metadata as context.
- CLI and IM status card paths must share view-model construction.
- Slack and Feishu rich renderers can differ, but text fallback should remain stable.

## Installer And Migration Rules

- `install`/`deploy` should end with a readiness report.
- `doctor` should expose the same readiness checks in human and JSON output.
- Non-interactive install must not prompt for secrets.
- Interactive init can configure Judge and IM credentials.
- Existing legacy `judge-fast.json` migration remains supported.
- No path should print API keys or auth headers.
- No path should mutate OpenClaw fallback order automatically.

## Testing

Tests should cover:

- Judge preset choice produces `judge.enabled=true`, model `gpt-5.4-mini`, OpenAI-compatible base URL, and `local=false`.
- Remote Judge call still includes `reasoning_effort: "none"`.
- Missing Judge readiness is a warning with actionable CLI/IM guidance, not a hard install failure.
- Router onboarding can display Judge-missing guidance without writing Judge config.
- Feishu cards are generated for onboarding/status and action ids decode to the same semantic flow.
- Feishu text fallback is used when card delivery fails.
- Status panel renders for CLI text, Slack, and Feishu without claiming execution truth.
- Install/deploy readiness summarizes runtime, Judge, IM, router wizard, and status panel.

## Non-Goals

- Do not add `glm-4.7` as a preset.
- Do not build a new Feishu runtime, streaming layer, or message edit layer.
- Do not merge Judge config into router wizard storage.
- Do not mutate OpenClaw `models.fallbacks` or provider lists without explicit user confirmation.
- Do not reintroduce legacy runtime truth, outbox, or heuristic dispatch authority.
- Do not store credentials outside the existing config paths.

## Rollout

Implement as OpenSpec work packages:

1. Judge preset and readiness model.
2. CLI init/doctor/install readiness integration.
3. Slack onboarding Judge-missing guidance.
4. Feishu card/action adapter for onboarding and status cards.
5. Final packaging, docs, and smoke tests.

Each package should be reviewed and tested before the next starts.
