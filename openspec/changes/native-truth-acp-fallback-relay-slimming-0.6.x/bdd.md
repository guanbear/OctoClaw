# BDD: Native Truth, ACP Fallback, and Relay Slimming

Date: 2026-05-17

## Naming

- `NTR-P1-*`: native truth and legacy heuristic isolation
- `NTR-P2-*`: ACP fallback observe/enforce
- `NTR-P3-*`: delivery relay slimming

All scenarios are written so another AI can implement tests directly. Prefer
automated Vitest tests. Mark live Slack/Feishu tests as smoke only when real
credentials are required, and provide a mock equivalent.

---

## NTR-P1: Native Session Truth

### NTR-P1-001: Native spawn-child is child truth

**Given** an OpenClaw native run record:

```json
{
  "runId": "run-1",
  "status": "running",
  "kind": "spawn-child",
  "agentRuntime": { "id": "acpx" },
  "childSessionKey": "child-session-1"
}
```

**When** `projectNativeStatus({ openclawRunId: "run-1" })` resolves the record

**Then** the projection contains:

```json
{
  "status": "running",
  "nativeKind": "spawn-child",
  "agentRuntimeId": "acpx",
  "childSessionKey": "child-session-1",
  "found": true,
  "degraded": false
}
```

**And** downstream runtime status view sets:

```json
{
  "nativeKind": "spawn-child",
  "agentRuntimeId": "acpx"
}
```

### NTR-P1-002: Native direct is not overridden by legacy child inference

**Given** a native record:

```json
{
  "runId": "run-direct-1",
  "status": "completed",
  "kind": "direct",
  "agentRuntime": { "id": "acpx" },
  "summary": "done"
}
```

**And** the session key contains a misleading substring:

```text
agent:main:slack:channel:C123:subagent-old-label
```

**When** runtime status projection runs

**Then** OctoClaw must not classify this as a spawn child

**And** no `spawn_started` transition may be emitted from the substring alone

**And** if a legacy fallback event is emitted, it must include:

```json
{
  "readOnly": true,
  "allowed": false,
  "reason": "native_kind_present"
}
```

### NTR-P1-003: Native registry missing with known native id is degraded/lost

**Given** a task has `openclawRunId = "run-missing-1"`

**And** OpenClaw runtime registry lookup returns no run

**When** OctoClaw projects runtime status

**Then** status is `lost` or `degraded`

**And** OctoClaw must not claim the task is running or completed from cache

**And** status reason is one of:

```text
native_id_known_but_registry_missing
native_registry_lookup_failed
native_registry_unavailable
```

### NTR-P1-004: Native registry unavailable may display cache but marks degraded

**Given** a task has:

```json
{
  "openclawRunId": "run-unavailable-1",
  "cache": { "status": "running", "summary": "cached running" }
}
```

**And** the native registry API is unavailable

**When** status projection runs

**Then** displayed status is `degraded`

**And** `rawStatus = "native_registry_unavailable"`

**And** summary may include the cached summary

**But** OctoClaw must not emit `spawn_started` from cache alone

### NTR-P1-005: Legacy heuristic is read-only for old records

**Given** an old task-state record has no `nativeKind`, no `agentRuntimeId`, and
no native run id

**And** it has legacy child session fields from an older OctoClaw version

**When** status panel renders the old record

**Then** the panel may display a legacy child reference

**And** the projection source is marked `legacy_read_only`

**And** an event is emitted:

```json
{
  "event": "legacy_heuristic_fallback_used",
  "surface": "status_projection",
  "newTask": false,
  "readOnly": true
}
```

### NTR-P1-006: Legacy heuristic is blocked for new dispatch admission

**Given** a new WorkContract lacks native accepted spawn evidence

**And** a transcript contains text:

```text
I called sessions_spawn and delegated this task.
```

**When** dispatch confirm or started ACK logic runs

**Then** OctoClaw must not set `spawnExecuted = true`

**And** it must not send "task started" or "delegated" ACK

**And** the decision reason includes `no_native_spawn_evidence`

### NTR-P1-007: Legacy heuristic hit count is observable

**Given** status projection uses any legacy fallback

**When** replay/audit events are inspected

**Then** each fallback hit contains:

```json
{
  "event": "legacy_heuristic_fallback_used",
  "surface": "<surface>",
  "reason": "<reason>",
  "newTask": true,
  "readOnly": true
}
```

**And** new-task fallback hits are countable by nightly/report tooling

### NTR-P1-008: New-task smoke has zero legacy runtime fallback hits

**Given** a smoke run creates a new delegated task on OpenClaw >= 2026.5.12

**When** the task completes

**Then** replay contains no `legacy_heuristic_fallback_used` event with:

```json
{ "newTask": true, "allowed": true }
```

**And** status projection contains native fields.

### NTR-P1-009: Assistant text cannot prove delivery

**Given** assistant output says:

```text
I sent the final answer to Slack.
```

**But** native delivery status is missing

**When** delivery/status projection runs

**Then** OctoClaw must not mark final as delivered

**And** it must show `pending`, `degraded`, or fallback-delivery state

### NTR-P1-010: Transcript completion cannot prove result materialization

**Given** child transcript contains:

```text
RESULT: done
```

**But** WorkContract has no result receipt and native final is missing

**When** result materialization projection runs for a new task

**Then** OctoClaw must not mark `resultMaterialized = true`

**And** it must record `transcript_result_ignored_without_native_or_receipt`

---

## NTR-P2: ACP Fallback

### NTR-P2-001: Native ACP fallback snapshot is read-only

**Given** OpenClaw config contains:

```json
{
  "acp": {
    "fallbacks": ["acpx", "codex-native"]
  }
}
```

**When** OctoClaw loads native ACP fallback snapshot

**Then** it returns:

```json
{
  "status": "ok",
  "fallbackRuntimeIds": ["acpx", "codex-native"],
  "source": "openclaw_config"
}
```

**And** no OpenClaw config file is modified

### NTR-P2-002: ACP fallback unavailable is explicit

**Given** OpenClaw does not expose ACP fallback config

**When** OctoClaw loads native ACP fallback snapshot

**Then** it returns:

```json
{
  "status": "unavailable",
  "source": "none",
  "reason": "native_acp_fallback_unavailable"
}
```

**And** dispatch behavior is unchanged

### NTR-P2-003: Observe mode records fallback metadata without behavior change

**Given** `nativeAcpFallbackMode = "observe"`

**When** a delegated ACP task is dispatched

**Then** replay includes `native_acp_fallback.mode = "observe"`

**And** OctoClaw does not alter backend selection

**And** existing dispatch tests still pass

### NTR-P2-004: Backend unavailable before output is native fallback eligible

**Given** primary ACP runtime fails before emitting output

**When** fallback classification runs

**Then** reason is `backend_unavailable_before_output`

**And** it is eligible for OpenClaw ACP fallback

### NTR-P2-005: Backend unavailable after output is not clean failover

**Given** primary ACP runtime emits partial output

**And** then fails

**When** fallback classification runs

**Then** reason is `backend_unavailable_after_output`

**And** OctoClaw must not silently switch runtime

**And** status must be degraded or failed according to result evidence

### NTR-P2-006: Task timeout remains OctoClaw recovery

**Given** the worker starts and exceeds timeout

**When** watchdog/recovery runs

**Then** fallback reason is `task_timeout`

**And** OpenClaw ACP fallback is not used as backend failover

**And** OctoClaw recovery/retry policy remains responsible

### NTR-P2-007: Enforce mode does not create duplicate task

**Given** `nativeAcpFallbackMode = "delegate_backend_unavailable"`

**And** primary ACP runtime fails before output

**When** OpenClaw native ACP fallback selects a fallback runtime

**Then** OctoClaw keeps one WorkContract id

**And** no second OctoClaw task id is created

**And** replay records the selected fallback runtime

### NTR-P2-008: Enforce mode does not produce duplicate final

**Given** ACP fallback occurs before output

**When** fallback runtime completes successfully

**Then** user receives one final answer

**And** duplicate-final detector reports zero duplicates

### NTR-P2-009: Output-started primary failure is not rerouted

**Given** primary ACP runtime has already emitted visible output

**When** it fails

**Then** OpenClaw ACP fallback is not treated as clean runtime replacement

**And** OctoClaw reports failure/degraded state with evidence

---

## NTR-P3: Delivery Relay Slimming

### NTR-P3-001: Native delivery success creates audit-only verdict

**Given** native delivery result is:

```json
{
  "status": "delivered",
  "messageId": "1778573724.032469"
}
```

**When** delivery relay verdict runs

**Then** it returns:

```json
{
  "nativeDelivered": true,
  "relayCompensationNeeded": false,
  "source": "native_delivery",
  "reason": "native_delivery_success"
}
```

### NTR-P3-002: Native delivery failure still compensates

**Given** native delivery failed with `channel_not_found` or equivalent error

**When** delivery relay verdict runs

**Then** `relayCompensationNeeded = true`

**And** reason includes native failure details

### NTR-P3-003: Native delivery missing with native result compensates after timeout

**Given** native child result exists

**And** native delivery status is missing after configured timeout

**When** delivery relay verdict runs

**Then** `relayCompensationNeeded = true`

**And** reason is `native_delivery_missing_after_timeout`

### NTR-P3-004: Native success audit-only mode does not resend

**Given** `deliveryRelayMode = "native_success_audit_only"`

**And** native delivery success is proven

**When** OctoClaw relay runs

**Then** it writes audit event

**And** it does not call channel send again

### NTR-P3-005: Message-tool-only reply is not compensated when native visible

**Given** native delivery reports visible message-tool-only reply delivered

**When** relay compensation logic runs

**Then** compensation is skipped

**And** duplicate final count remains zero

### NTR-P3-006: Card/button-only reply is not compensated when native visible

**Given** native delivery reports rich/card/button-only reply delivered

**When** relay compensation logic runs

**Then** compensation is skipped

**And** the audit event records `rich_native_delivery_success`

### NTR-P3-007: Native degraded delivery still uses fallback

**Given** native delivery status is `degraded`

**When** relay logic runs

**Then** OctoClaw fallback delivery is allowed

**And** final status explains both native degraded and fallback result

### NTR-P3-008: Duplicate native final suppresses relay

**Given** native delivery already produced a final message id

**And** relay compensation is about to send identical result hash

**When** duplicate detector runs

**Then** relay send is suppressed

**And** audit records `duplicate_final_suppressed`

### NTR-P3-009: Slack and Feishu smoke cover native delivery trust

**Given** live or mock Slack/Feishu adapter tests cover:

- plain text final;
- delegated final;
- message-tool-only final;
- rich/card/button-only final;
- native failure;
- native missing after timeout.

**When** smoke completes

**Then** native success cases have no OctoClaw compensation send

**And** failure/missing cases still compensate

**And** no duplicate final is observed

---

## Minimum Test File Map

```text
extensions/octoclaw-runtime/src/state/native-status-projector.test.ts
extensions/octoclaw-runtime/src/tools/runtime-task-projection.test.ts
extensions/octoclaw-runtime/src/tools/runtime-status.test.ts
extensions/octoclaw-runtime/src/delegate/native-spawn-gate*.test.ts
extensions/octoclaw-runtime/src/delegate/native-spawn-confirm*.test.ts
extensions/octoclaw-runtime/src/replay/message-guard*.test.ts
extensions/octoclaw-runtime/src/im/slack/*.test.ts
extensions/octoclaw-runtime/src/im/feishu/*.test.ts
tools/octoclawctl/src/slack-acceptance/*.test.ts
tools/octoclawctl/src/nightly/*.test.ts
```

## Scenario-To-Task Mapping

| Scenario | Task |
|----------|------|
| NTR-P1-001..004 | P1-A |
| NTR-P1-005..008 | P1-B |
| NTR-P1-009..010 | P1-C |
| NTR-P2-001..003 | P2-A |
| NTR-P2-004..006 | P2-B |
| NTR-P2-007..009 | P2-C |
| NTR-P3-001..003 | P3-A |
| NTR-P3-004..007 | P3-B |
| NTR-P3-008..009 | P3-C |
