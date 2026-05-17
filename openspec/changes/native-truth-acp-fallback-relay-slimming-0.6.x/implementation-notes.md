# Implementation Notes: Native Truth, ACP Fallback, and Relay Slimming

Date: 2026-05-17

## Deletion Ledger

### P5-A: LOC Baseline (pre-deletion)

Recorded 2026-05-17. This is the "before" snapshot for P5-B deletion closeout.

| Metric | Count |
|--------|-------|
| Production files | 178 |
| Production LOC | 45,666 |
| Test files | 117 |
| Test LOC | 37,113 |
| **Total files** | **295** |
| **Total LOC** | **82,779** |

### Files Modified by This Change (P1–P4)

| Phase | File | LOC | Change Summary |
|-------|------|-----|----------------|
| P2-C | `delegate/native-acp-fallback.ts` | 165 | Added `exposedFallbackRuntimeId` field; enforced `observe`/`delegate_backend_unavailable` mode gating |
| P3-B | `im/delivery-relay-verdict.ts` | 143 | Added `DeliveryPresentation` type; wired `deliveryRelayMode` flag into `shouldSendRelayCompensation`; rich delivery audit reasons |
| P3-C | `im/delivery-relay-verdict.ts` | 143→143 | Removed redundant delivery branches (sent/acknowledged/acked no longer treated as delivered); removed `recordDeliveryProjectionLegacyBoundary`, `nativeDeliveryStructured`, 2 dead imports |
| P3-C | `tools/runtime-task-projection.ts` | 745 | Fixed `hasDeliveryAck` to require `deliveryStatus==="delivered"` only; removed stale task-state-only delivery inference |
| P4-A | `runtime-host/types.ts` | 39 | New: `RuntimeHostId`, `RuntimeStatusSnapshot`, `RuntimeDeliverySnapshot`, `RuntimeFallbackSnapshot`, `HostRuntimeAdapter` |
| P4-A | `runtime-host/index.ts` | 11 | New: re-exports from types |
| P4-B | `runtime-host/openclaw-adapter.ts` | 112 | New: `createOpenClawRuntimeAdapter`, `normalizeNativeDeliveryToSnapshot` |
| P4-B | `runtime-host/openclaw-adapter.ts` | +12 | Added `adapterFallbackToNativeSnapshot` — reverse conversion for metadata builders |
| P4-B | `tools/handlers/dispatch.ts` | ~1511 | Replaced direct `readNativeAcpFallbackSnapshot()` with `createOpenClawRuntimeAdapter().readFallbacks()` + `adapterFallbackToNativeSnapshot()`. Removed `readNativeAcpFallbackSnapshot` import. |
| P4-B | `runtime-host/types.ts` | +27 | Extended status snapshot/ref with optional reversible projection fields; no new adapter methods. |
| P4-B | `runtime-host/openclaw-adapter.ts` | +52 | Added `statusSnapshotToNativeProjection()` and full status ref forwarding for status call-site migration. |
| P4-B | `tools/runtime-status.ts` | ~848 | Replaced direct `projectNativeStatus()` status-panel read with `createOpenClawRuntimeAdapter().readStatus()` + reversible projection conversion. |
| P4-B | `runtime-host/index.ts` | 10 | Added `adapterFallbackToNativeSnapshot`, `statusSnapshotToNativeProjection`, and `RuntimeStatusRef` to exports |
| P4-C | `runtime-host/hermes-capabilities.ts` | 57 | New: `HermesCapabilityMatrix`, `RuntimeHostMode`, `resolveRuntimeHostMode`, `hermesDryRunSpawn`, `hermesDryRunDeliver` |

### Retained Large Modules (≥100 LOC)

Threshold: all production `.ts` files with ≥100 lines in `extensions/octoclaw-runtime/src` that are within the OpenSpec change scope or adjacent to modified paths. Sorted by LOC descending.

#### Directly Modified / Created (retained with reason)

| File | LOC | Retained Reason |
|------|-----|-----------------|
| `tools/runtime-task-projection.ts` | 745 | Core projection engine. `hasDeliveryAck` tightened in P3-C; still needed for all task status/delivery projection. Not a deletion candidate. |
| `im/delivery-relay-verdict.ts` | 143 | Delivery relay verdict logic. Branch-removed in P3-C but still owns: audit-only mode, duplicate detection, fallback compensation on failure/missing/degraded. Not a deletion candidate. |
| `delegate/native-acp-fallback.ts` | 165 | ACP fallback enforcement. Added `exposedFallbackRuntimeId` in P2-C. Owns observe/enforce mode gating. Not a deletion candidate. |
| `runtime-host/openclaw-adapter.ts` | 112 | OpenClaw adapter created in P4-B. Wraps existing native status/delivery/fallback reads. Retained: foundation for future call-site migration. |
| `state/native-status-projector.ts` | 346 | Native status projection. Modified in P1 for native kind/runtime id. Core runtime truth source. Not a deletion candidate. |
| `runtime-host/hermes-capabilities.ts` | 57 | Hermes dry-run capability matrix created in P4-C. Reporting-only module. Retained for future Hermes integration. |

#### Adjacent Modules in Delivery/Status/Runtime Path (retained, not modified)

| File | LOC | Retained Reason |
|------|-----|-----------------|
| `tools/handlers/dispatch.ts` | 1,511 | Main dispatch handler. Calls into delivery relay and ACP fallback. Deferred call-site migration target for P4-B adapter consumption. Not a deletion candidate. |
| `tools/runtime-status.ts` | 848 | Runtime status tool. Consumes `projectNativeStatus`. Not modified by this change. |
| `delegate/native-spawn-confirm.ts` | 712 | Spawn confirmation flow. Adjacent to spawn/child-session truth but outside ACP fallback scope. Not a deletion candidate. |
| `resolve/native-announce.ts` | 432 | Native announcement sender. Deferred call-site migration target for P4-B adapter consumption. |
| `resolve/native-announce-delivery.ts` | 267 | Delivery path for native announcements. Adjacent to delivery relay verdict but owns the actual send path. |
| `resolve/native-announce-state.ts` | 226 | State management for native announcements. |
| `state/legacy-heuristics.ts` | 69 | Legacy heuristics catalog created in P1-B. Marked read-only boundary. Retained: needed for old-record display. P5-B deletion candidate. |

#### Other Large Production Modules (outside OpenSpec scope)

The following modules are ≥100 LOC but are outside the native-truth/ACP/delivery-relay/runtime-host scope. Retained with no changes expected from this OpenSpec change.
The `Category` column is the retention reason for this baseline: these modules belong to product surfaces outside the deletion closeout scope.

| File | LOC | Category |
|------|-----|----------|
| `resolve/policy-resolver.ts` | 1,871 | Policy resolution |
| `tools/registration.ts` | 1,460 | Tool registration |
| `ack/ack-guard.ts` | 1,330 | Ack guard |
| `router-onboarding.ts` | 1,157 | Router onboarding |
| `budgeted-main.ts` | 1,090 | Budgeted main loop |
| `resolve/session.ts` | 1,065 | Session resolution |
| `conversation-grounding.ts` | 1,062 | Conversation grounding |
| `extension-entry.ts` | 912 | Extension entry |
| `hooks/before-tool-call.ts` | 873 | Hook |
| `im/slack/slack-adapter.ts` | 854 | Slack adapter |
| `delegate/native-spawn-intent-store.ts` | 684 | Spawn intent storage |
| `runtime-payloads.ts` | 698 | Runtime payloads |
| `state/policy-state.ts` | 672 | Policy state |
| `hooks/before-prompt-build.ts` | 594 | Hook |
| `ack/ack-route-commit.ts` | 544 | Ack route commit |
| `adapter/taskflow-bridge.ts` | 536 | TaskFlow bridge |
| `state/task-state-store.ts` | 477 | Task state store |
| `resolve/policy-routing-helpers.ts` | 476 | Policy routing |
| `adapter/runtime-taskflow.ts` | 466 | Runtime TaskFlow |
| `ack/execution-transition-notifier.ts` | 464 | Execution transition |
| `tools/planner-context.ts` | 439 | Planner context |
| `resolve/runtime-recovery.ts` | 433 | Runtime recovery |
| `resolve/judge-context-packet.ts` | 411 | Judge context |
| `resolve/llm-judge.ts` | 403 | LLM judge |
| `core/workflow/index.ts` | 395 | Workflow |
| `runtime-ledger/projection-rebuild.ts` | 389 | Ledger projection |
| `hooks/footer-mode.ts` | 375 | Footer mode |
| `runtime-ledger/ticket-enforcement.ts` | 366 | Ticket enforcement |
| `ack/ack-burst.ts` | 363 | Ack burst |
| `receipt.ts` | 356 | Receipts |
| `work-contract/store.ts` | 354 | WorkContract store |
| `im/slack/wizard/flow.ts` | 343 | Slack wizard |
| `adapter/native-helper.ts` | 341 | Native helper |
| `runtime-ledger/shadow.ts` | 337 | Ledger shadow |
| `ack/ack-watchdog.ts` | 331 | Ack watchdog |
| `replay/replay.ts` | 328 | Replay |
| `im/feishu/feishu-adapter.ts` | 324 | Feishu adapter |
| `fast-delegate/draft.ts` | 322 | Fast delegate draft |
| `hooks/message-lifecycle.ts` | 303 | Message lifecycle |
| `resolve/execution-coverage-precheck.ts` | 300 | Execution coverage |
| `resolve/outbound-guards.ts` | 295 | Outbound guards |
| `replay/policy-utils.ts` | 293 | Replay policy |
| `im-status-renderer.ts` | 288 | IM status renderer |
| `work-contract/native-taskflow-adapter.ts` | 287 | Native TaskFlow adapter |
| `runtime-ledger/index.ts` | 280 | Ledger index |
| `runtime-ledger/lifecycle-reconciler.ts` | 280 | Lifecycle reconciler |
| `resolve/env.ts` | 277 | Environment resolution |
| `tools/dispatch-logic.ts` | 275 | Dispatch logic |
| `fast-delegate/probe.ts` | 269 | Fast delegate probe |
| `state/task-state-retention.ts` | 268 | Task state retention |
| `resolve/native-announce-delivery.ts` | 267 | Native announce delivery |
| `runtime-ledger/native-reconcile.ts` | 267 | Native reconcile |
| `ack/ack-timing.ts` | 266 | Ack timing |
| `work-contract/continuity.ts` | 263 | WorkContract continuity |
| `router-lite/shadow-bridge.ts` | 250 | Router lite shadow |
| `core/delegate/index.ts` | 244 | Delegate core |
| `runtime-ledger/ticket-dry-run.ts` | 239 | Ticket dry run |
| `ack/ack-delegate-without-dispatch.ts` | 233 | Ack without dispatch |
| `resolve/native-announce-state.ts` | 226 | Native announce state |
| `im/discord/discord-adapter.ts` | 225 | Discord adapter |
| `core/telemetry/index.ts` | 221 | Telemetry |
| `work-contract/materializer.ts` | 220 | WorkContract materializer |
| `hooks/agent-end.ts` | 215 | Agent end hook |
| `ports/openclaw-dist-taskflow-port.ts` | 207 | OpenClaw port |
| `im/slack-thread-anchor.ts` | 202 | Slack thread anchor |
| `im/telegram/telegram-adapter.ts` | 200 | Telegram adapter |
| `adapter/webhook-surface.ts` | 194 | Webhook surface |
| `dispatch-admission.ts` | 192 | Dispatch admission |
| `ack/ack-dedupe.ts` | 191 | Ack dedupe |
| `resolve/native-announce-parse.ts` | 186 | Native announce parse |
| `extension-entry-helpers.ts` | 181 | Extension entry helpers |
| `router-cost-runtime.ts` | 181 | Router cost runtime |
| `ack/ack-decision.ts` | 174 | Ack decision |
| `model-map.ts` | 173 | Model map |
| `plugin.ts` | 173 | Plugin |
| `delegate/native-spawn-intent.ts` | 170 | Spawn intent |
| `tools/registration-helpers.ts` | 169 | Registration helpers |
| `delegate/speculative-preload.ts` | 168 | Speculative preload |
| `replay/message-guard.ts` | 167 | Message guard |
| `context/delegate-packets.ts` | 166 | Delegate packets |
| `resolve/route-seal.ts` | 164 | Route seal |
| `runtime-ledger/tmux-evidence.ts` | 164 | Tmux evidence |
| `im/wechat/wechat-adapter.ts` | 163 | WeChat adapter |
| `delegate/native-spawn-gate.ts` | 162 | Spawn gate |
| `im/index.ts` | 162 | IM index |
| `core/im/adapter.ts` | 156 | IM adapter core |
| `context/context-budget.ts` | 155 | Context budget |
| `ports/openclaw-runtime-task-port.ts` | 154 | OpenClaw runtime task port |
| `hooks/after-prompt-build.ts` | 153 | After prompt build |
| `inbound-timestamps.ts` | 153 | Inbound timestamps |
| `core/tasks/index.ts` | 151 | Tasks core |
| `ports/taskflow-port.ts` | 151 | TaskFlow port |
| `router-lite/request-builder.ts` | 149 | Router lite request builder |
| `util/type-coercion.ts` | 143 | Type coercion |
| `ack/ack-state.ts` | 142 | Ack state |
| `hooks/speculative-preload-handler.ts` | 142 | Speculative preload handler |
| `im/slack/wizard/messages.ts` | 140 | Slack wizard messages |
| `bridge.ts` | 138 | Bridge |
| `router-lite/health-recorder.ts` | 138 | Router health recorder |
| `runtime-ledger/shadow-diff.ts` | 135 | Shadow diff |
| `artifacts/delegate-artifacts.ts` | 131 | Delegate artifacts |
| `resolve/outbound-reply-dispatch.ts` | 131 | Outbound reply dispatch |
| `core/delivery/protocol.ts` | 126 | Delivery protocol |
| `hooks/after-tool-call.ts` | 123 | After tool call |
| `work-contract/builders.ts` | 122 | WorkContract builders |
| `resolve/route-helpers.ts` | 119 | Route helpers |
| `hooks/before-model-resolve.ts` | 111 | Before model resolve |
| `core/recovery/index.ts` | 110 | Recovery core |
| `runtime-ledger/operator-diagnostics.ts` | 108 | Operator diagnostics |
| `core/requests/index.ts` | 101 | Requests core |

### Deletion Candidates (P5-B)

The following are identified for potential deletion in P5-B, pending BDD evidence:

1. **`state/legacy-heuristics.ts`** (69 LOC) — Legacy heuristic catalog, marked read-only in P1-B. Deletion candidate when all consumers confirmed migrated.
2. **Stale delivery inference branches** — Already removed from `delivery-relay-verdict.ts` in P3-C. Any remaining callers in `runtime-task-projection.ts` that used `hasDeliveryAck` with sent/acknowledged/acked should be verified clean.
3. **`recordDeliveryProjectionLegacyBoundary`** — Already removed in P3-C. No remaining callers.
4. **Pass-through wrappers** — To be identified in P5-B audit.

### Phase Acceptance Summary

| Phase | Status | Tests | Evidence |
|-------|--------|-------|----------|
| P2-C | ✓ Complete | 49 pass + 1 skip | All enforcement pre-existed; tasks.md updated |
| P3-B | ✓ Complete | 50 pass | `deliveryRelayMode` wired; `DeliveryPresentation` added |
| P3-C | ✓ Complete | 70 pass | Redundant branches removed; `hasDeliveryAck` tightened |
| P4-A | ✓ Complete | 18 pass | Minimal type boundary; no live behavior changes |
| P4-B | Partial (fallback + status panel migrated) | adapter/status/projector 38 pass, runtime check pass; previous planner 32 pass +1 skip, fallback 17 pass | Adapter wrapper created; fallback call site in dispatch.ts and status panel in runtime-status.ts migrated. Relay/delivery call sites remain pending. |
| P4-C | ✓ Complete | 44 pass | Hermes dry-run foundation; fail-closed spawn/deliver |
| P5-A | ✓ This ledger | LOC baseline recorded | See tables above |
| P5-B | Pending | — | — |
| P5-C | Pending | — | — |
