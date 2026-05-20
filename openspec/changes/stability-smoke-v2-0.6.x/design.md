# Design: Stability Smoke v2

## Authority Model

- Native TaskFlow remains execution lifecycle truth.
- WorkContract remains semantic/delegation/handoff/continuity truth.
- Slack messages, ACKs, footers, status panels, and wizard prompts are projections.
- Replay events and acceptance reports are audit evidence, not live routing inputs.
- AI review can classify and recommend; it cannot pass or fail a gate without structured evidence.

## Report Model

Add a stability report:

```ts
type StabilityGate = "pass" | "fail" | "unknown";
type StabilitySeverity = "blocker" | "major" | "minor" | "observe";
type StabilityCaseMode = "live_slack" | "synthetic" | "replay" | "router_model" | "wizard" | "provider";

interface StabilityFailurePacket {
  code: string;
  severity: StabilitySeverity;
  caseId: string;
  mode: StabilityCaseMode;
  classification?: "runtime_bug" | "smoke_spec_bug" | "environment_issue" | "unknown";
  threadTs?: string;
  promptHash?: string;
  route?: string;
  model?: string;
  footerVia?: string;
  workContractId?: string;
  spawnIntentId?: string;
  runId?: string;
  childSessionKey?: string;
  replayEventIds?: string[];
  stageMs?: Record<string, number>;
  relatedCommits?: string[];
  artifactPaths?: Record<string, string>;
}

interface StabilityReport {
  schemaVersion: "octoclaw.stability_smoke.report/v2";
  generatedAt: string;
  runKind: "post_deploy" | "nightly" | "full_3d" | "manual";
  overallGate: StabilityGate;
  lanes: StabilityLaneResult[];
  failures: StabilityFailurePacket[];
  artifactDir: string;
}
```

Reports must be sanitized. They may include prompt hashes and short labels, but not full prompts, raw transcripts, auth headers, API keys, or full model responses.

## Case Pack Schema

Case packs are JSON files generated from a fixed catalog and optional AI curation.

```ts
interface StabilityCasePack {
  schemaVersion: "octoclaw.stability_smoke.case_pack/v2";
  generatedAt: string;
  generatedBy: "catalog" | "glm-5.1" | "gpt-5.5" | "manual";
  runKind: "post_deploy" | "nightly" | "full_3d" | "manual";
  cases: StabilityCase[];
}

interface StabilityCase {
  id: string;
  mode: StabilityCaseMode;
  severity: StabilitySeverity;
  tags: string[];
  prompt?: string;
  maxRuntimeMs?: number;
  expect: Record<string, unknown>;
}
```

Validation rules:

- Unknown `mode` or `severity` fails closed.
- `live_slack` cases must have a prompt and explicit max runtime.
- AI-generated packs cannot add more live cases than the configured cap.
- Provider failure injection must be synthetic unless the pack explicitly sets `allowLiveProviderProbe=true`.

## Case Catalog

### Post-Deploy Pack

- `reply_core.simple_chat`
- `streaming_core.long_reply`
- `delegate_core.native_final`
- `footer_truth.current_model`
- `status_core.read_only`

### Nightly Pack

Includes post-deploy pack plus:

- `ack.thread_anchor`
- `ack.no_misleading_text`
- `delegate.spawn_intent_hash_escape`
- `delegate.native_final_footer`
- `footer.no_delegate_without_spawn`
- `router.simple_normal_deep_model_matrix`
- `wizard.start_resume_idempotent`
- `provider.402_or_429_fallback`
- `restart.shutting_down_message`

### Full Acceptance Pack

Runs every 3 days. Includes nightly pack plus:

- Full Slack wizard flow.
- Router model discovery/proposal checks.
- Health cooldown and fallback suggestion checks.
- Restart-window interruption recovery.
- Duplicate final and parent echo regressions.

## Stability Lanes

### slack_delivery

Validates:

- Prompt posts successfully to the intended acceptance channel.
- Replies are in the expected thread.
- Slack API delivery errors are surfaced.

### ack_contract

Validates:

- Required ACK arrives within case-specific max.
- ACK is anchored to the same thread.
- ACK text is not misleading.
- Duplicate ACKs are reported.

### streaming_contract

Validates:

- Streaming/partial channels do not receive conflicting task ACKs.
- Long reply cases produce a final response without route flip or stray delegate footer.

### delegate_contract

Validates:

- Delegate footer requires spawn evidence.
- Native spawn intent exists.
- Child session/run exists.
- Native child final is delivered through Slack API.

### footer_truth

Validates:

- Footer `route`, `model`, `via`, worker, WorkContract, and complexity match replay evidence.
- `route=delegate` appears only when actual dispatch/spawn occurred.

### router_model_choice

Validates:

- Expected model is computed from current OpenClaw models, configured router wizard preferences, health cooldown, native fallback list, and complexity.
- Slack footer or replay model matches the expected choice or records an allowed fallback reason.

### wizard_contract

Validates:

- Wizard can be manually triggered.
- Start/resume works.
- Duplicate click is idempotent.
- Out-of-order answered step returns a clear message.
- Wizard failures do not block routing.

### provider_resilience

Validates:

- 402/429/timeout does not leak a bare provider error to Slack.
- If fallback is available, fallback occurs and footer/replay explain it.
- If no fallback is available, the failure is user-readable and records health evidence.

### nightly_replay

Reuses existing nightly lanes:

- route quality
- route commit ACK
- execution transition
- delegation health
- delivery

## AI Case Selection

Input to GLM-5.1:

- Last 24h stability/nightly reports.
- Recent replay summary.
- Recent Slack acceptance failures.
- Current OpenClaw model list/fallback list.
- Router wizard and health snapshot summaries.
- Recent commits touching runtime, ACK, Slack, router, wizard, or provider code.

Output:

- A schema-valid nightly case pack.
- A short rationale for each AI-selected case.
- Confidence score.

Rules:

- Invalid output is discarded and replaced by catalog nightly pack.
- Low confidence escalates review to GPT-5.5, but not live execution volume.
- AI cannot add credential-bearing prompts or raw transcript capture.

## AI Review And Fix Draft

Review input is a structured failure packet list, not raw logs.

Review output:

- failure group
- likely owner area
- classification: `runtime_bug`, `smoke_spec_bug`, `environment_issue`, or `unknown`
- evidence summary
- recommended next action

Fix-draft rules:

- Only run Codex fix-draft when at least one blocker/major failure is classified as `runtime_bug`.
- Fix-draft must keep changes small and local.
- Fix-draft must not commit, push, deploy, restart Gateway, or mutate OpenClaw config.
- If evidence is insufficient, it must leave the worktree unchanged and record blockers.
- If the draft changes more than 5 files, changes more than 300 lines, touches runtime delegate/ACK/router hot paths, or has failing validation, mark it `needs_human_review` and stop.
- Passing validation does not authorize commit/deploy. The report must ask the user to confirm before Codex commits, deploys, or restarts anything.
- After user confirmation, Codex independently reviews the diff, runs required tests, commits, deploys, and runs post-deploy smoke.

## OpenClaw Scheduling

Add scheduler-friendly commands:

```bash
octoclawctl stability post-deploy --config <config> --output-dir <dir>
octoclawctl stability nightly --config <config> --output-dir <dir>
octoclawctl stability full --config <config> --output-dir <dir> --cadence 3d
octoclawctl stability review-latest --output-dir <dir>
octoclawctl stability fix-draft --output-dir <dir>
```

OpenClaw scheduled tasks should call these commands. The task definition stores schedule and command only; case selection, execution, scoring, and review stay in `octoclawctl`.

## File Ownership

Expected areas:

- `tools/octoclawctl/src/stability/**`
- `tools/octoclawctl/src/slack-acceptance/**`
- `tools/octoclawctl/src/nightly/**`
- `tools/octoclawctl/src/nightly-eval/**`
- `tools/octoclawctl/src/cli.ts`
- `docs/`
- local scheduler wrapper under `~/.openclaw/bin/` may be regenerated by CLI, but repo logic lives in `tools/octoclawctl`.

Avoid:

- runtime policy resolver changes
- delegate/native spawn implementation changes
- router scoring behavior changes
- OpenClaw fallback mutation

## Error Handling

- Slack token missing: skip live Slack cases with `environment_unhealthy`, but still run synthetic/replay lanes.
- Gateway shutting down: classify `gateway_restart_drop` unless retry succeeds within configured grace.
- AI unavailable: use catalog case pack and mark AI lane unknown, not fail.
- Provider probe unavailable: use synthetic provider fixture unless live provider probing is explicitly enabled.
- Replay missing: live Slack can still run, but replay-backed lanes become unknown.

## Testing Strategy

- Unit tests for case-pack schema and catalog validation.
- Unit tests for failure packet generation.
- Slack acceptance tests for footer/replay assertions.
- Synthetic fixture tests for known recent regressions.
- CLI tests for stability commands.
- Nightly-eval tests for stability report aggregation and AI review fallback.

## Rollback

Rollback is non-invasive:

- Disable scheduled stability commands.
- Restore old nightly config.
- Keep generated reports as artifacts.
- No runtime data migration is required.
