# @octoclaw/cli

Command line tools for installing, deploying, diagnosing, and smoke-testing OctoClaw in an OpenClaw environment.

## Install

```bash
npm install -g @octoclaw/cli
octoclawctl init
octoclawctl deploy
octoclawctl doctor
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
