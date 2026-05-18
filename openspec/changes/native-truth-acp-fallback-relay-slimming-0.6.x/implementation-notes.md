# Implementation Notes: Native Truth, ACP Fallback, and Relay Slimming

Date: 2026-05-17

## Phase 0 Evidence

- OpenClaw version: `OpenClaw 2026.5.12 (f066dd2)`.
- GitNexus refresh: `npx gitnexus analyze` completed, 18,425 nodes / 25,975 edges / 597 clusters / 300 flows.
- Dirty worktree before this P5-C slice: branch `v0.5.0` ahead of origin by 1, untracked `docs/superpowers/`, untracked `extensions/octoclaw-runtime/src/runtime-host/p5-slimming-guard.test.ts`.
- Impact analysis for edited runtime symbols:
  - `deliveryRelayVerdict`: GitNexus target not found after refresh; impactedCount 0; risk UNKNOWN. Manual `rg` shows production callers only in `resolve/native-announce.ts`, covered by outbound guard tests.
  - `normalizeNativeDeliveryToSnapshot`: GitNexus target not found after refresh; impactedCount 0; risk UNKNOWN. No implementation change in this slice.
  - `readRuntimeFile`: test helper only; GitNexus target not found; impactedCount 0; risk UNKNOWN.

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
| P3-B | `im/delivery-relay-verdict.ts` | 143 | Added `DeliveryPresentation` type; temporarily wired `deliveryRelayMode` flag into relay compensation decisions; rich delivery audit reasons |
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
| P4-B | `im/delivery-relay-verdict.ts` | ~143 | Delivery verdict now consumes `RuntimeDeliverySnapshot` shape directly while preserving native delivered/failed/degraded semantics. |
| P4-B | `resolve/native-announce.ts` | ~432 | Native announce delivery attempts now normalize through `normalizeNativeDeliveryToSnapshot()` before relay verdict/audit. |
| P4-B | `runtime-host/index.ts` | 10 | Added `adapterFallbackToNativeSnapshot`, `statusSnapshotToNativeProjection`, and `RuntimeStatusRef` to exports |
| P4-C | `runtime-host/hermes-capabilities.ts` | 57 | New: `HermesCapabilityMatrix`, `RuntimeHostMode`, `resolveRuntimeHostMode`, `hermesDryRunSpawn`, `hermesDryRunDeliver` |
| P5-C | `im/delivery-relay-verdict.ts` | 143→123 | Retired transitional `deliveryRelayMode` live switch, removed `OCTOCLAW_DELIVERY_RELAY_MODE`, `DeliveryRelayMode`, `resolveDeliveryRelayMode()`, and `shouldSendRelayCompensation()` |
| P5-B | `im/delivery-relay-verdict.ts` | 123→120 | Removed remaining presentation-specific native success branch; rich/message-tool delivered replies now use the same native delivery success verdict as plain replies |
| P5-B | `tools/runtime-task-projection.ts` | ~745 | Removed `childSessionKey`-only spawn inference; spawn evidence now requires explicit spawn signal, run id, child session id, or a native flow + child-session binding with no explicit spawn=false |
| P5-B | `resolve/session.ts` | ~1065 | Removed session-label substring matches from child-session truth return value; OpenClaw native child ids remain accepted |
| P5-B/P5-C | `runtime-host/p5-slimming-guard.test.ts` | New | Added guard coverage for adapter-only native reads, retired relay switches, and user-facing docs |

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
| `tools/runtime-status.ts` | 848 | Runtime status tool. P4-B migrated status panel native reads through the RuntimeAdapter; still retained as the status rendering surface. |
| `delegate/native-spawn-confirm.ts` | 712 | Spawn confirmation flow. Adjacent to spawn/child-session truth but outside ACP fallback scope. Not a deletion candidate. |
| `resolve/native-announce.ts` | 432 | Native announcement sender. P4-B migrated relay verdict input to consume normalized RuntimeAdapter delivery snapshots; retained for delivery/audit orchestration. |
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

### P5-B Deletion Closeout

Deleted or closed in this slice:

1. **New-task session-label runtime truth** — `isSubagentSessionRef()` no
   longer returns true from a text/label substring. It still accepts native
   child facts (`nativeKind="spawn-child"`) and OpenClaw native child ids.
   Covered by `legacy-heuristics.test.ts` and P5 static guard.
2. **Child-session-key-only spawn inference** — `runtimeStatusEvidence()` no
   longer treats a stale `childSessionKey` as spawn evidence without explicit
   spawn truth, `runId`, child session id, or a native flow + child-session
   binding with no explicit `spawnExecuted=false`. Covered by
   `runtime-task-projection.test.ts` and
   `registration-dispatch-honesty.test.ts`.
3. **Delivery presentation special branches** — rich/message-tool native
   delivery success uses the same single native delivery success branch as
   plain text. Failure/missing/degraded compensation remains. Covered by
   `delivery-relay-verdict.test.ts` and P5 static guard.
4. **ACP self-managed backend retry branch** — no live dispatch retry/outbox/
   finalizer branch remains for backend-unavailable failover. Enforce mode
   records native ACP fallback metadata and delegates only
   `backend_unavailable_before_output`. Covered by
   `registration-planner.test.ts` and P5 static guard.
5. **OpenClaw duplicate direct reads** — status/fallback live call sites stay
   behind `createOpenClawRuntimeAdapter()`. Covered by P5 static guard.
6. **Pass-through wrapper audit** — no wrapper that merely passes through data
   remains as a P5-B deletion target. The retained adapter conversion helpers
   normalize status/source and preserve native metadata compatibility; removing
   them would force unrelated status/dispatch rewrites rather than delete dead
   behavior.

Current LOC snapshot after P5-B: production 45,774 LOC across 178 files; tests
37,579 LOC across 118 files.

### Hard Deletion Follow-Up

Baseline for this follow-up is the P5-A production LOC snapshot: 45,666.

#### HD-1B: Structured Delivery Outbox/Protocol

- Removed:
  - `core/delivery/outbox.ts`
  - `core/delivery/protocol.ts`
  - matching tests
- Replacement: native delivery/announce is the live delivery path; replay keeps
  audit metadata without the old structured outbox payload chain.
- Guard/BDD: `NTR-P5-001`, `NTR-P5-004`.

#### HD-2: Ledger Rebuild And Crash-Recovery Tail

- Removed:
  - `runtime-ledger/projection-rebuild.ts`
  - `runtime-ledger/crash-recovery.ts`
  - `runtime-ledger/operator-diagnostics.ts`
  - matching tests
  - `octoclaw_crash_recovery` tool registration
  - `OCTOCLAW_TASK_STATE_REBUILD` flag and startup rebuild side effect
- Replacement: runtime status reads task-state/native adapter facts directly;
  watchdog startup no longer rewrites task-state before status projection.
- Guard/BDD: `NTR-P5-001`, static guard in
  `runtime-host/p5-slimming-guard.test.ts`.
- LOC after HD-2: production 44,658.
- Verification:
  - `pnpm vitest run extensions/octoclaw-runtime/src/tools/runtime-status.test.ts extensions/octoclaw-runtime/src/ack/__tests__/watchdog-startup-reconcile.test.ts extensions/octoclaw-runtime/src/tools/registration-planner.test.ts extensions/octoclaw-runtime/src/runtime-host/p5-slimming-guard.test.ts extensions/octoclaw-runtime/src/runtime-ledger/runtime-ledger-hot-path.test.ts extensions/octoclaw-runtime/src/runtime-ledger/__tests__/feature-flags.test.ts`
  - `pnpm check`

#### HD-3: Unused Experimental Adapter Layers

- Removed:
  - `fast-delegate/draft.ts`
  - `fast-delegate/probe.ts`
  - `work-contract/native-taskflow-adapter.ts`
  - `ports/openclaw-runtime-taskflow-port.ts`
  - `core/im/adapter.ts`
  - matching tests for those removed modules
- Replacement: live dispatch uses `ports/openclaw-dist-taskflow-port.ts` and
  the host runtime adapter introduced in P4; the removed modules had no live
  import outside their own tests and the stale api.runtime.taskFlow port test.
- Guard/BDD: `NTR-P5-001` static absent-file guard in
  `runtime-host/p5-slimming-guard.test.ts`; live TaskFlow port behavior remains
  covered by `ports/taskflow-port.test.ts`.
- LOC after HD-3: production 43,475; tests 35,494.
- Delta: HD-3 removed 1,183 production LOC and 873 test LOC. Hard deletion
  follow-up total vs P5-A is now -2,191 production LOC.
- Verification:
  - Red first: `pnpm vitest run extensions/octoclaw-runtime/src/runtime-host/p5-slimming-guard.test.ts` failed on the 9 expected HD-3 files.
  - Green after deletion: `pnpm vitest run extensions/octoclaw-runtime/src/runtime-host/p5-slimming-guard.test.ts extensions/octoclaw-runtime/src/ports/taskflow-port.test.ts` passed, 26 tests.

#### HD-4 Through HD-7: Runtime Ledger Tails, Surfaces, Runtime-Core Compatibility

- Removed:
  - `runtime-ledger/shadow-diff.ts`
  - `runtime-ledger/native-reconcile.ts`
  - matching runtime-ledger diagnostic tests
  - `adapter/webhook-surface.ts`
  - `plugin.ts`
  - `adapter/runtime-taskflow.ts`
  - `core/workflow/*`
  - `core/tasks/*`
  - `core/requests/*`
  - `core/telemetry/*`
  - `core/recovery/*`
  - `core/delegate/*`
  - `core/ack/*`
  - orphaned `core/workflow/index.test.mjs`
- Retained with reason:
  - `runtime-ledger/shadow.ts`: still stores compact shadow metadata used by
    ticket/ledger tests.
  - `runtime-ledger/ticket-*`: still protects WorkContract admission and route
    seal semantics.
  - `adapter/state-surface.ts`: still required by `@octoclaw/status-surface`
    as a lightweight compatibility type/helper module; it no longer depends on
    the deleted runtime-taskflow adapter.
  - `runtime-payloads.ts`: now directly uses the native helper for
    `create-managed-flow` and `run-task`; it preserves WorkContract-compatible
    payload fields without the deleted workflow/plugin layer.
- Replacement: native TaskFlow/helper calls and host runtime adapter now own
  execution/status truth. WorkContract remains semantic/delegation truth.
  Replay/audit remains, but the removed modules no longer own runtime truth.
- Guard/BDD: `NTR-P5-001` through `NTR-P5-006`, plus hard-deletion guards in
  `runtime-host/p5-slimming-guard.test.ts`.
- LOC after HD-7: production 40,368; tests 32,804.
- Delta vs P5-A baseline: production -5,298 LOC; tests -4,309 LOC.
- Verification:
  - `pnpm vitest run extensions/octoclaw-runtime/src/resolve/policy-resolver-judge-fallback.test.ts extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts extensions/octoclaw-runtime/src/replay/turn-execution-receipt.test.ts extensions/octoclaw-runtime/src/runtime-payloads.test.ts`: 4 files, 127 tests pass.
  - `pnpm vitest run extensions/octoclaw-runtime/src/runtime-host/p5-slimming-guard.test.ts extensions/octoclaw-runtime/src/runtime-payloads.test.ts extensions/octoclaw-runtime/src/tools/registration-planner.test.ts extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts extensions/octoclaw-runtime/src/tools/runtime-status.test.ts extensions/octoclaw-runtime/src/tools/runtime-task-projection.test.ts extensions/octoclaw-runtime/src/resolve/policy-resolver-judge-fallback.test.ts extensions/octoclaw-status-surface/src/read-model/index.test.ts extensions/octoclaw-status-surface/src/view-model/index.test.ts extensions/octoclaw-status-surface/src/actions/index.test.ts`: 10 files, 225 tests pass, 1 skipped.
  - `pnpm check`: pass.
  - `git diff --check`: pass.

### Phase Acceptance Summary

| Phase | Status | Tests | Evidence |
|-------|--------|-------|----------|
| P2-C | ✓ Complete | 49 pass + 1 skip | All enforcement pre-existed; tasks.md updated |
| P3-B | ✓ Complete | 50 pass | `deliveryRelayMode` temporarily wired; `DeliveryPresentation` added |
| P3-C | ✓ Complete | 70 pass | Redundant branches removed; `hasDeliveryAck` tightened |
| P4-A | ✓ Complete | 18 pass | Minimal type boundary; no live behavior changes |
| P4-B | ✓ Complete | adapter/status/projector 38 pass; delivery/adapter/native-announce 75 pass; runtime check pass; previous planner 32 pass +1 skip, fallback 17 pass | Adapter wrapper created; fallback call site in dispatch.ts, status panel in runtime-status.ts, and native announce relay verdict input migrated to adapter snapshots. |
| P4-C | ✓ Complete | 44 pass | Hermes dry-run foundation; fail-closed spawn/deliver |
| P5-A | ✓ This ledger | LOC baseline recorded | See tables above |
| P5-B | ✓ Complete | focused P5-B suite 149 pass + 1 skip | Deleted remaining new-task session-label/childSessionKey runtime truth and presentation-specific delivery branches; adapter-only native reads and native ACP fallback coverage guarded. Old-record display compatibility readers remain read-only by design. |
| P5-C + hard deletion follow-up | ✓ Complete | p5 guard + runtime/status regression 225 pass + 1 skip; runtime check pass | Retired delivery relay transitional flag/helper and deleted runtime-core compatibility tails. Current LOC snapshot after HD-7: production 40,368 LOC; tests 32,803 LOC. |

### P5-B/P5-C Verification Before Hard Deletion Follow-Up (2026-05-18)

- `git diff --check`: pass.
- P5-B red check before implementation:
  `pnpm vitest run extensions/octoclaw-runtime/src/tools/runtime-task-projection.test.ts extensions/octoclaw-runtime/src/state/legacy-heuristics.test.ts extensions/octoclaw-runtime/src/runtime-host/p5-slimming-guard.test.ts` failed on the expected legacy branches (`childSessionKey`-only spawn, session-label subagent match, rich delivery special branch).
- P5-B focused suite after implementation:
  `pnpm vitest run extensions/octoclaw-runtime/src/tools/runtime-task-projection.test.ts extensions/octoclaw-runtime/src/state/legacy-heuristics.test.ts extensions/octoclaw-runtime/src/runtime-host/p5-slimming-guard.test.ts extensions/octoclaw-runtime/src/im/delivery-relay-verdict.test.ts extensions/octoclaw-runtime/src/tools/runtime-status.test.ts extensions/octoclaw-runtime/src/tools/registration-planner.test.ts extensions/octoclaw-runtime/src/runtime-host/openclaw-adapter.test.ts extensions/octoclaw-runtime/src/__tests__/extension-entry-outbound-guards.test.ts`: 8 files, 143 tests pass, 1 skipped.
- P5-B regression follow-up:
  `pnpm vitest run extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts extensions/octoclaw-runtime/src/tools/runtime-task-projection.test.ts extensions/octoclaw-runtime/src/runtime-host/p5-slimming-guard.test.ts`: 3 files, 55 tests pass.
- `pnpm vitest run extensions/octoclaw-runtime/src/runtime-host/p5-slimming-guard.test.ts extensions/octoclaw-runtime/src/im/delivery-relay-verdict.test.ts extensions/octoclaw-runtime/src/runtime-host/openclaw-adapter.test.ts extensions/octoclaw-runtime/src/__tests__/extension-entry-outbound-guards.test.ts`: 4 files, 77 tests pass.
- `pnpm vitest run extensions/octoclaw-runtime/src/router-onboarding.test.ts`: 18 tests pass. One Slack interactive handler test now has a local 10s timeout because it passed in ~0.5s alone but exceeded Vitest's default 5s once under full-suite load.
- `pnpm check`: pass.
- `node scripts/verify-openclaw-baseline.mjs`: pass; OpenClaw 2026.5.12 / f066dd2.
- `pnpm test`: 182 files pass; 2126 tests pass, 2 skipped, 1 todo.
- `npx gitnexus detect-changes --repo OctoClaw`: No changes detected.

### HD-1B: Structured Runtime Delivery Payload Chain Deletion

Date: 2026-05-18

Deleted the old structured runtime delivery outbox/protocol chain. Native delivery/announce is the live user-facing delivery path. The old structured delivery outbox was a dead artifact that payloads carried but no consumer actually processed for user-facing delivery.

#### Deleted Files (4)

| File | Lines (before) | Reason |
|------|---------------|--------|
| `core/delivery/outbox.ts` | 74 | Old structured delivery outbox; no live delivery consumer |
| `core/delivery/outbox.test.ts` | 88 | Tests for deleted outbox |
| `core/delivery/protocol.ts` | 125 | Old structured delivery protocol; `octoclaw.runtime_delivery/v1` |
| `core/delivery/protocol.test.ts` | 115 | Tests for deleted protocol |

#### Modified Files (5)

| File | LOC Before | LOC After | Change Summary |
|------|-----------|-----------|----------------|
| `runtime-payloads.ts` | 697 | 657 | Removed `buildWorkflowFinalDelivery`/`buildWorkflowProgressDelivery`/`enqueueWorkflowDelivery` imports; removed progress/final delivery creation and enqueue in both `buildTsRuntimeDispatchPayload` and `buildTsRuntimeSpawnPayload`; removed `deliveries` output field from both payload returns |
| `core/workflow/index.ts` | 394 | 355 | Removed `createOutbox`/`DeliveryOutbox` import; removed delivery/protocol imports; removed `outbox` field from `RuntimeWorkflowState`; removed `outbox: createOutbox()` init; removed `buildWorkflowProgressDelivery`/`buildWorkflowFinalDelivery`/`enqueueWorkflowDelivery` wrapper functions |
| `replay/replay.ts` | 327 | 304 | Removed `payload.deliveries` dependency from `recordDispatchLifecycleReplayEvents`; function now emits a single `dispatch_lifecycle` replay event without the old progress/final delivery sub-events |
| `runtime-payloads.test.ts` | 227 | 224 | Replaced `deliveries` assertions with `expect(payload).not.toHaveProperty("deliveries")` in both tests |
| `core/workflow/index.test.ts` | 159 | 158 | Removed `expect(state.outbox.entries).toEqual({})` assertion |

#### LOC Impact

| Metric | Before (P5-C) | After HD-1B | Delta |
|--------|---------------|-------------|-------|
| Production files | 178 | 176 | -2 |
| Production LOC | 45,778 | 45,477 | -301 |
| Test files | 118 | 116 | -2 |
| Test LOC | 37,501 | 37,371 | -130 |
| **Total LOC** | **83,279** | **82,848** | **-431** |

#### Retained Live Responsibilities

- `recordDispatchLifecycleReplayEvents` remains (called from `dispatch.ts` line 1211) but now emits a generic `dispatch_lifecycle` event without the old deliveries-specific sub-events. This preserves dispatch replay audit capability.
- `RuntimeWorkflowState` retains `ackLedger` (ACK deduplication is live).
- Native delivery/announce path unchanged (prohibited from this deletion).

#### Verification

- `pnpm vitest run extensions/octoclaw-runtime/src/runtime-payloads.test.ts extensions/octoclaw-runtime/src/core/workflow/index.test.ts`: 2 files, 11 tests pass.
- `pnpm vitest run extensions/octoclaw-runtime/src/im/delivery-relay-verdict.test.ts extensions/octoclaw-runtime/src/tools/registration-planner.test.ts`: 2 files, 46 pass + 1 skipped.
- `rg "core/delivery|delivery/protocol|delivery/outbox|buildWorkflowProgressDelivery|buildWorkflowFinalDelivery|enqueueWorkflowDelivery|protocolVersion: \"octoclaw.runtime_delivery/v1\"|outbox:" extensions/octoclaw-runtime/src -g "*.ts"`: **zero hits** in production code.
- `pnpm check`: pass.
- `pnpm test`: 180 files, 2118 pass, 2 skipped, 1 todo.

#### Scope Deviations

- None. All edits within the allowed scope documented in the deletion packet.

### HD-2: Task-State Rebuild and Crash-Recovery Migration Tail Deletion

Date: 2026-05-18

Deleted the old ledger-to-task-state rebuild and manual crash-recovery operator
tail. Runtime status now reads the task-state cache/archive directly, while
native status continues through the OpenClaw runtime adapter. Watchdog startup
still forces an immediate reconcile tick but no longer rewrites task-state from
the ledger first.

#### Deleted Files (6)

| File | Reason |
|------|--------|
| `runtime-ledger/projection-rebuild.ts` | Rebuild-on-read migration tail replaced by native/task-state adapter reads |
| `runtime-ledger/crash-recovery.ts` | Manual operator recovery path no longer owns runtime truth |
| `runtime-ledger/operator-diagnostics.ts` | Diagnostics/rebuild wrapper for deleted migration path |
| `runtime-ledger/__tests__/projection-rebuild.test.ts` | Tests for deleted migration path |
| `runtime-ledger/__tests__/crash-recovery.test.ts` | Tests for deleted operator path |
| `runtime-ledger/__tests__/operator-diagnostics.test.ts` | Tests for deleted diagnostics wrapper |

#### LOC Impact

| Metric | Before HD-2 | After HD-2 | Delta |
|--------|-------------|------------|-------|
| Production LOC | 45,477 | 44,658 | -819 |
| Test LOC | 37,371 | 36,429 | -942 |
| **Total LOC** | **82,848** | **81,087** | **-1,761** |

#### Retained Live Responsibilities

- Runtime ledger SQLite schema, tickets, native reconcile, shadow metadata, and
  WorkContract storage remain live and were not changed.
- Runtime status still reads active task-state records plus archive on request;
  native status projection remains adapter-backed.
- Watchdog timeout/status reconcile remains live through its normal tick path.

#### Verification

- Red check before implementation:
  `pnpm vitest run extensions/octoclaw-runtime/src/runtime-host/p5-slimming-guard.test.ts`
  failed on the expected deleted-module and deleted-symbol assertions.
- Focused HD-2 suite:
  `pnpm vitest run extensions/octoclaw-runtime/src/tools/runtime-status.test.ts extensions/octoclaw-runtime/src/ack/__tests__/watchdog-startup-reconcile.test.ts extensions/octoclaw-runtime/src/tools/registration-planner.test.ts extensions/octoclaw-runtime/src/runtime-host/p5-slimming-guard.test.ts extensions/octoclaw-runtime/src/runtime-ledger/runtime-ledger-hot-path.test.ts extensions/octoclaw-runtime/src/runtime-ledger/__tests__/feature-flags.test.ts`:
  6 files, 82 tests pass, 1 skipped.
- Live-code grep for deleted rebuild/recovery symbols and the removed operator
  env/tool names: zero hits outside the static guard.

#### Remaining Deletion Gap

Resolved by HD-3 through HD-7. Final hard deletion follow-up production LOC is
40,368, down 5,298 LOC from the P5-A baseline of 45,666.

### Hard Deletion Final Verification (2026-05-18)

- `git diff --check`: pass.
- `pnpm vitest run extensions/octoclaw-runtime/src/resolve/policy-resolver-judge-fallback.test.ts extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts extensions/octoclaw-runtime/src/replay/turn-execution-receipt.test.ts extensions/octoclaw-runtime/src/runtime-payloads.test.ts`: 4 files, 127 tests pass.
- `pnpm vitest run extensions/octoclaw-runtime/src/runtime-host/p5-slimming-guard.test.ts extensions/octoclaw-runtime/src/runtime-payloads.test.ts extensions/octoclaw-runtime/src/tools/registration-planner.test.ts extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts extensions/octoclaw-runtime/src/tools/runtime-status.test.ts extensions/octoclaw-runtime/src/tools/runtime-task-projection.test.ts extensions/octoclaw-runtime/src/resolve/policy-resolver-judge-fallback.test.ts extensions/octoclaw-status-surface/src/read-model/index.test.ts extensions/octoclaw-status-surface/src/view-model/index.test.ts extensions/octoclaw-status-surface/src/actions/index.test.ts`: 10 files, 225 tests pass, 1 skipped.
- `pnpm check`: pass.
- `pnpm test`: 158 files, 1993 tests pass, 1 skipped, 1 todo.
- `node scripts/verify-openclaw-baseline.mjs`: pass; OpenClaw 2026.5.12 / f066dd2.
- `npx gitnexus detect-changes --repo OctoClaw`: pass, no changes detected.
