# OctoClaw Migration Onboarding And Feishu Guide

This guide is for a fresh machine or a migrated OpenClaw environment where OctoClaw is installed but local setup state may be missing.

## Readiness Flow

Run the setup wizard first:

```bash
octoclawctl init
```

For a remote Judge, choose `gpt-5.4-mini` when available. OctoClaw prefers an existing OpenAI-compatible OpenClaw provider such as `cliproxyapi`; if none is found, the wizard asks for a base URL and API key. The router wizard does not store Judge credentials.

After setup or deploy, check readiness:

```bash
octoclawctl doctor
octoclawctl doctor --format json
```

The readiness report covers OpenClaw, the runtime plugin, Judge, Slack, Feishu, router wizard, and the status panel. Missing Judge is a warning because routing fails open to the primary model.

## Re-run Router Setup

From CLI:

```bash
octoclawctl router wizard --cli
```

From Slack or Feishu, send a normal message after deployment. If router setup has not completed, OctoClaw sends an onboarding card. Missing Judge appears as a warning with `octoclawctl init` guidance; answering router questions never writes Judge config.

## Feishu Verification

Feishu is card-first for onboarding and status, with plain text fallback when card delivery fails.

Smoke checks:

```bash
octoclawctl doctor
octoclawctl status
```

In Feishu:

- Trigger a fresh onboarding prompt from a direct or threaded session.
- Click `开始配置` and confirm the wizard advances to step 1.
- Click an old step button again and confirm it replies `这一步已经回答过`.
- Request status and confirm the status panel renders as a Feishu card.

Feishu does not use Slack streaming. It should still deliver final text and card projections through the normal IM adapter.

## Packaging Expectations

`octoclawctl install`, `update`, and `deploy` build and sync:

- runtime plugin under OpenClaw extensions
- OctoClaw packages, including `octoclaw-status-surface`
- CLI/source manifest metadata

The deploy closeout prints the same readiness summary as `doctor`. If the status panel check warns, run:

```bash
pnpm build
octoclawctl deploy
```

## Guardrails

- OctoClaw never automatically runs `openclaw models fallbacks add` or `openclaw models fallbacks remove`.
- Router wizard config is local routing preference, not Judge credential storage.
- Status cards are projections only; they do not create execution truth.
