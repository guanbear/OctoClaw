# Spec Delta: AutoRouter Lite

## ADDED Requirements

### Requirement: AutoRouter Lite Is Shadow-First

AutoRouter Lite SHALL produce model intelligence, proposals, and shadow recommendations without changing live route/model behavior.

#### Scenario: shadow recommendation fails

- WHEN snapshot loading or recommendation scoring fails
- THEN OctoClaw SHALL keep the current judge route and selected model
- AND SHALL NOT change dispatch, spawn, ACK, footer, or WorkContract state.

#### Scenario: live selection requested by this change

- WHEN an implementation tries to replace the live model from Router Lite output
- THEN the change SHALL be rejected as out of scope
- AND a separate gated-live OpenSpec SHALL be required.

### Requirement: Judge Inputs Stay Slim

AutoRouter Lite SHALL consume only the active judge route fields plus compact runtime signals.

#### Scenario: old judge fields appear

- WHEN old fields such as `role`, `workType`, `scope`, `tool_need_hint`, or `duration_hint` are present in legacy data
- THEN Router Lite MAY ignore them for backward compatibility
- AND SHALL NOT use them for route/model selection.

### Requirement: Snapshot Facts Carry Evidence

Model-intel snapshot fields used for hard decisions SHALL carry source, freshness, and confidence.

#### Scenario: capability has no source

- WHEN a capability field has no source evidence
- THEN it SHALL NOT be treated as a hard positive signal.

#### Scenario: price sources conflict

- WHEN two price sources disagree materially
- THEN the snapshot SHALL preserve both sources
- AND SHALL mark the price as conflicting or lower-confidence
- AND SHALL NOT silently overwrite one source.

### Requirement: Unknown Quota Is Not Free

Quota and plan data SHALL be conservative.

#### Scenario: quota pressure is unknown

- WHEN `quotaPressure=unknown`
- THEN the model SHALL NOT receive a free-or-sunk plan bonus
- AND the recommendation SHALL record that quota evidence is missing.

#### Scenario: quota pressure is high

- WHEN `quotaPressure=high` or the model is in cooldown
- THEN the model SHALL be excluded from normal recommendations
- OR the shadow event SHALL record why it was ignored.

### Requirement: Unconfigured Models Are Proposal Only

Models not configured in local OpenClaw SHALL NOT be used for live route/model decisions.

#### Scenario: same-provider cheaper model discovered

- WHEN a cheaper same-provider candidate is discovered but `configured=false`
- THEN it MAY appear in `model-config-proposal.json`
- AND it MAY appear in shadow as `ignoredReason=not_configured`
- AND it SHALL NOT be selected for live use.

### Requirement: Hard Gates Precede Cost Scoring

AutoRouter Lite SHALL filter capability and health before optimizing cost.

#### Scenario: tool task and tool support unknown

- WHEN a delegated task requires tool use
- AND candidate model `toolUse` is `unknown` or `no`
- THEN the model SHALL NOT be recommended as live-eligible
- AND the missing tool evidence SHALL be recorded.

#### Scenario: cheap but unhealthy model

- WHEN a model is cheap but recent failure, timeout, cooldown, or tool-call failure evidence is poor
- THEN stability/health gates SHALL reject or heavily downrank it before cost scoring.

### Requirement: No Hot-Path Remote Catalog Fetch

External model catalogs, pricing APIs, and leaderboards SHALL NOT be fetched during a Slack/user-message turn.

#### Scenario: user sends a normal message

- WHEN OctoClaw handles an inbound user message
- THEN AutoRouter Lite SHALL use existing cached snapshot data
- AND SHALL NOT call OpenRouter, models.dev, leaderboard APIs, or provider catalogs over the network.

#### Scenario: refresh command or scheduled job runs

- WHEN a CLI refresh or scheduled model-intel job runs
- THEN it MAY fetch external public sources
- AND SHALL write the normalized facts into snapshot for later hot-path use.

### Requirement: Shadow Events Explain Decisions

Shadow recommendations SHALL be auditable.

#### Scenario: recommendation exists

- WHEN a model is recommended
- THEN the shadow event SHALL include actual model, recommended model, mode, scenario, estimated cost delta, quality floor, and selected reason codes.

#### Scenario: no recommendation exists

- WHEN no model is recommended
- THEN the shadow event SHALL include an ignored reason such as `no_snapshot`, `no_eligible_model`, `not_configured`, `quota_pressure_high`, `capability_below_floor`, `health_below_floor`, `explicit_model_override`, or `status_or_provenance_request`.

### Requirement: Status And Provenance Requests Stay Main-Fast

Cost optimization SHALL NOT force status/provenance/session-control requests into delegate.

#### Scenario: route is reply for status

- WHEN the judge/runtime route is `reply`
- AND the request is a status, provenance, model, footer, or dispatch-state question
- THEN AutoRouter Lite MAY record shadow comparison
- AND SHALL NOT force delegation for cost reasons.
