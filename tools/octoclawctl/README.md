# @octoclaw/cli

Command line tools for installing, deploying, diagnosing, and smoke-testing OctoClaw in an OpenClaw environment.

## Install

> The published npm package currently provides **read-only operator commands**
> (`doctor`, `status`, `details`, `queue`, `timeline`). It cannot deploy the
> runtime into OpenClaw on its own yet. For a full install, use the source
> method in the repo README or `docs/octoclaw-ai-install-runbook.md`.

```bash
npm install -g @octoclaw/cli
octoclawctl doctor          # environment checks
octoclawctl status          # projection (after the runtime is deployed from source)
```

Full source install (deploys the runtime):

```bash
git clone https://github.com/guanbear/OctoClaw.git && cd OctoClaw
git checkout v0.6.0
pnpm install --frozen-lockfile && pnpm build
node tools/octoclawctl/dist/cli.js init
node tools/octoclawctl/dist/cli.js deploy --restart
node tools/octoclawctl/dist/cli.js doctor
```

## Migration And Feishu

For migrated machines, Feishu-only installs, or environments without a local Judge, use the repository runbook:

```text
docs/octoclaw-migration-onboarding-feishu-guide.md
```

The intended setup model is AI-runbook first and thin wizard second. The wizard asks only for user-owned decisions such as secrets, IM channel selection, remote Judge/provider selection, and explicit config writes.

Minimum target:

- OpenClaw >= 2026.5.12
- Node.js >= 22
- A local Qwen3 0.6B Judge or remote OpenAI-compatible `gpt-5.4-mini`

## Common Commands

```bash
octoclawctl init --auto-remote-judge
octoclawctl doctor --format json
octoclawctl router wizard --cli
octoclawctl router model-intel refresh
octoclawctl stability full --output-dir ~/.openclaw/reports --config ~/.openclaw/octoclaw-slack-acceptance-config.json --format json
```

OctoClaw never prints credentials in readiness output and never mutates OpenClaw fallback order automatically.
