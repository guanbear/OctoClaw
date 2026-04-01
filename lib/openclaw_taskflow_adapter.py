#!/usr/bin/env python3
"""OctoClaw <-> OpenClaw task/flow substrate adapter.

Current phase:
- mirror-first registration into OctoClaw-local mirror file
- native-fact binding against ``openclaw tasks list --json`` output

This module intentionally does not write into OpenClaw's native task ledger.
"""

from __future__ import annotations

import fcntl
import json
import os
import shutil
import subprocess
from datetime import datetime, timezone
from typing import Any

try:
    from octopus_config import OPENCLAW_TASKFLOW_MIRROR_FILE, openclaw_taskflow_config
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.octopus_config import OPENCLAW_TASKFLOW_MIRROR_FILE, openclaw_taskflow_config


TASKFLOW_LINK_SCHEMA_VERSION = "octoclaw.taskflow.link/v1"
TASKFLOW_MIRROR_SCHEMA_VERSION = "octoclaw.taskflow.mirror/v1"
SUPPORTED_TASKFLOW_ROUTES = {"runner", "spawn_single", "spawn_multi"}
NATIVE_BINDING_THRESHOLD = 100


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def _normalized_str(value: Any) -> str:
    return str(value or "").strip()


def _taskflow_cfg(config: dict[str, Any] | None = None) -> dict[str, Any]:
    section = openclaw_taskflow_config(config)
    return section if isinstance(section, dict) else {}


def _bool(value: Any, default: bool = False) -> bool:
    text = _normalized_str(value).lower()
    if not text:
        return default
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return default


def _load_mirror_unlocked(path: str) -> dict[str, Any]:
    if not os.path.exists(path):
        return {
            "schema_version": TASKFLOW_MIRROR_SCHEMA_VERSION,
            "updated_at": "",
            "entries": {},
        }
    try:
        with open(path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    payload.setdefault("schema_version", TASKFLOW_MIRROR_SCHEMA_VERSION)
    payload.setdefault("updated_at", "")
    payload.setdefault("entries", {})
    if not isinstance(payload.get("entries"), dict):
        payload["entries"] = {}
    return payload


def _persist_mirror(path: str, payload: dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    payload["schema_version"] = TASKFLOW_MIRROR_SCHEMA_VERSION
    payload["updated_at"] = now_iso()
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    os.replace(tmp_path, path)


def load_taskflow_mirror(path: str | None = None) -> dict[str, Any]:
    return _load_mirror_unlocked(path or OPENCLAW_TASKFLOW_MIRROR_FILE)


def has_openclaw_cli() -> bool:
    return shutil.which("openclaw") is not None


def _runner_wants_flow(config: dict[str, Any] | None = None) -> bool:
    return _bool(_taskflow_cfg(config).get("register_runner_one_task_flows"), default=False)


def _spawn_flow_kind(task: dict[str, Any], config: dict[str, Any] | None = None) -> str:
    route = _normalized_str(task.get("route")).lower()
    if route == "spawn_single" and _bool(_taskflow_cfg(config).get("register_spawn_single_flows"), default=True):
        return "one_task"
    if route == "spawn_multi" and _bool(_taskflow_cfg(config).get("register_spawn_multi_linear_flows"), default=True):
        return "linear"
    return ""


def _flow_kind(task: dict[str, Any], config: dict[str, Any] | None = None) -> str:
    route = _normalized_str(task.get("route")).lower()
    if route == "runner":
        return "one_task" if _runner_wants_flow(config) else ""
    return _spawn_flow_kind(task, config)


def _native_binding_enabled(config: dict[str, Any] | None = None) -> bool:
    return _bool(_taskflow_cfg(config).get("native_binding_enabled"), default=True)


def _native_runtime_candidates(task: dict[str, Any]) -> list[str]:
    runtime = _normalized_str(task.get("runtime")).lower()
    route = _normalized_str(task.get("route")).lower()
    candidates: list[str] = []
    if runtime:
        candidates.append(runtime)
    if route == "spawn_single":
        candidates.extend(["subagent", "task", "background"])
    elif route == "runner":
        candidates.extend(["runner", "cli", "background"])
    elif route == "spawn_multi":
        candidates.extend(["flow", "task"])
    deduped: list[str] = []
    for item in candidates:
        if item and item not in deduped:
            deduped.append(item)
    return deduped


def _binding_from_task(task: dict[str, Any]) -> dict[str, Any]:
    explicit = dict(task.get("openclaw_taskflow", {})) if isinstance(task.get("openclaw_taskflow"), dict) else {}
    artifacts = task.get("artifacts", {}) if isinstance(task.get("artifacts"), dict) else {}
    artifact_binding = dict(artifacts.get("openclaw_taskflow", {})) if isinstance(artifacts.get("openclaw_taskflow"), dict) else {}
    merged = dict(artifact_binding)
    for key, value in explicit.items():
        if value not in (None, "", [], {}):
            merged[key] = value
    return merged


def _native_lookup_payload(task: dict[str, Any]) -> dict[str, str]:
    artifacts = task.get("artifacts", {}) if isinstance(task.get("artifacts"), dict) else {}
    spawn_execution = artifacts.get("spawn_execution", {}) if isinstance(artifacts.get("spawn_execution"), dict) else {}
    return {
        "session_key": _normalized_str(task.get("session_key")),
        "session_id": _normalized_str(task.get("session_id")),
        "run_id": _normalized_str(task.get("run_id")),
        "child_session_key": _normalized_str(spawn_execution.get("child_session_key")),
        "child_session_id": _normalized_str(spawn_execution.get("session_id")),
        "native_task_id": _normalized_str(task.get("openclaw_task_id") or spawn_execution.get("native_task_id")),
        "native_flow_id": _normalized_str(task.get("openclaw_flow_id") or spawn_execution.get("native_flow_id")),
        "task_text": _normalized_task_text(task.get("task_description") or task.get("summary") or task.get("title")),
    }


def list_native_openclaw_tasks(config: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    if not _native_binding_enabled(config) or not has_openclaw_cli():
        return []
    result = subprocess.run(
        ["openclaw", "tasks", "list", "--json"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return []
    try:
        payload = json.loads(result.stdout or "[]")
    except json.JSONDecodeError:
        return []
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in ("tasks", "items", "rows"):
            value = payload.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
    return []


def _normalized_task_text(value: Any) -> str:
    return " ".join(_normalized_str(value).lower().split())


def _native_match_score(task: dict[str, Any], native_task: dict[str, Any]) -> int:
    lookup = _native_lookup_payload(task)
    score = 0
    native_task_id = _normalized_str(native_task.get("taskId") or native_task.get("task_id") or native_task.get("id"))
    native_flow_id = _normalized_str(
        native_task.get("parentFlowId") or native_task.get("parent_flow_id") or native_task.get("flowId") or native_task.get("flow_id")
    )
    native_run_id = _normalized_str(native_task.get("runId") or native_task.get("run_id"))
    requester_session_key = _normalized_str(native_task.get("requesterSessionKey") or native_task.get("requester_session_key"))
    child_session_key = _normalized_str(native_task.get("childSessionKey") or native_task.get("child_session_key"))
    session_id = _normalized_str(native_task.get("sessionId") or native_task.get("session_id"))
    runtime = _normalized_str(native_task.get("runtime")).lower()
    task_text = _normalized_task_text(native_task.get("task") or native_task.get("title") or native_task.get("summary"))

    if lookup["native_task_id"] and lookup["native_task_id"] == native_task_id:
        score += 300
    if lookup["native_flow_id"] and lookup["native_flow_id"] == native_flow_id:
        score += 120
    if lookup["run_id"] and lookup["run_id"] == native_run_id:
        score += 180
    if lookup["session_key"] and lookup["session_key"] == requester_session_key:
        score += 140
    if lookup["child_session_key"] and lookup["child_session_key"] == child_session_key:
        score += 140
    if lookup["session_id"] and lookup["session_id"] == session_id:
        score += 120
    if lookup["child_session_id"] and lookup["child_session_id"] == session_id:
        score += 100
    if runtime and runtime in _native_runtime_candidates(task):
        score += 25
    if lookup["task_text"] and task_text:
        if lookup["task_text"] == task_text:
            score += 60
        elif lookup["task_text"] in task_text or task_text in lookup["task_text"]:
            score += 30
    return score


def reconcile_native_taskflow_binding(
    task: dict[str, Any],
    *,
    binding: dict[str, Any] | None = None,
    native_tasks: list[dict[str, Any]] | None = None,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    resolved = dict(binding or _binding_from_task(task) or build_taskflow_binding(task, config=config))
    if not resolved or not _native_binding_enabled(config):
        return resolved

    lookup = _native_lookup_payload(task)
    if lookup["native_task_id"] or lookup["native_flow_id"]:
        resolved["task_id"] = lookup["native_task_id"] or _normalized_str(resolved.get("task_id"))
        resolved["flow_id"] = lookup["native_flow_id"] or _normalized_str(resolved.get("flow_id"))
        resolved["binding_state"] = "mirrored_bound"
        resolved["native_binding_state"] = "bound"
        resolved["native_seen_at"] = now_iso()
        return resolved

    candidates = native_tasks if isinstance(native_tasks, list) else list_native_openclaw_tasks(config=config)
    best_match: dict[str, Any] | None = None
    best_score = 0
    for native_task in candidates:
        if not isinstance(native_task, dict):
            continue
        score = _native_match_score(task, native_task)
        if score > best_score:
            best_score = score
            best_match = native_task
    if not best_match or best_score < NATIVE_BINDING_THRESHOLD:
        resolved.setdefault("native_binding_state", "none")
        return resolved

    resolved["task_id"] = _normalized_str(best_match.get("taskId") or best_match.get("task_id") or best_match.get("id"))
    resolved["flow_id"] = _normalized_str(
        best_match.get("parentFlowId") or best_match.get("parent_flow_id") or best_match.get("flowId") or best_match.get("flow_id")
    )
    resolved["binding_state"] = "mirrored_bound"
    resolved["native_binding_state"] = "bound"
    resolved["native_status"] = _normalized_str(best_match.get("status"))
    resolved["native_runtime"] = _normalized_str(best_match.get("runtime"))
    resolved["native_match_score"] = best_score
    resolved["native_seen_at"] = now_iso()
    return resolved


def build_taskflow_binding(task: dict[str, Any], *, config: dict[str, Any] | None = None) -> dict[str, Any]:
    if not isinstance(task, dict):
        return {}
    cfg = _taskflow_cfg(config)
    if not _bool(cfg.get("enabled"), default=True):
        return {}
    route = _normalized_str(task.get("route")).lower()
    if route not in SUPPORTED_TASKFLOW_ROUTES:
        return {}
    if route == "runner" and not _bool(cfg.get("register_runner_tasks"), default=True):
        return {}
    flow_kind = _flow_kind(task, config=config)
    lookup = _native_lookup_payload(task)
    task_runtime = "openclaw_task"
    binding_state = "mirrored"
    native_binding_state = "none"
    task_id = lookup["native_task_id"]
    flow_id = lookup["native_flow_id"]
    if task_id or flow_id:
        binding_state = "mirrored_bound"
        native_binding_state = "bound"
    return {
        "schema_version": TASKFLOW_LINK_SCHEMA_VERSION,
        "backend": _normalized_str(cfg.get("backend")) or "mirror",
        "binding_state": binding_state,
        "native_binding_state": native_binding_state,
        "task_runtime": task_runtime,
        "flow_runtime": "openclaw_flow" if flow_kind else "",
        "flow_kind": flow_kind,
        "task_id": task_id,
        "flow_id": flow_id,
        "mirror_task_key": _normalized_str(task.get("id")),
        "mirror_flow_key": _normalized_str(task.get("id")) if flow_kind else "",
        "route": route,
        "runtime": _normalized_str(task.get("runtime")),
        "worker_pool": _normalized_str(task.get("worker_pool")),
        "session_key": lookup["session_key"],
        "session_id": lookup["session_id"] or lookup["child_session_id"],
        "run_id": lookup["run_id"],
        "summary": _normalized_str(task.get("summary")),
        "task_text": lookup["task_text"],
        "updated_at": now_iso(),
    }


def register_taskflow_binding(task: dict[str, Any], *, config: dict[str, Any] | None = None) -> dict[str, Any]:
    binding = build_taskflow_binding(task, config=config)
    if not binding:
        return {}
    path = OPENCLAW_TASKFLOW_MIRROR_FILE
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a+", encoding="utf-8") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            mirror = _load_mirror_unlocked(path)
            entries = mirror.get("entries", {})
            entries[_normalized_str(task.get("id"))] = {
                "task_id": _normalized_str(task.get("id")),
                "route": _normalized_str(task.get("route")),
                "worker_pool": _normalized_str(task.get("worker_pool")),
                "status": _normalized_str(task.get("status")),
                "summary": _normalized_str(task.get("summary")),
                "link": binding,
                "updated_at": now_iso(),
            }
            mirror["entries"] = entries
            _persist_mirror(path, mirror)
            fcntl.flock(fh, fcntl.LOCK_UN)
    except OSError:
        # Local tests or read-only environments may not have a writable
        # workspace mirror path. The binding still remains useful in-memory.
        return binding
    return binding


def enrich_task_record_with_taskflow(
    task: dict[str, Any],
    *,
    native_tasks: list[dict[str, Any]] | None = None,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not isinstance(task, dict):
        return task
    binding = _binding_from_task(task)
    if not binding:
        binding = register_taskflow_binding(task, config=config)
    if not binding:
        return task
    resolved = reconcile_native_taskflow_binding(task, binding=binding, native_tasks=native_tasks, config=config)
    updated = dict(task)
    artifacts = dict(updated.get("artifacts", {})) if isinstance(updated.get("artifacts"), dict) else {}
    artifacts["openclaw_taskflow"] = resolved
    updated["artifacts"] = artifacts
    updated["openclaw_taskflow"] = resolved
    updated["openclaw_taskflow_backend"] = _normalized_str(resolved.get("backend"))
    updated["openclaw_taskflow_state"] = _normalized_str(resolved.get("binding_state"))
    updated["openclaw_task_id"] = _normalized_str(resolved.get("task_id"))
    updated["openclaw_flow_id"] = _normalized_str(resolved.get("flow_id"))
    updated["openclaw_flow_kind"] = _normalized_str(resolved.get("flow_kind"))
    return updated
