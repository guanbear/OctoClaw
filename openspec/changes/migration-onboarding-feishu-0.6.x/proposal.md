# Change: Migration Onboarding, Judge Presets, And Feishu

Date: 2026-05-19
Target release: v0.6.x
Depends on:

- Auto Router v3.1/v3.2 router wizard and health loop
- Native runtime slimming P5/P6
- Current Feishu L2 adapter baseline

## Purpose

Fresh OctoClaw installs and migrated environments should not rely on hidden local state. If a machine has no local Judge, the setup flow should guide the user to a working lightweight Judge, including a tested remote no-reasoning preset. Slack and Feishu should both be usable setup/status surfaces, with Feishu using cards where Slack uses blocks.

This change adds:

1. `gpt-5.4-mini` as a curated remote OpenAI-compatible Judge preset.
2. Shared readiness checks for Judge, IM, router wizard, status panel, and runtime plugin deployment.
3. CLI install/init/doctor output that tells the user exactly what is missing.
4. Slack onboarding guidance when Judge is missing or unhealthy.
5. Feishu card-based onboarding/status support and Feishu action handling.
6. Packaging verification so a deployed install contains runtime, router, status surface, and CLI support.

## Problem

Today the setup pieces exist but are not connected:

- `octoclawctl init` asks for Judge, but router onboarding does not.
- Auto Router onboarding can mention Judge without helping a migrated install configure it.
- Only generic remote Judge options exist; `gpt-5.4-mini` is known to work as a no-reasoning preset, while `glm-4.7` is known not to.
- Feishu can send cards, but the interactive wizard/action loop is not adapted.
- Status surface has rich renderers, but install/readiness does not expose it as a coherent status panel.
- Install/deploy does not give a complete post-install readiness report.

## Scope

### WP-A: Judge Preset And Readiness Core

- Add `gpt-5.4-mini` to Judge setup as a remote OpenAI-compatible preset.
- Prefer existing configured compatible providers, especially `cliproxyapi` when present.
- Add a shared readiness model that reports Judge missing/unreachable separately from router wizard incomplete.
- Preserve current no-reasoning runtime payload behavior.

### WP-B: CLI Init, Doctor, Install, And Migration Guidance

- Wire readiness into `octoclawctl init`, `doctor`, `install`, and `deploy` output.
- Keep non-interactive mode non-mutating and non-prompting.
- Ensure legacy `judge-fast.json` migration remains supported.

### WP-C: Slack Onboarding Judge Guidance

- If router onboarding starts while Judge is missing/unhealthy, show a clear warning and setup action.
- Do not write Judge config from router wizard storage.
- Keep existing router wizard answers and same-provider proposal logic intact.

### WP-D: Feishu Cards And Actions

- Render onboarding and status cards as Feishu cards.
- Decode Feishu card action ids into the same semantic wizard actions used by Slack.
- Add idempotency and text fallback behavior.

### WP-E: Status Panel And Packaging Closeout

- Expose status panel readiness and rich/text render paths through CLI and IM.
- Verify deployed package set includes runtime, router, status surface, and CLI command support.
- Update docs and smoke instructions.

## Non-Goals

- Do not add `glm-4.7` or other untested Judge presets.
- Do not add a Feishu streaming or message-edit implementation.
- Do not silently mutate OpenClaw provider credentials, model fallbacks, or fallback order.
- Do not merge Judge config into `router-wizard.json`.
- Do not reintroduce OctoClaw-owned runtime execution truth, delivery outbox, or heuristic dispatch authority.
- Do not store credentials in logs, snapshots, BDD fixtures, or IM message text.

## Acceptance Gate

This change is complete when:

- [ ] `gpt-5.4-mini` appears in interactive Judge setup and is stored as a remote non-local Judge when selected.
- [ ] Judge calls for OpenAI-compatible endpoints continue to include `reasoning_effort: "none"`.
- [ ] A migrated install with no Judge gets actionable CLI and IM guidance.
- [ ] Router wizard can warn about missing Judge without writing Judge config.
- [ ] Feishu onboarding/status cards render and Feishu button actions advance the same wizard state.
- [ ] Feishu card failure falls back to text guidance.
- [ ] Status panel renders through CLI text, Slack blocks, and Feishu cards.
- [ ] Install/deploy readiness reports runtime, Judge, IM, router wizard, and status panel.
- [ ] Targeted BDD tests in `bdd.md` pass.
- [ ] `pnpm check && pnpm test` passes, or any unrelated pre-existing failure is documented with targeted green tests.

## Risk Notes

- Feishu interactive callbacks may differ from Slack payloads. Keep payload decoding at the Feishu edge and test with representative card action bodies.
- Provider discovery must be conservative. If provider compatibility is ambiguous, ask the user rather than guessing.
- Readiness warnings must not become hard install failures unless OpenClaw/runtime plugin itself cannot load.
- Status panel must remain a projection and not regain execution authority.
