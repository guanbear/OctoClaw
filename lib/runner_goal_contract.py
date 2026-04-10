#!/usr/bin/env python3
"""Runner goal contract helpers."""

from __future__ import annotations

from typing import Any


RUNNER_GOAL_CONTRACT_SCHEMA_VERSION = "octoclaw.runner_goal_contract/v1"


def _text(value: Any) -> str:
    return str(value or "").strip()


def _compact_text(value: Any, limit: int = 160) -> str:
    collapsed = " ".join(_text(value).split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 1].rstrip() + "…"


def _route_meta(decision: dict[str, Any] | None) -> dict[str, Any]:
    payload = decision if isinstance(decision, dict) else {}
    route_meta = payload.get("route_decision", {})
    return route_meta if isinstance(route_meta, dict) else {}


def _model_meta(decision: dict[str, Any] | None) -> dict[str, Any]:
    payload = decision if isinstance(decision, dict) else {}
    model_meta = payload.get("model_policy", {})
    return model_meta if isinstance(model_meta, dict) else {}


def build_runner_goal_contract(
    *,
    task: str,
    command: str,
    summary: str = "",
    timeout_seconds: int = 120,
    decision: dict[str, Any] | None = None,
    playbook: dict[str, Any] | None = None,
    session_key: str = "",
    runner_job_id: str = "",
    task_id: str = "",
    taskflow_binding: dict[str, Any] | None = None,
) -> dict[str, Any]:
    route_meta = _route_meta(decision)
    model_meta = _model_meta(decision)
    playbook = playbook if isinstance(playbook, dict) else {}
    probe_spec = playbook.get("probe_spec", {}) if isinstance(playbook.get("probe_spec"), dict) else {}
    binding = taskflow_binding if isinstance(taskflow_binding, dict) else {}
    normalized_task_id = _text(task_id) or _text(runner_job_id)
    normalized_runner_job_id = _text(runner_job_id) or normalized_task_id
    return {
        "schema_version": RUNNER_GOAL_CONTRACT_SCHEMA_VERSION,
        "goal": _text(task),
        "title": _compact_text(summary or task, 120),
        "summary_hint": _text(summary),
        "route": "runner",
        "worker_pool": _text(route_meta.get("worker_pool")) or "octoclaw-runner",
        "work_type": _text(route_meta.get("work_type")) or "ops",
        "phase": _text(route_meta.get("phase")) or "inspect",
        "profile": _text(model_meta.get("profile")) or "ops-fast",
        "model_band": _text(model_meta.get("model_band")) or "fast",
        "execution_contract": _text(route_meta.get("work_contract")) or "inspect_report",
        "command": _text(command),
        "playbook_kind": _text(playbook.get("kind")),
        "probe_kind": _text(probe_spec.get("kind")),
        "access_mode": "read_only",
        "allowed_tools": ["shell"],
        "allowed_hosts": [],
        "timeout_seconds": int(timeout_seconds or 0),
        "max_output_chars": 12000,
        "secrets_redaction_required": True,
        "destructive_action_requires_confirmation": True,
        "session_key": _text(session_key),
        "runner_job_id": normalized_runner_job_id,
        "task_id": normalized_task_id,
        "source": "octoclaw_dispatch",
        "native_task_binding": {
            "task_id": _text(binding.get("task_id")) or normalized_task_id,
            "flow_id": _text(binding.get("flow_id")),
            "backend": _text(binding.get("backend")),
            "binding_state": _text(binding.get("binding_state")),
            "task_runtime": _text(binding.get("task_runtime")),
            "flow_runtime": _text(binding.get("flow_runtime")),
        },
    }
