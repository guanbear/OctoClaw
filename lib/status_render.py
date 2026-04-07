#!/usr/bin/env python3
"""Generic OctoClaw status renderers for text-only environments."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

try:
    from worker_taxonomy import is_runner_task, resolve_executor, resolve_model_band, resolve_worker_pool, role_display
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.worker_taxonomy import is_runner_task, resolve_executor, resolve_model_band, resolve_worker_pool, role_display

try:
    from runtime_task_record import task_queue_bucket, task_state_model
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.runtime_task_record import task_queue_bucket, task_state_model

try:
    from task_display import build_task_actions, build_task_anchor, render_task_anchor_text
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.task_display import build_task_actions, build_task_anchor, render_task_anchor_text

FINAL_STATUSES = {"done", "failed", "deferred", "completed"}
SUCCESS_STATUSES = {"done", "completed"}
SYSTEM_TASK_PATTERNS = (
    "omniroute",
    "自动选模策略",
    "套餐状态",
    "provider usage",
    "quota snapshot",
    "model health",
    "replay automation",
    "nightly review",
    "patrol",
    "bridge sync",
    "refresh octoclaw",
)


def _taskflow_field(task: dict[str, Any], key: str) -> str:
    direct = str(task.get(f"openclaw_{key}", "") or "").strip()
    if direct:
        return direct
    binding = task.get("openclaw_taskflow", {}) if isinstance(task.get("openclaw_taskflow", {}), dict) else {}
    return str(binding.get(key, "") or "").strip()


def summarize_taskflow_substrate(tasks: list[dict[str, Any]]) -> dict[str, int]:
    tracked = 0
    mirrored = 0
    managed = 0
    native_bound = 0
    native_active = 0
    checkpointed = 0
    artifact_ready = 0
    handoff_ready = 0
    delivered = 0

    for task in tasks:
        if not isinstance(task, dict):
            continue
        binding_state = _taskflow_field(task, "taskflow_state") or _taskflow_field(task, "binding_state")
        native_binding = _taskflow_field(task, "native_binding_state")
        native_status = _taskflow_field(task, "native_status").lower()
        sync_mode = _taskflow_field(task, "taskflow_sync_mode")
        handoff_state = str(task.get("handoff_state", "") or "").strip().lower()
        task_event_summary = task.get("task_event_summary", {}) if isinstance(task.get("task_event_summary", {}), dict) else {}
        kind_counts = task_event_summary.get("kind_counts", {}) if isinstance(task_event_summary.get("kind_counts", {}), dict) else {}
        if binding_state:
            tracked += 1
            if "mirror" in binding_state:
                mirrored += 1
        if sync_mode == "managed":
            managed += 1
        if native_binding == "bound":
            native_bound += 1
        if native_status in {"queued", "running", "blocked"}:
            native_active += 1
        if int(kind_counts.get("checkpoint", 0) or 0) > 0:
            checkpointed += 1
        if int(kind_counts.get("artifact_ready", 0) or 0) > 0:
            artifact_ready += 1
        if handoff_state == "user_safe_ready":
            handoff_ready += 1
        elif handoff_state == "delivered":
            delivered += 1

    return {
        "tracked": tracked,
        "mirrored": mirrored,
        "managed": managed,
        "native_bound": native_bound,
        "native_active": native_active,
        "checkpointed": checkpointed,
        "artifact_ready": artifact_ready,
        "handoff_ready": handoff_ready,
        "delivered": delivered,
    }


def render_taskflow_substrate_summary(summary: dict[str, int]) -> str:
    tracked = int(summary.get("tracked", 0) or 0)
    if tracked <= 0:
        return "🧩 Substrate：no mirrored taskflow bindings yet"
    mirrored = int(summary.get("mirrored", 0) or 0)
    managed = int(summary.get("managed", 0) or 0)
    native_bound = int(summary.get("native_bound", 0) or 0)
    native_active = int(summary.get("native_active", 0) or 0)
    checkpointed = int(summary.get("checkpointed", 0) or 0)
    artifact_ready = int(summary.get("artifact_ready", 0) or 0)
    handoff_ready = int(summary.get("handoff_ready", 0) or 0)
    delivered = int(summary.get("delivered", 0) or 0)
    return (
        "🧩 Substrate："
        f"tracked {tracked} · mirrored {mirrored} · managed {managed} · native bound {native_bound} · "
        f"native active {native_active} · checkpoints/artifacts {checkpointed}/{artifact_ready} · "
        f"handoff ready/delivered {handoff_ready}/{delivered}"
    )


def task_executor(task: dict) -> str:
    return resolve_executor(task)


def is_team_parent(task: dict) -> bool:
    return str(task.get("task_kind", "") or "").strip() == "team_parent"


def is_team_step(task: dict) -> bool:
    return str(task.get("task_kind", "") or "").strip() == "team_step"


def task_role_emoji(task: dict) -> str:
    if is_team_parent(task):
        return "🕸️"
    return role_display(task)["emoji"]


def task_role_name(task: dict) -> str:
    if is_team_parent(task):
        return "协作流"
    return role_display(task)["name"]


def parse_time(value: str):
    if not value:
        return None
    try:
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        return datetime.fromisoformat(value)
    except Exception:
        return None


def short_model(path: str, limit: int = 42) -> str:
    path = str(path or "").strip()
    if not path:
        return "?"
    if limit <= 0 or len(path) <= limit:
        return path
    if "/" not in path:
        return path[: max(1, limit - 1)] + "…"

    left, right = path.split("/", 1)
    if len(right) + 2 >= limit:
        tail = max(8, limit - 3)
        return "…/" + right[-tail:]

    head_budget = max(6, limit - len(right) - 2)
    if len(left) <= head_budget:
        return f"{left}/{right}"
    return f"{left[: max(1, head_budget - 1)]}…/{right}"


def compact_model(path: str) -> str:
    return short_model(path, limit=52)


def table_model(path: str) -> str:
    return short_model(path, limit=8)


def task_model_display(path: str, limit: int = 52) -> str:
    return short_model(path, limit=limit)


def task_model_band(task: dict[str, Any]) -> str:
    return str(resolve_model_band(task, default="normal") or "normal")


def model_cost_badge(path: str) -> str:
    lower = (path or "").lower()
    if "gpt-5.4" in lower or "gpt_5_4" in lower or "opus" in lower:
        return "¥¥¥"
    if "sonnet" in lower:
        return "¥¥"
    if "glm" in lower or "minimax" in lower or "m2_5" in lower or "m2.5" in lower or "kimi" in lower:
        return "¥"
    return "?"


def summarize_model_health(state: dict[str, Any] | None, *, top_n: int = 3) -> dict[str, Any]:
    payload = state if isinstance(state, dict) else {}
    models = payload.get("models", {}) if isinstance(payload.get("models", {}), dict) else {}
    rows: list[dict[str, Any]] = []
    cooldown = 0
    degraded = 0
    quota_high = 0
    quota_critical = 0

    for model_id, raw in models.items():
        if not isinstance(raw, dict):
            continue
        state_name = str(raw.get("state", "") or "").strip().lower()
        quota_pressure = str(raw.get("quota_pressure", "") or "").strip().lower()
        row = {
            "model": str(model_id or "").strip(),
            "state": state_name or "healthy",
            "quota_pressure": quota_pressure,
            "last_degraded_at": str(raw.get("last_degraded_at", "") or "").strip(),
            "recent_failures": int(raw.get("recent_429_count", 0) or 0)
            + int(raw.get("recent_timeout_count", 0) or 0)
            + int(raw.get("recent_failover_count", 0) or 0),
        }
        rows.append(row)
        if state_name == "cooldown":
            cooldown += 1
        elif state_name == "degraded":
            degraded += 1
        if quota_pressure == "high":
            quota_high += 1
        elif quota_pressure == "critical":
            quota_critical += 1

    def _priority(row: dict[str, Any]) -> tuple[int, int, str, str]:
        state_rank = {"cooldown": 0, "degraded": 1, "healthy": 2}.get(str(row.get("state", "")), 3)
        quota_rank = {"critical": 0, "high": 1}.get(str(row.get("quota_pressure", "")), 2)
        last = str(row.get("last_degraded_at", "") or "")
        return (state_rank, quota_rank, f"~{last}" if last else "~", str(row.get("model", "")))

    rows.sort(key=_priority)
    return {
        "tracked_models": len(rows),
        "cooldown_count": cooldown,
        "degraded_count": degraded,
        "quota_high_count": quota_high,
        "quota_critical_count": quota_critical,
        "top_models": rows[: max(0, top_n)],
    }


def render_model_health_summary(summary: dict[str, Any]) -> list[str]:
    tracked = int(summary.get("tracked_models", 0) or 0)
    if tracked <= 0:
        return ["🩺 模型健康：no health signals yet"]

    cooldown = int(summary.get("cooldown_count", 0) or 0)
    degraded = int(summary.get("degraded_count", 0) or 0)
    quota_high = int(summary.get("quota_high_count", 0) or 0)
    quota_critical = int(summary.get("quota_critical_count", 0) or 0)
    lines = [
        f"🩺 模型健康：tracked {tracked} · cooldown {cooldown} · degraded {degraded} · quota high/critical {quota_high}/{quota_critical}"
    ]
    top_models = summary.get("top_models", []) if isinstance(summary.get("top_models", []), list) else []
    if top_models:
        highlights: list[str] = []
        for row in top_models:
            if not isinstance(row, dict):
                continue
            model = short_model(str(row.get("model", "") or ""), limit=28)
            state_name = str(row.get("state", "healthy") or "healthy").strip().lower()
            quota = str(row.get("quota_pressure", "") or "").strip().lower()
            bits = [model]
            if state_name in {"cooldown", "degraded"}:
                bits.append(state_name)
            if quota in {"high", "critical"}:
                bits.append(f"quota:{quota}")
            highlights.append(" ".join(bits))
        if highlights:
            lines.append("   health watch: " + " | ".join(highlights))
    return lines


def render_main_model_drift_summary(drift: dict[str, Any]) -> list[str]:
    if not isinstance(drift, dict) or not drift:
        return []
    if not bool(drift.get("enabled", False)):
        return ["🧭 主链漂移：disabled"]

    reason = str(drift.get("reason", "") or "").strip()
    if reason in {"main_session_missing", "mode_not_managed", "expected_model_missing", "current_model_missing"}:
        mode_text = str(drift.get("current_mode", "") or "").strip()
        suffix = f" · {mode_text}" if mode_text else ""
        return [f"🧭 主链漂移：{reason}{suffix}"]

    expected_raw = str(drift.get("expected_model", "") or "").strip()
    actual_raw = str(drift.get("actual_model", "") or "").strip()
    override_raw = str(drift.get("current_override", "") or "").strip()
    current_raw = str(drift.get("compared_model", "") or actual_raw or override_raw or "").strip()
    expected = short_model(expected_raw, limit=32)
    current = short_model(current_raw, limit=32) if current_raw else ""
    lines: list[str] = []
    if bool(drift.get("drift", False)):
        lines.append(f"🧭 主链漂移：detected · expected {expected} · actual {current or 'unknown'}")
    else:
        lines.append(f"🧭 主链漂移：aligned · {expected}")

    if override_raw:
        override = short_model(override_raw, limit=32)
        if bool(drift.get("override_drift", False)) and not bool(drift.get("drift", False)) and actual_raw:
            lines.append(f"   session override：{override}（stale, actual aligned）")
        elif actual_raw and override_raw != actual_raw:
            lines.append(f"   session override：{override}")
    elif actual_raw:
        lines.append("   session override：none")
    return lines


def operator_hint(task: dict[str, Any], limit: int = 28) -> str:
    artifacts = task.get("artifacts", {}) if isinstance(task.get("artifacts", {}), dict) else {}
    surface = artifacts.get("operator_surface", {}) if isinstance(artifacts.get("operator_surface", {}), dict) else {}
    value = str(artifacts.get("operator_hint", "") or surface.get("operator_hint", "") or "").strip()
    if not value:
        return ""
    if len(value) <= limit:
        return value
    return value[: limit - 1].rstrip() + "…"


GENERIC_SUMMARY_PREFIXES = (
    "runner完成",
    "runner失败",
    "已通过常驻 runner 完成检查",
    "当前任务适合主 agent 直接处理",
)


def preferred_task_title(task: dict, limit: int = 48) -> str:
    summary = str(task.get("summary") or "").strip()
    task_desc = str(task.get("task_description") or "").strip()
    task_id = str(task.get("id") or "?").strip()
    if is_team_parent(task) and task_desc:
        return task_desc[:limit]
    if task_desc and (not summary or summary.startswith(GENERIC_SUMMARY_PREFIXES)):
        return task_desc[:limit]
    if summary:
        return summary[:limit]
    return task_id[:limit]


def _task_text_blob(task: dict[str, Any]) -> str:
    return " ".join(
        [
            str(task.get("title", "") or ""),
            str(task.get("summary", "") or ""),
            str(task.get("task_description", "") or ""),
            str(task.get("user_safe_summary", "") or ""),
        ]
    ).strip().lower()


def is_system_maintenance_task(task: dict[str, Any]) -> bool:
    if not isinstance(task, dict):
        return False
    if str(task.get("session_key", "") or "").strip() or str(task.get("session_origin", "") or "").strip():
        return False
    text_blob = _task_text_blob(task)
    if any(pattern in text_blob for pattern in SYSTEM_TASK_PATTERNS):
        return True
    return False


def format_duration(started_at: str, now: datetime) -> str:
    started = parse_time(started_at)
    if not started:
        return "?"
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    seconds = max(0, int((now - started).total_seconds()))
    if seconds < 60:
        return f"{seconds}s"
    minutes, seconds = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes}m{seconds}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h{minutes}m"


def format_duration_between(started_at: str, completed_at: str, now: datetime) -> str:
    started = parse_time(started_at)
    completed = parse_time(completed_at)
    if not completed:
        return format_duration(started_at, now)
    if not started:
        return "?"
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    if completed.tzinfo is None:
        completed = completed.replace(tzinfo=timezone.utc)
    seconds = max(0, int((completed - started).total_seconds()))
    if seconds < 60:
        return "<1m"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes}m"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h{minutes}m"


def format_clock(value: str, now: datetime) -> str:
    dt = parse_time(value)
    if not dt:
        return "?"
    if dt.tzinfo:
        dt = dt.astimezone(now.tzinfo)
    return dt.strftime("%H:%M")


def _task_id(task: dict[str, Any]) -> str:
    return str(task.get("id", "") or "").strip()


def _task_sort_value(task: dict[str, Any]) -> float:
    for field in ("updated_at", "completed_at", "started_at", "spawned_at"):
        dt = parse_time(str(task.get(field, "") or ""))
        if dt is None:
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    return 0.0


def _resolved_child_ids(parent: dict[str, Any], children: list[dict[str, Any]]) -> list[str]:
    explicit_child_ids = [str(item).strip() for item in (parent.get("child_ids", []) or []) if str(item).strip()]
    inferred_ids = [_task_id(child) for child in children if _task_id(child)]
    resolved = list(explicit_child_ids)
    for child_id in inferred_ids:
        if child_id not in resolved:
            resolved.append(child_id)
    return resolved


def _build_lineage_step_rows(parent: dict[str, Any], children: list[dict[str, Any]], child_ids: list[str]) -> list[dict[str, Any]]:
    artifacts = parent.get("artifacts", {}) if isinstance(parent.get("artifacts", {}), dict) else {}
    step_task_ids = artifacts.get("step_task_ids", {}) if isinstance(artifacts.get("step_task_ids", {}), dict) else {}
    step_order = artifacts.get("step_order", []) if isinstance(artifacts.get("step_order", []), list) else []
    children_by_id = {_task_id(child): child for child in children if _task_id(child)}
    rows: list[dict[str, Any]] = []
    used_child_ids: set[str] = set()

    for step_name in step_order:
        name = str(step_name).strip()
        if not name:
            continue
        child_id = str(step_task_ids.get(name, "") or "").strip()
        if not child_id and child_ids:
            index = len(rows)
            if index < len(child_ids):
                child_id = str(child_ids[index] or "").strip()
        child = children_by_id.get(child_id)
        if child is None:
            continue
        rows.append({"step": name, "task": child})
        used_child_ids.add(child_id)

    for child_id in child_ids:
        child = children_by_id.get(child_id)
        if child is None or child_id in used_child_ids:
            continue
        rows.append({"step": "", "task": child})
        used_child_ids.add(child_id)

    for child in children:
        child_id = _task_id(child)
        if not child_id or child_id in used_child_ids:
            continue
        rows.append({"step": "", "task": child})
        used_child_ids.add(child_id)

    return rows


def _build_status_lineages(tasks: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], set[str], set[str]]:
    tasks_by_id = {_task_id(task): task for task in tasks if _task_id(task)}
    children_by_parent: dict[str, list[dict[str, Any]]] = {}
    for task in tasks:
        parent_id = str(task.get("parent_id", "") or "").strip()
        if parent_id:
            children_by_parent.setdefault(parent_id, []).append(task)

    parent_ids: list[str] = []
    seen_parent_ids: set[str] = set()
    for task in tasks:
        task_id = _task_id(task)
        if not task_id or task_id in seen_parent_ids:
            continue
        if is_team_parent(task) or task.get("child_ids") or task_id in children_by_parent:
            seen_parent_ids.add(task_id)
            parent_ids.append(task_id)

    parent_ids.sort(key=lambda task_id: _task_sort_value(tasks_by_id.get(task_id, {})), reverse=True)

    lineages: list[dict[str, Any]] = []
    child_ids_all: set[str] = set()

    for parent_id in parent_ids:
        parent = tasks_by_id.get(parent_id)
        if not isinstance(parent, dict):
            continue
        children = []
        seen_child_ids: set[str] = set()
        explicit_child_ids = [str(item).strip() for item in (parent.get("child_ids", []) or []) if str(item).strip()]
        for child_id in explicit_child_ids:
            child = tasks_by_id.get(child_id)
            if child is None:
                continue
            children.append(child)
            seen_child_ids.add(child_id)
        inferred_children = sorted(children_by_parent.get(parent_id, []), key=_task_sort_value)
        for child in inferred_children:
            child_id = _task_id(child)
            if child_id and child_id not in seen_child_ids:
                children.append(child)
                seen_child_ids.add(child_id)

        if not children and not explicit_child_ids:
            continue

        child_ids = _resolved_child_ids(parent, children)
        status_counts: dict[str, int] = {}
        open_task_count = 0
        done_child_count = 0
        failed_child_count = 0
        for child in children:
            status = str(child.get("status", "") or "").strip().lower()
            status_counts[status] = status_counts.get(status, 0) + 1
            if status in SUCCESS_STATUSES:
                done_child_count += 1
            if status == "failed":
                failed_child_count += 1
            if status not in FINAL_STATUSES:
                open_task_count += 1

        step_rows = _build_lineage_step_rows(parent, children, child_ids)
        lineages.append(
            {
                "parent": parent,
                "children": children,
                "child_ids": child_ids,
                "child_count": len(child_ids),
                "open_task_count": open_task_count,
                "done_child_count": done_child_count,
                "failed_child_count": failed_child_count,
                "status_counts": status_counts,
                "step_rows": step_rows,
            }
        )
        child_ids_all.update(_task_id(child) for child in children if _task_id(child))

    return lineages, set(parent_ids), child_ids_all


def _should_count_recent(task: dict[str, Any], recent_window: datetime, lineage_child_ids: set[str], now: datetime) -> bool:
    task_id = _task_id(task)
    if task_id in lineage_child_ids:
        return False
    completed = parse_time(str(task.get("completed_at", "") or ""))
    if completed is None:
        return False
    if completed.tzinfo:
        completed = completed.astimezone(now.tzinfo).replace(tzinfo=None)
    return completed >= recent_window.replace(tzinfo=None)


def _task_binding(task: dict[str, Any]) -> dict[str, Any]:
    direct = task.get("openclaw_taskflow", {}) if isinstance(task.get("openclaw_taskflow", {}), dict) else {}
    artifacts = task.get("artifacts", {}) if isinstance(task.get("artifacts", {}), dict) else {}
    artifact_binding = artifacts.get("openclaw_taskflow", {}) if isinstance(artifacts.get("openclaw_taskflow", {}), dict) else {}
    merged = dict(artifact_binding)
    merged.update({key: value for key, value in direct.items() if value not in (None, "", [], {})})
    return merged


def _task_clock(task: dict[str, Any]) -> datetime | None:
    for field in ("updated_at", "completed_at", "started_at", "spawned_at", "created_at"):
        parsed = parse_time(str(task.get(field, "") or ""))
        if parsed is not None:
            return parsed
    return None


def _is_stale_mirror_only_queued(task: dict[str, Any], now: datetime, *, stale_minutes: int = 90) -> bool:
    if str(task_queue_bucket(task) or "").strip().lower() != "queued":
        return False
    binding = _task_binding(task)
    if not binding:
        return False
    backend = str(binding.get("backend", "") or "").strip().lower()
    if backend and backend != "mirror":
        return False
    binding_state = str(binding.get("binding_state", "") or "").strip().lower()
    native_binding_state = str(binding.get("native_binding_state", "") or "").strip().lower()
    native_status = str(binding.get("native_status", "") or "").strip().lower()
    flow_id = str(binding.get("flow_id", "") or "").strip()
    task_id = str(binding.get("task_id", "") or "").strip()
    substrate_state = str(binding.get("substrate_state", "") or "").strip().lower()
    if flow_id or task_id or native_binding_state == "bound" or native_status in {"queued", "running", "blocked"} or substrate_state in {"queued", "running", "blocked"}:
        return False
    if binding_state not in {"", "mirrored"}:
        return False
    recovery_action = str(task.get("recovery_action", "") or "").strip().lower()
    artifacts = task.get("artifacts", {}) if isinstance(task.get("artifacts", {}), dict) else {}
    spawn_execution = artifacts.get("spawn_execution", {}) if isinstance(artifacts.get("spawn_execution", {}), dict) else {}
    has_session_identity = any(
        str(value or "").strip()
        for value in (
            task.get("session_key"),
            task.get("session_id"),
            task.get("run_id"),
            spawn_execution.get("session_id"),
            spawn_execution.get("run_id"),
        )
    )
    if has_session_identity and recovery_action != "dead_agent_recovered":
        return False
    clock = _task_clock(task)
    if clock is None:
        return False
    if clock.tzinfo is None:
        clock = clock.replace(tzinfo=timezone.utc)
    age_minutes = max(0.0, (now - clock.astimezone(now.tzinfo)).total_seconds() / 60.0)
    return age_minutes >= float(stale_minutes)


def build_status_snapshot(tasks: list[dict], now: datetime | None = None, recent_minutes: int = 30) -> dict:
    now = now or datetime.now(timezone(timedelta(hours=8)))
    recent_window = now - timedelta(minutes=recent_minutes)
    lineages, lineage_parent_ids, lineage_child_ids = _build_status_lineages(tasks)
    lineage_task_ids = lineage_parent_ids | lineage_child_ids
    generic_tasks = [task for task in tasks if _task_id(task) not in lineage_task_ids]
    user_tasks = [task for task in generic_tasks if not is_system_maintenance_task(task)]
    system_tasks = [task for task in generic_tasks if is_system_maintenance_task(task)]
    active_lineages = [
        lineage
        for lineage in lineages
        if str(lineage.get("parent", {}).get("status", "") or "").strip().lower() not in {"done", "failed", "deferred"}
        or int(lineage.get("open_task_count", 0) or 0) > 0
    ]
    user_lineages = [lineage for lineage in active_lineages if not is_system_maintenance_task(lineage.get("parent", {}))]
    system_lineages = [lineage for lineage in active_lineages if is_system_maintenance_task(lineage.get("parent", {}))]

    running = [task for task in user_tasks if task_queue_bucket(task) == "running"]
    queued_all = [task for task in user_tasks if task_queue_bucket(task) == "queued"]
    stale_queued = [task for task in queued_all if _is_stale_mirror_only_queued(task, now)]
    queued = [task for task in queued_all if _task_id(task) not in {_task_id(item) for item in stale_queued}]
    deferred = [task for task in user_tasks if str(task.get("status") or "").strip().lower() == "deferred"]
    pending = [task for task in user_tasks if str(task.get("status") or "").strip().lower() == "pending_confirm"]
    system_running = [task for task in system_tasks if task_queue_bucket(task) == "running"]
    system_queued_all = [task for task in system_tasks if task_queue_bucket(task) == "queued"]
    system_stale_queued = [task for task in system_queued_all if _is_stale_mirror_only_queued(task, now)]
    system_queued = [task for task in system_queued_all if _task_id(task) not in {_task_id(item) for item in system_stale_queued}]
    system_deferred = [task for task in system_tasks if str(task.get("status") or "").strip().lower() == "deferred"]
    system_pending = [task for task in system_tasks if str(task.get("status") or "").strip().lower() == "pending_confirm"]
    failed_recent = []
    done_recent = []
    system_failed_recent = []
    system_done_recent = []
    steer_needed = []
    for task in tasks:
        recovery_action = str(task.get("recovery_action") or "").strip().lower()
        if not is_system_maintenance_task(task):
            if recovery_action == "needs_steer":
                steer_needed.append(task)
        if not _should_count_recent(task, recent_window, lineage_child_ids, now):
            continue
        state_model = task_state_model(task)
        outcome_state = str(state_model.get("outcome_state", "") or "").strip().lower()
        lifecycle_state = str(state_model.get("lifecycle_state", "") or "").strip().lower()
        if lifecycle_state not in {"finished", "cancelled"}:
            continue
        if outcome_state == "done":
            if is_system_maintenance_task(task):
                system_done_recent.append(task)
            else:
                done_recent.append(task)
        elif outcome_state == "failed":
            if is_system_maintenance_task(task):
                system_failed_recent.append(task)
            else:
                failed_recent.append(task)

    return {
        "now": now,
        "running": running,
        "queued": queued,
        "stale_queued": stale_queued,
        "deferred": deferred,
        "pending": pending,
        "system_running": system_running,
        "system_queued": system_queued,
        "system_stale_queued": system_stale_queued,
        "system_deferred": system_deferred,
        "system_pending": system_pending,
        "done_recent": done_recent,
        "failed_recent": failed_recent,
        "system_done_recent": system_done_recent,
        "system_failed_recent": system_failed_recent,
        "steer_needed": steer_needed,
        "lineages": lineages,
        "active_lineages": user_lineages,
        "system_active_lineages": system_lineages,
        "lineage_parent_ids": lineage_parent_ids,
        "lineage_child_ids": lineage_child_ids,
    }


def _task_status_label(task: dict[str, Any]) -> str:
    value = str(task.get("status", "") or "").strip().lower()
    mapping = {
        "done": "done",
        "completed": "done",
        "failed": "failed",
        "running": "running",
        "dispatched": "queued",
        "queued": "queued",
        "pending_confirm": "blocked",
        "blocked": "blocked",
        "deferred": "deferred",
    }
    return mapping.get(value, value or "?")


def _lineage_progress_text(lineage: dict[str, Any]) -> str:
    child_count = int(lineage.get("child_count", 0) or 0)
    done_child_count = int(lineage.get("done_child_count", 0) or 0)
    failed_child_count = int(lineage.get("failed_child_count", 0) or 0)
    open_task_count = int(lineage.get("open_task_count", 0) or 0)
    parts = [f"{done_child_count}/{child_count} done"] if child_count else ["0 steps"]
    if failed_child_count:
        parts.append(f"{failed_child_count} failed")
    if open_task_count:
        parts.append(f"{open_task_count} open")
    return " · ".join(parts)


def _compact_task_line(task: dict, now: datetime) -> str:
    emoji = task_role_emoji(task)
    role = task_role_name(task)
    name = preferred_task_title(task, limit=52)
    model = task_model_display(task.get("model", ""))
    cost = model_cost_badge(task.get("model", ""))
    model_band = task_model_band(task)[:8]
    duration = format_duration(task.get("started_at") or task.get("spawned_at") or "", now)
    eta = task.get("expected_done_at")
    eta_text = f" · 预计 {format_clock(eta, now)}" if eta else ""
    op_hint = operator_hint(task)
    op_text = f" · {op_hint}" if op_hint else ""
    return f"  {emoji} {role} · {model} · {cost} · {model_band} · ⏱️ {duration}{eta_text}{op_text}\n    └ {name}"


def _compact_lineage_lines(lineage: dict[str, Any], now: datetime) -> list[str]:
    parent = lineage["parent"]
    parent_name = preferred_task_title(parent, limit=54)
    parent_status = _task_status_label(parent)
    duration = format_duration(parent.get("started_at") or parent.get("spawned_at") or parent.get("updated_at") or "", now)
    parent_hint = operator_hint(parent)
    parent_hint_text = f" · {parent_hint}" if parent_hint else ""
    lines = [
        f"  🕸️ {parent_name} · {parent_status} · {_lineage_progress_text(lineage)} · ⏱️ {duration}{parent_hint_text}"
    ]
    step_rows = lineage.get("step_rows", [])
    for idx, step_row in enumerate(step_rows[:4]):
        child = step_row["task"]
        branch = "└" if idx == min(len(step_rows), 4) - 1 else "├"
        step_name = str(step_row.get("step", "") or child.get("phase", "") or _task_id(child) or "step").strip()
        child_status = _task_status_label(child)
        child_title = preferred_task_title(child, limit=56)
        lines.append(f"    {branch} {step_name:<10} [{child_status:<7}] {child_title}")
    if len(step_rows) > 4:
        lines.append(f"    └ … 其余 {len(step_rows) - 4} 个子步骤")
    return lines


def _anchor_text(task: dict[str, Any], now: datetime) -> str:
    anchor = build_task_anchor(task, now=now)
    actions = build_task_actions(task)
    return render_task_anchor_text(anchor, actions)


def _lineage_step_summary(lineage: dict[str, Any]) -> str:
    step_rows = lineage.get("step_rows", []) if isinstance(lineage.get("step_rows", []), list) else []
    if not step_rows:
        return ""
    parts: list[str] = []
    for step_row in step_rows[:4]:
        if not isinstance(step_row, dict):
            continue
        child = step_row.get("task", {}) if isinstance(step_row.get("task", {}), dict) else {}
        step_name = str(step_row.get("step", "") or child.get("phase", "") or child.get("id", "") or "step").strip()
        status = _task_status_label(child)
        parts.append(f"{step_name}({status})")
    if len(step_rows) > 4:
        parts.append(f"+{len(step_rows) - 4}")
    return "子步骤：" + " · ".join(parts) if parts else ""


def _append_anchor_section(lines: list[str], title: str, tasks: list[dict], now: datetime, *, limit: int) -> None:
    lines.append(title)
    if not tasks:
        lines.append("(none)")
        lines.append("")
        return
    for task in tasks[:limit]:
        lines.append(_anchor_text(task, now))
        lines.append("")


def render_status_text_compact(snapshot: dict) -> str:
    now = snapshot["now"]
    recent_done_count = len(snapshot["done_recent"])
    recent_failed_count = len(snapshot["failed_recent"])
    stale_queued_count = len(snapshot.get("stale_queued", []))
    problem_tasks = list(snapshot["steer_needed"]) + list(snapshot["failed_recent"])
    system_maintenance = list(snapshot.get("system_active_lineages", [])) + list(snapshot.get("system_running", [])) + list(snapshot.get("system_queued", [])) + list(snapshot.get("system_done_recent", []))
    substrate_summary = summarize_taskflow_substrate(
        list(snapshot["running"])
        + list(snapshot["queued"])
        + list(snapshot["pending"])
        + list(snapshot["done_recent"])
        + [lineage.get("parent", {}) for lineage in snapshot.get("active_lineages", []) if isinstance(lineage.get("parent", {}), dict)]
    )
    lines = [
        "🐙 八爪鱼（OctoClaw）任务收件箱",
        (
            f"流程 {len(snapshot['active_lineages'])} | 运行中 {len(snapshot['running'])} | "
            f"排队 {len(snapshot['queued'])} | 待确认 {len(snapshot['pending'])} | "
            f"异常 {len(problem_tasks)} | 近期完成 {recent_done_count}"
        ),
        render_taskflow_substrate_summary(substrate_summary),
        "",
    ]

    if snapshot["active_lineages"]:
        lines.append(f"🕸️ 协作流程（{len(snapshot['active_lineages'])}个）")
        for lineage in snapshot["active_lineages"][:4]:
            parent = lineage.get("parent", {}) if isinstance(lineage.get("parent", {}), dict) else {}
            if not parent:
                continue
            lines.append(_anchor_text(parent, now))
            step_summary = _lineage_step_summary(lineage)
            if step_summary:
                lines.append(step_summary)
            lines.append("")

    _append_anchor_section(lines, f"🔵 运行中（{len(snapshot['running'])}个）", snapshot["running"], now, limit=6)
    queued_title = f"⏸️ 排队中（{len(snapshot['queued'])}个）"
    if stale_queued_count:
        queued_title += f" · 已折叠陈旧 {stale_queued_count}"
    _append_anchor_section(lines, queued_title, snapshot["queued"], now, limit=6)
    _append_anchor_section(lines, f"❓ 待确认（{len(snapshot['pending'])}个）", snapshot["pending"], now, limit=4)
    _append_anchor_section(lines, f"⚠️ 异常与恢复（{len(problem_tasks)}个）", problem_tasks, now, limit=6)
    _append_anchor_section(lines, f"✅ 最近完成（{recent_done_count}个）", snapshot["done_recent"], now, limit=4)
    if system_maintenance:
        system_rows: list[dict[str, Any]] = []
        for lineage in snapshot.get("system_active_lineages", [])[:2]:
            parent = lineage.get("parent", {})
            if isinstance(parent, dict):
                system_rows.append(parent)
        system_rows.extend(snapshot.get("system_running", [])[:2])
        system_rows.extend(snapshot.get("system_queued", [])[:2])
        system_rows.extend(snapshot.get("system_done_recent", [])[:3])
        _append_anchor_section(lines, f"⚙️ 系统维护（{len(system_maintenance)}个）", system_rows, now, limit=3)

    if recent_failed_count:
        lines.append(f"📉 最近失败：{recent_failed_count}")

    return "\n".join(lines).rstrip()


def _table_row(columns: list[str], widths: list[int]) -> str:
    cells = []
    for idx, value in enumerate(columns):
        width = widths[idx]
        cells.append(f" {value[:width].ljust(width)} ")
    return "|" + "|".join(cells) + "|"


def _recovery_note(task: dict[str, Any]) -> str:
    resume_state = str(
        ((task.get("session_resume") or {}) if isinstance(task.get("session_resume"), dict) else {}).get("resume_state", "")
        or task.get("resume_state", "")
        or ""
    ).strip()
    session_status = str(task.get("session_status") or "").strip()
    recovery_action = str(task.get("recovery_action") or "").strip()
    return " / ".join(part for part in [f"resume:{resume_state}" if resume_state else "", recovery_action, session_status] if part)[:18]


def render_status_table(snapshot: dict) -> str:
    now = snapshot["now"]
    rows = []

    for lineage in snapshot["active_lineages"][:8]:
        parent = lineage["parent"]
        rows.append(
            [
                ("team: " + preferred_task_title(parent, limit=16))[:22],
                "协作流",
                table_model(parent.get("model", "")),
                _task_status_label(parent)[:8],
                (_lineage_progress_text(lineage) + (f" · {operator_hint(parent, 12)}" if operator_hint(parent, 12) else ""))[:18],
            ]
        )
        for step_row in lineage.get("step_rows", [])[:3]:
            child = step_row["task"]
            step_name = str(step_row.get("step", "") or child.get("phase", "") or _task_id(child) or "step").strip()
            rows.append(
                [
                    ("↳ " + step_name)[:22],
                    task_role_name(child)[:8],
                    table_model(child.get("model", "")),
                    _task_status_label(child)[:8],
                    preferred_task_title(child, limit=18),
                ]
            )

    for group_name, tasks, status_text in (
        ("run", snapshot["running"], "run"),
        ("queued", snapshot["queued"], "queued"),
        ("pending", snapshot["pending"], "pending"),
        ("recover", snapshot["steer_needed"], "steer"),
    ):
        for task in tasks[:16]:
            if group_name == "queued":
                note = _recovery_note(task) or ("deps:" + ",".join(task.get("deps", [])[:2]))
            elif group_name == "recover":
                note = _recovery_note(task)
            else:
                note = format_duration(task.get("started_at") or task.get("spawned_at") or "", now)
            rows.append(
                [
                    preferred_task_title(task, limit=22),
                    task_role_name(task)[:8],
                    table_model(task.get("model", "")),
                    status_text,
                    (note + (f" · {operator_hint(task, 10)}" if operator_hint(task, 10) else ""))[:18],
                ]
            )

    widths = [22, 8, 8, 8, 18]
    border = "+" + "+".join("-" * (w + 2) for w in widths) + "+"
    lines = [
        "🐙 八爪鱼（OctoClaw）状态",
        border,
        _table_row(["Task", "Role", "Model", "Status", "Note"], widths),
        border,
    ]
    if rows:
        lines.extend(_table_row(row, widths) for row in rows)
    else:
        lines.append(_table_row(["(no active tasks)", "", "", "", ""], widths))
    lines.append(border)
    return "\n".join(lines)


def render_status_lanes(snapshot: dict) -> str:
    now = snapshot["now"]
    lane_map = [
        (
            "Runner lane",
            [task for task in snapshot["running"] + snapshot["queued"] if is_runner_task(task)],
        ),
        (
            "Build lane",
            [
                task
                for task in snapshot["running"] + snapshot["queued"]
                if not is_runner_task(task) and resolve_worker_pool(task) in ("octoclaw-code", "octoclaw-review")
            ],
        ),
        (
            "Research lane",
            [
                task
                for task in snapshot["running"] + snapshot["queued"]
                if not is_runner_task(task) and resolve_worker_pool(task) == "octoclaw-research"
            ],
        ),
        ("Recovery", snapshot["steer_needed"]),
    ]

    def lane_line(task: dict) -> str:
        name = preferred_task_title(task, limit=26)
        status = task.get("status", "?")
        if task in snapshot["steer_needed"]:
            status = "needs-steer"
        if task.get("status") == "queued":
            note = "deps"
        else:
            note = format_duration(task.get("started_at") or task.get("spawned_at") or "", now)
        op_hint = operator_hint(task, 18)
        suffix = f" · {op_hint}" if op_hint else ""
        return f"  └─ {name:<26} [{status:<11}] {note}{suffix}"

    lines = [
        "🐙 八爪鱼（OctoClaw）",
        "",
        "Main",
        "  └─ orchestration active",
        "",
        "Team lane",
    ]
    if snapshot["active_lineages"]:
        for lineage in snapshot["active_lineages"][:4]:
            parent = lineage["parent"]
            parent_name = preferred_task_title(parent, limit=24)
            parent_hint = operator_hint(parent, 18)
            suffix = f" · {parent_hint}" if parent_hint else ""
            lines.append(f"  └─ {parent_name:<24} [{_task_status_label(parent):<11}] {_lineage_progress_text(lineage)}{suffix}")
            step_rows = lineage.get("step_rows", [])
            for idx, step_row in enumerate(step_rows[:3]):
                child = step_row["task"]
                step_name = str(step_row.get("step", "") or child.get("phase", "") or _task_id(child) or "step").strip()
                branch = "└" if idx == min(len(step_rows), 3) - 1 else "├"
                lines.append(
                    f"      {branch} {step_name:<18} [{_task_status_label(child):<11}] "
                    f"{preferred_task_title(child, limit=24)}"
                )
            if len(step_rows) > 3:
                lines.append(f"      └ … 其余 {len(step_rows) - 3} 个子步骤")
    else:
        lines.append("  └─ idle")

    for title, tasks in lane_map:
        lines.extend(["", title])
        if tasks:
            lines.extend(lane_line(task) for task in tasks[:6])
        else:
            lines.append("  └─ idle")
    return "\n".join(lines)


def render_status_task_anchors(snapshot: dict) -> str:
    now = snapshot["now"]
    lines = ["🐙 八爪鱼（OctoClaw）任务锚点", ""]

    sections: list[tuple[str, list[dict[str, Any]], int]] = []
    lineage_parents = [
        lineage.get("parent", {})
        for lineage in snapshot.get("active_lineages", [])[:6]
        if isinstance(lineage.get("parent", {}), dict)
    ]
    if lineage_parents:
        sections.append((f"🕸️ 协作流（{len(lineage_parents)}个）", lineage_parents, 6))
    sections.extend(
        [
            (f"🔵 运行中（{len(snapshot.get('running', []))}个）", snapshot.get("running", []), 8),
            (f"✅ 最近完成（{len(snapshot.get('done_recent', []))}个，30m）", snapshot.get("done_recent", []), 4),
            (f"⏸️ 排队中（{len(snapshot.get('queued', []))}个）", snapshot.get("queued", []), 8),
            (f"❓ 待确认（{len(snapshot.get('pending', []))}个）", snapshot.get("pending", []), 4),
            (f"⚠️ 异常与恢复（{len(snapshot.get('steer_needed', [])) + len(snapshot.get('failed_recent', []))}个）", list(snapshot.get("steer_needed", [])) + list(snapshot.get("failed_recent", [])), 6),
        ]
    )
    system_done_recent = snapshot.get("system_done_recent", []) if isinstance(snapshot.get("system_done_recent", []), list) else []
    if system_done_recent:
        sections.append((f"⚙️ 系统维护（{len(system_done_recent)}个近期完成）", system_done_recent, 2))

    rendered_sections: list[str] = []
    for title, tasks, limit in sections:
        task_list = [task for task in tasks if isinstance(task, dict)]
        if not task_list:
            continue
        rendered_sections.append(title)
        for task in task_list[:limit]:
            anchor = build_task_anchor(task, now=now)
            actions = build_task_actions(task)
            rendered_sections.append(render_task_anchor_text(anchor, actions))
            rendered_sections.append("")

    stale_queued = snapshot.get("stale_queued", []) if isinstance(snapshot.get("stale_queued", []), list) else []
    if stale_queued:
        rendered_sections.append(f"🗃️ 已折叠陈旧排队（{len(stale_queued)}个）")
        rendered_sections.append("这些通常是旧的 mirror-only queued 记录；默认不再占用主面板。")

    if not rendered_sections:
        lines.append("(no visible task anchors)")
        return "\n".join(lines)

    lines.append("\n".join(rendered_sections).rstrip())
    return "\n".join(lines).rstrip()
