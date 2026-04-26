# OctoClaw Slack Acceptance Harness

Date: 2026-04-26  
Scope: D4 real Slack/IM black-box acceptance harness for ACK/delegation/status behavior.

## Purpose

`octoclawctl slack-acceptance` verifies real Slack-facing behavior against an explicit acceptance bot/channel/session. It is an offline acceptance harness: it sends test prompts, reads Slack thread replies, checks content/timing/replay evidence, and writes sanitized artifacts. It does not mutate live route/model policy and does not enable multi-agent by default.

## Command

```bash
octoclawctl slack-acceptance \
  --config ./slack-acceptance.json \
  --output-dir ./reports/slack-acceptance \
  --format markdown
```

Formats:

- `markdown` writes JSON + Markdown artifacts and prints paths plus gate summary.
- `json` writes artifacts and prints the sanitized JSON report.

The command fails closed before sending anything when required config is missing, the token env var is unset, `target.channel` is missing, or a DM/direct target is used without `target.allowDm=true`.

## Config

```json
{
  "schemaVersion": "octoclaw.slack_acceptance.config/v1",
  "botTokenEnv": "OCTOCLAW_ACCEPTANCE_SLACK_BOT_TOKEN",
  "sessionKey": "slack:default:channel:C_ACCEPTANCE:thread:1234567890.000001",
  "target": {
    "channel": "C_ACCEPTANCE",
    "threadTs": "1234567890.000001"
  },
  "outputLabel": "acceptance",
  "replayPath": "/Users/guanbear/.octoclaw/replay/runtime-policy.jsonl",
  "exposedTools": ["message.send", "message.update", "message.react", "message.typing"],
  "ackTimeoutMs": 30000,
  "finalTimeoutMs": 180000,
  "pollIntervalMs": 2000,
  "fixtures": {
    "materializedNoSpawn": true
  }
}
```

Do not put Slack tokens in the config file. Use `botTokenEnv` only.

## Default Cases

The default suite covers:

1. `plain_chat`: `在吗`
2. `fresh_lookup`
3. `delegated_work`
4. `status_panel`
5. `provenance_followup`: `刚才那个任务判定是啥，怎么查的？`
6. `route_objection_correction`
7. `no_lie_materialized_no_spawn` when fixture is configured

Status/provenance/no-lie cases are expected not to spawn. When `replayPath` is configured, the harness checks replay events after the prompt timestamp for spawn evidence. Missing or malformed replay evidence returns `unknown`, not `pass`.

## Safety Rules

- No production DM is selected by default.
- DM/direct targets require explicit `target.allowDm=true`.
- Production-labeled targets require explicit `target.allowProductionTarget=true`.
- Allowed Slack-facing tools are limited to `message.send`, `message.update`, `message.react`, and `message.typing`; any other exposed tool fails the audit.
- Reports recursively redact token/secret fields and strip raw transcript, child transcript, worker chain-of-thought, and execution log fields.
- The harness stores Slack acceptance transcript snippets as artifacts, but never injects them into parent context.
