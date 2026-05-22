# OctoClaw Migration Onboarding And Feishu Guide

This guide is for a fresh machine or a migrated OpenClaw environment where OctoClaw is installed but local setup state may be missing.

## Operating Model: AI Runbook, Thin Wizard

Treat this document as the primary migration procedure for an AI assistant or operator. The assistant should run checks, inspect outputs, repair drift, and summarize remaining human decisions.

The interactive wizard should stay thin. It is useful for choices that need user authority:

- which IM channel to enable: Slack, Feishu, or both
- which remote Judge/provider to use when no local Judge exists
- whether to write config changes
- secrets that cannot be discovered automatically
- whether to send live test messages

Do not move the whole migration decision tree into Slack or Feishu buttons. Long explanations, failure analysis, smoke review, and package checks belong in this runbook so an AI can execute them repeatably.

## Minimum Target

- OpenClaw >= 2026.5.12
- Node.js >= 22
- This OctoClaw repo built locally, or a released `@octoclaw/cli` package
- At least one IM channel: Slack or Feishu
- A Judge: local Qwen3 0.6B or remote OpenAI-compatible `gpt-5.4-mini`
- No requirement for a local Judge. If local Judge is missing, use `octoclawctl init --auto-remote-judge` and confirm a remote provider.

## Readiness Flow

Run the setup wizard first:

```bash
octoclawctl init
```

For a remote Judge, start with `gpt-5.4-mini` when available. OctoClaw prefers an existing OpenAI-compatible OpenClaw provider such as `cliproxyapi`; if none is found, the wizard asks for a base URL and API key. The current judge eval also marks `glm-4.5-air`, `xiaomi/mimo-v2-flash`, and `deepseek/deepseek-v4-flash` as usable remote alternatives, but they should be selected explicitly after checking latency and JSON reliability. `glm-4.5-air` is fast when it returns but has long-tail timeout risk in the eval. The router wizard does not store Judge credentials.

After setup or deploy, check readiness:

```bash
octoclawctl doctor
octoclawctl doctor --format json
```

The readiness report covers OpenClaw, the runtime plugin, Judge, Slack, Feishu, router wizard, and the status panel. Missing Judge is a warning because routing fails open to the primary model.

## AI Migration Sequence

Use this sequence on a new machine or after moving an existing OpenClaw home.

1. Confirm the substrate:

```bash
node --version
openclaw --version
```

OpenClaw must be `2026.5.12` or newer. If it is older, stop and upgrade OpenClaw before installing OctoClaw.

2. Build from the repo when using a source checkout:

```bash
pnpm install
pnpm build
```

3. Install or deploy OctoClaw:

```bash
node tools/octoclawctl/dist/cli.js install
node tools/octoclawctl/dist/cli.js deploy
```

If OctoClaw is already installed and only code changed:

```bash
node tools/octoclawctl/dist/cli.js deploy --skip-build --restart
```

4. Configure missing setup surfaces:

```bash
octoclawctl init
```

For a machine without local Judge, prefer:

```bash
octoclawctl init --auto-remote-judge
```

The command may reuse an existing OpenAI-compatible OpenClaw provider such as `cliproxyapi`. If provider compatibility is ambiguous, ask the user before writing Judge config.

5. Verify readiness:

```bash
octoclawctl doctor
octoclawctl doctor --format json
```

Interpret readiness as follows:

- `openclaw=fail`: stop; install or upgrade OpenClaw.
- `runtime_plugin=fail`: run `octoclawctl deploy`.
- `judge=warn`: routing still works, but configure local Qwen3 0.6B or remote `gpt-5.4-mini` before judging quality.
- `im.feishu=warn`: acceptable on Slack-only installs; blocking on Feishu-only installs.
- `router_wizard=warn`: run `octoclawctl router wizard --cli` or trigger IM onboarding.
- `status_panel=warn`: run `pnpm build` then `octoclawctl deploy`.

6. Refresh router model intelligence:

```bash
octoclawctl router model-intel refresh
octoclawctl router capability install-schedule
```

The refresh may read public model catalog data and local OpenClaw provider config. It must not write OpenClaw fallback order.

7. Run a real smoke where credentials exist:

```bash
set -a
source ~/.openclaw/octoclaw-slack-acceptance.env >/dev/null 2>&1
set +a
node tools/octoclawctl/dist/cli.js stability full \
  --output-dir ~/.openclaw/reports \
  --config ~/.openclaw/octoclaw-slack-acceptance-config.json \
  --format json
```

Pass criteria:

- `overallGate` is `pass`
- `slack_delivery` passes if Slack is configured
- synthetic lanes pass even without live Feishu
- provider fallback cases pass
- wizard contract cases pass

For Feishu-only target machines, replace the Slack live smoke with Feishu manual smoke below until a Feishu acceptance harness is available.

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

## Feishu-Only Migration Smoke

Use this when the target machine has Feishu but no Slack.

1. Run:

```bash
octoclawctl doctor
```

2. Confirm:

- `im.feishu` is `pass`
- `runtime_plugin` is `pass`
- `judge` is `pass` or an accepted `warn`
- `status_panel` is `pass`

3. In Feishu, send a simple direct message such as:

```text
你现在用的是什么模型
```

Expected: a normal final reply. The footer should identify `route=reply`, model, and difficulty when available.

4. Trigger onboarding if router wizard is incomplete:

```text
重新配置 Auto Router
```

Expected: Feishu card appears. `开始配置` advances to the first question. Re-clicking an answered step returns `这一步已经回答过`.

5. Request status:

```text
看下 OctoClaw 状态面板
```

Expected: a Feishu card or text fallback showing projection state. It must not claim a child run exists unless native evidence exists.

6. Trigger a delegated task:

```text
帮我查一下 OpenClaw 当前版本和 OctoClaw readiness，最后用三句话总结
```

Expected: route is delegated only if policy decides delegation is needed; otherwise a direct reply is acceptable. If delegated, native session evidence should appear in status and the final message should not leak internal prompts or raw sub-agent logs.

## Failure Handling Matrix

| Symptom | Likely cause | Action |
|---|---|---|
| `Previous run is still shutting down` | Gateway restart/deploy window | Wait 10-20 seconds, retry the user turn, then check `openclaw gateway status`. |
| Missing Judge warning | Migrated machine has no local judge config | Run `octoclawctl init --auto-remote-judge`; prefer `gpt-5.4-mini` if an OpenAI-compatible provider is available. |
| Feishu card not delivered | Card API unsupported or credentials wrong | Check `im.feishu` readiness; adapter should fall back to text when the target is resolvable. |
| Router wizard keeps showing defaults only | Wizard state incomplete or old action clicked | Run `octoclawctl router wizard --cli --resume`; in IM, duplicate answered clicks should reply `这一步已经回答过`. |
| Status panel missing | `octoclaw-status-surface` package not deployed | Run `pnpm build` and `octoclawctl deploy`. |
| 402 / 429 from primary model | Provider quota or billing issue | Router health/fallback may choose a configured fallback; do not mutate OpenClaw fallback order automatically. |
| Live smoke fails on `delegate.parallel_two_children_status` | Native spawn/confirm/projection binding regression | Inspect the generated stability report and replay events before patching; both child sessions must have distinct native run evidence. |
| Final reply disappears during deploy | Gateway restart interrupted the active turn | Treat as an interruption, not a successful task. Re-run the user request after gateway readiness returns. |

## Packaging Expectations

`octoclawctl install`, `update`, and `deploy` build and sync:

- runtime plugin under OpenClaw extensions
- OctoClaw packages, including `octoclaw-status-surface`
- CLI/source manifest metadata

The deploy closeout prints the same readiness summary as `doctor`. Before release, also inspect the CLI package:

```bash
mkdir -p /tmp/octoclaw-pack
pnpm --filter @octoclaw/cli pack --pack-destination /tmp/octoclaw-pack
ls -lh /tmp/octoclaw-pack/*.tgz
```

If the status panel check warns, run:

```bash
pnpm build
octoclawctl deploy
```

## Guardrails

- OctoClaw never automatically runs `openclaw models fallbacks add` or `openclaw models fallbacks remove`.
- Router wizard config is local routing preference, not Judge credential storage.
- Status cards are projections only; they do not create execution truth.
- Do not print API keys, Slack tokens, Feishu secrets, auth headers, full prompts, or full model responses in logs/reports.
- Do not mark Feishu smoke as live-passed unless it was tested against real Feishu credentials.
