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
from datetime import datetime, timedelta, timezone
from typing import Any

try:
    from octopus_config import OPENCLAW_TASKFLOW_MIRROR_FILE, openclaw_taskflow_config
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.octopus_config import OPENCLAW_TASKFLOW_MIRROR_FILE, openclaw_taskflow_config


TASKFLOW_LINK_SCHEMA_VERSION = "octoclaw.taskflow.link/v1"
TASKFLOW_MIRROR_SCHEMA_VERSION = "octoclaw.taskflow.mirror/v1"
SUPPORTED_TASKFLOW_ROUTES = {"runner", "spawn_single", "spawn_multi"}
NATIVE_BINDING_THRESHOLD = 100
DEFAULT_TASKFLOW_MIRROR_RETENTION_HOURS = 48


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def _parse_time(value: Any) -> datetime | None:
    raw = _normalized_str(value)
    if not raw:
        return None
    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        parsed = datetime.fromisoformat(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed
    except Exception:
        return None


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


def native_create_supported() -> bool:
    if not has_openclaw_cli():
        return False
    for args in (["tasks", "--help"], ["tasks", "list", "--help"]):
        try:
            result = subprocess.run(["openclaw", *args], capture_output=True, text=True, timeout=10, check=False)
        except Exception:
            continue
        output = "\n".join(part for part in [result.stdout or "", result.stderr or ""] if part)
        if "create" in output.lower():
            return True
    return False


def _normalized_int(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    text = _normalized_str(value)
    if not text:
        return 0
    try:
        return int(text)
    except ValueError:
        return 0


def _retention_hours(config: dict[str, Any] | None = None) -> int:
    hours = _normalized_int(_taskflow_cfg(config).get("mirror_cleanup_retention_hours"))
    return hours if hours > 0 else DEFAULT_TASKFLOW_MIRROR_RETENTION_HOURS


def _first_present(payload: dict[str, Any], *keys: str) -> Any:
    if not isinstance(payload, dict):
        return None
    for key in keys:
        if key not in payload:
            continue
        value = payload.get(key)
        if isinstance(value, bool):
            return value
        if _normalized_str(value):
            return value
    return None


def _default_sync_mode(config: dict[str, Any] | None = None, binding: dict[str, Any] | None = None) -> str:
    explicit = _normalized_str((binding or {}).get("sync_mode"))
    if explicit:
        return explicit.lower()
    backend = _normalized_str((binding or {}).get("backend") or _taskflow_cfg(config).get("backend")).lower()
    if backend in {"mirror", "mirrored"}:
        return "mirrored"
    if backend == "managed":
        return "managed"
    return ""


def _native_sync_mode(native_task: dict[str, Any]) -> str:
    explicit = _normalized_str(
        _first_present(
            native_task,
            "syncMode",
            "sync_mode",
            "taskFlowSyncMode",
            "taskflowSyncMode",
            "flowSyncMode",
            "flow_sync_mode",
        )
    ).lower()
    if explicit in {"managed", "mirrored"}:
        return explicit
    for key in ("managed", "isManaged", "taskFlowManaged", "taskflowManaged", "flowManaged"):
        if key in native_task and _bool(native_task.get(key), default=False):
            return "managed"
    for key in ("mirrored", "isMirrored", "taskFlowMirrored", "taskflowMirrored", "flowMirrored"):
        if key in native_task and _bool(native_task.get(key), default=False):
            return "mirrored"
    return ""


def _native_substrate_state(native_task: dict[str, Any]) -> str:
    return _normalized_str(
        _first_present(
            native_task,
            "flowState",
            "flow_state",
            "taskFlowState",
            "taskflowState",
            "state",
        )
    )


def _native_substrate_revision(native_task: dict[str, Any]) -> int:
    return _normalized_int(
        _first_present(
            native_task,
            "stateRevision",
            "state_revision",
            "flowRevision",
            "flow_revision",
            "revision",
        )
    )


def _run_openclaw_cli(args: list[str], *, timeout_seconds: int = 20) -> dict[str, Any]:
    cmd = ["openclaw", *args]
    if "--json" not in cmd:
        cmd.append("--json")
    if not has_openclaw_cli():
        return {
            "ok": False,
            "status": "unavailable",
            "error": "openclaw CLI not found on PATH",
            "cmd": cmd,
        }
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=max(5, int(timeout_seconds)),
            check=False,
        )
    except Exception as exc:
        return {
            "ok": False,
            "status": "error",
            "error": str(exc),
            "cmd": cmd,
        }
    stdout = (result.stdout or "").strip()
    stderr = (result.stderr or "").strip()
    payload: Any = None
    if stdout:
        try:
            payload = json.loads(stdout)
        except json.JSONDecodeError:
            payload = stdout
    return {
        "ok": result.returncode == 0,
        "status": "ok" if result.returncode == 0 else "error",
        "stdout": stdout,
        "stderr": stderr,
        "payload": payload,
        "returncode": result.returncode,
        "cmd": cmd,
    }


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


def _apply_native_taskflow_facts(
    resolved: dict[str, Any],
    native_task: dict[str, Any],
    *,
    match_score: int = 0,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    updated = dict(resolved)
    updated["task_id"] = _normalized_str(
        native_task.get("taskId") or native_task.get("task_id") or native_task.get("id") or updated.get("task_id")
    )
    updated["flow_id"] = _normalized_str(
        native_task.get("parentFlowId")
        or native_task.get("parent_flow_id")
        or native_task.get("flowId")
        or native_task.get("flow_id")
        or updated.get("flow_id")
    )
    updated["binding_state"] = "mirrored_bound"
    updated["native_binding_state"] = "bound"
    updated["native_status"] = _normalized_str(native_task.get("status") or updated.get("native_status"))
    updated["native_runtime"] = _normalized_str(native_task.get("runtime") or updated.get("native_runtime"))
    sync_mode = _native_sync_mode(native_task) or _default_sync_mode(config=config, binding=updated)
    if sync_mode:
        updated["sync_mode"] = sync_mode
    substrate_state = _native_substrate_state(native_task) or _normalized_str(updated.get("substrate_state"))
    if substrate_state:
        updated["substrate_state"] = substrate_state
    substrate_revision = _native_substrate_revision(native_task)
    if substrate_revision or str(updated.get("substrate_revision", "")).strip():
        updated["substrate_revision"] = substrate_revision or _normalized_int(updated.get("substrate_revision"))
    updated["native_seen_at"] = now_iso()
    if match_score:
        updated["native_match_score"] = match_score
    return updated


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
        if lookup["native_task_id"] or lookup["native_flow_id"]:
            if not _normalized_str(resolved.get("sync_mode")):
                resolved["sync_mode"] = _default_sync_mode(config=config, binding=resolved)
            resolved["native_seen_at"] = now_iso()
            return resolved
        resolved.setdefault("native_binding_state", "none")
        return resolved

    return _apply_native_taskflow_facts(resolved, best_match, match_score=best_score, config=config)


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
    sync_mode = _default_sync_mode(config=config)
    if task_id or flow_id:
        binding_state = "mirrored_bound"
        native_binding_state = "bound"
    create_preference = "native_preferred" if route in {"spawn_single", "spawn_multi"} or _runner_wants_flow(config) else "mirror_only"
    create_status = "native_bound" if native_binding_state == "bound" else (
        "native_unavailable_fallback_mirror" if create_preference == "native_preferred" and not native_create_supported() else "mirror_only"
    )
    return {
        "schema_version": TASKFLOW_LINK_SCHEMA_VERSION,
        "backend": _normalized_str(cfg.get("backend")) or "mirror",
        "binding_state": binding_state,
        "native_binding_state": native_binding_state,
        "create_preference": create_preference,
        "create_status": create_status,
        "sync_mode": sync_mode,
        "substrate_state": "",
        "substrate_revision": 0,
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


def cancel_native_taskflow(
    task: dict[str, Any],
    *,
    timeout_seconds: int = 20,
) -> dict[str, Any]:
    binding = _binding_from_task(task)
    flow_id = _normalized_str(task.get("openclaw_flow_id") or binding.get("flow_id"))
    task_id = _normalized_str(task.get("openclaw_task_id") or binding.get("task_id"))
    attempts: list[dict[str, Any]] = []
    if not flow_id and not task_id:
        return {
            "ok": False,
            "status": "unavailable",
            "error": "no native task/flow binding",
            "attempts": attempts,
        }
    if flow_id:
        flow_result = _run_openclaw_cli(["flows", "cancel", flow_id], timeout_seconds=timeout_seconds)
        attempts.append({"kind": "flow", "id": flow_id, "result": flow_result})
        if flow_result.get("ok"):
            return {
                "ok": True,
                "status": "ok",
                "target_kind": "flow",
                "target_id": flow_id,
                "attempts": attempts,
            }
    if task_id:
        task_result = _run_openclaw_cli(["tasks", "cancel", task_id], timeout_seconds=timeout_seconds)
        attempts.append({"kind": "task", "id": task_id, "result": task_result})
        if task_result.get("ok"):
            return {
                "ok": True,
                "status": "ok",
                "target_kind": "task",
                "target_id": task_id,
                "attempts": attempts,
            }
    error = ""
    if attempts:
        last = attempts[-1].get("result", {}) if isinstance(attempts[-1], dict) else {}
        error = _normalized_str((last or {}).get("error") or (last or {}).get("stderr") or (last or {}).get("stdout"))
    return {
        "ok": False,
        "status": "error" if attempts else "unavailable",
        "error": error or "native cancel command failed",
        "attempts": attempts,
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
    updated["openclaw_task_runtime"] = _normalized_str(resolved.get("task_runtime"))
    updated["openclaw_flow_runtime"] = _normalized_str(resolved.get("flow_runtime"))
    updated["openclaw_taskflow_sync_mode"] = _normalized_str(resolved.get("sync_mode"))
    updated["openclaw_taskflow_substrate_state"] = _normalized_str(resolved.get("substrate_state"))
    substrate_revision = resolved.get("substrate_revision")
    updated["openclaw_taskflow_substrate_revision"] = int(substrate_revision or 0) if str(substrate_revision or "").strip() else 0
    updated["openclaw_task_id"] = _normalized_str(resolved.get("task_id"))
    updated["openclaw_flow_id"] = _normalized_str(resolved.get("flow_id"))
    updated["openclaw_flow_kind"] = _normalized_str(resolved.get("flow_kind"))
    updated["openclaw_native_binding_state"] = _normalized_str(resolved.get("native_binding_state"))
    updated["openclaw_native_status"] = _normalized_str(resolved.get("native_status"))
    updated["openclaw_native_runtime"] = _normalized_str(resolved.get("native_runtime"))
    updated["openclaw_native_seen_at"] = _normalized_str(resolved.get("native_seen_at"))
    native_match_score = resolved.get("native_match_score")
    updated["openclaw_native_match_score"] = int(native_match_score or 0) if str(native_match_score or "").strip() else 0
    return updated


def summarize_taskflow_inventory(tasks: list[dict[str, Any]]) -> dict[str, Any]:
    summary = {
        "total_tasks": 0,
        "taskflow_tracked": 0,
        "native_bound": 0,
        "native_preferred": 0,
        "mirror_only": 0,
        "native_unavailable_fallback_mirror": 0,
        "cleanup_candidates": 0,
        "cleanup_retention_hours": DEFAULT_TASKFLOW_MIRROR_RETENTION_HOURS,
        "flow_kind_counts": {},
        "route_counts": {},
    }
    for task in tasks:
        if not isinstance(task, dict):
            continue
        summary["total_tasks"] += 1
        binding = _binding_from_task(task)
        if not binding:
            continue
        summary["taskflow_tracked"] += 1
        route = _normalized_str(task.get("route")).lower()
        if route:
            route_counts = summary["route_counts"]
            route_counts[route] = int(route_counts.get(route, 0) or 0) + 1
        flow_kind = _normalized_str(binding.get("flow_kind")).lower()
        if flow_kind:
            flow_counts = summary["flow_kind_counts"]
            flow_counts[flow_kind] = int(flow_counts.get(flow_kind, 0) or 0) + 1
        if _normalized_str(binding.get("native_binding_state")).lower() == "bound":
            summary["native_bound"] += 1
        if _normalized_str(binding.get("create_preference")).lower() == "native_preferred":
            summary["native_preferred"] += 1
        create_status = _normalized_str(binding.get("create_status")).lower()
        if create_status == "mirror_only":
            summary["mirror_only"] += 1
        elif create_status == "native_unavailable_fallback_mirror":
            summary["native_unavailable_fallback_mirror"] += 1
        lifecycle_state = _normalized_str(task.get("lifecycle_state")).lower()
        status = _normalized_str(task.get("status")).lower()
        is_terminal = lifecycle_state in {"finished", "cancelled"} or status in {"done", "failed", "blocked", "cancelled", "deferred"}
        if is_terminal and create_status in {"mirror_only", "native_unavailable_fallback_mirror"}:
            summary["cleanup_candidates"] += 1
    return summary


def describe_taskflow_cleanup(
    tasks: list[dict[str, Any]],
    *,
    mirror_payload: dict[str, Any] | None = None,
    now: datetime | None = None,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    retention_hours = _retention_hours(config)
    current_time = now or datetime.now(timezone.utc).astimezone()
    cutoff = current_time - timedelta(hours=retention_hours)
    mirror = mirror_payload if isinstance(mirror_payload, dict) else load_taskflow_mirror()
    entries = mirror.get("entries", {}) if isinstance(mirror.get("entries", {}), dict) else {}
    candidates: list[dict[str, Any]] = []

    for task in tasks:
        if not isinstance(task, dict):
            continue
        binding = _binding_from_task(task)
        if not binding:
            continue
        create_status = _normalized_str(binding.get("create_status")).lower()
        if create_status not in {"mirror_only", "native_unavailable_fallback_mirror"}:
            continue
        lifecycle_state = _normalized_str(task.get("lifecycle_state")).lower()
        status = _normalized_str(task.get("status")).lower()
        is_terminal = lifecycle_state in {"finished", "cancelled"} or status in {"done", "failed", "blocked", "cancelled", "deferred"}
        if not is_terminal:
            continue
        task_id = _normalized_str(task.get("id"))
        mirror_entry = entries.get(task_id) if isinstance(entries.get(task_id), dict) else {}
        last_seen = (
            _parse_time(task.get("completed_at"))
            or _parse_time(task.get("updated_at"))
            or _parse_time(mirror_entry.get("updated_at"))
        )
        age_hours: int | None = None
        eligible_now = False
        if last_seen:
            age_hours = max(0, int((current_time - last_seen).total_seconds() // 3600))
            eligible_now = last_seen <= cutoff
        candidates.append(
            {
                "task_id": task_id,
                "route": _normalized_str(task.get("route")),
                "status": status,
                "lifecycle_state": lifecycle_state,
                "create_status": create_status,
                "mirror_entry_present": bool(mirror_entry),
                "last_seen_at": last_seen.astimezone().isoformat() if last_seen else "",
                "age_hours": age_hours,
                "retention_hours": retention_hours,
                "eligible_now": eligible_now and bool(mirror_entry),
            }
        )

    candidates.sort(
        key=lambda item: (
            0 if bool(item.get("eligible_now")) else 1,
            -int(item.get("age_hours") or 0),
            _normalized_str(item.get("task_id")),
        )
    )
    return {
        "retention_hours": retention_hours,
        "candidate_count": len(candidates),
        "eligible_count": sum(1 for item in candidates if bool(item.get("eligible_now"))),
        "candidates": candidates,
    }


def cleanup_taskflow_mirror(
    tasks: list[dict[str, Any]],
    *,
    path: str | None = None,
    now: datetime | None = None,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    mirror_path = path or OPENCLAW_TASKFLOW_MIRROR_FILE
    mirror = load_taskflow_mirror(mirror_path)
    preview = describe_taskflow_cleanup(tasks, mirror_payload=mirror, now=now, config=config)
    entries = mirror.get("entries", {}) if isinstance(mirror.get("entries", {}), dict) else {}
    removed_task_ids: list[str] = []
    for item in preview.get("candidates", []):
        if not isinstance(item, dict) or not bool(item.get("eligible_now")):
            continue
        task_id = _normalized_str(item.get("task_id"))
        if task_id and task_id in entries:
            removed_task_ids.append(task_id)
            entries.pop(task_id, None)
    if removed_task_ids:
        mirror["entries"] = entries
        _persist_mirror(mirror_path, mirror)
    return {
        "retention_hours": int(preview.get("retention_hours", _retention_hours(config)) or _retention_hours(config)),
        "candidate_count": int(preview.get("candidate_count", 0) or 0),
        "removed_count": len(removed_task_ids),
        "removed_task_ids": removed_task_ids,
        "remaining_entries": len(entries),
    }
