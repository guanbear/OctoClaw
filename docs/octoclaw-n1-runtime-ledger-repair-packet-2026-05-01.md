# OctoClaw N1 Runtime Ledger Repair Packet

Date: 2026-05-01
Branch: `refactor/0.4.0-stable`
Status: implementation repair packet for external AI
Related:

- `docs/octoclaw-ts-rebuild-design-v2.md`
- `docs/octoclaw-n1-runtime-ledger-implementation-plan-2026-05-01.md`
- `docs/octoclaw-judge-dispatch-complexity-improvement-2026-05-01.md`
- `docs/octoclaw-state-convergence-4-4-design.md`

---

## 1. Scope

N1 的目标不是“模块存在”或“单测通过”，而是让委派从 policy suggestion 变成可恢复、可审计、可拒绝误触发的 runtime path。

外部 AI 修复时不要只做 isolated module tests。必须证明真实 hot path：

```text
conversation grounding
  -> policy resolver
  -> WorkContract / ticket
  -> scheduler queue / lease
  -> native materialization / child spawn
  -> completion binding
  -> status projection / recovery
```

符合文档验收。

---

## 2. P1 Repair Items

### P1-1: `resume_preferred` must truly reuse child session

Files:

- `extensions/octoclaw-runtime/src/tools/registration.ts`
- `extensions/octoclaw-runtime/src/work-contract/continuity.ts`
- related tests under `extensions/octoclaw-runtime/src/tools/` and `extensions/octoclaw-runtime/src/work-contract/`

Current issue:

`octoclaw_dispatch` writes the preferred child session into metadata when `continuationMode=resume_preferred`, but `trySpawnSubagentRuntime` still calls `buildChildSessionKey()`, which generates a fresh `randomUUID()` child session every time.

Required implementation:

1. Add an explicit preferred child session input to `trySpawnSubagentRuntime`.
2. Resolve spawn session key in this order:
   - explicit preferred child session key from `selectPreferredChildSession`;
   - `metadata.childSessionKey` / `metadata.child_session_key`;
   - compatible WorkContract continuity preferred child session;
   - new generated child session only when no compatible preferred session exists.
3. Pass the resolved key into `runtime.run({ sessionKey })`.
4. Mark session reuse evidence in runtime truth / task-state projection.
5. Reject or retire preferred session only when the session is missing, retired, scope-incompatible, or belongs to another delegate task.

Acceptance tests:

- `resume_preferred` uses the existing child session key, not a new UUID.
- retired or scope-incompatible preferred sessions create a new key and record the reason.
- completion binding uses the same child session key that `runtime.run` used.

---

### P1-2: scheduler queue / lease must be wired into live dispatch

Files:

- `extensions/octoclaw-runtime/src/tools/registration.ts`
- `extensions/octoclaw-runtime/src/runtime-ledger/scheduler.ts`
- `extensions/octoclaw-runtime/src/runtime-ledger/ticket-enforcement.ts`
- `extensions/octoclaw-runtime/src/runtime-ledger/native-reconcile.ts`

Current issue:

`admitDelegationTicketForDispatch` can create `scheduler_queue` rows, but live `octoclaw_dispatch` still proceeds directly to payload materialization and `trySpawnSubagentRuntime`. The scheduler functions are exported and unit-tested, but not used to control the hot path.

Required implementation:

1. After ticket admission, promote the admitted queue row through scheduler:
   - `promoteToQueued`;
   - `tryAcquireLease`;
   - native materialization / child spawn;
   - `materializeNativeIds`;
   - terminal `releaseOrComplete` from finalizer/recovery.
2. Independent tasks may run concurrently up to capacity.
3. Shared write scope or explicit dependency must produce `queued_after` / `blocked_by`, not silent skip.
4. Main turn lock must not block independent spawn materialization. If a lock/capacity/backend prevents spawn, status must be explicit `queued` or `blocked`.
5. If `OCTOCLAW_SCHEDULER_ENABLED` remains gated, docs and status must say this is staged fallback; do not claim N1 scheduler hot path complete.

Acceptance tests:

- two independent delegated tasks can both become running/spawning under available capacity;
- conflicting write scopes serialize with explicit blocked/queued state;
- busy main session does not produce `no_dispatch_evidence` for an independent task;
- a queued/blocked task does not report `spawn_confirmed=true`.

---

### P1-3: existing execution follow-up must not be solved by keyword patches

Files:

- `extensions/octoclaw-runtime/src/conversation-grounding.ts`
- `extensions/octoclaw-runtime/src/resolve/policy-resolver.ts`
- `extensions/octoclaw-runtime/src/runtime-ledger/ticket-dry-run.ts`
- `extensions/octoclaw-runtime/src/runtime-ledger/ticket-enforcement.ts`
- `extensions/octoclaw-runtime/src/tools/registration.ts`

Current issue:

The existing protection works only after a turn is already labeled `execution_followup` / `status_or_provenance`. The first layer still relies too much on regex-style prompt patterns, so natural short questions about dispatch failure may miss the follow-up lane.

Do not fix this by adding more phrases such as "为啥没派发成功" or "why no spawn". That becomes an unbounded keyword wall.

Required implementation:

1. In `conversation-grounding`, build `RecentExecutionContext` first:
   - recent WorkContract;
   - task-state projection;
   - runtime-policy-replay / task-events;
   - runtime ledger row;
   - dispatch/spawn/result/delivery receipts.
2. Add `relation_to_recent_execution`:
   - `existing_execution_status_query`;
   - `existing_execution_failure_reason_query`;
   - `existing_execution_provenance_query`;
   - `existing_execution_amendment`;
   - `new_work`;
   - `ambiguous`.
3. Map status / failure reason / provenance relations into the existing pipe:
   - `intent_class=execution_followup`;
   - `route_hint=reply`;
   - `lane_hint=control_observer`;
   - `require_state_grounding=true`;
   - forbid `octoclaw_dispatch`, `octoclaw_spawn`, `sessions_spawn`.
4. Route `existing_execution_amendment` into amendment protocol: `steer_child | queue_after | cancel_and_respawn | reply_status_only`.
5. Only `new_work` can request a delegation ticket, and it still needs `is_new_work=true` plus a non-empty expected deliverable.
6. `ambiguous` must not dispatch. Clarify, or reply with state-grounded status / no-verifiable-record.

Acceptance tests:

- given `RecentExecutionContext.execution_verdict=no_dispatch_evidence`, a failure reason relation does not issue a ticket and does not dispatch;
- given `spawn_not_confirmed`, status/provenance/failure relations reply from control-observer facts;
- new independent work still routes to `new_work` even when there is recent execution in the thread;
- dispatch hot path rejects non-`new_work` ticket candidates even if judge suggests `delegate`.

---

### P1-4: `retry` / `stop` / `approve` / `reject` must not be fake actions

Files:

- `extensions/octoclaw-runtime/src/tools/registration.ts`
- `extensions/octoclaw-runtime/src/core/delegate/index.ts`
- `extensions/octoclaw-runtime/src/work-contract/store.ts`
- `extensions/octoclaw-runtime/src/runtime-ledger/*`

Current issue:

`octoclaw_task_action` exposes `retry`, `stop`, `approve`, and `reject`, but `executeTaskAnchorCommand` currently returns read-only detail/queue payloads. The action enum promises side effects that are not performed.

Required implementation:

1. Implement `retry` at minimum:
   - find WorkContract / delegate task;
   - create a new attempt under the same `delegateTaskId`;
   - write task-state projection, runtime ledger attempt, replay event, and status timeline;
   - reuse preferred child session when compatible, otherwise record session retirement / respawn.
2. Define `stop`, `approve`, and `reject`:
   - either implement real state transitions;
   - or temporarily remove/hide them from tool enum and docs until implemented.
3. Status and timeline must distinguish original failed attempt from retried attempt.

Acceptance tests:

- `octoclaw_task_action retry <task>` creates attempt_no + 1 under same delegate task;
- retry persists to ledger and task-state;
- stop/approve/reject cannot return a success-looking read-only payload if no mutation occurred.

---

### P1-5: corrupt `task-state.json` must not become empty truth

Files:

- `extensions/octoclaw-runtime/src/state/task-state-store.ts`
- `extensions/octoclaw-runtime/src/runtime-ledger/projection-rebuild.ts`
- operator/status recovery tests

Current issue:

`readTaskStateDocument` catches all errors and returns empty tasks. JSON parse failure, IO failure, and missing file are treated the same. A later write can silently overwrite a corrupt projection with an empty one.

Required implementation:

1. Distinguish:
   - missing file (`ENOENT`);
   - JSON parse error;
   - schema mismatch;
   - IO/read error.
2. Missing file may return an empty projection.
3. Parse error must quarantine or preserve the original file and emit a recovery signal.
4. IO error must fail closed for writes that would replace durable projection.
5. If runtime ledger is available, operator/status should offer rebuild from ledger + native DB + replay.

Acceptance tests:

- invalid JSON is not overwritten by empty tasks;
- IO error does not silently produce an empty durable document;
- projection rebuild can restore `task-state.json` from ledger rows.

---

## 3. P2 Repair Items

### P2-1: N1 docs must not overclaim deferred tables

Files:

- `docs/octoclaw-judge-dispatch-complexity-improvement-2026-05-01.md`
- `docs/octoclaw-n1-runtime-ledger-implementation-plan-2026-05-01.md`
- `docs/octoclaw-ts-rebuild-design-v2.md`

Canonical N1-MVP tables:

- `work_contracts`
- `delegation_tickets`
- `task_attempts`
- `scheduler_queue`
- `completion_bindings`
- `runtime_events`

Deferred / fallback:

- `delivery_outbox`: existing JSON/adapter path until retry/dedup requires promotion.
- `amendments`: attempt rows plus existing retry/amendment model until explicit protocol promotion.
- `resource_locks`: inline `scheduler_queue.resource_keys_json` + `blocked_by` until independent lock table is justified.

Docs must use this same wording everywhere.

---

### P2-2: operator diagnostics tests and implementation must be stable

Files:

- `extensions/octoclaw-runtime/src/runtime-ledger/operator-diagnostics.ts`
- `extensions/octoclaw-runtime/src/runtime-ledger/__tests__/operator-diagnostics.test.ts`

Current issue:

Focused tests showed `operator-diagnostics.test.ts` failing on health counts and orphan listing. Fix using realistic temp SQLite fixtures rather than mocks that do not match `openRuntimeLedger` / migration behavior.

Acceptance tests:

- health report opens a real temp ledger and returns counts;
- orphan completion listing returns completion summaries;
- stale lease release delegates to scheduler and reports requeued count.

---

### P2-3: judge validator must match policy spec

Files:

- `packages/octoclaw-policy/src/judge/judge-schema.ts`
- runtime validator call sites
- policy spec tests

Current issue:

Hot-path validator is weaker than policy spec. Minimal `{ route: "delegate", confidence: 0.7 }` can pass even if scope/tool/duration/reason fields are missing.

Required implementation:

1. Decide required fields for hot path.
2. If a field is optional for backwards compatibility, record explicit degraded/fallback reason.
3. Do not silently invent strong defaults that make low-information judge output look authoritative.

Acceptance tests:

- missing required judge fields either reject or mark degraded;
- degraded judge output cannot bypass runtime ticket/new-work checks.

---

### P2-4: ACK text ACK0 policy must be aligned

Files:

- `extensions/octoclaw-runtime/src/ack/ack-decision.ts`
- `docs/octoclaw-judge-ack-policy-spec-2026-04-21.md`
- ACK tests

Current issue:

Policy spec allows reaction ACK or text ACK0, but implementation disables text ACK0 when reaction is not sent. Pick one product direction:

- if text ACK0 is disabled, update spec and tests;
- if text ACK0 is kept, implement gated text ACK0 for non-reaction channels.

---

## 4. Do Not Do

Do not:

- add a larger keyword list as the P1-3 fix;
- create a second routing system parallel to `reply | delegate`;
- let judge output directly authorize dispatch;
- treat WorkContract seal as dispatch evidence;
- treat TaskFlow creation as spawn evidence;
- expose side-effect actions that only return read-only payloads;
- claim scheduler/concurrency complete while live dispatch bypasses scheduler lease.

---

## 5. Verification Command Set

At minimum run:

```bash
COREPACK_HOME=/private/tmp/octoclaw-corepack corepack pnpm exec vitest run \
  extensions/octoclaw-runtime/src/conversation-grounding.test.ts \
  extensions/octoclaw-runtime/src/resolve/policy-resolver-judge-fallback.test.ts \
  extensions/octoclaw-runtime/src/runtime-ledger/__tests__/ticket-dry-run.test.ts \
  extensions/octoclaw-runtime/src/runtime-ledger/__tests__/ticket-enforcement.test.ts \
  extensions/octoclaw-runtime/src/runtime-ledger/__tests__/scheduler.test.ts \
  extensions/octoclaw-runtime/src/runtime-ledger/__tests__/operator-diagnostics.test.ts \
  extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts \
  extensions/octoclaw-runtime/src/work-contract/store.test.ts
```

Also run:

```bash
git diff --check
```

Passing tests are not enough if the implementation only tests isolated modules. Add hot-path tests that call the registered `octoclaw_dispatch` / `octoclaw_task_action` tools and prove the runtime behavior matches this packet.
