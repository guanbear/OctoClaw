# Design: Native Runtime Slimming and Host Adapter Foundation

## 0. One-Sentence Target Architecture

OctoClaw should decide route and policy, the host runtime should prove runtime
and delivery facts, OpenClaw should remain the only live host for this change,
and legacy OctoClaw heuristics should only explain old records that predate
native truth.

## 1. Vocabulary

| Term | Meaning |
|------|---------|
| Native truth | Structured OpenClaw runtime fact from task/run/flow/session/delivery surfaces. |
| Legacy heuristic | Any inference from strings, transcript text, old task-state shapes, session labels, or previous assistant wording. |
| New task | A task created after `NativeStatusProjection.nativeKind` and `agentRuntimeId` support is present. |
| Legacy record | Old task-state/replay record missing native fields due to older OctoClaw/OpenClaw versions. |
| Backend failover | Runtime backend unavailable before useful output. Example: primary ACP backend cannot start. |
| Task recovery | Worker did run but failed, timed out, produced bad output, or violated WorkContract. |
| Native delivery success | OpenClaw delivery status proves the user-facing reply was sent/delivered. |
| Relay compensation | OctoClaw sends or re-sends because native delivery was missing or failed. |
| Host runtime | The external agent runtime that owns sessions, background runs, delivery, and backend failover. Current live host: OpenClaw. Future candidate: Hermes. |
| RuntimeAdapter | A minimal OctoClaw boundary that normalizes host runtime facts without owning execution truth. |
| Deletion ledger | A short implementation note listing removed files/branches, before/after LOC, tests that proved deletion safe, and retained risks. |

## 2. Phase 1: Native Session Truth First

### 2.1 Desired Data Model

Extend or preserve projection fields:

```typescript
interface NativeStatusProjection {
  status: NativeProjectedStatus;
  rawStatus: string;
  source: "run" | "flow" | "latest" | "cache" | "none";
  reason: string;
  found: boolean;
  degraded: boolean;
  runId?: string;
  flowId?: string;
  taskId?: string;
  childSessionKey?: string;
  nativeKind?: string;       // "spawn-child", "direct", "acp", ...
  agentRuntimeId?: string;   // exact OpenClaw runtime id
  summary?: string;
  revision?: number;
  error?: string;
}
```

Add a runtime truth classification:

```typescript
type RuntimeTruthSource =
  | "native_run"
  | "native_flow"
  | "native_latest"
  | "legacy_cache_read_only"
  | "legacy_heuristic_read_only"
  | "none";

interface RuntimeTruthVerdict {
  isSpawnChild: boolean;
  spawnEvidence: "accepted_native" | "legacy_read_only" | "none";
  nativeKind: string;
  agentRuntimeId: string;
  reason: string;
  source: RuntimeTruthSource;
}
```

The verdict can be implemented as a helper, but do not introduce a large new
abstraction if a small projector helper is enough.

### 2.2 Native-First Decision Rules

For new tasks:

1. If `nativeKind === "spawn-child"`, treat the task as a child session.
2. If `runId` or `childSessionKey` is present from native accepted status, treat
   spawn as accepted.
3. If native status is missing while native ids exist, project `lost` or
   `degraded`, not success.
4. If native status says direct/non-child, do not override it using session name
   strings.
5. If native fields are absent, legacy heuristics may render old status text but
   must not drive new dispatch/confirm/ACK/delivery.

### 2.3 Legacy Heuristic Isolation

Move legacy heuristics behind one explicit boundary:

```typescript
interface LegacyHeuristicResult {
  allowed: boolean;        // false for new tasks in enforce mode
  readOnly: true;
  reason: string;         // "legacy_missing_native_kind", ...
  inferredKind?: string;
  inferredChildSessionKey?: string;
}
```

Minimum acceptable implementation:

- do not move every legacy helper immediately;
- add a top-level gate near projection/dispatch call sites;
- emit an event whenever legacy fallback is used.

Suggested event:

```json
{
  "event": "legacy_heuristic_fallback_used",
  "taskId": "task-...",
  "workContractId": "wc-...",
  "surface": "status_projection|dispatch_guard|message_guard",
  "reason": "native_fields_absent",
  "newTask": false,
  "readOnly": true
}
```

For new tasks, this event should either not occur or occur with
`allowed=false`.

### 2.4 Code Areas To Inspect

Start with these files:

- `extensions/octoclaw-runtime/src/state/native-status-projector.ts`
- `extensions/octoclaw-runtime/src/tools/runtime-task-projection.ts`
- `extensions/octoclaw-runtime/src/tools/runtime-status.ts`
- `extensions/octoclaw-runtime/src/delegate/native-spawn-confirm.ts`
- `extensions/octoclaw-runtime/src/delegate/native-spawn-gate.ts`
- `extensions/octoclaw-runtime/src/ack/execution-transition-notifier.ts`
- `extensions/octoclaw-runtime/src/replay/message-guard.ts`
- `extensions/octoclaw-runtime/src/state/policy-state.ts`
- `packages/octoclaw-contracts/src/status-projection.ts`
- `packages/octoclaw-contracts/src/work-contract.ts`

Do not use this list as permission to edit all files. Follow impact analysis,
then make narrow changes.

### 2.5 What To Delete First

Delete or disable only after tests exist:

- session-kind inference from session key substrings when native kind is present;
- child detection from assistant text such as "subagent", "sessions_spawn", or
  "delegated";
- transcript-text completion inference for new tasks;
- any path that upgrades cached `running` to successful spawn without native
  accepted evidence.

Keep temporarily:

- legacy task-state readers for archived records;
- replay migration readers;
- status display for old records, marked as `legacy_read_only`.

## 3. Phase 2: ACP Fallback Native Integration

### 3.1 Principle

OpenClaw `acp.fallbacks` handles runtime backend failover before output.
OctoClaw handles route policy and task-level recovery after execution has begun.

Do not confuse:

| Case | Owner |
|------|-------|
| Primary ACP backend cannot start before output | OpenClaw ACP fallback |
| Primary ACP backend starts and emits partial output | Do not fallback silently |
| Worker times out | OctoClaw watchdog/recovery |
| Worker returns malformed result | OctoClaw WorkContract/result handling |
| Worker violates route/tool policy | OctoClaw policy/replay guard |

### 3.2 Observe-Only Read Path

Read native fallback order/config using existing OpenClaw surfaces. The repo
already reads model fallback order in router health work; reuse that pattern
instead of adding another config parser.

Known current entry points:

- `tools/octoclawctl/src/cli.ts` reads `openclaw models fallbacks list --json`
  for router health.
- `packages/octoclaw-router/src/decision/model-intel-facts.ts` accepts native
  fallback order as input.

For ACP runtime fallback, implement a similar read path:

```typescript
interface NativeAcpFallbackSnapshot {
  status: "ok" | "unavailable" | "not_configured";
  primaryRuntimeId: string;
  fallbackRuntimeIds: string[];
  source: "openclaw_config" | "openclaw_status" | "none";
  observedAt: string;
}
```

If OpenClaw does not expose a stable CLI command for `acp.fallbacks`, use config
read-only access and mark source accordingly. Do not write config in this change.

### 3.3 Replay Metadata

Every delegated ACP run should be able to report:

```json
{
  "native_acp_fallback": {
    "mode": "observe",
    "primaryRuntimeId": "acpx",
    "fallbackRuntimeIds": ["codex-native"],
    "fallbackAttempted": false,
    "fallbackSelectedRuntimeId": "",
    "reason": ""
  }
}
```

If a fallback occurs, replay must include whether output had already started.
If output had started, OctoClaw must not treat fallback as a clean failover.

### 3.4 Enforce Mode

Only after observe-only smoke passes:

- remove OctoClaw backend-unavailable self-spawn retry for ACP-backed paths;
- let OpenClaw ACP fallback select the replacement runtime;
- keep OctoClaw task recovery for post-start failures.

Feature flag:

```typescript
nativeAcpFallbackMode:
  | "observe"
  | "delegate_backend_unavailable";
```

Acceptance for enforce mode:

- one WorkContract;
- one native spawn accepted chain;
- no duplicate task id;
- no duplicate final;
- replay records fallback event from OpenClaw native facts.

## 4. Phase 3: Delivery Relay Slimming

### 4.1 Principle

Native delivery success wins. OctoClaw compensation runs only when native
delivery is missing, failed, or degraded.

### 4.2 Required Delivery Verdict

Introduce a compact verdict if one does not already exist:

```typescript
type DeliveryTruthSource =
  | "native_delivery"
  | "octoclaw_relay"
  | "audit_only"
  | "none";

interface DeliveryRelayVerdict {
  finalVisible: boolean;
  nativeDelivered: boolean;
  relayCompensationNeeded: boolean;
  duplicateRisk: boolean;
  source: DeliveryTruthSource;
  reason: string;
}
```

Decision table:

| Native delivery | OctoClaw relay action | Status |
|-----------------|-----------------------|--------|
| delivered | audit only | completed/delivered |
| sent but not confirmed | wait or degraded, no immediate duplicate | pending/degraded |
| failed | compensate | fallback delivery |
| missing with native result | compensate after timeout | fallback delivery |
| duplicate native final detected | suppress relay | duplicate avoided |

### 4.3 Surfaces To Inspect

- `extensions/octoclaw-runtime/src/im/send.ts`
- `extensions/octoclaw-runtime/src/im/delivery-port.ts`
- `extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts`
- `extensions/octoclaw-runtime/src/im/feishu/feishu-adapter.ts`
- `extensions/octoclaw-runtime/src/ack/execution-transition-notifier.ts`
- `extensions/octoclaw-runtime/src/replay/replay.ts`
- `tools/octoclawctl/src/slack-acceptance/harness.ts`
- `tools/octoclawctl/src/nightly/classifier.ts`
- `tools/octoclawctl/src/nightly/report.ts`

### 4.4 What Can Be Removed After Evidence

Candidates:

- compensation branch for message-tool-only reply when native delivery proves
  visible final;
- special card/button-only mirror fallback when native rich presentation is
  confirmed;
- status projection that infers delivery from stale task-state alone;
- relay duplicate-final prevention branches that are redundant with native
  delivery ids.

Do not remove:

- fallback delivery on native failure;
- audit logs;
- duplicate final detection;
- smoke harness;
- user-facing status explaining degraded/missing delivery.

## 5. Phase 4: RuntimeAdapter Foundation

### 5.1 Why This Exists

The current live target is still OpenClaw. The adapter exists for two reasons:

1. Stop scattering OpenClaw-specific runtime assumptions through policy,
   status, delivery, ACK, and recovery call sites.
2. Make a later Hermes migration a bounded host-adapter project, not a rewrite
   of OctoClaw's policy and WorkContract logic.

This phase must not become a generic framework. Keep the seam small and driven
only by existing BDD scenarios.

Hermes docs show that Hermes has a CLI/gateway/ACP/API entrypoint model, a
messaging gateway, SQLite-backed sessions, plugin hooks, and programmatic ACP /
TUI gateway / API server integration. That is enough to justify an adapter seam,
but not enough to turn Hermes on without a separate live-runtime spec.

Reference docs:

- https://hermes-agent.nousresearch.com/docs/developer-guide/architecture
- https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration
- https://hermes-agent.nousresearch.com/docs/user-guide/messaging
- https://hermes-agent.nousresearch.com/docs/zh-Hans/guides/migrate-from-openclaw

### 5.2 Minimal Adapter Shape

Suggested files:

```text
extensions/octoclaw-runtime/src/runtime-host/types.ts
extensions/octoclaw-runtime/src/runtime-host/openclaw-adapter.ts
extensions/octoclaw-runtime/src/runtime-host/hermes-capabilities.ts
extensions/octoclaw-runtime/src/runtime-host/index.ts
```

Do not create these files if existing module boundaries can host the same
minimal types cleanly. The important rule is dependency direction, not file
names.

Minimal interface:

```typescript
export type RuntimeHostId = "openclaw" | "hermes";

export interface RuntimeSpawnEvidence {
  accepted: boolean;
  runId?: string;
  flowId?: string;
  childSessionKey?: string;
  nativeKind?: string;
  agentRuntimeId?: string;
  reason: string;
}

export interface RuntimeStatusSnapshot {
  found: boolean;
  degraded: boolean;
  status: "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "lost" | "unknown";
  runId?: string;
  flowId?: string;
  childSessionKey?: string;
  nativeKind?: string;
  agentRuntimeId?: string;
  reason: string;
}

export interface RuntimeDeliverySnapshot {
  found: boolean;
  delivered: boolean;
  degraded: boolean;
  messageId?: string;
  channelId?: string;
  reason: string;
}

export interface RuntimeFallbackSnapshot {
  status: "ok" | "unavailable" | "not_configured";
  primaryRuntimeId?: string;
  fallbackRuntimeIds: string[];
  source: "openclaw_config" | "openclaw_status" | "hermes_config" | "none";
  observedAt: string;
  reason?: string;
}

export interface HostRuntimeAdapter {
  readonly host: RuntimeHostId;
  readStatus(ref: { runId?: string; flowId?: string; childSessionKey?: string }): Promise<RuntimeStatusSnapshot>;
  readDelivery(ref: { runId?: string; flowId?: string; childSessionKey?: string }): Promise<RuntimeDeliverySnapshot>;
  readFallbacks(): Promise<RuntimeFallbackSnapshot>;
}
```

Notes:

- `spawn` does not need to be added if the current planner/confirm flow already
  emits and confirms native spawn through OpenClaw tools. Add spawn only when a
  BDD scenario proves an adapter-owned call is necessary.
- `cancel` does not need to be added until `octoclaw_task_action` actually
  routes cancellation through the host.
- The adapter must normalize facts, not store them as truth.

### 5.3 OpenClaw Adapter Rules

The OpenClaw adapter wraps existing native access:

- native status projector;
- TaskFlow/session lookup ports;
- native ACP fallback read path;
- native delivery receipt/projection path.

It must not change live behavior in P4-A. The first patch should be a pure
extraction with tests proving identical results.

### 5.4 Hermes Foundation Rules

Hermes work in this change is limited to:

```typescript
export interface HermesCapabilityMatrix {
  acp: "supported" | "unknown";
  gatewayMessaging: "supported" | "unknown";
  sessionStorage: "supported" | "unknown";
  backgroundDelegation: "supported" | "unknown";
  deliveryReceipts: "supported" | "unknown";
  runtimeFallbacks: "supported" | "unknown";
  notes: string[];
}
```

Expected initial matrix:

| Capability | Status | Why |
|------------|--------|-----|
| ACP | supported | Hermes exposes ACP over stdio. |
| Gateway messaging | supported | Hermes has a messaging gateway and many platform adapters. |
| Session storage | supported | Hermes documents SQLite-backed session storage. |
| Background delegation | unknown | Must be verified against Hermes delegate/background semantics before live use. |
| Delivery receipts | unknown | Messaging delivery exists, but receipt semantics need proof. |
| Runtime fallback | unknown | Provider/runtime fallback mapping must be verified separately. |

Do not add a live Hermes dependency, process launcher, config migration, or
runtime switch in this change. The only allowed runtime mode is:

```typescript
runtimeHostMode = "openclaw" | "hermes_dry_run";
```

`hermes_dry_run` may load the capability matrix and report unsupported live
execution. It must not spawn or deliver.

## 6. Phase 5: Deletion Closeout

### 6.1 Goal

P1-P4 are not complete if they only add safer paths. The final result must be
smaller. P5 removes code that no longer owns behavior.

### 6.2 Required Deletion Ledger

Every deletion patch must include a short ledger in implementation notes:

```text
Deletion Ledger
- Baseline command: node <loc-script> extensions/octoclaw-runtime/src
- Before runtime prod LOC: <number>
- After runtime prod LOC: <number>
- Removed files/branches:
  - <path or symbol> — replaced by <native truth / adapter / BDD id>
- Tests proving safe deletion:
  - <command>
- Retained large modules:
  - <path> — retained because <reason>
```

The current measured reference from 2026-05-17 was roughly:

```text
extensions/octoclaw-runtime production LOC: 45436
extensions/octoclaw-runtime test LOC: 35881
```

Do not make an exact LOC number a blocking product requirement; code can move.
But after P5, the runtime production line count should be materially lower, and
any major non-reduction must be explained.

### 6.3 Deletion Priority

Delete in this order:

1. New-task text/transcript/session-label heuristics already blocked by P1.
2. ACP backend-unavailable self-managed retry branches replaced by P2.
3. Delivery compensation branches replaced by P3 native success audit-only mode.
4. OpenClaw concrete call-site duplication replaced by P4 adapter.
5. Transitional flags whose observe/enforce rollout is complete.
6. Stale docs/tests that describe removed live paths.

Keep:

- WorkContract;
- route seal;
- replay/audit;
- explicit fallback delivery on native failed/missing/degraded;
- old-record read-only adapters with archive tests;
- smoke harnesses.

## 7. Implementation Sequence

### Slice A: Native Truth Gate

1. Add or complete `RuntimeTruthVerdict`.
2. Route status projection through it.
3. Add event when legacy fallback is used.
4. Add tests for native present, native missing, and old-record fallback.

### Slice B: New-Task Legacy Ban

1. Identify new task by presence of modern WorkContract/native fields or
   created-at after migration marker.
2. Prevent legacy heuristics from affecting dispatch/confirm/ACK/delivery for
   new tasks.
3. Keep legacy fallback for old status display only.

### Slice C: ACP Fallback Observe

1. Read native ACP fallback configuration/facts.
2. Add replay/status metadata.
3. Do not change execution behavior.

### Slice D: ACP Fallback Enforce

1. Behind flag, remove OctoClaw backend-unavailable retry from ACP paths.
2. Record native selected fallback runtime.
3. Verify no duplicate dispatch/final.

### Slice E: Delivery Relay Observe

1. Add `DeliveryRelayVerdict`.
2. Record native delivery success/failure and relay compensation reason.
3. Keep current relay behavior.

### Slice F: Delivery Relay Slim

1. Behind flag, bypass relay on proven native delivery success.
2. Keep fallback on native missing/failed/degraded.
3. Run Slack/Feishu smoke.

### Slice G: RuntimeAdapter Extraction

1. Add minimal adapter types.
2. Wrap current OpenClaw status/delivery/fallback read paths.
3. Move call sites to depend on adapter outputs.
4. Prove OpenClaw behavior is unchanged.

### Slice H: Hermes Foundation

1. Add Hermes capability matrix.
2. Add `hermes_dry_run` reporting only.
3. Prove `runtimeHostMode="openclaw"` imports no Hermes live dependency and
   behaves identically.

### Slice I: Deletion Closeout

1. Generate before LOC baseline.
2. Delete proven-dead legacy branches one category at a time.
3. Retire completed transitional flags.
4. Update docs/status/help text to match the surviving architecture.
5. Generate after LOC report and deletion ledger.

## 8. Regression Risks

| Risk | Mitigation |
|------|------------|
| Old replay/task-state loses display | Keep legacy-read-only adapters. |
| Native registry outage hides active task | Project degraded/lost, do not claim success. |
| ACP fallback creates two runs | Replay must prove one WorkContract and one accepted chain. |
| Native delivery has channel-specific bug | Keep relay compensation until smoke passes per channel. |
| AI deletes too much | Tasks require observe-only telemetry and BDD tests before deletion. |
| Adapter becomes a new framework | Allow only methods required by BDD and current call sites. |
| Hermes foundation changes live behavior | Keep Hermes dry-run only and assert OpenClaw mode does not import or call it. |
| LOC drops by moving code, not deleting complexity | Require deletion ledger with removed behavior and tests. |

## 9. Definition Of Done

The change is done when:

- all BDD scenarios are mapped to automated or documented manual tests;
- new tasks no longer depend on string/transcript heuristics for runtime truth;
- legacy fallback hit count is observable and zero for new-task smoke;
- ACP fallback observe mode records native fallback facts;
- ACP backend-unavailable enforcement has no double-dispatch regression;
- delivery relay bypass is enabled only for proven native delivery success;
- the remaining relay code is smaller and clearly separated into audit,
  fallback, and duplicate detection;
- OpenClaw runtime facts enter OctoClaw through a minimal adapter boundary;
- Hermes migration is prepared by capability mapping and dry-run reporting only;
- legacy branches replaced by native behavior are deleted and documented in a
  deletion ledger.
