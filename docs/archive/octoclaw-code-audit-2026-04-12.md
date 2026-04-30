# OctoClaw Code Audit Report — 2026-04-12

## Scope

Full project code review following Wave 1-3 hardening. Focus: bugs, logic errors,
design deviations against the 4.10 router-policy refactor.

---

## 🔴 Critical (pre-existing)

### P1. auto_redispatch infinite retry loop
**File**: `lib/patrol/__init__.py:4057-4142`

`should_auto_redispatch()` checks the ORIGINAL task's `retry_count`, but
`auto_redispatch_task()` only increments `retry_count` on the NEW task. The
original is never updated, so patrol can redispatch the same failed task
indefinitely on every cycle.

**Fix**: Increment original task's `retry_count` before creating new task.

### P2. classify_tasks missing states
**File**: `lib/patrol/__init__.py:728-902`

States `done`, `expired`, `completed_no_result`, `blocked_final` are silently
dropped instead of being returned in a dedicated category. Lost tasks.

### P3. wait_for_runner_result polling without locks
**File**: `lib/dispatch_task.py:934-959`

Reads `RUNNER_QUEUE_FILE` and result JSON files without `fcntl` locking.
Concurrent runner writes can cause torn reads or missed completions.

### P4. node_bridge reader loop silent death (FIXED)
**File**: `lib/node_bridge.py` (now fixed in this branch)

Reader thread died silently, causing misleading `TimeoutError` on subsequent
calls. Fixed: sets `_dead` flag, wakes all pending callers in `finally`.

### P5. node_bridge _results race condition (FIXED)
**File**: `lib/node_bridge.py` (now fixed)

`_results` dict was accessed outside the lock. Fixed: all `_results` and
`_pending` access now under `self._lock`.

### P6. spawn wrapper files never cleaned on failure
**File**: `lib/octoclaw_spawn.py:977-1019, 2049-2073`

Wrapper script and stdout/stderr logs persist in native-spawn/ when
`execute_spawn_backend` throws. Accumulates orphaned files over time.

---

## 🟡 Medium (pre-existing)

| # | Issue | File | Lines |
|---|-------|------|-------|
| M1 | `kill_subagent` swallows all gateway errors | patrol | 4323-4368 |
| M2 | `calculate_hard_timeout` formula inconsistent with doc | patrol | 3786-3788 |
| M3 | `main()` no top-level exception handler | patrol | 5147 |
| M4 | Notification dedup TOCTOU race | patrol | 5604-5709 |
| M5 | `gateway_call` timeout mismatch with caller intent | session_ops | 41-76 |
| M6 | `gateway_call` returns `{}` on non-dict response | session_ops | 69-76 |
| M7 | `resolve_message_target` silently swallows exceptions | session_ops | 260-263 |
| M8 | `cmd_heartbeat` writes health file without locking | runner_queue | 379-381 |
| M9 | Template injection in `inject_spawn_runtime_hints` | octoclaw_spawn | 229-238 |
| M10 | `check_task_transcript_errors` over-counts validation failures | patrol | 2382 |
| M11 | `normalize_result_status` defaults unknown to "failed" | runtime_protocol | 124-132 |
| M12 | `parse_iso` returns naive datetime for inputs without timezone | patrol | 544-552 |
| M13 | `send_task_notification` no retry on transient failures | notifier | 282-431 |

---

## 🟢 Low (pre-existing)

| # | Issue | File |
|---|-------|------|
| L1 | `runner_queue.save_state` not atomic (no temp+rename) | runner_queue:64-70 |
| L2 | `build_runner_goal_contract` no schema validation | runner_goal_contract:35-89 |
| L3 | `sync_recovered_stale_runner_jobs` silently ignores failures | dispatch_task:1052 |
| L4 | `FEISHU_CARD_STATE_FILE` path inconsistent with others | octopus_config:258 |
| L5 | `_openclaw_env` hardcoded PATH entries | patrol:283-287 |
| L6 | `get_notification_backend` loads sessions as side effect | octopus_config:699-706 |

---

## Design Deviations (vs 4.10 refactor doc)

1. **ACK timer not fully independent**: ACK is still gated by policy decision
   latency in some paths. Design says "ACK independent of model/runner latency
   (500-800ms timer)" — current ACK fires after signal extraction, not before.

2. **Decision cache not active**: R3.5 (120s TTL cache) is defined in schema
   but `state` field shows `"not_checked"` — cache lookup is not implemented.

3. **Python still in some live paths**: `octoclaw_policy.py:build_decision`
   is imported by `auto_router.py` for CLI eval and by `dispatch_task.py` as
   parity fallback. Design says "Python exits live router hot path."

---

## Items Fixed in This Branch

- ✅ CI/CD GitHub Actions workflow
- ✅ Judge cascade replaces `legacy_planner_until_stateless_judge_live`
- ✅ Persistent Node bridge (node_bridge.py + bridge.js)
- ✅ patrol.py → patrol/ package structure
- ✅ Route-based dispatch timeout tiers
- ✅ Python parity code marked deprecated
- ✅ Legacy shell scripts marked deprecated
- ✅ Session state persistence via OCTOCLAW_SESSION_STATE_FILE
- ✅ node_bridge.py thread safety fixes
- ✅ Slack acceptance verification document
