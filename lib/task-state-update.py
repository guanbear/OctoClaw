#!/usr/bin/env python3
from __future__ import annotations

"""
task-state-update.py — atomic task-state.json writer with file lock.
Prevents concurrent sub-agent corruption of task-state.json.
"""

import argparse
import fcntl
import json
import os
import sys
from datetime import datetime, timezone, timedelta

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from clawteam_bridge import sync_task
from notifier import send_task_notification
from runtime_task_record import normalize_task_record, normalize_task_records
from runtime_protocol import normalize_worker_result
from worker_taxonomy import (
    normalize_model_band,
    resolve_executor as taxonomy_resolve_executor,
)

WORKSPACE = os.environ.get("WORKSPACE", "/workspace")
STATE_FILE = f"{WORKSPACE}/tmp/octopus/task-state.json"
PATROL_NOTIFY_STATE_FILE = f"{WORKSPACE}/tmp/octopus/patrol-notify-state.json"


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def load_state(fp) -> dict:
    """Read and parse state file; tolerate bare list or malformed JSON."""
    fp.seek(0)
    raw = fp.read().strip()
    if not raw:
        return {"tasks": [], "updated_at": ""}
    try:
        data = json.loads(raw)
        if isinstance(data, list):
            return {"tasks": data, "updated_at": ""}
        if isinstance(data, dict) and "tasks" in data:
            return data
        return {"tasks": [], "updated_at": ""}
    except json.JSONDecodeError:
        return {"tasks": [], "updated_at": ""}


def save_state(fp, state: dict):
    """Truncate and rewrite the state file."""
    state["tasks"] = normalize_task_records(state.get("tasks", []))
    state["updated_at"] = now_iso()
    fp.seek(0)
    fp.truncate()
    fp.write(json.dumps(state, ensure_ascii=False, indent=2))
    fp.flush()


def cleanup_old(tasks: list) -> list:
    """Remove done/failed/deferred records older than 7 days."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=7)
    result = []
    for t in tasks:
        if t.get("status") in ("done", "failed", "deferred"):
            completed = t.get("completed_at") or t.get("spawned_at") or ""
            if completed:
                try:
                    dt = datetime.fromisoformat(completed)
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=timezone.utc)
                    if dt < cutoff:
                        continue
                except ValueError:
                    pass
        result.append(t)
    return result


def load_notify_state() -> dict:
    try:
        with open(PATROL_NOTIFY_STATE_FILE, "r", encoding="utf-8") as fh:
            loaded = json.load(fh)
            if not isinstance(loaded, dict):
                return {"task_ids": {}, "task_anchor_messages": {}, "updated_at": ""}
            loaded.setdefault("task_ids", {})
            loaded.setdefault("task_anchor_messages", {})
            loaded.setdefault("updated_at", "")
            return loaded
    except Exception:
        return {"task_ids": {}, "task_anchor_messages": {}, "updated_at": ""}


def save_notify_state(state: dict):
    try:
        os.makedirs(os.path.dirname(PATROL_NOTIFY_STATE_FILE), exist_ok=True)
        with open(PATROL_NOTIFY_STATE_FILE, "w", encoding="utf-8") as fh:
            json.dump(state, fh, ensure_ascii=False)
    except Exception:
        return


def resolve_expected_done(value: str) -> str:
    """Convert '+Nmin' / '+Nh' offsets or return as-is."""
    if not value:
        return ""
    if value.startswith("+"):
        offset = value[1:]
        minutes = 0
        if offset.endswith("min"):
            minutes = int(offset[:-3])
        elif offset.endswith("h"):
            minutes = int(offset[:-1]) * 60
        else:
            minutes = int(offset)
        dt = datetime.now(timezone.utc).astimezone() + timedelta(minutes=minutes)
        return dt.isoformat()
    return value


def infer_executor(task: dict, explicit: str = "") -> str:
    if explicit:
        return explicit
    resolved = str(taxonomy_resolve_executor(task) or "").strip().lower()
    return resolved if resolved in {"subagent", "runner", "team", "main"} else "subagent"


def parse_bool_arg(value: str) -> bool:
    text = str(value or "").strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    raise argparse.ArgumentTypeError(f"invalid boolean value: {value}")


def parse_json_arg(value: str) -> dict:
    text = str(value or "").strip()
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise argparse.ArgumentTypeError(f"invalid JSON value: {exc}") from exc
    if isinstance(parsed, dict):
        return parsed
    raise argparse.ArgumentTypeError("JSON value must be an object")


FINAL_STATUSES = {"done", "failed", "deferred", "completed"}
SUCCESS_STATUSES = {"done", "completed"}
ACTIVE_STATUSES = {"running", "in_progress"}
PENDING_STATUSES = {"queued", "dispatched", "pending", "pending_confirm", "blocked"}


def compact_text(text: str, limit: int = 120) -> str:
    collapsed = " ".join(str(text or "").strip().split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 1].rstrip() + "…"


def _task_id_map(tasks: list) -> dict:
    return {str(task.get("id", "") or ""): task for task in tasks if isinstance(task, dict) and str(task.get("id", "") or "").strip()}


def _resolve_child_records(tasks: list, parent: dict) -> tuple[list, list[str]]:
    tasks_by_id = _task_id_map(tasks)
    explicit_child_ids = [str(item).strip() for item in (parent.get("child_ids", []) or []) if str(item).strip()]
    children = []
    seen = set()

    for child_id in explicit_child_ids:
        child = tasks_by_id.get(child_id)
        if child is None:
            continue
        children.append(child)
        seen.add(child_id)

    parent_id = str(parent.get("id", "") or "").strip()
    if parent_id:
        for task in tasks:
            child_parent_id = str(task.get("parent_id", "") or "").strip()
            child_id = str(task.get("id", "") or "").strip()
            if child_parent_id != parent_id or not child_id or child_id in seen:
                continue
            children.append(task)
            seen.add(child_id)

    child_ids = explicit_child_ids or [str(child.get("id", "") or "") for child in children if str(child.get("id", "") or "")]
    return children, child_ids


def _step_task_ids(parent: dict, child_ids: list[str]) -> dict:
    artifacts = parent.get("artifacts", {}) if isinstance(parent.get("artifacts", {}), dict) else {}
    explicit = artifacts.get("step_task_ids", {})
    if isinstance(explicit, dict):
        mapped = {str(step).strip(): str(task_id).strip() for step, task_id in explicit.items() if str(step).strip() and str(task_id).strip()}
        if mapped:
            return mapped
    order = artifacts.get("step_order", [])
    if isinstance(order, list):
        mapped = {}
        for idx, step_name in enumerate(order):
            name = str(step_name).strip()
            if not name or idx >= len(child_ids):
                continue
            task_id = str(child_ids[idx]).strip()
            if task_id:
                mapped[name] = task_id
        return mapped
    return {}


def _status_label(status: str) -> str:
    value = str(status or "").strip().lower()
    mapping = {
        "done": "done",
        "completed": "done",
        "failed": "failed",
        "running": "running",
        "in_progress": "running",
        "queued": "queued",
        "dispatched": "queued",
        "pending": "queued",
        "pending_confirm": "blocked",
        "blocked": "blocked",
        "deferred": "deferred",
    }
    return mapping.get(value, value or "unknown")


def _aggregate_parent_status(children: list[dict]) -> str:
    if not children:
        return ""
    statuses = [str(child.get("status", "") or "").strip().lower() for child in children]
    failed_count = sum(1 for status in statuses if status == "failed")
    done_count = sum(1 for status in statuses if status in SUCCESS_STATUSES)
    deferred_count = sum(1 for status in statuses if status == "deferred")
    running_count = sum(1 for status in statuses if status in ACTIVE_STATUSES)
    open_count = sum(1 for status in statuses if status not in FINAL_STATUSES)
    child_count = len(statuses)

    if failed_count > 0:
        return "failed"
    if child_count > 0 and done_count == child_count:
        return "done"
    if open_count == 0 and deferred_count > 0:
        return "deferred"
    if running_count > 0 or (done_count > 0 and open_count > 0):
        return "running"
    if open_count > 0:
        return "dispatched"
    return ""


def _aggregate_parent_summary(parent: dict, children: list[dict], child_ids: list[str], step_task_ids: dict) -> str:
    status = str(parent.get("status", "") or "").strip().lower()
    step_tokens = []
    tasks_by_id = _task_id_map(children)
    for step_name in (parent.get("artifacts", {}) or {}).get("step_order", []) if isinstance(parent.get("artifacts", {}), dict) else []:
        name = str(step_name).strip()
        task_id = str(step_task_ids.get(name, "") or "").strip()
        child = tasks_by_id.get(task_id)
        if not name or child is None:
            continue
        step_tokens.append(f"{name} {_status_label(child.get('status', ''))}")
    if step_tokens:
        prefix = {
            "done": "spawn_multi complete",
            "failed": "spawn_multi failed",
            "deferred": "spawn_multi deferred",
            "running": "spawn_multi running",
            "dispatched": "spawn_multi planned",
        }.get(status, "spawn_multi update")
        return f"{prefix}: {' · '.join(step_tokens)}"

    status_counts = {}
    for child in children:
        child_status = _status_label(child.get("status", ""))
        status_counts[child_status] = status_counts.get(child_status, 0) + 1

    child_count = len(child_ids)
    done_count = sum(1 for child in children if str(child.get("status", "") or "").strip().lower() in SUCCESS_STATUSES)
    open_count = sum(1 for child in children if str(child.get("status", "") or "").strip().lower() not in FINAL_STATUSES)

    if status == "done":
        return f"spawn_multi complete: {done_count}/{child_count} steps done"
    if status == "failed":
        parts = [f"{count} {name}" for name, count in status_counts.items() if count]
        return f"spawn_multi failed: {' / '.join(parts)}"
    if status == "deferred":
        return f"spawn_multi deferred: {done_count}/{child_count} done / deferred"
    if open_count > 0:
        parts = [f"{done_count}/{child_count} done"]
        for name in ("running", "queued", "blocked"):
            count = status_counts.get(name, 0)
            if count:
                parts.append(f"{count} {name}")
        return f"spawn_multi running: {' · '.join(parts)}"
    return f"spawn_multi planned: {child_count} steps"


def _task_signature(task: dict) -> str:
    normalized = normalize_task_record(dict(task))
    payload = dict(normalized)
    payload.pop("updated_at", None)
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def _default_parent_report_path(task_id: str) -> str:
    task_id = str(task_id or "").strip()
    if not task_id:
        return ""
    return os.path.join(WORKSPACE, "tmp", "octopus", "shared", f"{task_id}.md")


def _report_excerpt(path: str, *, max_lines: int = 20, max_chars: int = 1600) -> str:
    target = str(path or "").strip()
    if not target or not os.path.exists(target):
        return ""
    try:
        with open(target, "r", encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return ""
    excerpt = "\n".join(lines[:max_lines]).strip()
    if len(excerpt) > max_chars:
        excerpt = excerpt[: max_chars - 1].rstrip() + "…"
    return excerpt


def _materialize_parent_report(
    before: dict,
    *,
    status: str,
    summary: str,
    child_ids: list[str],
    child_summaries: dict[str, str],
    child_reports: dict[str, str],
    step_task_ids: dict[str, str],
) -> str:
    parent_id = str(before.get("id", "") or "").strip()
    report_path = str(before.get("report_path", "") or "").strip() or _default_parent_report_path(parent_id)
    if not parent_id or not report_path:
        return ""

    step_by_child = {task_id: step_name for step_name, task_id in step_task_ids.items() if step_name and task_id}
    title = str(before.get("title", "") or before.get("task_description", "") or parent_id).strip()
    lines = [
        f"# OctoClaw Team Result: {title}",
        "",
        f"- Task ID: {parent_id}",
        f"- Status: {status}",
        f"- Summary: {summary or ''}",
        "",
        "## Child Results",
        "",
    ]

    for child_id in child_ids:
        step_name = str(step_by_child.get(child_id, "") or "").strip()
        heading = f"### {step_name}" if step_name else f"### {child_id}"
        child_summary = str(child_summaries.get(child_id, "") or "").strip()
        child_report = str(child_reports.get(child_id, "") or "").strip()
        lines.append(heading)
        if child_summary:
            lines.append("")
            lines.append(child_summary)
        if child_report:
            lines.append("")
            lines.append(f"Report: {child_report}")
            excerpt = _report_excerpt(child_report)
            if excerpt:
                lines.append("")
                lines.append("```md")
                lines.append(excerpt)
                lines.append("```")
        lines.append("")

    try:
        os.makedirs(os.path.dirname(report_path), exist_ok=True)
        with open(report_path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines).rstrip() + "\n")
    except OSError:
        return ""
    return report_path


def _aggregate_parent_record(tasks: list, parent: dict) -> dict | None:
    task_kind = str(parent.get("task_kind", "") or "").strip()
    has_children = bool(parent.get("child_ids"))
    if task_kind != "team_parent" and not has_children:
        return None

    children, child_ids = _resolve_child_records(tasks, parent)
    if not child_ids:
        return None

    before = normalize_task_record(dict(parent))
    candidate = dict(before)
    artifacts = dict(before.get("artifacts", {}) or {})
    tasks_by_id = _task_id_map(children)
    step_task_ids = _step_task_ids(before, child_ids)
    step_statuses = {}
    step_summaries = {}
    step_reports = dict(artifacts.get("step_reports", {}) or {})

    child_statuses = {}
    child_reports = {}
    child_summaries = {}
    child_worker_results = {}
    completed_child_ids = []
    failed_child_ids = []
    open_child_ids = []

    for child_id in child_ids:
        child = tasks_by_id.get(child_id)
        if child is None:
            continue
        status = str(child.get("status", "") or "").strip()
        summary = compact_text(child.get("summary", ""), 200)
        report_path = str(child.get("report_path", "") or "").strip()
        child_artifacts = child.get("artifacts", {}) if isinstance(child.get("artifacts", {}), dict) else {}
        worker_result = child_artifacts.get("worker_result") if isinstance(child_artifacts.get("worker_result"), dict) else None
        child_statuses[child_id] = status
        child_reports[child_id] = report_path
        child_summaries[child_id] = summary
        if worker_result:
            child_worker_results[child_id] = worker_result
        lowered = status.lower()
        if lowered in SUCCESS_STATUSES:
            completed_child_ids.append(child_id)
        elif lowered == "failed":
            failed_child_ids.append(child_id)
        elif lowered not in {"deferred", "completed"}:
            open_child_ids.append(child_id)

    for step_name, child_id in step_task_ids.items():
        child = tasks_by_id.get(child_id)
        if child is None:
            continue
        child_artifacts = child.get("artifacts", {}) if isinstance(child.get("artifacts", {}), dict) else {}
        worker_result = child_artifacts.get("worker_result") if isinstance(child_artifacts.get("worker_result"), dict) else None
        step_statuses[step_name] = str(child.get("status", "") or "")
        step_summaries[step_name] = compact_text(child.get("summary", ""), 160)
        report_path = str(child.get("report_path", "") or "").strip()
        if report_path:
            step_reports[step_name] = report_path
        if worker_result:
            step_reports.setdefault(step_name, str(worker_result.get("report", "") or report_path))

    derived_status = _aggregate_parent_status([tasks_by_id[child_id] for child_id in child_ids if child_id in tasks_by_id]) or str(before.get("status", "") or "dispatched")
    candidate["status"] = derived_status
    candidate["summary"] = _aggregate_parent_summary(candidate, [tasks_by_id[child_id] for child_id in child_ids if child_id in tasks_by_id], child_ids, step_task_ids)
    candidate["child_ids"] = child_ids

    artifacts.update(
        {
            "child_task_ids": child_ids,
            "child_count": len(child_ids),
            "child_statuses": child_statuses,
            "child_reports": child_reports,
            "child_summaries": child_summaries,
            "child_worker_results": child_worker_results,
            "completed_child_ids": completed_child_ids,
            "failed_child_ids": failed_child_ids,
            "open_child_ids": open_child_ids,
            "completed_child_count": len(completed_child_ids),
            "failed_child_count": len(failed_child_ids),
            "open_child_count": len(open_child_ids),
            "step_task_ids": step_task_ids,
            "step_statuses": step_statuses,
            "step_summaries": step_summaries,
            "step_reports": step_reports,
            "step_worker_results": {
                step_name: child_worker_results[child_id]
                for step_name, child_id in step_task_ids.items()
                if child_id in child_worker_results
            },
        }
    )
    if derived_status in {"done", "failed"}:
        parent_report_path = _materialize_parent_report(
            before,
            status=derived_status,
            summary=str(candidate.get("summary", "") or ""),
            child_ids=child_ids,
            child_summaries=child_summaries,
            child_reports=child_reports,
            step_task_ids=step_task_ids,
        )
        if parent_report_path:
            candidate["report_path"] = parent_report_path
        child_report_paths = [
            path
            for path in [str(child_reports.get(child_id, "") or "").strip() for child_id in child_ids]
            if path
        ]
        parent_result = normalize_worker_result(
            {
                "task_id": str(before.get("id", "") or ""),
                "status": derived_status,
                "summary": candidate.get("summary", ""),
                "report": str(candidate.get("report_path", "") or before.get("report_path", "") or ""),
                "artifacts": child_report_paths,
                "risks": [f"failed child: {child_id}" for child_id in failed_child_ids],
                "next_step": "none" if derived_status == "done" else "inspect child reports and retry or replan",
            },
            task_id=str(before.get("id", "") or ""),
            default_report=str(candidate.get("report_path", "") or before.get("report_path", "") or ""),
        )
        artifacts["worker_result"] = parent_result
    candidate["artifacts"] = artifacts

    if derived_status in {"done", "failed", "deferred"}:
        candidate["completed_at"] = str(before.get("completed_at", "") or now_iso())
    else:
        candidate["completed_at"] = ""
    if derived_status == "running" and not str(before.get("started_at", "") or "").strip():
        candidate["started_at"] = now_iso()

    normalized_candidate = normalize_task_record(candidate)
    if _task_signature(before) == _task_signature(normalized_candidate):
        return None
    normalized_candidate["updated_at"] = now_iso()
    return normalized_candidate


def _lineage_sync_records(tasks: list, current_record: dict) -> tuple[dict, list[tuple[dict, str]]]:
    tasks_by_id = _task_id_map(tasks)
    current_id = str(current_record.get("id", "") or "").strip()
    updated_current = dict(current_record)
    sync_records: list[tuple[dict, str]] = []
    visited = set()
    target_ids = []

    if str(current_record.get("task_kind", "") or "").strip() == "team_parent" or current_record.get("child_ids"):
        target_ids.append(current_id)

    parent_id = str(current_record.get("parent_id", "") or "").strip()
    while parent_id and parent_id not in visited:
        visited.add(parent_id)
        target_ids.append(parent_id)
        parent = tasks_by_id.get(parent_id)
        if not isinstance(parent, dict):
            break
        parent_id = str(parent.get("parent_id", "") or "").strip()

    for target_id in target_ids:
        target = tasks_by_id.get(target_id)
        if not isinstance(target, dict):
            continue
        previous_status = str(target.get("status", "") or "")
        aggregated = _aggregate_parent_record(tasks, target)
        if not isinstance(aggregated, dict):
            continue
        target.clear()
        target.update(aggregated)
        if target_id == current_id:
            updated_current = dict(target)
        sync_records.append((dict(target), previous_status))

    extra_syncs = [(record, previous_status) for record, previous_status in sync_records if str(record.get("id", "") or "") != current_id]
    return updated_current, extra_syncs


def _sync_event_type(record: dict, previous_status: str, fallback: str = "upsert") -> str:
    status = str(record.get("status", "") or "").strip().lower()
    if status in {"done", "failed", "deferred"} and status != str(previous_status or "").strip().lower():
        return status
    return fallback


def _should_seed_task_anchor(record: dict, previous_status: str, anchor_messages: dict) -> bool:
    task_id = str(record.get("id", "") or "").strip()
    session_key = str(record.get("session_key", "") or "").strip()
    status = str(record.get("status", "") or "").strip().lower()
    route = str(record.get("route", "") or "").strip().lower()
    if not task_id or not session_key:
        return False
    if route == "direct":
        return False
    if status not in {"queued", "dispatched", "running", "blocked", "needs_approval"}:
        return False
    if str(previous_status or "").strip():
        return False
    if isinstance(anchor_messages.get(task_id), dict) and str(anchor_messages[task_id].get("message_id", "") or "").strip():
        return False
    return True


def _seed_task_anchor(record: dict, previous_status: str) -> dict:
    notify_state = load_notify_state()
    anchor_messages = notify_state.get("task_anchor_messages", {})
    if not isinstance(anchor_messages, dict):
        anchor_messages = {}
    if not _should_seed_task_anchor(record, previous_status, anchor_messages):
        return {"ok": False, "skipped": True}

    try:
        result = send_task_notification(record)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    if not result.get("ok"):
        return result

    task_id = str(record.get("id", "") or "").strip()
    message_id = str(result.get("message_id", "") or result.get("messageId", "") or "").strip()
    anchor_messages[task_id] = {
        "backend": str(result.get("backend", "") or ""),
        "message_id": message_id,
        "updated_at": now_iso(),
    }
    notify_state["task_anchor_messages"] = anchor_messages
    notify_state["updated_at"] = now_iso()
    save_notify_state(notify_state)
    return {
        "ok": True,
        "backend": str(result.get("backend", "") or ""),
        "message_id": message_id,
        "action": str(result.get("action", "send") or "send"),
    }


def cmd_upsert(args):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    lineage_syncs = []
    model_band_arg = normalize_model_band(getattr(args, "model_band", "") or "", default="")
    with open(STATE_FILE, "a+") as fp:
        fcntl.flock(fp, fcntl.LOCK_EX)
        state = load_state(fp)
        tasks = state["tasks"]
        previous_status = ""
        current_record = None

        # Find existing task by id
        existing = next((t for t in tasks if t.get("id") == args.id), None)

        if existing:
            previous_status = str(existing.get("status", "") or "")
            # Update fields if provided
            existing.pop("label", None)
            existing.pop("legacy_label", None)
            if args.model:
                existing["model"] = args.model
            if args.status:
                old_status = existing.get("status", "")
                existing["status"] = args.status
                if args.status == "running" and old_status != "running":
                    existing["started_at"] = now_iso()
            if args.summary:
                existing["summary"] = args.summary
            if args.files:
                existing["files_changed"] = [f.strip() for f in args.files.split(",") if f.strip()]
            if args.deps:
                existing["deps"] = [d.strip() for d in args.deps.split(",") if d.strip()]
            if args.expected_done:
                existing["expected_done_at"] = resolve_expected_done(args.expected_done)
            if model_band_arg:
                existing["model_band"] = model_band_arg
            existing.pop("tier", None)
            if args.task_description:
                existing["task_description"] = args.task_description
            if args.source:
                existing["source"] = args.source
            if args.session_id:
                existing["session_id"] = args.session_id
            if args.session_key:
                existing["session_key"] = args.session_key
            if args.run_id:
                existing["run_id"] = args.run_id
            if args.session_status:
                existing["session_status"] = args.session_status
            if args.agent_id:
                existing["agent_id"] = args.agent_id
            if args.agent_namespace:
                existing["agent_namespace"] = args.agent_namespace
            if args.managed_by_octoclaw is not None:
                existing["managed_by_octoclaw"] = args.managed_by_octoclaw
            if args.last_observed_at:
                existing["last_observed_at"] = resolve_expected_done(args.last_observed_at)
            if args.recovery_action:
                existing["recovery_action"] = args.recovery_action
            if args.retry_count is not None:
                existing["retry_count"] = args.retry_count
            if args.owner:
                existing["owner"] = args.owner
            if args.route:
                existing["route"] = args.route
            if args.runtime:
                existing["runtime"] = args.runtime
            if args.parent_id:
                existing["parent_id"] = args.parent_id
            if args.child_ids:
                existing["child_ids"] = [item.strip() for item in args.child_ids.split(",") if item.strip()]
            if args.report_path:
                existing["report_path"] = args.report_path
            if args.context_path:
                existing["context_path"] = args.context_path
            if args.context_summary:
                existing["context_summary"] = args.context_summary
            if args.task_kind:
                existing["task_kind"] = args.task_kind
            if args.title:
                existing["title"] = args.title
            if args.worker_pool:
                existing["worker_pool"] = args.worker_pool
            if args.work_type:
                existing["work_type"] = args.work_type
            if args.phase:
                existing["phase"] = args.phase
            if args.protocol:
                existing["protocol"] = args.protocol
            if args.profile:
                existing["profile"] = args.profile
            if args.review_required is not None:
                existing["review_required"] = args.review_required
            if args.artifacts_json:
                artifacts = existing.get("artifacts", {})
                if not isinstance(artifacts, dict):
                    artifacts = {}
                artifacts.update(args.artifacts_json)
                existing["artifacts"] = artifacts
            if args.executor or not existing.get("executor") or args.route or args.runtime or args.worker_pool or args.task_kind:
                existing["executor"] = infer_executor(existing, args.executor or "")
            existing["updated_at"] = now_iso()
            normalized = normalize_task_record(existing)
            existing.clear()
            existing.update(normalized)
            current_record = dict(existing)
        else:
            record = {
                "id": args.id,
                "model": args.model or "",
                "status": args.status or "dispatched",
                "summary": args.summary or "",
                "spawned_at": now_iso(),
                "updated_at": now_iso(),
            }
            if args.status == "running":
                record["started_at"] = now_iso()
            if args.files:
                record["files_changed"] = [f.strip() for f in args.files.split(",") if f.strip()]
            if args.deps:
                record["deps"] = [d.strip() for d in args.deps.split(",") if d.strip()]
            if args.expected_done:
                record["expected_done_at"] = resolve_expected_done(args.expected_done)
            if model_band_arg:
                record["model_band"] = model_band_arg
            if args.task_description:
                record["task_description"] = args.task_description
            record["source"] = args.source if args.source else "octoclaw"
            if args.session_id:
                record["session_id"] = args.session_id
            if args.session_key:
                record["session_key"] = args.session_key
            if args.run_id:
                record["run_id"] = args.run_id
            if args.session_status:
                record["session_status"] = args.session_status
            if args.agent_id:
                record["agent_id"] = args.agent_id
            if args.agent_namespace:
                record["agent_namespace"] = args.agent_namespace
            if args.managed_by_octoclaw is not None:
                record["managed_by_octoclaw"] = args.managed_by_octoclaw
            if args.last_observed_at:
                record["last_observed_at"] = resolve_expected_done(args.last_observed_at)
            if args.recovery_action:
                record["recovery_action"] = args.recovery_action
            if args.retry_count is not None:
                record["retry_count"] = args.retry_count
            if args.owner:
                record["owner"] = args.owner
            if args.route:
                record["route"] = args.route
            if args.runtime:
                record["runtime"] = args.runtime
            if args.parent_id:
                record["parent_id"] = args.parent_id
            if args.child_ids:
                record["child_ids"] = [item.strip() for item in args.child_ids.split(",") if item.strip()]
            if args.report_path:
                record["report_path"] = args.report_path
            if args.context_path:
                record["context_path"] = args.context_path
            if args.context_summary:
                record["context_summary"] = args.context_summary
            if args.task_kind:
                record["task_kind"] = args.task_kind
            if args.title:
                record["title"] = args.title
            if args.worker_pool:
                record["worker_pool"] = args.worker_pool
            if args.work_type:
                record["work_type"] = args.work_type
            if args.phase:
                record["phase"] = args.phase
            if args.protocol:
                record["protocol"] = args.protocol
            if args.profile:
                record["profile"] = args.profile
            if args.review_required is not None:
                record["review_required"] = args.review_required
            if args.artifacts_json:
                record["artifacts"] = dict(args.artifacts_json)
            record["executor"] = infer_executor(record, args.executor or "")
            tasks.append(record)
            current_record = normalize_task_record(record)
            tasks[-1] = dict(current_record)

        current_record, lineage_syncs = _lineage_sync_records(tasks, current_record or {})
        state["tasks"] = tasks
        save_state(fp, state)
    if current_record:
        sync_task(current_record, event_type="upsert", previous_status=previous_status)
        _seed_task_anchor(current_record, previous_status)
    for record, record_previous_status in lineage_syncs:
        sync_task(record, event_type=_sync_event_type(record, record_previous_status), previous_status=record_previous_status)
    print(f"[ok] upsert id={args.id} status={args.status or 'dispatched'}")


def cmd_done(args):
    _finish(
        args.id,
        "done",
        args.summary,
        report_path=args.report_path,
        artifacts_json=args.artifacts_json,
    )


def cmd_failed(args):
    _finish(
        args.id,
        "failed",
        args.summary,
        report_path=args.report_path,
        artifacts_json=args.artifacts_json,
    )


def _finish(task_id: str, status: str, summary: str, *, report_path: str = "", artifacts_json: dict | None = None):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    lineage_syncs = []
    with open(STATE_FILE, "a+") as fp:
        fcntl.flock(fp, fcntl.LOCK_EX)
        state = load_state(fp)
        tasks = state["tasks"]
        previous_status = ""
        current_record = None

        existing = next((t for t in tasks if t.get("id") == task_id), None)
        if existing:
            previous_status = str(existing.get("status", "") or "")
            existing["status"] = status
            existing["completed_at"] = now_iso()
            existing["updated_at"] = now_iso()
            if summary:
                existing["summary"] = summary
            if report_path:
                existing["report_path"] = report_path
            if artifacts_json:
                artifacts = existing.get("artifacts", {})
                if not isinstance(artifacts, dict):
                    artifacts = {}
                artifacts.update(artifacts_json)
                existing["artifacts"] = artifacts
            normalized = normalize_task_record(existing)
            existing.clear()
            existing.update(normalized)
            current_record = dict(existing)
        else:
            record = {
                "id": task_id,
                "status": status,
                "summary": summary or "",
                "completed_at": now_iso(),
                "spawned_at": now_iso(),
                "updated_at": now_iso(),
            }
            if report_path:
                record["report_path"] = report_path
            if artifacts_json:
                record["artifacts"] = dict(artifacts_json)
            tasks.append(record)
            current_record = normalize_task_record(record)
            tasks[-1] = dict(current_record)

        current_record, lineage_syncs = _lineage_sync_records(tasks, current_record or {})
        # Clean up old done/failed records
        state["tasks"] = cleanup_old(tasks)
        save_state(fp, state)
    if current_record:
        sync_task(current_record, event_type=status, previous_status=previous_status)
    for record, record_previous_status in lineage_syncs:
        sync_task(record, event_type=_sync_event_type(record, record_previous_status), previous_status=record_previous_status)
    print(f"[ok] {status} id={task_id}")


def cmd_list(args):
    if not os.path.exists(STATE_FILE):
        print("(no task-state.json found)")
        return
    with open(STATE_FILE, "r") as fp:
        fcntl.flock(fp, fcntl.LOCK_SH)
        state = load_state(fp)

    tasks = state.get("tasks", [])
    if not tasks:
        print("(no tasks)")
        return

    STATUS_ICON = {
        "dispatched": "🟡",
        "running":    "🔵",
        "done":       "✅",
        "failed":     "❌",
        "queued":     "⏸️",
        "pending_confirm": "❓",
        "deferred":   "⏳",
    }

    print(f"{'ID':<35} {'STATUS':<12} {'MODEL':<20} {'SUMMARY'}")
    print("-" * 90)
    for t in tasks:
        icon = STATUS_ICON.get(t.get("status", ""), "❔")
        sid = (t.get("id") or "")[:34]
        status = f"{icon} {t.get('status','')}"
        model = (t.get("model") or "")[:19]
        summary = (t.get("summary") or "")[:50]
        print(f"{sid:<35} {status:<14} {model:<20} {summary}")


def main():
    parser = argparse.ArgumentParser(description="Atomic task-state.json updater")
    sub = parser.add_subparsers(dest="command")

    # upsert
    p_upsert = sub.add_parser("upsert")
    p_upsert.add_argument("--id", required=True)
    p_upsert.add_argument("--model")
    p_upsert.add_argument("--status")
    p_upsert.add_argument("--summary")
    p_upsert.add_argument("--files")
    p_upsert.add_argument("--deps")
    p_upsert.add_argument("--expected-done", dest="expected_done")
    p_upsert.add_argument("--model-band", dest="model_band")
    p_upsert.add_argument("--task-description", dest="task_description")
    p_upsert.add_argument("--source")
    p_upsert.add_argument("--session-id", dest="session_id")
    p_upsert.add_argument("--session-key", dest="session_key")
    p_upsert.add_argument("--run-id", dest="run_id")
    p_upsert.add_argument("--session-status", dest="session_status")
    p_upsert.add_argument("--agent-id", dest="agent_id")
    p_upsert.add_argument("--agent-namespace", dest="agent_namespace")
    p_upsert.add_argument("--managed-by-octoclaw", dest="managed_by_octoclaw", type=parse_bool_arg)
    p_upsert.add_argument("--last-observed-at", dest="last_observed_at")
    p_upsert.add_argument("--recovery-action", dest="recovery_action")
    p_upsert.add_argument("--retry-count", dest="retry_count", type=int)
    p_upsert.add_argument("--executor", choices=["subagent", "runner", "team", "main"])
    p_upsert.add_argument("--owner")
    p_upsert.add_argument("--route")
    p_upsert.add_argument("--runtime")
    p_upsert.add_argument("--parent-id", dest="parent_id")
    p_upsert.add_argument("--child-ids", dest="child_ids")
    p_upsert.add_argument("--report-path", dest="report_path")
    p_upsert.add_argument("--context-path", dest="context_path")
    p_upsert.add_argument("--context-summary", dest="context_summary")
    p_upsert.add_argument("--task-kind", dest="task_kind")
    p_upsert.add_argument("--title")
    p_upsert.add_argument("--worker-pool", dest="worker_pool")
    p_upsert.add_argument("--work-type", dest="work_type")
    p_upsert.add_argument("--phase")
    p_upsert.add_argument("--protocol")
    p_upsert.add_argument("--profile")
    p_upsert.add_argument("--review-required", dest="review_required", type=parse_bool_arg)
    p_upsert.add_argument("--artifacts-json", dest="artifacts_json", type=parse_json_arg, default={})

    # done
    p_done = sub.add_parser("done")
    p_done.add_argument("--id", required=True)
    p_done.add_argument("--summary", default="")
    p_done.add_argument("--report-path", dest="report_path", default="")
    p_done.add_argument("--artifacts-json", dest="artifacts_json", type=parse_json_arg, default={})

    # failed
    p_failed = sub.add_parser("failed")
    p_failed.add_argument("--id", required=True)
    p_failed.add_argument("--summary", default="")
    p_failed.add_argument("--report-path", dest="report_path", default="")
    p_failed.add_argument("--artifacts-json", dest="artifacts_json", type=parse_json_arg, default={})

    # list
    sub.add_parser("list")

    args = parser.parse_args()
    if args.command == "upsert":
        cmd_upsert(args)
    elif args.command == "done":
        cmd_done(args)
    elif args.command == "failed":
        cmd_failed(args)
    elif args.command == "list":
        cmd_list(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
