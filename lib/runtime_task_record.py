#!/usr/bin/env python3
"""Shared runtime task record helpers for OctoClaw."""

from __future__ import annotations

from typing import Any


TASK_RECORD_SCHEMA_VERSION = "octoclaw.runtime_task.record/v1"

LABEL_TO_WORK_TYPE = {
    "octopus-runner": "ops",
    "octoclaw-runner": "ops",
    "octopus-fix": "code",
    "octopus-test": "review",
    "octopus-scout": "research",
    "octopus-analyze": "research",
    "octopus-writer": "research",
}

LABEL_TO_PHASE = {
    "octopus-runner": "inspect",
    "octoclaw-runner": "inspect",
    "octopus-fix": "implement",
    "octopus-test": "verify",
    "octopus-scout": "collect",
    "octopus-analyze": "inspect",
    "octopus-writer": "report",
}

WORK_TYPE_TO_POOL = {
    "ops": "octoclaw-runner",
    "research": "octoclaw-research",
    "code": "octoclaw-code",
    "review": "octoclaw-review",
}


def compact_text(text: str, limit: int = 120) -> str:
    collapsed = " ".join(str(text or "").strip().split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 1].rstrip() + "…"


def _normalized_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return []


def _normalized_str(value: Any) -> str:
    return str(value or "").strip()


def _normalized_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    return text in {"1", "true", "yes", "on"}


def infer_executor(task: dict[str, Any]) -> str:
    explicit = _normalized_str(task.get("executor"))
    if explicit:
        return explicit
    route = _normalized_str(task.get("route"))
    runtime = _normalized_str(task.get("runtime"))
    label = _normalized_str(task.get("label"))
    if route == "spawn_multi":
        return "team"
    if route == "runner" or runtime == "runner" or label in {"octopus-runner", "octoclaw-runner"}:
        return "runner"
    if route in {"spawn_single", "spawn_multi"} or runtime in {"subagent", "acp"}:
        return "subagent"
    return ""


def infer_executor_type(task: dict[str, Any]) -> str:
    explicit = _normalized_str(task.get("executor_type"))
    if explicit:
        return explicit
    route = _normalized_str(task.get("route"))
    executor = infer_executor(task)
    if route == "runner" or executor == "runner":
        return "runner"
    if route == "spawn_multi":
        return "team"
    if route == "spawn_single" or executor == "subagent":
        return "subagent"
    if route == "direct":
        return "main"
    return "unknown"


def infer_work_type(task: dict[str, Any]) -> str:
    explicit = _normalized_str(task.get("work_type"))
    if explicit:
        return explicit
    route = _normalized_str(task.get("route"))
    label = _normalized_str(task.get("label"))
    if route == "runner":
        return "ops"
    return LABEL_TO_WORK_TYPE.get(label, "")


def infer_phase(task: dict[str, Any], work_type: str) -> str:
    explicit = _normalized_str(task.get("phase"))
    if explicit:
        return explicit
    route = _normalized_str(task.get("route"))
    label = _normalized_str(task.get("label"))
    if route == "runner":
        return "inspect"
    if work_type == "review":
        return "verify"
    return LABEL_TO_PHASE.get(label, "")


def infer_worker_pool(task: dict[str, Any], work_type: str) -> str:
    explicit = _normalized_str(task.get("worker_pool"))
    if explicit:
        return explicit
    route = _normalized_str(task.get("route"))
    executor = infer_executor(task)
    if route == "runner" or executor == "runner":
        return "octoclaw-runner"
    return WORK_TYPE_TO_POOL.get(work_type, "")


def infer_runtime(task: dict[str, Any]) -> str:
    explicit = _normalized_str(task.get("runtime"))
    if explicit:
        return explicit
    route = _normalized_str(task.get("route"))
    executor = infer_executor(task)
    if route == "runner" or executor == "runner":
        return "runner"
    if route in {"spawn_single", "spawn_multi"} or executor == "subagent":
        return "subagent"
    return ""


def infer_title(task: dict[str, Any]) -> str:
    for field in ("title", "task_description", "summary", "id"):
        value = compact_text(_normalized_str(task.get(field)))
        if value:
            return value
    return "untitled-task"


def merge_artifacts(task: dict[str, Any]) -> dict[str, Any]:
    raw = task.get("artifacts")
    artifacts = dict(raw) if isinstance(raw, dict) else {}
    report_path = _normalized_str(task.get("report_path"))
    context_path = _normalized_str(task.get("context_path"))
    context_summary = _normalized_str(task.get("context_summary"))
    files_changed = _normalized_list(task.get("files_changed"))

    if report_path:
        artifacts["report_path"] = report_path
    if context_path:
        artifacts["context_path"] = context_path
    if context_summary:
        artifacts["context_summary"] = context_summary
    if files_changed:
        artifacts["files_changed"] = files_changed
    return artifacts


def normalize_task_record(task: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(task, dict):
        return {}

    normalized = dict(task)
    normalized["id"] = _normalized_str(normalized.get("id"))
    normalized["schema_version"] = TASK_RECORD_SCHEMA_VERSION
    normalized["title"] = infer_title(normalized)
    normalized["status"] = _normalized_str(normalized.get("status"))
    normalized["source"] = _normalized_str(normalized.get("source")) or "octopus"
    normalized["route"] = _normalized_str(normalized.get("route"))
    normalized["runtime"] = infer_runtime(normalized)
    normalized["executor"] = infer_executor(normalized)
    normalized["executor_type"] = infer_executor_type(normalized)
    normalized["task_kind"] = _normalized_str(normalized.get("task_kind"))
    work_type = infer_work_type(normalized)
    normalized["work_type"] = work_type
    normalized["phase"] = infer_phase(normalized, work_type)
    normalized["worker_pool"] = infer_worker_pool(normalized, work_type)
    normalized["protocol"] = _normalized_str(normalized.get("protocol")) or "normal"
    normalized["profile"] = _normalized_str(normalized.get("profile"))
    normalized["review_required"] = _normalized_bool(normalized.get("review_required"))
    normalized["label"] = _normalized_str(normalized.get("label"))
    normalized["owner"] = _normalized_str(normalized.get("owner"))
    normalized["tier"] = _normalized_str(normalized.get("tier"))
    normalized["model"] = _normalized_str(normalized.get("model"))
    normalized["summary"] = _normalized_str(normalized.get("summary"))
    normalized["task_description"] = _normalized_str(normalized.get("task_description"))
    normalized["parent_id"] = _normalized_str(normalized.get("parent_id"))
    normalized["deps"] = _normalized_list(normalized.get("deps"))
    normalized["child_ids"] = _normalized_list(normalized.get("child_ids"))
    normalized["report_path"] = _normalized_str(normalized.get("report_path"))
    normalized["context_path"] = _normalized_str(normalized.get("context_path"))
    normalized["context_summary"] = _normalized_str(normalized.get("context_summary"))
    normalized["files_changed"] = _normalized_list(normalized.get("files_changed"))
    normalized["spawned_at"] = _normalized_str(normalized.get("spawned_at"))
    normalized["started_at"] = _normalized_str(normalized.get("started_at"))
    normalized["completed_at"] = _normalized_str(normalized.get("completed_at"))
    normalized["updated_at"] = _normalized_str(normalized.get("updated_at"))
    normalized["session_id"] = _normalized_str(normalized.get("session_id"))
    normalized["run_id"] = _normalized_str(normalized.get("run_id"))
    normalized["session_status"] = _normalized_str(normalized.get("session_status"))
    normalized["last_observed_at"] = _normalized_str(normalized.get("last_observed_at"))
    normalized["recovery_action"] = _normalized_str(normalized.get("recovery_action"))
    retry_count = normalized.get("retry_count")
    normalized["retry_count"] = int(retry_count or 0) if str(retry_count or "").strip() else 0
    normalized["expected_done_at"] = _normalized_str(normalized.get("expected_done_at"))
    normalized["artifacts"] = merge_artifacts(normalized)
    return normalized


def normalize_task_records(tasks: list[Any]) -> list[dict[str, Any]]:
    return [normalize_task_record(task) for task in tasks if isinstance(task, dict)]
