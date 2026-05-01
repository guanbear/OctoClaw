# OctoClaw N1 Runtime Ledger Implementation Plan

Date: 2026-05-01
Branch: `refactor/0.4.0-stable`
Status: implementation contract / OpenSpec packet source
Related:

- `docs/octoclaw-ts-rebuild-design-v2.md`
- `docs/octoclaw-judge-dispatch-complexity-improvement-2026-05-01.md`
- `docs/octoclaw-state-convergence-4-4-design.md`
- `docs/octoclaw-n1-runtime-ledger-repair-packet-2026-05-01.md`

---

## 1. Purpose

N1 must turn the current delegation path from “JSON projection + best-effort finalizer” into a recoverable runtime system:

```text
judge proposal
  -> WorkDecisionSeal
  -> WorkContract
  -> delegation ticket
  -> scheduler queue / lease
  -> native TaskFlow / TaskRun materialization
  -> completion binding
  -> result materialization
  -> delivery outbox
  -> status projection
```

The central implementation decision is:

> **Create an OctoClaw-owned SQLite runtime ledger for WorkContract, delegation ticket, scheduler queue, task attempt, completion binding, and runtime event truth. Keep OpenClaw native SQLite as lifecycle authority. Keep `task-state.json` as rebuildable projection. Existing delivery outbox and amendment paths remain JSON projections/adapters until explicitly promoted to ledger tables.**

---

## 2. Storage Decision

### 2.1 Use a new OctoClaw SQLite database

Path:

```text
~/.openclaw/workspace/.octoclaw/runtime/octoclaw-runtime.sqlite
```

Recommended runtime path resolver:

```text
OCTOCLAW_RUNTIME_DB_PATH
  -> explicit env override for tests/operators
workspaceRoot/.octoclaw/runtime/octoclaw-runtime.sqlite
  -> default
```

Why SQLite:

- Atomic queue pop / lease acquire / ticket use.
- Transactional WorkContract + attempt + native binding updates.
- Indexed status queries for active/queued/blocked/orphaned tasks.
- Crash recovery via expired lease scan.
- Simpler and safer than hand-rolled JSON file locking for concurrent dispatch.

Implementation constraint:

- Use Node's built-in `node:sqlite` through a small OctoClaw wrapper, mirroring OpenClaw's `requireNodeSqlite()` pattern. Do not add `better-sqlite3`, `sqlite3`, Prisma, Drizzle, or another native dependency for N1 unless a later design explicitly justifies it.
- If `node:sqlite` is unavailable, shadow mode may record `ledger_unavailable`; enforce mode must fail closed for new delegation and return a replyable diagnostic rather than falling back to JSON as scheduler truth.
- Store the DB under `.octoclaw/runtime/`, not `tmp/octopus/`, because queue/attempt/completion truth must survive temp cleanup and should sit next to completions/outbox.

### 2.2 Do not mutate OpenClaw native DB schema

OpenClaw already owns:

| DB | Tables | Use from OctoClaw |
|----|--------|-------------------|
| `~/.openclaw/flows/registry.sqlite` | `flow_runs` | Native flow lifecycle; consume through OpenClaw TaskFlow bridge/API first, direct DB read only as bounded read-only diagnostic fallback |
| `~/.openclaw/tasks/runs.sqlite` | `task_runs`, `task_delivery_state` | Native task run/session/delivery lifecycle; consume through OpenClaw TaskRun/TaskFlow bridge/API first, direct DB read only as bounded read-only diagnostic fallback |

OctoClaw must not add columns or store WorkContract metadata in these DBs. Native DB schema belongs to OpenClaw. Direct DB reads, if used before a public OpenClaw query API exists, must be isolated behind an adapter with schema/version guards and must never be the only execution proof.

### 2.3 Downgrade `task-state.json` to projection

`task-state.json` remains useful for:

- Fast status rendering.
- Compatibility with existing `octoclaw_status` and debug tooling.
- Human-readable snapshots.

But it must be rebuildable from:

```text
OctoClaw runtime ledger
  + OpenClaw native flow/task DBs
  + runtime replay tail
  + completion files/outbox
```

If `task-state.json` is missing or corrupt, the system must rebuild or quarantine it; it must not erase ledger truth.

---

## 3. Complexity Budget: Minimal N1-MVP Slice

The project goal is more stable, lighter, faster. N1 must start with a minimal recoverable ledger path, not a big-bang distributed scheduler.

### 3.1 N1-MVP tables (implement in first slice)

Only these tables ship in the first implementation slice:

| Table | Purpose | Required for |
|-------|---------|--------------|
| `schema_migrations` | Idempotent migration tracking | Step 0 |
| `work_contracts` | Canonical WorkContract truth | All steps |
| `delegation_tickets` | One-shot dispatch authorization | Steps 1-3 |
| `task_attempts` | Spawn/retry/respawn attempt records | Steps 1+ |
| `scheduler_queue` | Transactional queue/lease | Step 4 |
| `completion_bindings` | Completion path validation + orphan detection | Step 6 |
| `runtime_events` | Append-only audit + projection rebuild | All steps |

### 3.2 Deferred to later opt-in slices

These tables remain JSON/adapter-backed or deferred until a specific acceptance scenario requires them:

| Table | Current fallback | When to promote |
|-------|-----------------|-----------------|
| `delivery_outbox` | Existing JSON delivery outbox adapter with exponential backoff | When outbox retry needs transactional dedup or cross-restart durability beyond current adapter |
| `amendments` | Existing `retryDelegateAttempt` model + task-state | When amendment protocol (steer/queue-after/cancel-respawn) needs queryable history beyond attempt rows |
| `resource_locks` | Scheduler queue `resource_keys_json` + `blocked_by` fields | When resource contention tracking needs independent lease table instead of inline queue fields |

Promotion requires: a concrete failing acceptance scenario, a one-slice OpenSpec packet, and explicit review gate approval. Do not promote speculatively.

### 3.3 Principle

> Ship the minimum ledger that makes delegation recoverable. Add tables only when the existing path demonstrably fails a stated acceptance scenario.

---

## 4. First-Slice SQLite Schema

### 4.1 Pragmas and migrations

On open:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

Migration table:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Migrations must be idempotent and monotonic. Never mutate tables opportunistically from business logic.

### 4.2 `work_contracts`

Canonical OctoClaw business contract.

```sql
CREATE TABLE work_contracts (
  work_contract_id TEXT PRIMARY KEY,
  route TEXT NOT NULL CHECK (route IN ('reply', 'delegate')),
  intent_class TEXT,
  expected_deliverable TEXT,
  complexity_final TEXT CHECK (complexity_final IN ('simple', 'normal', 'deep') OR complexity_final IS NULL),
  complexity_reason_codes_json TEXT NOT NULL DEFAULT '[]',
  delivery_target_json TEXT NOT NULL DEFAULT '{}',
  work_contract_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sealed',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_work_contracts_status ON work_contracts(status);
CREATE INDEX idx_work_contracts_updated_at ON work_contracts(updated_at);
```

Allowed `status` values:

```text
sealed | registered | queued | blocked | spawning | running |
deliverable_ready | delivery_retry | delivered | completed |
failed | canceled | timeout_no_result | completion_orphaned | binding_mismatch
```

### 4.3 `delegation_tickets`

One-shot permission to create a delegated execution unit.

```sql
CREATE TABLE delegation_tickets (
  ticket_id TEXT PRIMARY KEY,
  work_contract_id TEXT NOT NULL REFERENCES work_contracts(work_contract_id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  delivery_target_id TEXT NOT NULL,
  expected_deliverable TEXT NOT NULL,
  complexity_final TEXT,
  status TEXT NOT NULL CHECK (status IN ('issued', 'used', 'revoked', 'expired')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  revoke_reason TEXT,
  ticket_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_delegation_tickets_work_contract ON delegation_tickets(work_contract_id);
CREATE INDEX idx_delegation_tickets_status_expires ON delegation_tickets(status, expires_at);
```

Invariant:

```text
dispatch may materialize only when ticket.status='issued' and expires_at > now
use ticket and enqueue/spawn attempt in one transaction
```

### 4.4 `task_attempts`

One row per spawn/retry/respawn/amendment attempt.

```sql
CREATE TABLE task_attempts (
  attempt_id TEXT PRIMARY KEY,
  work_contract_id TEXT NOT NULL REFERENCES work_contracts(work_contract_id) ON DELETE CASCADE,
  delegate_task_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  attempt_kind TEXT NOT NULL CHECK (attempt_kind IN ('initial', 'retry', 'amendment', 'respawn')),
  status TEXT NOT NULL,
  native_flow_id TEXT,
  native_task_id TEXT,
  child_session_key TEXT,
  child_run_id TEXT,
  model_profile TEXT,
  worker_pool TEXT,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  terminal_outcome TEXT,
  terminal_summary TEXT,
  error_code TEXT,
  error_message TEXT,
  attempt_json TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 0,
  UNIQUE(work_contract_id, attempt_no)
);
CREATE INDEX idx_task_attempts_work_contract ON task_attempts(work_contract_id);
CREATE INDEX idx_task_attempts_delegate_task ON task_attempts(delegate_task_id);
CREATE INDEX idx_task_attempts_native_task ON task_attempts(native_task_id);
CREATE INDEX idx_task_attempts_child_session ON task_attempts(child_session_key);
CREATE INDEX idx_task_attempts_status_updated ON task_attempts(status, updated_at);
```

`status` should use the same canonical status vocabulary as `work_contracts` where possible.

### 4.5 `scheduler_queue`

Queue and lease truth.

```sql
CREATE TABLE scheduler_queue (
  queue_id TEXT PRIMARY KEY,
  work_contract_id TEXT NOT NULL REFERENCES work_contracts(work_contract_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id) ON DELETE CASCADE,
  queue_status TEXT NOT NULL CHECK (queue_status IN ('admitted', 'queued', 'blocked', 'spawning', 'running', 'terminal')),
  priority INTEGER NOT NULL DEFAULT 0,
  dependency_ids_json TEXT NOT NULL DEFAULT '[]',
  queued_after TEXT,
  blocked_by TEXT,
  blocked_reason TEXT,
  resource_keys_json TEXT NOT NULL DEFAULT '[]',
  lease_owner TEXT,
  lease_expires_at TEXT,
  wakeup_at TEXT,
  wakeup_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_scheduler_queue_status_priority ON scheduler_queue(queue_status, priority, created_at);
CREATE INDEX idx_scheduler_queue_wakeup ON scheduler_queue(wakeup_at);
CREATE INDEX idx_scheduler_queue_attempt ON scheduler_queue(attempt_id);
```

### 4.6 `completion_bindings`

Completion path and binding verdict.

```sql
CREATE TABLE completion_bindings (
  completion_id TEXT PRIMARY KEY,
  work_contract_id TEXT NOT NULL REFERENCES work_contracts(work_contract_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id) ON DELETE CASCADE,
  expected_path TEXT NOT NULL,
  expected_work_contract_id TEXT NOT NULL,
  expected_delegate_task_id TEXT NOT NULL,
  expected_native_task_id TEXT,
  expected_child_session_key TEXT,
  observed_path TEXT,
  observed_work_contract_id TEXT,
  observed_delegate_task_id TEXT,
  observed_native_task_id TEXT,
  observed_child_session_key TEXT,
  verdict TEXT NOT NULL CHECK (verdict IN ('pending', 'matched', 'completion_orphaned', 'binding_mismatch', 'missing', 'invalid_json')),
  observed_at TEXT,
  completed_at TEXT,
  completion_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_completion_bindings_expected_path ON completion_bindings(expected_path);
CREATE INDEX idx_completion_bindings_verdict ON completion_bindings(verdict);
CREATE INDEX idx_completion_bindings_attempt ON completion_bindings(attempt_id);
```

Invariant:

```text
normal finalization requires verdict='matched'
wrong path or empty workContractId must become completion_orphaned/binding_mismatch, not running/result=none
```

### 4.7 `runtime_events`

Append-only audit and projection rebuild source.

```sql
CREATE TABLE runtime_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  work_contract_id TEXT,
  attempt_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_runtime_events_contract_created ON runtime_events(work_contract_id, created_at);
CREATE INDEX idx_runtime_events_attempt_created ON runtime_events(attempt_id, created_at);
```

---

## 5. Deferred Schema Sketches (not first-slice migrations)

The following sketches document likely future promotions only. They are intentionally outside the N1-MVP migration set. A table may move into the live schema only after a concrete failing acceptance scenario, a single-slice OpenSpec packet, and reviewer approval.

### 5.1 `resource_locks`

> **This table is deferred per §3.2.** It remains inline in `scheduler_queue.resource_keys_json` and `blocked_by` fields until resource contention tracking demonstrably needs an independent lease table. Do not create a migration for this table in the first slice.

```sql
CREATE TABLE resource_locks (
  resource_key TEXT PRIMARY KEY,
  holder_attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id) ON DELETE CASCADE,
  lock_mode TEXT NOT NULL CHECK (lock_mode IN ('shared', 'exclusive')),
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_resource_locks_expires ON resource_locks(expires_at);
```

Resource key examples:

```text
workspace:/Users/guanbear/octoclaw_stable
repo:/Users/guanbear/octoclaw_stable
file:extensions/octoclaw-runtime/src/tools/registration.ts
im-thread:slack:D0AR3GTPYQL:1777592404.273209
native-session:agent:main:subagent:...
model-account:provider/model/account
```

### 5.2 `delivery_outbox`

> **This table is deferred per §3.2.** Delivery outbox logic remains in the existing JSON delivery outbox adapter with exponential backoff. Do not create a migration for this table in the first slice. Promote only when outbox retry needs transactional dedup or cross-restart durability beyond current adapter.

Durable user-visible delivery attempts (sketch for future promotion):

```sql
CREATE TABLE delivery_outbox (
  delivery_id TEXT PRIMARY KEY,
  work_contract_id TEXT REFERENCES work_contracts(work_contract_id) ON DELETE CASCADE,
  attempt_id TEXT REFERENCES task_attempts(attempt_id) ON DELETE SET NULL,
  delivery_kind TEXT NOT NULL CHECK (delivery_kind IN ('ack', 'progress', 'final', 'status', 'error')),
  delivery_target_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'retrying', 'suppressed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  sent_at TEXT,
  provider_message_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_delivery_outbox_status_next ON delivery_outbox(status, next_attempt_at);
CREATE INDEX idx_delivery_outbox_work_contract ON delivery_outbox(work_contract_id);
```

### 5.3 `amendments`

> **This table is deferred per §3.2.** Amendment logic remains in the existing `retryDelegateAttempt` model and task-state. Do not create a migration for this table in the first slice. Promote only when amendment protocol needs queryable history beyond attempt rows.

Task modification decisions (sketch for future promotion):

```sql
CREATE TABLE amendments (
  amendment_id TEXT PRIMARY KEY,
  work_contract_id TEXT NOT NULL REFERENCES work_contracts(work_contract_id) ON DELETE CASCADE,
  parent_attempt_id TEXT REFERENCES task_attempts(attempt_id) ON DELETE SET NULL,
  decision TEXT NOT NULL CHECK (decision IN ('steer_child', 'queue_after', 'cancel_and_respawn', 'reply_status_only')),
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  prompt_delta_summary TEXT,
  created_attempt_id TEXT REFERENCES task_attempts(attempt_id) ON DELETE SET NULL,
  amendment_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_amendments_work_contract ON amendments(work_contract_id);
```


---

## 6. Staged Implementation Steps

N1 rolls out one reversible slice at a time: shadow ledger -> ticket dry-run -> ticket enforcement -> simple scheduler lease/queue -> completion binding/orphan scan -> projection rebuild. Before a stage passes its gate, it must not change live dispatch behavior. Do not merge stages just to save time; stability comes from small reviewable steps.

### Step 0 — Prep and contract tests

Deliverables:

- Runtime DB path resolver: `OCTOCLAW_RUNTIME_DB_PATH` override, default `resolveWorkspaceRoot()/.octoclaw/runtime/octoclaw-runtime.sqlite`.
- `node:sqlite` wrapper with OpenClaw-compatible unavailable-runtime error handling.
- Migration runner with `schema_migrations`.
- Unit tests for migration idempotency and WAL/open pragmas.
- Snapshot fixture for empty DB.

Acceptance:

- Opening DB twice does not duplicate migrations.
- Corrupt DB path or permission failure surfaces explicit degraded status.
- No new native SQLite dependency is introduced.
- Enforce mode refuses new delegation if ledger open fails; shadow mode records degraded evidence.

### Step 1 — Ledger write path in shadow mode

Keep existing live behavior, but mirror new truth into SQLite.

Deliverables:

- `work_contracts` writes from policy seal/saveWorkContract.
- `delegation_tickets` candidates for delegate route.
- `task_attempts` rows for current dispatch attempts.
- `runtime_events` for seal/ticket/attempt transitions.

Acceptance:

- Existing tests still pass.
- For every delegate task in `task-state.json`, a matching ledger row exists in shadow mode.
- Shadow diff report shows ledger vs task-state mismatches without changing live behavior.

### Step 2 — Ticket dry-run and replay evidence

Deliverables:

- Policy emits `delegation_ticket_candidate`.
- Dispatch records whether ticket would allow/deny materialization.
- Replay fields: `ticket_decision`, `ticket_denial_reason`, `is_new_work`, `expected_deliverable`.

Acceptance:

- “为什么刚才自己回复一次又派发一次” records `ticket_not_issued` / `not_new_work`.
- Fresh code-change task records `ticket_would_issue`.
- No live dispatch behavior changes yet.

### Step 3 — Enforce tickets for new dispatch

Deliverables:

- `octoclaw_dispatch` requires a valid issued ticket for new WorkContract materialization.
- Ticket use + attempt creation + queue row creation happens in one transaction.
- Invalid ticket returns structured `rejected` response; no native task is created.

Acceptance:

- No ticket / expired / used / revoked / scope mismatch tests all reject without creating task.
- Valid ticket creates exactly one attempt row.
- Replaying the same dispatch call does not create a duplicate attempt.

### Step 4 — Simple scheduler queue and inline resource blocking

Deliverables:

- Scheduler module with `admit`, `tryAcquireLease`, `materialize`, `releaseOrComplete`, `requeueExpiredLeases`.
- Inline resource key derivation from WorkContract read/write scope and delivery target; no separate `resource_locks` table in N1-MVP.
- Capacity config: `OCTOCLAW_MAX_CONCURRENT_SPAWNS`, default conservative.
- Queue/status projection for `queued_after` and `blocked_by`.

Acceptance:

- Two independent read-only tasks can run concurrently.
- Two write-conflicting tasks serialize; second shows `queued_after` or `blocked_by`.
- Main turn lock busy does not prevent independent scheduler materialization.
- Lease expiry after simulated crash requeues or recovers safely.

### Step 5 — Native lifecycle reconciliation

Deliverables:

- Read adapter that first uses the existing OpenClaw runtime bridge / `TaskFlowPort` / native helper capabilities.
- Optional direct SQLite diagnostic adapter for `flow_runs` and `task_runs`, isolated behind schema/version guards and used only when bridge/API coverage is missing.
- Reconciliation job compares ledger attempt native ids with native lifecycle state.
- `spawn_confirmed` only set when native task/session/process evidence exists.

Acceptance:

- TaskFlow creation without child session/run is not `spawn_confirmed`.
- Native terminal state updates ledger attempt terminal state.
- Missing native row marks attempt `binding_mismatch` or `dispatch_materialized_but_no_spawn_evidence`.
- Tests mock the bridge adapter; direct SQLite tests are diagnostic/fallback only.

### Step 6 — Completion binding and orphan recovery

Deliverables:

- Deterministic completion path creation before child prompt is built.
- Completion finalizer validates expected/observed ids.
- Orphan scanner for `.completion.json` and mismatched completion files.
- Recovery candidate status and operator action.

Acceptance:

- Empty `workContractId` completion becomes `completion_orphaned`, not `running/result=none`.
- Wrong path completion is discoverable by childSessionKey/delegateTaskId/session log.
- Matched completion materializes result and enqueues final delivery exactly once.

### Step 7 — Status projection and delivery adapter integration

Deliverables:

- Final/progress/status delivery continues through the existing JSON delivery outbox adapter; ledger stores only status/projection evidence needed to avoid false `completed`.
- `task-state.json` projection generator from ledger + native DB snapshot.
- `octoclaw_status` default uses compact canonical verdict; raw/debug shows underlying planes.

Acceptance:

- Deleting `task-state.json` and running rebuild restores status from ledger/native DB.
- Deliverable result with failed Slack send appears `deliverable_ready` / `delivery_retry`, not completed.
- Default status no longer lists reply-only work as delegated task noise.

### Step 8 — Retry/amendment protocol (post-MVP unless needed for acceptance)

Deliverables:

- Amendment classifier consuming WorkContract scope, attempt stage, child continuity, result state, and prompt delta; do not create an `amendments` table unless promoted by §3.2.
- Implement `steer_child`, `queue_after`, `cancel_and_respawn`, `reply_status_only`.
- `octoclaw_task_action retry` creates a new attempt under same `delegateTaskId`.

Acceptance:

- Status/provenance follow-up becomes `reply_status_only` and creates no task.
- Safe supplement to running child becomes `steer_child`.
- Scope-changing supplement becomes `queue_after`.
- Invalidated attempt becomes `cancel_and_respawn` with reason and new attempt.

### Step 9 — Cutover and cleanup

Deliverables:

- Feature flags:
  - `OCTOCLAW_RUNTIME_LEDGER=shadow|enforce`
  - `OCTOCLAW_SCHEDULER_ENABLED=0|1`
  - `OCTOCLAW_TASK_STATE_REBUILD=0|1`
- Migration/backfill from existing `task-state.json` into ledger.
- Operator commands: inspect DB health, rebuild projection, list orphan completions, release stale leases.

Acceptance:

- Shadow mode runs for representative sessions with mismatch report.
- Enforce mode passes focused tests and Slack acceptance.
- Rollback path: disable scheduler enforcement, keep ledger read-only, preserve DB file.

---

## 7. Verification Matrix

| Area | Test |
|------|------|
| Migration | DB opens, migrations idempotent, WAL enabled |
| Ticket | valid/expired/used/revoked/scope mismatch |
| Queue | independent concurrency, dependency queue, blocked resource, capacity limit |
| Lease | crash before spawn, crash after native task, expired lease recovery |
| Native sync | flow exists/no child run, child run terminal, native row missing |
| Completion | matched, wrong path, empty WorkContractId, invalid JSON, duplicate completion |
| Delivery | existing JSON outbox sent/failed/retry, duplicate final suppression, no false completed |
| Projection | delete/corrupt `task-state.json`, rebuild from ledger/native DB |
| Amendment | post-MVP acceptance if enabled: steer, queue-after, cancel-respawn, status-only |
| Replay/nightly | ticket allow/deny, false delegate, completion orphan, scheduler queue, duplicate owner |

Minimum commands before merge:

```bash
pnpm exec vitest run \
  extensions/octoclaw-runtime/src/**/runtime-ledger*.test.ts \
  extensions/octoclaw-runtime/src/**/scheduler*.test.ts \
  extensions/octoclaw-runtime/src/**/child-finalizer*.test.ts \
  extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts

pnpm exec vitest run extensions/octoclaw-runtime/src/**/runtime-ledger*.test.ts --runInBand

pnpm exec tsc --noEmit --pretty false -p extensions/octoclaw-runtime/tsconfig.json
pnpm exec tsc --noEmit --pretty false -p tools/octoclawctl/tsconfig.json
pnpm --filter octoclaw-runtime build
pnpm --filter octoclawctl build
```

Acceptance is not “tests pass” only. The reviewer must inspect the diff, ledger rows, projections, and user-visible behavior against the stated purpose for at least these manual scenarios:

1. Independent dual dispatch.
2. Write-conflicting dispatch.
3. Completion wrong path / empty WorkContractId.
4. Slack delivery failure then retry.
5. Delete `task-state.json` and rebuild.

---

## 8. OpenSpec Implementation Template

Use this packet when handing N1 chunks to OpenCode or another implementation agent.

```markdown
# OpenSpec Work Packet: OctoClaw N1 Runtime Ledger

## Problem
OctoClaw delegation currently relies on `task-state.json` plus best-effort replay/projection. This is insufficient for concurrent dispatch, dependency queueing, retry/amendment, completion binding, and crash recovery. Implement the bounded N1 slice described below.

## Design References
- `docs/octoclaw-ts-rebuild-design-v2.md` N1
- `docs/octoclaw-judge-dispatch-complexity-improvement-2026-05-01.md`
- `docs/octoclaw-n1-runtime-ledger-implementation-plan-2026-05-01.md`
- `docs/octoclaw-state-convergence-4-4-design.md`

## Scope
Implement only: <one slice, e.g. migration runner + first-slice schema, ticket dry-run, ticket enforcement, scheduler queue, completion binding, projection rebuild>.

Allowed files:
- <explicit file/module list>

Do not touch:
- OpenClaw native DB schema under `~/.openclaw/flows` or `~/.openclaw/tasks`
- unrelated IM adapter behavior
- unrelated judge prompt/rule injection
- unrelated status formatting
- deferred tables (`resource_locks`, `delivery_outbox`, `amendments`) unless this packet explicitly promotes one with acceptance proof

## Required Invariants
- `spawn_confirmed=true` requires native task/session/process evidence.
- `task-state.json` is a projection, not scheduler truth.
- New dispatch requires a valid delegation ticket once enforcement is enabled.
- Completion must match expected WorkContract/native/session binding before result materialization.
- Queue pop / lease acquire / attempt transition must be transactional.
- No raw child transcript injection into parent context.

## Deliverables
- Code changes for the slice.
- Focused tests listed below.
- Migration/backfill behavior if schema changes.
- Replay/status evidence fields if live behavior changes.
- Short risk/rollback note.

## Tests
Run:
```bash
<exact focused tests>
pnpm exec tsc --noEmit --pretty false -p extensions/octoclaw-runtime/tsconfig.json
```

## Acceptance Criteria
- <slice-specific acceptance bullets>
- Tests passing is required but not sufficient; reviewer must confirm behavior reaches the slice purpose and does not add avoidable architecture.
- Existing dispatch/reply behavior remains compatible unless feature flag is enabled.
- Failure states are explicit (`queued`, `blocked`, `completion_orphaned`, `binding_mismatch`, etc.), never silent no-op.

## Evidence to Return
- Changed files.
- Test output summary.
- Any schema migrations added.
- Manual scenario proof if applicable.
- Known risks and rollback.
```

---

## 9. Design Risk Review

This design is intentionally more conservative than “just add a DB and route everything through it”. Known risks and mitigations:

| Risk | Mitigation |
|------|------------|
| New DB becomes a second competing truth | Ledger owns OctoClaw business truth; OpenClaw DB owns native lifecycle; `task-state.json` is projection only. Documents and tests must enforce this split. |
| Direct reads of OpenClaw DB break on upstream schema changes | Prefer OpenClaw bridge/API; keep direct SQLite reads optional, read-only, guarded, and covered by schema smoke tests. |
| SQLite dependency adds install/deploy fragility | Use built-in `node:sqlite` under Node 22+, matching OpenClaw; add no external native package in N1. |
| Big-bang migration destabilizes live dispatch | Roll out shadow -> dry-run -> enforce behind flags; keep `task-state.json` compatibility projection during rollout. |
| Scheduler adds too much complexity | Implement only ticket, queue, lease fields, attempt, completion binding, and runtime events in N1-MVP; keep resource locks inline until proven necessary; no priority optimizer, no distributed scheduler, no online learning. |
| DB file under temp path gets cleaned | Store under `.octoclaw/runtime/`; keep `tmp/octopus` for projections/logs only. |

---

## 10. Rollback and Safety

- Keep ledger enforcement behind feature flag until shadow mismatch is understood.
- Never delete existing `task-state.json` or completion files during migration; copy/backfill only.
- Migration must be forward-only but safe to rerun.
- Rollback disables enforcement and scheduler materialization, not the DB file.
- Operator repair commands must prefer quarantine over destructive cleanup.
