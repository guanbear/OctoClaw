#!/usr/bin/env python3
"""OctoClaw <-> OpenClaw task/flow substrate adapter.

Current phase:
- native-preferred managed TaskFlow create for eligible spawn routes
- mirror registration into OctoClaw-local mirror file
- native-fact binding against OpenClaw task / flow ledgers
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
    from octopus_config import LIB_DIR, OPENCLAW_TASKFLOW_MIRROR_FILE, load_octopus_config, openclaw_taskflow_config
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.octopus_config import LIB_DIR, OPENCLAW_TASKFLOW_MIRROR_FILE, load_octopus_config, openclaw_taskflow_config


TASKFLOW_LINK_SCHEMA_VERSION = "octoclaw.taskflow.link/v1"
TASKFLOW_MIRROR_SCHEMA_VERSION = "octoclaw.taskflow.mirror/v1"
SUPPORTED_TASKFLOW_ROUTES = {"runner", "spawn_single", "spawn_multi"}
NATIVE_BINDING_THRESHOLD = 100
DEFAULT_TASKFLOW_MIRROR_RETENTION_HOURS = 48
RUNTIME_HELPER = os.path.join(LIB_DIR, "openclaw_taskflow_runtime_helper.mjs")
_NATIVE_CREATE_SUPPORTED_CACHE: bool | None = None


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


def _retain_legacy_mirror_entry(binding: dict[str, Any]) -> bool:
    if not isinstance(binding, dict):
        return False
    native_binding_state = _normalized_str(binding.get("native_binding_state")).lower()
    if native_binding_state == "bound":
        return False
    create_status = _normalized_str(binding.get("create_status")).lower()
    if create_status in {"mirror_only", "native_unavailable_fallback_mirror"}:
        return True
    backend = _normalized_str(binding.get("backend")).lower()
    sync_mode = _normalized_str(binding.get("sync_mode")).lower()
    if backend == "managed" or sync_mode == "managed":
        return False
    return _normalized_str(binding.get("binding_state")).lower() == "mirrored"


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


def _openclaw_bin(config: dict[str, Any] | None = None) -> str:
    cfg = config or load_octopus_config()
    spawn_cfg = cfg.get("spawn_execution", {}) if isinstance(cfg.get("spawn_execution", {}), dict) else {}
    configured = _normalized_str(spawn_cfg.get("openclaw_bin"))
    candidates = [configured] if configured else []
    candidates.extend(["openclaw", "/opt/homebrew/bin/openclaw", "/usr/local/bin/openclaw"])
    for candidate in candidates:
        if not candidate:
            continue
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
        if os.path.isabs(candidate) and os.path.exists(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return configured or "openclaw"


def _node_bin() -> str:
    for candidate in ("node", "/opt/homebrew/bin/node", "/usr/local/bin/node"):
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
        if os.path.isabs(candidate) and os.path.exists(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return ""


def has_openclaw_cli(config: dict[str, Any] | None = None) -> bool:
    return shutil.which(_openclaw_bin(config)) is not None


def native_create_supported() -> bool:
    global _NATIVE_CREATE_SUPPORTED_CACHE
    if _NATIVE_CREATE_SUPPORTED_CACHE is not None:
        return _NATIVE_CREATE_SUPPORTED_CACHE
    if not has_openclaw_cli():
        _NATIVE_CREATE_SUPPORTED_CACHE = False
        return False
    for args in (["tasks", "--help"], ["tasks", "list", "--help"]):
        try:
            result = subprocess.run(["openclaw", *args], capture_output=True, text=True, timeout=10, check=False)
        except Exception:
            continue
        output = "\n".join(part for part in [result.stdout or "", result.stderr or ""] if part)
        if "create" in output.lower():
            _NATIVE_CREATE_SUPPORTED_CACHE = True
            return True
    _NATIVE_CREATE_SUPPORTED_CACHE = False
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


def _run_openclaw_cli(args: list[str], *, timeout_seconds: int = 20, config: dict[str, Any] | None = None) -> dict[str, Any]:
    cmd = [_openclaw_bin(config), *args]
    if "--json" not in cmd:
        cmd.append("--json")
    if not has_openclaw_cli(config):
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


def _native_create_enabled(config: dict[str, Any] | None = None) -> bool:
    return _bool(_taskflow_cfg(config).get("native_create_enabled"), default=True)


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
    if not _native_binding_enabled(config) or not has_openclaw_cli(config):
        return []
    try:
        result = subprocess.run(
            [_openclaw_bin(config), "tasks", "list", "--json"],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
    except (subprocess.TimeoutExpired, Exception):
        return []
    if result.returncode != 0:
        return []
    raw = (result.stdout or "").strip() or (result.stderr or "").strip()
    try:
        payload = json.loads(raw or "[]")
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


def list_native_openclaw_flows(config: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    if not _native_binding_enabled(config) or not has_openclaw_cli(config):
        return []
    try:
        result = subprocess.run(
            [_openclaw_bin(config), "tasks", "flow", "list", "--json"],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
    except (subprocess.TimeoutExpired, Exception):
        return []
    if result.returncode != 0:
        return []
    raw = (result.stdout or "").strip() or (result.stderr or "").strip()
    try:
        payload = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return []
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in ("flows", "items", "rows"):
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


def _native_flow_match_score(resolved: dict[str, Any], native_flow: dict[str, Any]) -> int:
    if not isinstance(native_flow, dict):
        return 0
    score = 0
    expected_flow_id = _normalized_str(resolved.get("flow_id"))
    flow_id = _normalized_str(native_flow.get("flowId") or native_flow.get("flow_id") or native_flow.get("id"))
    owner_key = _normalized_str(native_flow.get("ownerKey") or native_flow.get("owner_key"))
    controller_id = _normalized_str(native_flow.get("controllerId") or native_flow.get("controller_id"))
    requester_session_key = _normalized_str(resolved.get("session_key"))
    expected_controller = _normalized_str(resolved.get("controller_id"))
    if expected_flow_id and expected_flow_id == flow_id:
        score += 320
    if requester_session_key and requester_session_key == owner_key:
        score += 120
    if expected_controller and expected_controller == controller_id:
        score += 180
    return score


def _apply_native_flow_facts(resolved: dict[str, Any], native_flow: dict[str, Any], *, match_score: int = 0) -> dict[str, Any]:
    updated = dict(resolved)
    updated["flow_id"] = _normalized_str(native_flow.get("flowId") or native_flow.get("flow_id") or native_flow.get("id") or updated.get("flow_id"))
    updated["backend"] = "managed"
    updated["binding_state"] = "mirrored_bound"
    updated["native_binding_state"] = "bound"
    updated["sync_mode"] = _normalized_str(native_flow.get("syncMode") or native_flow.get("sync_mode") or updated.get("sync_mode")) or "managed"
    updated["substrate_state"] = _normalized_str(native_flow.get("status") or native_flow.get("state") or updated.get("substrate_state"))
    updated["substrate_revision"] = _normalized_int(
        native_flow.get("revision") or native_flow.get("stateRevision") or native_flow.get("state_revision") or updated.get("substrate_revision")
    )
    updated["controller_id"] = _normalized_str(native_flow.get("controllerId") or native_flow.get("controller_id") or updated.get("controller_id"))
    updated["native_seen_at"] = now_iso()
    if match_score:
        updated["native_match_score"] = max(match_score, _normalized_int(updated.get("native_match_score")))
    return updated


def reconcile_native_taskflow_binding(
    task: dict[str, Any],
    *,
    binding: dict[str, Any] | None = None,
    native_tasks: list[dict[str, Any]] | None = None,
    native_flows: list[dict[str, Any]] | None = None,
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
    if best_match and best_score >= NATIVE_BINDING_THRESHOLD:
        resolved = _apply_native_taskflow_facts(resolved, best_match, match_score=best_score, config=config)
    elif lookup["native_task_id"] or lookup["native_flow_id"]:
        if not _normalized_str(resolved.get("sync_mode")):
            resolved["sync_mode"] = _default_sync_mode(config=config, binding=resolved)
        resolved["native_seen_at"] = now_iso()
    else:
        resolved.setdefault("native_binding_state", "none")

    flow_candidates = native_flows if isinstance(native_flows, list) else list_native_openclaw_flows(config=config)
    best_flow: dict[str, Any] | None = None
    best_flow_score = 0
    for native_flow in flow_candidates:
        if not isinstance(native_flow, dict):
            continue
        score = _native_flow_match_score(resolved, native_flow)
        if score > best_flow_score:
            best_flow_score = score
            best_flow = native_flow
    if best_flow and best_flow_score >= NATIVE_BINDING_THRESHOLD:
        resolved = _apply_native_flow_facts(resolved, best_flow, match_score=best_flow_score)
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
    explicit = _binding_from_task(task)
    task_runtime = "openclaw_task"
    binding_state = "mirrored"
    native_binding_state = "none"
    task_id = lookup["native_task_id"] or _normalized_str(explicit.get("task_id"))
    flow_id = lookup["native_flow_id"] or _normalized_str(explicit.get("flow_id"))
    sync_mode = _normalized_str(explicit.get("sync_mode")) or _default_sync_mode(config=config, binding=explicit)
    backend = _normalized_str(explicit.get("backend")) or _normalized_str(cfg.get("backend")) or "mirror"
    if task_id or flow_id:
        binding_state = "mirrored_bound"
        native_binding_state = "bound"
    if native_binding_state != "bound":
        backend = "mirror"
    create_preference = "native_preferred" if route in {"spawn_single", "spawn_multi"} or _runner_wants_flow(config) else "mirror_only"
    if native_binding_state == "bound" and flow_id:
        create_status = "native_bound"
    elif create_preference == "native_preferred" and not native_create_supported():
        create_status = "native_unavailable_fallback_mirror"
    else:
        create_status = "mirror_only"
    return {
        "schema_version": TASKFLOW_LINK_SCHEMA_VERSION,
        "backend": backend,
        "binding_state": binding_state,
        "native_binding_state": native_binding_state,
        "create_preference": create_preference,
        "create_status": create_status,
        "sync_mode": sync_mode,
        "substrate_state": _normalized_str(explicit.get("substrate_state")),
        "substrate_revision": _normalized_int(explicit.get("substrate_revision")),
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
        "controller_id": _normalized_str(explicit.get("controller_id")),
        "summary": _normalized_str(task.get("summary")),
        "task_text": lookup["task_text"],
        "updated_at": now_iso(),
    }


def _helper_available() -> bool:
    return os.path.exists(RUNTIME_HELPER) and bool(_node_bin())


def _run_runtime_helper(args: list[str], *, timeout_seconds: int = 20, config: dict[str, Any] | None = None) -> dict[str, Any]:
    if not _helper_available():
        return {
            "ok": False,
            "status": "unavailable",
            "error": "openclaw taskflow runtime helper unavailable",
        }
    cmd = [_node_bin(), RUNTIME_HELPER, *args, "--openclaw-bin", _openclaw_bin(config)]
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
    payload: dict[str, Any] | None = None
    if stdout:
        try:
            parsed = json.loads(stdout)
            if isinstance(parsed, dict):
                payload = parsed
        except json.JSONDecodeError:
            payload = None
    if result.returncode == 0 and isinstance(payload, dict):
        payload.setdefault("ok", True)
        payload.setdefault("status", "ok")
        return payload
    return {
        "ok": False,
        "status": "error" if result.returncode else "unavailable",
        "error": _normalized_str((payload or {}).get("error")) or stderr or stdout or "runtime helper failed",
        "stdout": stdout,
        "stderr": stderr,
        "returncode": result.returncode,
        "cmd": cmd,
    }


def create_managed_taskflow_binding(task: dict[str, Any], *, config: dict[str, Any] | None = None) -> dict[str, Any]:
    if not isinstance(task, dict) or not _native_create_enabled(config):
        return {}
    flow_kind = _flow_kind(task, config=config)
    if not flow_kind:
        return {}
    existing = _binding_from_task(task)
    if _normalized_str(existing.get("flow_id")):
        seeded = build_taskflow_binding(task, config=config)
        seeded["backend"] = "managed"
        seeded["sync_mode"] = _normalized_str(existing.get("sync_mode")) or "managed"
        return seeded
    session_key = _normalized_str(task.get("session_key"))
    if not session_key:
        return {}
    status = _normalized_str(task.get("status")).lower()
    flow_status = "running" if status in {"running", "started"} else "queued"
    task_text = _normalized_str(task.get("task_description") or task.get("summary") or task.get("title") or task.get("id"))
    controller_id = f"octoclaw:{_normalized_str(task.get('id')) or now_iso()}:{flow_kind}"
    state_json = {
        "octoclaw_task_id": _normalized_str(task.get("id")),
        "route": _normalized_str(task.get("route")),
        "worker_pool": _normalized_str(task.get("worker_pool")),
        "phase": _normalized_str(task.get("phase")),
        "runtime": _normalized_str(task.get("runtime")),
    }
    helper_result = _run_runtime_helper(
        [
            "create-managed-flow",
            "--session-key",
            session_key,
            "--controller-id",
            controller_id,
            "--goal",
            task_text,
            "--status",
            flow_status,
            "--current-step",
            _normalized_str(task.get("phase")) or _normalized_str(task.get("route")) or "queued",
            "--notify-policy",
            "silent",
            "--state-json",
            json.dumps(state_json, ensure_ascii=False),
        ],
        config=config,
    )
    if not helper_result.get("ok"):
        return {}
    flow = helper_result.get("flow", {}) if isinstance(helper_result.get("flow", {}), dict) else {}
    seeded = build_taskflow_binding(task, config=config)
    seeded["backend"] = "managed"
    seeded["binding_state"] = "mirrored_bound"
    seeded["native_binding_state"] = "bound"
    seeded["sync_mode"] = "managed"
    seeded["flow_id"] = _normalized_str(flow.get("flowId") or flow.get("flow_id") or helper_result.get("flow_id"))
    seeded["substrate_state"] = _normalized_str(flow.get("status") or flow_status)
    seeded["substrate_revision"] = _normalized_int(flow.get("revision"))
    seeded["controller_id"] = controller_id
    seeded["native_seen_at"] = now_iso()
    return seeded


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
        flow_result = _run_openclaw_cli(["tasks", "flow", "cancel", flow_id], timeout_seconds=timeout_seconds)
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
            task_id = _normalized_str(task.get("id"))
            if _retain_legacy_mirror_entry(binding):
                entries[task_id] = {
                    "task_id": task_id,
                    "route": _normalized_str(task.get("route")),
                    "worker_pool": _normalized_str(task.get("worker_pool")),
                    "status": _normalized_str(task.get("status")),
                    "summary": _normalized_str(task.get("summary")),
                    "link": binding,
                    "updated_at": now_iso(),
                }
            elif task_id:
                entries.pop(task_id, None)
            mirror["entries"] = entries
            _persist_mirror(path, mirror)
            fcntl.flock(fh, fcntl.LOCK_UN)
    except OSError:
        # Local tests or read-only environments may not have a writable
        # workspace mirror path. The binding still remains useful in-memory.
        return binding
    return binding


def sync_terminal_transition(
    task: dict[str, Any],
    transition_type: str,
    timeout_seconds: int = 15,
) -> dict[str, Any]:
    """Fire-and-forget native sync on terminal transitions.

    Only activates when the task has a bound, managed native TaskFlow binding.
    Calls the Node runtime helper to propagate finish/fail/cancel to the native flow.
    Never blocks or raises — always returns a structured result dict.
    """
    error_result: dict[str, Any] = {"synced": False, "native_action": transition_type, "flow_id": "", "error": ""}
    if not isinstance(task, dict):
        error_result["error"] = "task is not a dict"
        return error_result
    tf = task.get("openclaw_taskflow")
    if not isinstance(tf, dict):
        error_result["error"] = "no openclaw_taskflow binding"
        return error_result
    if _normalized_str(tf.get("native_binding_state")) != "bound":
        return error_result
    if _normalized_str(tf.get("backend")) != "managed":
        return error_result
    if transition_type not in ("finished", "failed", "cancelled"):
        error_result["error"] = f"unsupported transition_type: {transition_type}"
        return error_result

    flow_id = _normalized_str(tf.get("flow_id"))
    if not flow_id:
        error_result["error"] = "missing flow_id"
        return error_result

    try:
        action_map = {
            "finished": "finish-flow",
            "failed": "fail-flow",
            "cancelled": "cancel-flow",
        }
        action = action_map[transition_type]
        session_key = _normalized_str(tf.get("session_key") or task.get("session_key"))
        revision = _normalized_int(tf.get("substrate_revision"))
        if transition_type == "cancelled":
            helper_args = [
                action,
                "--flow-id", flow_id,
            ]
            if session_key:
                helper_args.extend(["--session-key", session_key])
        else:
            state_json = json.dumps(
                {
                    "octoclaw_task_id": _normalized_str(task.get("id")),
                    "transition": transition_type,
                    "timestamp": now_iso(),
                },
                ensure_ascii=False,
            )
            helper_args = [
                action,
                "--flow-id", flow_id,
                "--state-json", state_json,
            ]
            if session_key:
                helper_args.extend(["--session-key", session_key])
            if revision:
                helper_args.extend(["--expected-revision", str(revision)])

        result = _run_runtime_helper(helper_args, timeout_seconds=timeout_seconds)
        ok = bool(result.get("ok"))
        return {
            "synced": ok,
            "native_action": transition_type,
            "flow_id": flow_id,
            "error": "" if ok else _normalized_str(result.get("error")) or "runtime helper returned non-ok",
        }
    except Exception as exc:
        return {
            "synced": False,
            "native_action": transition_type,
            "flow_id": flow_id,
            "error": str(exc),
        }


def reconcile_native_bindings(
    tasks: list[dict[str, Any]] | None = None,
    workspace: str = "",
    fix: bool = False,
    timeout_seconds: int = 10,
) -> dict[str, Any]:
    """Compare native flow/task state with local projection and optionally sync.

    For each bound+managed task, checks whether the local terminal state has
    been propagated to the native substrate.  In report-only mode (fix=False)
    drift is reported but not corrected.  With fix=True, terminal transitions
    are synced to native via ``sync_terminal_transition()``.

    Returns a structured summary dict with per-item results.
    """
    # --- a. Resolve task list ------------------------------------------------
    if tasks is None:
        try:
            from read_projection import read_tasks as _read_tasks  # type: ignore[import]
        except (ModuleNotFoundError, ImportError):
            try:
                from lib.read_projection import read_tasks as _read_tasks  # type: ignore[import,no-redef]
            except (ModuleNotFoundError, ImportError):
                _read_tasks = None  # type: ignore[assignment]
        if _read_tasks is None:
            return {
                "checked_count": 0,
                "synced_count": 0,
                "drift_count": 0,
                "error_count": 1,
                "items": [],
                "errors": ["read_tasks unavailable"],
            }
        try:
            all_tasks = _read_tasks(workspace=workspace) or []
        except Exception as exc:
            return {
                "checked_count": 0,
                "synced_count": 0,
                "drift_count": 0,
                "error_count": 1,
                "items": [],
                "errors": [f"read_tasks failed: {exc}"],
            }
        tasks = [t for t in all_tasks if t.get("native_sync_eligible")]

    if not tasks:
        return {
            "checked_count": 0,
            "synced_count": 0,
            "drift_count": 0,
            "error_count": 0,
            "items": [],
            "errors": [],
        }

    # --- b+c. Process each bound+managed task --------------------------------
    items: list[dict[str, Any]] = []
    synced_count = 0
    drift_count = 0
    error_count = 0
    errors: list[str] = []

    for task in tasks:
        if not isinstance(task, dict):
            continue

        task_id = _normalized_str(task.get("id"))
        tf = task.get("openclaw_taskflow")
        if not isinstance(tf, dict):
            tf = {}

        flow_id = _normalized_str(tf.get("flow_id"))
        local_status = _normalized_str(task.get("status")).lower()
        local_lifecycle = _normalized_str(task.get("lifecycle_state")).lower()
        native_sync_eligible = bool(task.get("native_sync_eligible"))

        # Skip if no flow_id to act on
        if not flow_id:
            items.append({
                "task_id": task_id,
                "flow_id": "",
                "local_status": local_status,
                "local_lifecycle": local_lifecycle,
                "native_sync_eligible": native_sync_eligible,
                "action": "skip",
                "result": "skipped_no_flow_id",
            })
            continue

        # Determine if local task is terminal
        is_terminal = (
            local_lifecycle in ("finished", "cancelled")
            or local_status in ("done", "failed", "blocked", "cancelled", "deferred")
        )

        # Check if native already synced (substrate_state is terminal)
        substrate_state = _normalized_str(tf.get("substrate_state")).lower()
        native_already_terminal = substrate_state in (
            "finished", "cancelled", "done", "failed", "completed",
        )

        if not is_terminal:
            # Local not terminal — cannot know native state without querying,
            # so just report potential drift.
            items.append({
                "task_id": task_id,
                "flow_id": flow_id,
                "local_status": local_status,
                "local_lifecycle": local_lifecycle,
                "native_sync_eligible": native_sync_eligible,
                "action": "report_drift",
                "result": "potential_drift",
            })
            drift_count += 1
            continue

        if native_already_terminal:
            # Already synced — no action needed
            items.append({
                "task_id": task_id,
                "flow_id": flow_id,
                "local_status": local_status,
                "local_lifecycle": local_lifecycle,
                "native_sync_eligible": native_sync_eligible,
                "action": "skip",
                "result": "already_synced",
            })
            continue

        # Local terminal but native not yet synced
        transition_type = "cancelled" if local_lifecycle == "cancelled" or local_status == "cancelled" else (
            "failed" if local_status in ("failed", "blocked") else "finished"
        )

        if not fix:
            items.append({
                "task_id": task_id,
                "flow_id": flow_id,
                "local_status": local_status,
                "local_lifecycle": local_lifecycle,
                "native_sync_eligible": native_sync_eligible,
                "action": "sync_terminal",
                "result": "drift_detected",
            })
            drift_count += 1
            continue

        # fix=True — actually sync
        try:
            sync_result = sync_terminal_transition(
                task, transition_type, timeout_seconds=timeout_seconds,
            )
            if sync_result.get("synced"):
                items.append({
                    "task_id": task_id,
                    "flow_id": flow_id,
                    "local_status": local_status,
                    "local_lifecycle": local_lifecycle,
                    "native_sync_eligible": native_sync_eligible,
                    "action": "sync_terminal",
                    "result": "synced",
                })
                synced_count += 1
            else:
                err_msg = _normalized_str(sync_result.get("error")) or "sync_failed"
                items.append({
                    "task_id": task_id,
                    "flow_id": flow_id,
                    "local_status": local_status,
                    "local_lifecycle": local_lifecycle,
                    "native_sync_eligible": native_sync_eligible,
                    "action": "sync_terminal",
                    "result": "sync_failed",
                })
                error_count += 1
                errors.append(f"{task_id}: {err_msg}")
        except Exception as exc:
            items.append({
                "task_id": task_id,
                "flow_id": flow_id,
                "local_status": local_status,
                "local_lifecycle": local_lifecycle,
                "native_sync_eligible": native_sync_eligible,
                "action": "sync_terminal",
                "result": "sync_failed",
            })
            error_count += 1
            errors.append(f"{task_id}: {exc}")

    # --- e. Return summary ---------------------------------------------------
    return {
        "checked_count": len(items),
        "synced_count": synced_count,
        "drift_count": drift_count,
        "error_count": error_count,
        "items": items,
        "errors": errors,
    }


def enrich_task_record_with_taskflow(
    task: dict[str, Any],
    *,
    native_tasks: list[dict[str, Any]] | None = None,
    native_flows: list[dict[str, Any]] | None = None,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not isinstance(task, dict):
        return task
    binding = _binding_from_task(task)
    if not binding:
        binding = register_taskflow_binding(task, config=config)
    if not binding:
        return task
    resolved = reconcile_native_taskflow_binding(
        task,
        binding=binding,
        native_tasks=native_tasks,
        native_flows=native_flows,
        config=config,
    )
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
    updated["native_sync_eligible"] = (
        str(resolved.get("native_binding_state", "")) == "bound"
        and str(resolved.get("backend", "")) == "managed"
    )
    try:
        os.makedirs(os.path.dirname(OPENCLAW_TASKFLOW_MIRROR_FILE), exist_ok=True)
        with open(OPENCLAW_TASKFLOW_MIRROR_FILE, "a+", encoding="utf-8") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            mirror = _load_mirror_unlocked(OPENCLAW_TASKFLOW_MIRROR_FILE)
            entries = mirror.get("entries", {})
            task_key = _normalized_str(updated.get("id"))
            if _retain_legacy_mirror_entry(resolved):
                entries[task_key] = {
                    "task_id": task_key,
                    "route": _normalized_str(updated.get("route")),
                    "worker_pool": _normalized_str(updated.get("worker_pool")),
                    "status": _normalized_str(updated.get("status")),
                    "summary": _normalized_str(updated.get("summary")),
                    "link": resolved,
                    "updated_at": now_iso(),
                }
            elif task_key:
                entries.pop(task_key, None)
            mirror["entries"] = entries
            _persist_mirror(OPENCLAW_TASKFLOW_MIRROR_FILE, mirror)
            fcntl.flock(fh, fcntl.LOCK_UN)
    except OSError:
        pass
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
        lifecycle_state = _normalized_str(task.get("lifecycle_state")).lower()
        status = _normalized_str(task.get("status")).lower()
        is_terminal = lifecycle_state in {"finished", "cancelled"} or status in {"done", "failed", "blocked", "cancelled", "deferred"}
        if not is_terminal:
            continue
        task_id = _normalized_str(task.get("id"))
        mirror_entry = entries.get(task_id) if isinstance(entries.get(task_id), dict) else {}
        native_binding_state = _normalized_str(binding.get("native_binding_state")).lower()
        backend = _normalized_str(binding.get("backend")).lower()
        sync_mode = _normalized_str(binding.get("sync_mode")).lower()
        cleanup_reason = ""
        if create_status in {"mirror_only", "native_unavailable_fallback_mirror"}:
            cleanup_reason = "legacy_fallback_retention_expired"
        elif mirror_entry and (native_binding_state == "bound" or backend == "managed" or sync_mode == "managed"):
            cleanup_reason = "native_or_managed_superseded"
        if not cleanup_reason:
            continue
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
                "cleanup_reason": cleanup_reason,
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
