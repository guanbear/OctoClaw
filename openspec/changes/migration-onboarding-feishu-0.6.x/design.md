# Design: Migration Onboarding, Judge Presets, And Feishu

## Authority Model

- Native TaskFlow is execution lifecycle truth.
- WorkContract is semantic/delegation/handoff/continuity truth.
- ACK, status, display, onboarding, dashboard, and readiness reports are projections.
- Router wizard config is local routing preference, not Judge credential storage.
- OctoClaw must not automatically modify OpenClaw model fallback order.

## Components

### Judge Preset

Extend `tools/octoclawctl/src/commands/init/steps/step-judge-model.ts`.

New choice:

```text
remote-gpt-5-4-mini
```

Behavior:

- Label in Chinese: `远端 OpenAI-compatible - gpt-5.4-mini（便宜、快速、无推理，推荐远端）`
- Label in English: `Remote OpenAI-compatible - gpt-5.4-mini (cheap, fast, no reasoning)`
- Model id: `gpt-5.4-mini`
- `local=false`
- Base URL/API key:
  - Prefer an existing configured OpenClaw provider that can serve `gpt-5.4-mini`.
  - Prefer provider ids/base URLs containing `cliproxyapi` when multiple candidates exist.
  - If no provider is found, prompt for OpenAI-compatible base URL and API key.

Runtime no-reasoning remains in `extensions/octoclaw-runtime/src/resolve/llm-judge.ts`:

- OpenAI-compatible: `reasoning_effort: "none"`
- Ollama native: `think: false`

### Readiness Model

Create a small shared readiness module in `tools/octoclawctl` first. Runtime can consume the same JSON shape through CLI output or duplicated narrow types if package layering makes direct import unsafe.

Suggested result shape:

```ts
type ReadinessStatus = "pass" | "warn" | "fail";

interface OctoclawReadinessCheck {
  id:
    | "openclaw"
    | "runtime_plugin"
    | "judge"
    | "im.slack"
    | "im.feishu"
    | "router_wizard"
    | "status_panel";
  status: ReadinessStatus;
  summary: string;
  remediation?: string;
}

interface OctoclawReadinessReport {
  schemaVersion: "octoclaw.readiness/v1";
  generatedAt: string;
  checks: OctoclawReadinessCheck[];
}
```

Rules:

- Missing Judge is `warn`, not `fail`, because routing can fail open.
- Unreachable configured Judge is `warn` unless the command explicitly asks for strict verification.
- Missing OpenClaw or missing runtime plugin main is `fail`.
- Missing IM tokens are per-channel warnings.
- Incomplete router wizard is a warning with manual trigger instructions.
- Status panel unavailable is warning if runtime still works.

### CLI Integration

`octoclawctl init`:

- Keeps existing interactive flow.
- Shows Judge preset list including `gpt-5.4-mini`.
- After writing config, prints readiness summary.

`octoclawctl doctor`:

- Adds readiness checks and optional JSON output if existing command supports it.
- Does not print secrets.

`octoclawctl install` / `deploy`:

- After deploy/validate, print readiness summary.
- Do not prompt for secrets during non-interactive deploy.

### Slack Onboarding Guidance

When router onboarding starts:

- Check readiness or narrow Judge state.
- If Judge is missing/unhealthy, prepend a warning section:
  - "Judge 未配置/不可达，Auto Router 会保守退回主模型。"
  - "运行 `octoclawctl init` 或 `octoclawctl config set judge...` 配置。"
  - If `gpt-5.4-mini` preset is available, mention it as recommended remote option.
- Do not write Judge config from router wizard actions.
- Existing router wizard state file and actions remain unchanged.

### Feishu Card Adapter

Add Feishu-specific rendering and action decoding in runtime IM modules.

Card renderer requirements:

- Convert neutral onboarding/status actions to Feishu card JSON blocks accepted by `FeishuAdapter`.
- Use deterministic action ids:

```text
octoclaw:<surface>:<action>:<value>
```

- For wizard steps, values must decode to the same semantic action names as Slack, for example `plan_subscription:<model>`.
- Include plain text fallback in message body.

Action handler requirements:

- Accept Feishu card callback payloads.
- Resolve user/session/thread anchor without uppercasing Feishu ids.
- Decode action id/value at the Feishu edge.
- Call the same router onboarding action reducer used by Slack where possible.
- Duplicate click on an answered step returns "这一步已经回答过".
- Unknown action returns a short error and does not mutate state.

### Status Panel

Keep `@octoclaw/status-surface` as the projection boundary.

Add or wire:

- CLI command/readiness output that confirms status panel renderer availability.
- Slack renderer path to existing block/status interactive blocks when available.
- Feishu renderer path to `feishu_card`.
- Text fallback for unsupported channels.

Status cards may show:

- task id / flow id
- state
- route
- model / worker
- native substrate summary
- last update time
- available actions

They must not claim spawn/run truth unless native evidence exists.

## File Ownership

Expected edit areas:

- `tools/octoclawctl/src/commands/init/**`
- `tools/octoclawctl/src/commands/doctor.ts`
- `tools/octoclawctl/src/install.ts`
- `tools/octoclawctl/src/cli.ts`
- `extensions/octoclaw-runtime/src/router-onboarding.ts`
- `extensions/octoclaw-runtime/src/im/feishu/**`
- `extensions/octoclaw-runtime/src/im-status-renderer.ts`
- `extensions/octoclaw-status-surface/src/**`
- Tests colocated with the modules above.
- User docs under `docs/`.

Avoid broad edits to:

- `extensions/octoclaw-runtime/src/resolve/policy-resolver.ts`
- native runtime dispatch/planner paths
- router scoring/health internals unless needed for readiness display only

## Error Handling

- Provider discovery failure falls back to explicit prompts.
- Feishu card send failure falls back to text.
- Feishu callback decode failure returns a visible error and does not mutate state.
- Readiness checks catch command/config errors and report warnings/failures; they do not throw from onboarding.
- Secrets are redacted from every message/log/error.

## Testing Strategy

- Unit tests for Judge choices and readiness classification.
- Unit tests for Feishu card rendering and callback decoding.
- Integration tests for router onboarding with missing Judge.
- Status renderer tests for Feishu card and text fallback.
- CLI tests for doctor/install readiness output.
- Existing Slack wizard tests must remain green.

## Rollback

Rollback is local:

- Remove the new Judge preset choice.
- Disable Feishu card action registration while keeping text delivery.
- Keep readiness checks in CLI; they are observational and safe.

No user data migration is required because this change does not alter existing config schema in a breaking way.
