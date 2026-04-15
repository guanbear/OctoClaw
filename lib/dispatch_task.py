#!/usr/bin/env python3
"""Unified OctoClaw task dispatcher.

- Consume a precomputed runtime policy decision from the gateway extension
- Fast lightweight tasks -> persistent runner
- Other tasks -> return a structured spawn recommendation
"""

from __future__ import annotations

import argparse
import copy
import fcntl
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone

from octoclaw_spawn import build_spawn_spec
from octopus_config import RUNNER_HEALTH_FILE, RUNNER_QUEUE_FILE, RUNNER_RESULTS_DIR, SHARED_DIR, TASK_STATE_FILE, WORKSPACE, load_json, load_octopus_config, resolve_runner_mode, spawn_operator_surface, workbench_config
try:
    from octopus_config import concurrency_policy as _load_concurrency_policy
except ImportError:
    _load_concurrency_policy = None

try:
    from dispatch_routing import generate_dispatch_key, generate_lane_key, normalize_dispatch_key, normalize_task_text_for_key, resolve_capacity_group
except ImportError:
    generate_dispatch_key = None
    generate_lane_key = None
    normalize_dispatch_key = None
    normalize_task_text_for_key = None
    resolve_capacity_group = None
from runner_goal_contract import build_runner_goal_contract
from runner_queue import recover_stale_running_jobs
from runtime_protocol import build_capability_bound_failure, build_delegated_materialization, normalize_worker_result
from runtime_snapshot import default_runner_execution_mode, load_runner_health, load_runner_queue_counts, probe_tmux_session
from runner_playbooks import infer_runner_playbook
from worker_taxonomy import (
    infer_model_band as taxonomy_infer_model_band,
    resolve_phase as taxonomy_resolve_phase,
    resolve_work_type as taxonomy_resolve_work_type,
)


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RUNNER_DISPATCH_PY = os.path.join(SCRIPT_DIR, "runner_dispatch.py")
RUNNER_DAEMON_SH = os.path.join(SCRIPT_DIR, "runner-daemon.sh")
RUNNER_LOOP_SH = os.path.join(SCRIPT_DIR, "runner_loop.sh")
RUNNER_QUEUE_PY = os.path.join(SCRIPT_DIR, "runner_queue.py")
RESOLVE_MODEL_PY = os.path.join(SCRIPT_DIR, "resolve-model.py")
TASK_STATE_PY = os.path.join(SCRIPT_DIR, "task-state-update.py")
MAX_INLINE_CHARS = 1200
RUNNER_STALE_SECONDS = 60
RUNNER_POOL_DEFAULTS = {
    "enabled": True,
    "max_queue_size": 20,
    "per_user_concurrency": 1,
    "lease_timeout_seconds": 90,
    "busy_strategy": "queue_or_progress",
    "legacy_runner_fallback": True,
}


def runner_tmux_status(config: dict | None = None) -> dict:
    cfg = config if isinstance(config, dict) else load_octopus_config()
    workbench = workbench_config(cfg)
    mode = str(workbench.get("supervisor_mode", "auto") or "auto").strip() or "auto"
    session_name = str(workbench.get("tmux_session_name", "") or "").strip()
    window_name = str(workbench.get("tmux_runner_window_name", "runner") or "runner").strip() or "runner"
    if mode != "tmux" or not session_name:
        return {
            "required": False,
            "available": False,
            "healthy": False,
            "reason": "not_configured",
            "session_name": session_name,
            "runner_window_name": window_name,
        }
    return probe_tmux_session(session_name, runner_window_name=window_name)


def ensure_runner_daemon(config: dict | None = None) -> dict:
    cfg = config if isinstance(config, dict) else load_octopus_config()
    runner_mode = default_runner_execution_mode(resolve_runner_mode(cfg))
    if runner_mode != "daemon":
        return {"ok": False, "reason": "runner_mode_not_daemon", "runner_mode": runner_mode}
    if not os.path.exists(RUNNER_DAEMON_SH):
        return {"ok": False, "reason": "runner_daemon_script_missing", "runner_mode": runner_mode}
    env = {
        **os.environ,
        "WORKSPACE": WORKSPACE,
        "OCTOCLAW_WORKSPACE": WORKSPACE,
        "OCTOCLAW_ENABLE_LEGACY_LOOPS": "1",
    }
    workbench = workbench_config(cfg)
    session_name = str(workbench.get("tmux_session_name", "") or "").strip()
    runner_window = str(workbench.get("tmux_runner_window_name", "runner") or "runner").strip() or "runner"
    if session_name:
        env["TMUX_SESSION_NAME"] = session_name
    if runner_window:
        env["TMUX_RUNNER_WINDOW_NAME"] = runner_window
    try:
        result = subprocess.run(
            ["bash", RUNNER_DAEMON_SH],
            capture_output=True,
            text=True,
            check=False,
            timeout=20,
            env=env,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "reason": "runner_daemon_timeout", "runner_mode": runner_mode}
    return {
        "ok": result.returncode == 0,
        "reason": "ok" if result.returncode == 0 else "runner_daemon_failed",
        "runner_mode": runner_mode,
        "stdout": str(result.stdout or "").strip(),
        "stderr": str(result.stderr or "").strip(),
        "returncode": int(result.returncode or 0),
    }

ROUTE_TIMEOUT_TIERS = {
    "runner": 12,
    "spawn_single": 45,
    "spawn_multi": 120,
    "direct": 5,
}

def route_timeout_seconds(route: str, default: int = 12) -> int:
    """Return wait timeout based on route type."""
    return ROUTE_TIMEOUT_TIERS.get(route, default)

MULTI_STEP_POLICY_PRESETS = {
    "planner": {
        "worker_pool": "octoclaw-research",
        "work_type": "research",
        "phase": "inspect",
        "profile": "research",
        "model_band": "normal",
        "selector_band": "standard",
        "reason_code": "spawn_multi_planner_step",
    },
    "review": {
        "worker_pool": "octoclaw-review",
        "work_type": "review",
        "phase": "verify",
        "profile": "review",
        "model_band": "strong",
        "selector_band": "strong",
        "reason_code": "spawn_multi_review_step",
    },
}


def decision_route(decision: dict) -> dict:
    value = decision.get("route_decision", {})
    return value if isinstance(value, dict) else {}


def decision_model(decision: dict) -> dict:
    value = decision.get("model_policy", {})
    return value if isinstance(value, dict) else {}


def decision_skill(decision: dict) -> dict:
    value = decision.get("skill_policy", {})
    return value if isinstance(value, dict) else {}


def decision_review(decision: dict) -> dict:
    value = decision.get("review_policy", {})
    return value if isinstance(value, dict) else {}


def decision_request(decision: dict) -> dict:
    value = decision.get("request", {})
    return value if isinstance(value, dict) else {}


def decision_metadata(decision: dict) -> dict:
    request = decision_request(decision)
    value = request.get("metadata", {})
    return value if isinstance(value, dict) else {}


def merge_runtime_metadata_into_decision(decision: dict, metadata: dict | None = None, *, session_key: str = "") -> dict:
    """Make CLI/tool materialization metadata authoritative for the live dispatch path."""
    merged = copy.deepcopy(decision if isinstance(decision, dict) else {})
    request = ensure_nested_dict(merged, "request")
    request_metadata = request.get("metadata", {})
    if not isinstance(request_metadata, dict):
        request_metadata = {}
    for key, value in (metadata or {}).items():
        if key == "session_key" and not str(value or "").strip():
            continue
        request_metadata[key] = value
    resolved_session_key = str(session_key or request_metadata.get("session_key", "") or request.get("session_key", "") or "").strip()
    if resolved_session_key:
        request["session_key"] = resolved_session_key
        request_metadata["session_key"] = resolved_session_key
    request["metadata"] = request_metadata
    return merged


def ensure_nested_dict(root: dict, key: str) -> dict:
    value = root.get(key, {})
    if not isinstance(value, dict):
        value = {}
        root[key] = value
    return value


def legacy_policy_fallback_enabled() -> bool:
    env_value = str(os.environ.get("OCTOCLAW_LEGACY_POLICY_FALLBACK", "") or "").strip().lower()
    if env_value in {"1", "true", "yes", "on"}:
        return True
    runtime_policy = load_octopus_config().get("runtime_policy", {})
    if not isinstance(runtime_policy, dict):
        return False
    features = runtime_policy.get("features", {})
    if isinstance(features, dict) and "legacy_policy_fallback" in features:
        return bool(features.get("legacy_policy_fallback"))
    return False


def build_legacy_policy_decision(task: str, command: str, metadata: dict | None = None, *, force_route: str = "") -> dict:
    import sys
    print("DEPRECATED: octoclaw legacy Python policy fallback activated — remove in R10", file=sys.stderr)
    from octoclaw_policy import build_decision as legacy_build_decision  # DEPRECATED: parity-only fallback, remove in R8+1

    return legacy_build_decision(task, command, metadata or {}, force_route=force_route)


def build_dispatch_policy_required_failure(task: str, *, force_route: str = "") -> dict:
    failure = build_capability_bound_failure(
        "dispatch",
        "policy_decision_required",
        detail="dispatch_task live hot path now requires a precomputed runtime policy decision. Use octoclaw_dispatch from the gateway extension or pass --policy-json.",
        missing_capabilities=["precomputed_policy_decision"],
        fallback_permitted=False,
    )
    route = str(force_route or "").strip() or "direct"
    return {
        "route": route,
        "executed": False,
        "reason": "policy_decision_required",
        "task": task,
        "capability_failure": failure,
        "materialization": build_delegated_materialization(
            lane=route,
            kind="dispatch_gate",
            status="materialization_failed",
            execution_contract="precomputed_policy_decision",
            executed=False,
            capability_failure=failure,
        ),
        "handoff": {
            "kind": "plan",
            "status": "failed",
            "summary": "dispatch 缺少预计算 policy decision，未继续执行。",
            "reply_text": "当前 dispatch 热路径要求先由 gateway extension 生成 runtime policy decision；这次没有拿到 policy_json，所以没有继续执行。",
            "report_path": "",
            "user_safe": True,
        },
        "policy_decision": {},
        "legacy_policy_fallback_used": False,
    }


def synthesize_multi_step_decision(decision: dict, step_name: str) -> dict:
    if step_name == "worker":
        return clone_worker_step_decision(decision)
    preset = MULTI_STEP_POLICY_PRESETS.get(step_name)
    if not preset:
        return clone_worker_step_decision(decision)
    cloned = copy.deepcopy(decision if isinstance(decision, dict) else {})
    route_meta = ensure_nested_dict(cloned, "route_decision")
    model_meta = ensure_nested_dict(cloned, "model_policy")
    route_meta["route"] = "spawn_single"
    route_meta["system_preferred_route"] = "spawn_single"
    route_meta["executor_type"] = "subagent"
    route_meta["dispatch_required"] = True
    route_meta["should_wait"] = False
    route_meta["wait_timeout_seconds"] = 0
    route_meta["worker_pool"] = str(preset.get("worker_pool", "") or "")
    route_meta["work_type"] = str(preset.get("work_type", "") or "")
    route_meta["phase"] = str(preset.get("phase", "") or "")
    route_meta["protocol"] = "normal"
    reason_codes = [str(preset.get("reason_code", "") or "").strip()]
    existing_reason_codes = [str(item or "").strip() for item in route_meta.get("reason_codes", []) if str(item or "").strip()]
    route_meta["reason_codes"] = [item for item in reason_codes + existing_reason_codes if item]
    route_meta["reason"] = route_meta["reason_codes"][0] if route_meta["reason_codes"] else str(preset.get("reason_code", "") or "")
    model_meta["profile"] = str(preset.get("profile", "") or "")
    model_meta["model_band"] = str(preset.get("model_band", "") or "")
    model_meta["selector_band"] = str(preset.get("selector_band", "") or "")
    model_meta["selected_model"] = ""
    cloned["summary"] = f"synthetic_{step_name}_decision -> {route_meta['worker_pool']} / profile={model_meta['profile']}"
    return cloned


def runner_playbook_hints(decision: dict) -> dict:
    route_meta = decision_route(decision)
    metadata = decision_metadata(decision)
    features = route_meta.get("features", {})
    if not isinstance(features, dict):
        features = {}
    conversation = metadata.get("conversation_control", {})
    if not isinstance(conversation, dict):
        conversation = {}
    return {
        "lookup_scope": str(conversation.get("lookup_scope") or features.get("lookup_scope") or "").strip(),
        "lookup_project": str(conversation.get("lookup_project") or features.get("lookup_project") or "").strip(),
        "lookup_focus": str(conversation.get("lookup_focus") or features.get("lookup_focus") or "").strip(),
        "target_scope": str(features.get("target_scope") or "").strip(),
        "requires_research": bool(features.get("requires_research")),
        "runner_negative_hits": int(features.get("runner_negative_hits") or 0),
        "summary_output_hits": int(features.get("summary_output_hits") or 0),
        "bounded_software_update_lookup": bool(features.get("bounded_software_update_lookup")),
    }


def decision_runner_playbook(decision: dict) -> dict | None:
    route_meta = decision_route(decision)
    playbook = route_meta.get("runner_playbook", {})
    if isinstance(playbook, dict) and playbook:
        return copy.deepcopy(playbook)
    return None


def octoclaw_identity_fields(decision: dict) -> dict:
    request = decision_request(decision)
    metadata = decision_metadata(decision)
    managed = metadata.get("managed_by_octoclaw")
    if managed is None or str(managed).strip() == "":
        managed = True
    return {
        "source": "octoclaw",
        "session_key": str(request.get("session_key", "") or metadata.get("session_key", "") or ""),
        "session_id": str(metadata.get("session_id", "") or ""),
        "agent_id": str(metadata.get("agent_id", "") or ""),
        "agent_namespace": str(metadata.get("agent_namespace", "") or "octoclaw"),
        "managed_by_octoclaw": "true" if str(managed).strip().lower() not in {"0", "false", "no", "off"} else "false",
    }


def apply_policy_fields(payload: dict, decision: dict) -> dict:
    route_meta = decision_route(decision)
    model_meta = decision_model(decision)
    skill_meta = decision_skill(decision)
    review_meta = decision_review(decision)

    payload["policy_summary"] = decision.get("summary", "")
    payload["policy_decision"] = decision
    payload["reason"] = route_meta.get("reason", payload.get("reason", ""))
    payload["reasons"] = route_meta.get("reason_codes", [])
    payload["reason_codes"] = route_meta.get("reason_codes", [])
    payload["scores"] = route_meta.get("scores", {})
    payload["system_preferred_route"] = route_meta.get("system_preferred_route", route_meta.get("route"))
    payload["task_class"] = route_meta.get("task_class")
    payload["expected_latency_ms"] = route_meta.get("expected_latency_ms")
    payload["expected_cost_band"] = route_meta.get("expected_cost_band")
    payload["context_growth_band"] = route_meta.get("context_growth_band")
    payload["execution_owner"] = route_meta.get("executor_type")
    payload["dispatch_required"] = route_meta.get("dispatch_required")
    payload["worker_pool"] = route_meta.get("worker_pool")
    payload["work_type"] = route_meta.get("work_type")
    payload["phase"] = route_meta.get("phase")
    payload["protocol"] = route_meta.get("protocol")
    payload["profile"] = payload.get("profile") or model_meta.get("profile", "")
    payload["model_band"] = payload.get("model_band") or model_meta.get("model_band", "")
    payload["selector_band"] = payload.get("selector_band") or model_meta.get("selector_band", "")
    payload["skill_bundle"] = skill_meta.get("default_skill_bundle", [])
    payload["review_required"] = review_meta.get("required", False)
    payload["legacy_policy_fallback_used"] = bool(decision.get("legacy_policy_fallback_used", False))
    if isinstance(decision.get("route_recommendation"), dict):
        payload["route_recommendation"] = dict(decision["route_recommendation"])
    if isinstance(decision.get("budget_recommendation"), dict):
        payload["budget_recommendation"] = dict(decision["budget_recommendation"])
    if isinstance(decision.get("auto_router"), dict):
        auto_router = dict(decision["auto_router"])
        payload["auto_router"] = auto_router
        router_core = auto_router.get("router_core")
        if isinstance(router_core, dict) and "execution_contract" not in payload:
            payload["execution_contract"] = dict(router_core)
    return payload


def clone_worker_step_decision(decision: dict) -> dict:
    cloned = copy.deepcopy(decision)
    route_meta = decision_route(cloned)
    route_meta["route"] = "spawn_single"
    route_meta["executor_type"] = "subagent"
    route_meta["dispatch_required"] = True
    route_meta["should_wait"] = False
    route_meta["wait_timeout_seconds"] = 0
    reason_codes = list(route_meta.get("reason_codes", []) or [])
    if "multi_worker_from_primary_decision" not in reason_codes:
        reason_codes.insert(0, "multi_worker_from_primary_decision")
    route_meta["reason_codes"] = reason_codes
    route_meta["reason"] = reason_codes[0] if reason_codes else "multi_worker_from_primary_decision"
    route_meta["worker_pool"] = route_meta.get("worker_pool", "octoclaw-research")
    cloned["summary"] = f"policy=spawn_single -> {route_meta.get('worker_pool', 'octoclaw-research')} / profile={decision_model(cloned).get('profile', '')}"
    return cloned


def compat_spawn_step_from_decision(decision: dict, fallback: dict | None = None) -> dict[str, str | dict]:
    fallback = fallback if isinstance(fallback, dict) else {}
    route_meta = decision_route(decision)
    model_meta = decision_model(decision)

    route = str(route_meta.get("route", fallback.get("route", "spawn_single")) or "spawn_single")
    worker_pool = str(route_meta.get("worker_pool", fallback.get("worker_pool", "")) or "")
    work_type = str(route_meta.get("work_type", fallback.get("work_type", "")) or "")
    phase = str(route_meta.get("phase", fallback.get("phase", "")) or "")
    profile = str(model_meta.get("profile", fallback.get("profile", "")) or "")
    model_band = str(model_meta.get("model_band", "") or fallback.get("model_band", "") or "")
    if not model_band:
        model_band = taxonomy_infer_model_band(route=route, worker_pool=worker_pool, work_type=work_type, protocol=str(route_meta.get("protocol", "") or "")) or "normal"
    return {
        "worker_pool": worker_pool,
        "work_type": work_type,
        "phase": phase,
        "profile": profile,
        "model_band": model_band,
        "selector_band": str(model_meta.get("selector_band", "") or fallback.get("selector_band", "") or ""),
        "model": str(model_meta.get("selected_model", "") or fallback.get("model", "") or ""),
        "policy_decision": decision,
    }


def now_compact() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")


def parse_iso(value: str):
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def check_dispatch_dedup(dispatch_key: str, workspace: str = "") -> dict | None:
    """Check if an active task with the same dispatch_key already exists in task-state.json.

    Returns dedup info dict if a non-terminal match is found, else None.
    """
    if normalize_dispatch_key is not None:
        if not normalize_dispatch_key(dispatch_key):
            return None
    elif not dispatch_key or not isinstance(dispatch_key, str):
        return None

    state_file = os.path.join(workspace, "tmp", "octopus", "task-state.json") if workspace else TASK_STATE_FILE
    if not os.path.isfile(state_file):
        return None

    dedup_window = 3600
    if _load_concurrency_policy is not None:
        try:
            policy = _load_concurrency_policy()
            if isinstance(policy, dict):
                dedup_window = max(0, int(policy.get("dedup_window_seconds", 3600) or 3600))
        except Exception:
            pass

    now_ts = time.time()
    cutoff = now_ts - dedup_window

    terminal_lifecycle = {"finished", "cancelled"}
    terminal_status = {"done", "completed", "failed", "cancelled"}

    try:
        with open(state_file, "r", encoding="utf-8") as f:
            fcntl.flock(f, fcntl.LOCK_SH)
            try:
                raw = f.read()
            finally:
                fcntl.flock(f, fcntl.LOCK_UN)
        data = json.loads(raw)
        if not isinstance(data, dict):
            return None
        tasks = data.get("tasks", [])
        if not isinstance(tasks, list):
            return None

        for task_entry in tasks:
            if not isinstance(task_entry, dict):
                continue
            task_dk = str(task_entry.get("dispatch_key", "") or "").strip()
            if task_dk != dispatch_key:
                continue
            lifecycle = str(task_entry.get("lifecycle_state", "") or "").strip().lower()
            status = str(task_entry.get("status", "") or "").strip().lower()
            if lifecycle in terminal_lifecycle or status in terminal_status:
                continue
            created_at = str(
                task_entry.get("created_at", "") or task_entry.get("dispatched_at", "") or task_entry.get("started_at", "") or ""
            ).strip()
            if created_at:
                parsed = parse_iso(created_at)
                if parsed is not None:
                    created_ts = parsed.timestamp()
                    if created_ts < cutoff:
                        continue
            return {
                "dedup": True,
                "existing_task_id": str(task_entry.get("id", "") or ""),
                "existing_status": status,
                "dispatch_key": dispatch_key,
            }
    except (OSError, json.JSONDecodeError, ValueError):
        return None

    return None


def task_title(task: str, limit: int = 72) -> str:
    text = re.sub(r"\s+", " ", (task or "").strip())
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def compact_text(text: str, limit: int = 120) -> str:
    value = re.sub(r"\s+", " ", str(text or "").strip())
    if len(value) <= limit:
        return value
    return value[: limit - 1].rstrip() + "…"


def upsert_runtime_task(
    dispatch_key: str = "",
    lane_key: str = "",
    capacity_group: str = "",
    **fields,
) -> None:
    cmd = ["python3", TASK_STATE_PY, "upsert"]
    for key, value in fields.items():
        text = str(value or "").strip()
        if not text:
            continue
        cmd.extend([f"--{key.replace('_', '-')}", text])
    if str(dispatch_key or "").strip():
        cmd.extend(["--dispatch-key", str(dispatch_key).strip()])
    if str(lane_key or "").strip():
        cmd.extend(["--lane-key", str(lane_key).strip()])
    if str(capacity_group or "").strip():
        cmd.extend(["--capacity-group", str(capacity_group).strip()])
    subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=15)


def append_runtime_task_event(task_id: str, kind: str, message: str, *, event_json: dict | None = None) -> None:
    normalized_task_id = str(task_id or "").strip()
    normalized_kind = str(kind or "").strip()
    normalized_message = str(message or "").strip()
    if not normalized_task_id or not normalized_kind:
        return
    cmd = [
        "python3",
        TASK_STATE_PY,
        "event",
        "--id",
        normalized_task_id,
        "--kind",
        normalized_kind,
        "--message",
        normalized_message or normalized_kind,
    ]
    if isinstance(event_json, dict) and event_json:
        cmd.extend(["--event-json", json.dumps(event_json, ensure_ascii=False)])
    subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=15)


def configured_spawn_backend() -> str:
    spawn_cfg = load_octopus_config().get("spawn_execution", {})
    if not isinstance(spawn_cfg, dict) or not spawn_cfg.get("enabled", False):
        return ""
    backend = str(spawn_cfg.get("backend", "plan") or "plan").strip().lower()
    return backend if backend in {"native", "clawteam"} else ""


def build_multi_parent_artifacts(plan: dict, steps: list[dict], backend: str, *, parent_spec: dict | None = None) -> dict:
    ordered_steps = [name for name in ("planner", "worker", "review") if isinstance(plan.get(name), dict)]
    child_task_ids = [str(step.get("task_id", "") or "").strip() for step in steps if str(step.get("task_id", "") or "").strip()]
    operator_surface = spawn_operator_surface()
    operator_surface["backend"] = backend
    backend_name = str(operator_surface.get("backend_name", "tmux") or "tmux")
    if backend == "clawteam":
        team_name = str(operator_surface.get("team_name", "") or "").strip()
        operator_surface["operator_hint"] = f"clawteam/{backend_name}" + (f" {team_name}" if team_name else "")
    else:
        operator_surface["operator_hint"] = backend or str(operator_surface.get("operator_hint", "") or "")

    def step_taxonomy(entry: dict) -> dict[str, str]:
        if not isinstance(entry, dict):
            return {"worker_pool": "", "work_type": "", "phase": "", "profile": "", "model_band": "", "selector_band": ""}
        worker_pool = str(entry.get("worker_pool", "") or "")
        profile = str(entry.get("profile", "") or "")
        work_type = str(entry.get("work_type", "") or "") or str(
            taxonomy_resolve_work_type({"worker_pool": worker_pool, "profile": profile}) or ""
        )
        phase = str(entry.get("phase", "") or "") or str(
            taxonomy_resolve_phase(
                {
                    "worker_pool": worker_pool,
                    "work_type": work_type,
                    "profile": profile,
                }
            )
            or ""
        )
        return {
            "worker_pool": worker_pool,
            "work_type": work_type,
            "phase": phase,
            "profile": profile,
            "model_band": str(entry.get("model_band", "") or ""),
            "selector_band": str(entry.get("selector_band", "") or ""),
        }

    artifacts = {
        "step_order": ordered_steps,
        "child_task_ids": child_task_ids,
        "step_task_ids": {
            str(step.get("step", "") or ""): str(step.get("task_id", "") or "")
            for step in steps
            if str(step.get("step", "") or "").strip() and str(step.get("task_id", "") or "").strip()
        },
        "step_task_kinds": {
            str(step.get("step", "") or ""): str(step.get("task_kind", "") or "")
            for step in steps
            if str(step.get("step", "") or "").strip()
        },
        "step_models": {
            name: {
                "worker_pool": step_taxonomy(plan.get(name) or {}).get("worker_pool", ""),
                "work_type": step_taxonomy(plan.get(name) or {}).get("work_type", ""),
                "phase": step_taxonomy(plan.get(name) or {}).get("phase", ""),
                "profile": step_taxonomy(plan.get(name) or {}).get("profile", ""),
                "model_band": step_taxonomy(plan.get(name) or {}).get("model_band", ""),
                "selector_band": step_taxonomy(plan.get(name) or {}).get("selector_band", ""),
                "model": str((plan.get(name) or {}).get("model", "") or ""),
            }
            for name in ordered_steps
        },
        "step_reports": {
            str(step.get("step", "") or ""): str(step.get("report_path", "") or "")
            for step in steps
            if str(step.get("step", "") or "").strip()
        },
        "execution_backend": backend,
        "child_count": len(child_task_ids),
        "operator_surface": operator_surface,
        "operator_hint": str(operator_surface.get("operator_hint", "") or ""),
    }
    parent_artifacts = (parent_spec or {}).get("artifacts", {}) if isinstance((parent_spec or {}).get("artifacts", {}), dict) else {}
    taskflow = (parent_spec or {}).get("openclaw_taskflow", {})
    if not isinstance(taskflow, dict):
        taskflow = parent_artifacts.get("openclaw_taskflow", {}) if isinstance(parent_artifacts.get("openclaw_taskflow", {}), dict) else {}
    if isinstance(taskflow, dict) and taskflow:
        artifacts["openclaw_taskflow"] = dict(taskflow)
    replacement_chain = execution_chain_source(parent_spec)
    if any(replacement_chain.values()):
        artifacts["replacement_chain"] = replacement_chain
    delegated_materialization = (parent_spec or {}).get("materialization")
    if isinstance(delegated_materialization, dict) and delegated_materialization:
        artifacts["delegated_materialization"] = dict(delegated_materialization)
    capability_failure = (parent_spec or {}).get("capability_failure")
    if isinstance(capability_failure, dict) and capability_failure:
        artifacts["capability_failure"] = dict(capability_failure)
    latest_truth = reconcile_latest_truth_packet(
        (parent_spec or {}).get("latest_truth") if isinstance((parent_spec or {}).get("latest_truth"), dict) else None,
        delegated_materialization if isinstance(delegated_materialization, dict) else None,
    )
    if latest_truth:
        artifacts["latest_truth"] = latest_truth
    return artifacts


def register_multi_parent_task(
    *,
    task: str,
    parent_spec: dict,
    decision: dict,
    plan: dict,
    execution: dict,
    backend: str,
    parent_parent_id: str = "",
) -> None:
    route_meta = decision_route(decision)
    model_meta = decision_model(decision)
    child_ids = [str(step.get("task_id", "") or "").strip() for step in execution.get("steps", []) if str(step.get("task_id", "") or "").strip()]
    step_names = " / ".join(name for name in ("planner", "worker", "review") if isinstance(plan.get(name), dict))
    executed = bool(execution.get("executed", False))
    handoff = execution.get("handoff", {}) if isinstance(execution.get("handoff", {}), dict) else {}
    status = "running" if executed else ("failed" if handoff.get("status") == "failed" else "dispatched")
    summary = (
        f"spawn_multi active: {step_names}" if executed
        else (f"spawn_multi failed: {step_names}" if status == "failed" else f"spawn_multi planned: {step_names}")
    )
    upsert_runtime_task(
        id=str(parent_spec.get("task_id", "") or ""),
        model=str(parent_spec.get("model", "") or ""),
        status=status,
        summary=summary,
        title=task_title(task),
        model_band=str(parent_spec.get("model_band", "") or ""),
        task_description=task,
        expected_done=str(parent_spec.get("expected_done", "") or ""),
        executor="team",
        route="spawn_multi",
        runtime=backend,
        parent_id=parent_parent_id,
        child_ids=",".join(child_ids),
        report_path=str(parent_spec.get("report_path", "") or ""),
        context_path=str(parent_spec.get("context_path", "") or ""),
        context_summary=str(parent_spec.get("context_summary", "") or ""),
        task_kind="team_parent",
        worker_pool=str(route_meta.get("worker_pool", "") or ""),
        work_type=str(route_meta.get("work_type", "") or ""),
        phase=str(route_meta.get("phase", "") or ""),
        protocol=str(route_meta.get("protocol", "") or "normal"),
        profile=str(model_meta.get("profile", "") or parent_spec.get("profile", "")),
        review_required="true" if bool(decision_review(decision).get("required", False)) else "false",
        artifacts_json=json.dumps(build_multi_parent_artifacts(plan, execution.get("steps", []), backend, parent_spec=parent_spec), ensure_ascii=False),
        **octoclaw_identity_fields(decision),
    )


def _tail_text(path: str, limit: int = 1600) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read().strip()
        if len(text) <= limit:
            return text
        return text[-limit:]
    except OSError:
        return ""


def _read_text(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def _clean_output_lines(text: str) -> list[str]:
    lines = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if re.fullmatch(r"[-=]{3,}[A-Z_-]*[-=]{0,}", line):
            continue
        lines.append(line)
    return lines


def _summarize_output(text: str, max_lines: int = 5, max_chars: int = 420) -> str:
    lines = _clean_output_lines(text)
    if not lines:
        return ""
    result: list[str] = []
    total = 0
    for line in lines[:max_lines]:
        if total + len(line) > max_chars and result:
            break
        result.append(line)
        total += len(line)
    summary = "\n".join(result).strip()
    if len(summary) > max_chars:
        summary = summary[: max_chars - 1].rstrip() + "…"
    return summary


def _write_shared_report(job_id: str, content: str) -> str:
    if not content.strip():
        return ""
    os.makedirs(SHARED_DIR, exist_ok=True)
    path = os.path.join(SHARED_DIR, f"{job_id}.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(content.rstrip() + "\n")
    return path


def _runner_result_payload(
    *,
    status: str,
    meta: dict | None,
    result_path: str,
    fallback_exit_code: int = 0,
    fallback_finished_at: str = "",
    fallback_summary: str = "",
) -> dict:
    meta = meta if isinstance(meta, dict) else {}
    stdout_file = str(meta.get("stdout_file", "") or "")
    stderr_file = str(meta.get("stderr_file", "") or "")
    stdout_excerpt = str(meta.get("stdout_excerpt", "") or "").strip() or _tail_text(stdout_file)
    stderr_excerpt = str(meta.get("stderr_excerpt", "") or "").strip() or _tail_text(stderr_file)
    worker_result = normalize_worker_result(
        meta.get("worker_result") if isinstance(meta.get("worker_result"), dict) else {
            "status": str(meta.get("status", "") or status or "done"),
            "summary": str(meta.get("summary", "") or fallback_summary or ""),
            "report": str(meta.get("report_path", "") or ""),
            "next_step": "none" if str(meta.get("status", "") or status or "done").strip().lower() in {"done", "completed"} else "inspect report and retry or replan",
        },
        task_id=str(meta.get("id", "") or ""),
        default_report=str(meta.get("report_path", "") or ""),
    )
    return {
        "completed": True,
        "status": str(meta.get("status", "") or status or "done"),
        "exit_code": int(meta.get("exit_code", fallback_exit_code) or fallback_exit_code or 0),
        "result_path": result_path,
        "report_path": str(meta.get("report_path", "") or worker_result.get("report", "") or ""),
        "summary": str(meta.get("summary", "") or worker_result.get("summary", "") or fallback_summary or ""),
        "stdout_file": stdout_file,
        "stderr_file": stderr_file,
        "stdout_excerpt": stdout_excerpt,
        "stderr_excerpt": stderr_excerpt,
        "execution_backend": str(meta.get("execution_backend", "") or "runner_queue"),
        "command": str(meta.get("command", "") or ""),
        "cwd": str(meta.get("cwd", "") or ""),
        "timeout_seconds": int(meta.get("timeout_seconds", 0) or 0),
        "worker_id": str(meta.get("worker_id", "") or ""),
        "finished_at": str(meta.get("finished_at", "") or fallback_finished_at or ""),
        "worker_result": worker_result,
    }


def build_runner_materialization(
    *,
    execution_contract: str,
    session_key: str = "",
    job_id: str = "",
    executed: bool = False,
    failure: dict | None = None,
) -> dict:
    return build_delegated_materialization(
        lane="runner",
        kind="runner_playbook",
        status="materialization_failed" if isinstance(failure, dict) and failure else "materialized",
        execution_contract=execution_contract,
        runner_job_id=job_id,
        session_key=session_key,
        executed=executed,
        capability_failure=failure,
    )


def build_spawn_materialization(
    *,
    route: str,
    execution_contract: str,
    session_key: str = "",
    task_id: str = "",
    executed: bool = False,
    failure: dict | None = None,
    controller_execution_id: str = "",
    supersedes: str = "",
    superseded_by: str = "",
    replacement_reason: str = "",
    latest_truth: dict | None = None,
) -> dict:
    return build_delegated_materialization(
        lane=route,
        kind="spawn_team_flow" if route == "spawn_multi" else "spawn_child_task",
        status="materialization_failed" if isinstance(failure, dict) and failure else "materialized",
        execution_contract=execution_contract,
        task_id=task_id,
        child_spec_id=task_id,
        session_key=session_key,
        executed=executed,
        capability_failure=failure,
        controller_execution_id=controller_execution_id,
        supersedes=supersedes,
        superseded_by=superseded_by,
        replacement_reason=replacement_reason,
        latest_truth=latest_truth,
    )


def reconcile_latest_truth_packet(*payloads: dict | None) -> dict:
    subject = ""
    version = ""
    release = ""
    source = ""
    published_at = ""
    summary = ""
    for payload in payloads:
        if not isinstance(payload, dict):
            continue
        latest_truth = payload.get("latest_truth") if isinstance(payload.get("latest_truth"), dict) else payload
        candidate_subject = str(latest_truth.get("subject", "") or latest_truth.get("project", "") or latest_truth.get("tool", "") or "").strip()
        candidate_version = str(latest_truth.get("version", "") or latest_truth.get("latest_version", "") or "").strip()
        candidate_release = str(latest_truth.get("release", "") or latest_truth.get("latest_release", "") or "").strip()
        candidate_source = str(latest_truth.get("source", "") or latest_truth.get("kind", "") or "").strip()
        candidate_published_at = str(latest_truth.get("published_at", "") or latest_truth.get("released_at", "") or "").strip()
        candidate_summary = str(latest_truth.get("summary", "") or latest_truth.get("reply_text", "") or "").strip()
        if candidate_subject and not subject:
            subject = candidate_subject
        if candidate_version:
            version = candidate_version
        if candidate_release:
            release = candidate_release
        if candidate_source:
            source = candidate_source
        if candidate_published_at:
            published_at = candidate_published_at
        if candidate_summary:
            summary = candidate_summary
    if not any([subject, version, release, source, published_at, summary]):
        return {}
    return {
        "subject": subject,
        "version": version,
        "release": release,
        "source": source,
        "published_at": published_at,
        "summary": summary,
    }


def execution_chain_source(payload: dict | None) -> dict:
    if not isinstance(payload, dict):
        return {}
    artifacts = payload.get("artifacts", {}) if isinstance(payload.get("artifacts"), dict) else {}
    replacement_chain = artifacts.get("replacement_chain", {}) if isinstance(artifacts.get("replacement_chain"), dict) else {}
    delegated_materialization = payload.get("materialization", {}) if isinstance(payload.get("materialization"), dict) else {}
    return {
        "controller_execution_id": str(payload.get("controller_execution_id", "") or replacement_chain.get("controller_execution_id", "") or delegated_materialization.get("controller_execution_id", "") or "").strip(),
        "supersedes": str(payload.get("supersedes", "") or replacement_chain.get("supersedes", "") or delegated_materialization.get("supersedes", "") or "").strip(),
        "superseded_by": str(payload.get("superseded_by", "") or replacement_chain.get("superseded_by", "") or delegated_materialization.get("superseded_by", "") or "").strip(),
        "replacement_reason": str(payload.get("replacement_reason", "") or replacement_chain.get("replacement_reason", "") or delegated_materialization.get("replacement_reason", "") or "").strip(),
    }


def build_runner_handoff(task: str, payload: dict, wait: dict | None) -> dict:
    job = payload.get("job", {}) if isinstance(payload, dict) else {}
    job_id = str(job.get("id", "") or "")
    wait = wait or {}
    if wait.get("completed"):
        status = str(wait.get("status", "done") or "done")
        worker_result = wait.get("worker_result") if isinstance(wait.get("worker_result"), dict) else {}
        runner_summary = compact_text(str(wait.get("summary", "") or worker_result.get("summary", "") or ""), 180)
        report_path = str(wait.get("report_path", "") or worker_result.get("report", "") or "")
        stdout_text = _read_text(str(wait.get("stdout_file", "") or "")) or str(wait.get("stdout_excerpt", "") or "")
        stderr_text = _read_text(str(wait.get("stderr_file", "") or "")) or str(wait.get("stderr_excerpt", "") or "")
        merged = stdout_text.strip()
        if stderr_text.strip():
            merged = f"{merged}\n\n[stderr]\n{stderr_text.strip()}".strip()
        reply_text = _summarize_output(stdout_text or merged)
        if not report_path and (len(merged) > 500 or len(_clean_output_lines(merged)) > 6):
            report_path = _write_shared_report(job_id or f"runner-{now_compact()}", merged)
        if not reply_text:
            reply_text = compact_text(str(worker_result.get("summary", "") or ""), 220) or runner_summary or "已通过常驻 runner 完成检查。"
        if len(reply_text) > MAX_INLINE_CHARS:
            if not report_path:
                report_path = _write_shared_report(job_id or f"runner-{now_compact()}", merged or reply_text)
            reply_text = reply_text[:MAX_INLINE_CHARS] + f"\n\n[输出已截断，完整内容：{report_path}]"
        summary = runner_summary or compact_text(str(worker_result.get("summary", "") or ""), 180) or (
            "已通过常驻 runner 完成检查，详细输出已写入共享文件。" if report_path else "已通过常驻 runner 完成检查。"
        )
        return {
            "kind": "final",
            "status": "success" if status == "done" else status,
            "summary": summary,
            "reply_text": reply_text,
            "report_path": report_path,
            "job_id": job_id,
            "execution_backend": str(wait.get("execution_backend", "") or "runner_queue"),
            "worker_result": worker_result,
            "user_safe": True,
        }
    timeout_seconds = int(wait.get("timeout_seconds", 0) or 0)
    return {
        "kind": "background",
        "status": "pending",
        "summary": "runner 已转后台继续执行。",
        "reply_text": f"OctoClaw 已转后台执行，可用 /octostatus 查看进度。任务ID：{job_id or 'unknown'}",
        "report_path": "",
        "job_id": job_id,
        "timeout_seconds": timeout_seconds,
        "user_safe": True,
    }


def build_spawn_handoff(route: str, worker_pool: str, task: str) -> dict:
    reply = "我会交给一个子任务继续处理，稍后给你结论。"
    if route == "spawn_multi":
        reply = "我会拆成分阶段子任务处理，先做调研/分析，再回给你结论。"
    elif worker_pool == "octoclaw-code":
        reply = "我会先交给修复子任务分析并整理修复建议。"
    elif worker_pool == "octoclaw-research":
        reply = "我会先交给调研子任务收集信息，再回来汇总结论。"
    elif worker_pool == "octoclaw-review":
        reply = "我会先交给分析子任务处理，再回来给你结论。"
    return {
        "kind": "plan",
        "status": "planned",
        "summary": f"{route} 已规划完成。",
        "reply_text": reply,
        "report_path": "",
        "task": task,
        "user_safe": True,
    }


def build_multi_step_task(base_task: str, step_name: str) -> str:
    if step_name == "planner":
        return (
            "你是多子任务流程里的规划/分析负责人。\n"
            "先拆解原始任务，明确关键检查点、依赖和交付结构；必要时先做快速调研，再给后续执行者一个清晰方案。\n\n"
            f"原始任务：\n{base_task}"
        )
    if step_name == "review":
        return (
            "你是多子任务流程里的审查/验证负责人。\n"
            "请站在 reviewer 视角检查主执行结果是否有遗漏、风险、回归点或表达不清的地方，并给出最终把关意见。\n\n"
            f"原始任务：\n{base_task}"
        )
    return (
        "你是多子任务流程里的主执行者。\n"
        "请基于原始任务完成主体分析/实现/整理工作，并把长结果写入共享报告。\n\n"
        f"原始任务：\n{base_task}"
    )


def execute_multi_spawn_plan(args, task: str, plan: dict, *, parent_task_id: str) -> dict:
    backend = configured_spawn_backend()
    if not backend:
        failure = build_capability_bound_failure(
            "spawn_multi",
            "spawn_backend_unavailable",
            detail="spawn_multi lane selected but no enabled spawn backend could materialize the child workflow.",
            missing_capabilities=["spawn_backend"],
            fallback_permitted=False,
        )
        return {
            "executed": False,
            "steps": [],
            "capability_failure": failure,
            "materialization": build_spawn_materialization(
                route="spawn_multi",
                execution_contract="coordinated_work",
                task_id=parent_task_id,
                executed=False,
                failure=failure,
            ),
            "handoff": {
                "kind": "plan",
                "status": "failed",
                "summary": "spawn_multi workflow 无法 materialize：缺少可用 backend。",
                "reply_text": "当前任务判定应走多子任务流程，但当前环境没有可用的 spawn backend，因此没有真正派发执行。",
                "report_path": "",
                "user_safe": True,
            },
        }

    ordered_steps = [name for name in ("planner", "worker", "review") if isinstance(plan.get(name), dict)]
    if not ordered_steps:
        failure = build_capability_bound_failure(
            "spawn_multi",
            "spawn_plan_missing",
            detail="spawn_multi lane selected but no valid planner/worker/review step specification was generated.",
            missing_capabilities=["spawn_multi_step_plan"],
            fallback_permitted=False,
        )
        return {
            "executed": False,
            "steps": [],
            "capability_failure": failure,
            "materialization": build_spawn_materialization(
                route="spawn_multi",
                execution_contract="coordinated_work",
                task_id=parent_task_id,
                executed=False,
                failure=failure,
            ),
            "handoff": {
                "kind": "plan",
                "status": "failed",
                "summary": "spawn_multi workflow 无法 materialize：缺少有效 step plan。",
                "reply_text": "当前任务判定应走多子任务流程，但没有生成有效的子步骤规范，因此没有真正派发执行。",
                "report_path": "",
                "user_safe": True,
            },
        }

    parent_id = parent_task_id
    previous_task_id = ""
    steps: list[dict] = []

    for step_name in ordered_steps:
        step = plan.get(step_name, {}) or {}
        step_task = build_multi_step_task(task, step_name)
        spec = build_spawn_spec(
            step_task,
            route="spawn_single",
            model_band=str(step.get("model_band", "") or ""),
            selector_band=str(step.get("selector_band", "") or ""),
            model=str(step.get("model", "") or ""),
            worker_pool=str(step.get("worker_pool", "") or ""),
            work_type=str(step.get("work_type", "") or ""),
            phase=str(step.get("phase", "") or ""),
            profile=str(step.get("profile", "") or ""),
            parent_id=parent_id,
            task_kind="team_step",
            register=True,
            execute=True,
            deps=[previous_task_id] if previous_task_id else None,
            policy_decision=step.get("policy_decision") if isinstance(step.get("policy_decision"), dict) else None,
        )
        steps.append(
            {
                "step": step_name,
                "model": spec.get("model", ""),
                "model_band": spec.get("model_band", ""),
                "selector_band": spec.get("selector_band", ""),
                "worker_pool": spec.get("worker_pool", ""),
                "work_type": spec.get("work_type", ""),
                "phase": spec.get("phase", ""),
                "task_id": spec.get("task_id", ""),
                "executed": bool(spec.get("executed", False)),
                "execution_error": spec.get("execution_error", ""),
                "report_path": spec.get("report_path", ""),
                "task_kind": spec.get("task_kind", ""),
                "spawn_execution": spec.get("spawn_execution", {}),
            }
        )
        if not spec.get("executed", False):
            failure = spec.get("capability_failure") if isinstance(spec.get("capability_failure"), dict) and spec.get("capability_failure") else build_capability_bound_failure(
                "spawn_multi",
                "spawn_child_materialization_failed",
                detail=f"{step_name} child workflow did not execute.",
                missing_capabilities=["spawn_backend_execution"],
                fallback_permitted=False,
            )
            return {
                "executed": False,
                "steps": steps,
                "capability_failure": failure,
                "materialization": build_spawn_materialization(
                    route="spawn_multi",
                    execution_contract="coordinated_work",
                    task_id=parent_task_id,
                    executed=False,
                    failure=failure,
                ),
                "handoff": {
                    "kind": "plan",
                    "status": "failed",
                    "summary": f"多子任务流程在 {step_name} 阶段启动失败。",
                    "reply_text": "我开始拆多子任务了，但其中一个工位启动失败，已保留已创建的状态信息。",
                    "report_path": "",
                    "user_safe": True,
                },
            }
        previous_task_id = str(spec.get("task_id", "") or previous_task_id)

    step_names = " / ".join(ordered_steps)
    backend_label = "OpenClaw 原生后台" if backend == "native" else "ClawTeam/tmux"
    return {
        "executed": True,
        "steps": steps,
        "capability_failure": {},
        "materialization": build_spawn_materialization(
            route="spawn_multi",
            execution_contract="coordinated_work",
            task_id=parent_task_id,
            executed=True,
        ),
        "handoff": {
            "kind": "background",
            "status": "pending",
            "summary": f"多子任务流程已通过{backend_label}启动：{step_names}。",
            "reply_text": f"我已经把这个任务拆成 {step_names} 几个工位挂到{backend_label}里继续处理，稍后回来汇总结论。",
            "report_path": "",
            "user_safe": True,
        },
    }


def wait_for_runner_result(job_id: str, timeout_seconds: int) -> dict:
    deadline = time.time() + max(0, timeout_seconds)
    meta_path = os.path.join(RUNNER_RESULTS_DIR, f"{job_id}.json")
    while time.time() <= deadline:
        if os.path.exists(meta_path):
            try:
                meta = load_json(meta_path)
            except Exception:
                meta = None
            if isinstance(meta, dict):
                return _runner_result_payload(status="done", meta=meta, result_path=meta_path)
        try:
            queue = load_json(RUNNER_QUEUE_FILE)
        except Exception:
            queue = None
        if isinstance(queue, dict):
            jobs = queue.get("jobs", [])
            if isinstance(jobs, list):
                job = next((item for item in jobs if item.get("id") == job_id), None)
                if isinstance(job, dict) and job.get("status") == "failed":
                    result_path = str(job.get("result_path", "") or "")
                    try:
                        meta = load_json(result_path) if result_path else None
                    except Exception:
                        meta = None
                    return _runner_result_payload(
                        status="failed",
                        meta=meta,
                        result_path=result_path,
                        fallback_exit_code=int(job.get("exit_code", 1) or 1),
                        fallback_finished_at=str(job.get("finished_at", "") or ""),
                        fallback_summary=str(job.get("summary", "") or ""),
                    )
        time.sleep(0.5)
    return {"completed": False, "timeout_seconds": timeout_seconds}


def runner_health_is_healthy(stale_after_seconds: int = RUNNER_STALE_SECONDS) -> bool:
    health = load_json(RUNNER_HEALTH_FILE)
    if not isinstance(health, dict) or not health.get("worker_id"):
        return False
    last = parse_iso(str(health.get("last_heartbeat_at", "") or ""))
    if last is None:
        return False
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    age_seconds = max(0, int((datetime.now(timezone.utc) - last.astimezone(timezone.utc)).total_seconds()))
    return age_seconds <= stale_after_seconds


def runner_pool_settings() -> dict:
    runtime_cfg = load_octopus_config().get("runtime_policy", {})
    runtime_cfg = runtime_cfg if isinstance(runtime_cfg, dict) else {}
    pool = runtime_cfg.get("runner_pool", {})
    pool = pool if isinstance(pool, dict) else {}
    features = runtime_cfg.get("features", {})
    features = features if isinstance(features, dict) else {}
    enabled = features.get("runner_pool_enabled")
    legacy_fallback = features.get("legacy_runner_fallback")
    return {
        "enabled": bool(enabled if isinstance(enabled, bool) else pool.get("enabled", RUNNER_POOL_DEFAULTS["enabled"])),
        "max_queue_size": max(1, int(pool.get("max_queue_size", RUNNER_POOL_DEFAULTS["max_queue_size"]) or RUNNER_POOL_DEFAULTS["max_queue_size"])),
        "per_user_concurrency": max(0, int(pool.get("per_user_concurrency", RUNNER_POOL_DEFAULTS["per_user_concurrency"]) or RUNNER_POOL_DEFAULTS["per_user_concurrency"])),
        "lease_timeout_seconds": max(1, int(pool.get("lease_timeout_seconds", RUNNER_POOL_DEFAULTS["lease_timeout_seconds"]) or RUNNER_POOL_DEFAULTS["lease_timeout_seconds"])),
        "busy_strategy": str(pool.get("busy_strategy", RUNNER_POOL_DEFAULTS["busy_strategy"]) or RUNNER_POOL_DEFAULTS["busy_strategy"]),
        "legacy_runner_fallback": bool(
            legacy_fallback if isinstance(legacy_fallback, bool) else pool.get("legacy_runner_fallback", RUNNER_POOL_DEFAULTS["legacy_runner_fallback"])
        ),
    }


def runner_queue_pressure_band(queue_counts: dict | None, max_queue_size: int) -> str:
    counts = queue_counts if isinstance(queue_counts, dict) else {}
    queued = max(0, int(counts.get("queued", 0) or 0))
    running = max(0, int(counts.get("running", 0) or 0))
    active = queued + running
    capacity = max(1, int(max_queue_size or RUNNER_POOL_DEFAULTS["max_queue_size"]))
    medium_threshold = max(1, (capacity + 1) // 2)
    if active >= capacity or queued >= capacity:
        return "high"
    if active >= medium_threshold or queued >= medium_threshold:
        return "medium"
    if active >= 1 or queued >= 1:
        return "low"
    return "none"


def load_runner_active_jobs() -> list[dict]:
    raw = load_json(RUNNER_QUEUE_FILE)
    jobs = raw.get("jobs", []) if isinstance(raw, dict) else []
    active_jobs: list[dict] = []
    for job in jobs:
        if not isinstance(job, dict):
            continue
        status = str(job.get("status", "") or "").strip().lower()
        if status not in {"queued", "running"}:
            continue
        active_jobs.append(dict(job))
    return active_jobs


def sync_recovered_stale_runner_jobs(recovered: dict | None) -> None:
    payload = recovered if isinstance(recovered, dict) else {}
    jobs = payload.get("jobs", [])
    if not isinstance(jobs, list) or not jobs:
        return
    for job in jobs:
        if not isinstance(job, dict):
            continue
        job_id = str(job.get("id", "") or "").strip()
        if not job_id:
            continue
        worker_id = str(job.get("worker_id", "") or "").strip()
        summary = f"Runner lease expired before completion · worker={worker_id or 'unknown'}"
        cmd = [
            "python3",
            TASK_STATE_PY,
            "failed",
            "--id",
            job_id,
            "--summary",
            summary,
            "--blocked-reason",
            "runner_lease_expired",
            "--observability-health",
            "degraded",
        ]
        result = subprocess.run(cmd, check=False, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"sync_recovered_stale_runner_jobs: task-state-update failed for {job_id}: {result.stderr}", file=sys.stderr)


def runner_dispatch_runtime_resolution(*, wait: bool, session_key: str = "") -> dict:
    cfg = load_octopus_config()
    runner_mode = default_runner_execution_mode(resolve_runner_mode(cfg))
    settings = runner_pool_settings()
    try:
        recovered = recover_stale_running_jobs(
            lease_timeout_seconds=settings["lease_timeout_seconds"],
            heartbeat_stale_seconds=RUNNER_STALE_SECONDS,
        )
    except OSError:
        recovered = {"recovered_count": 0, "jobs": []}
    sync_recovered_stale_runner_jobs(recovered)
    queue_counts = load_runner_queue_counts()
    active_jobs = load_runner_active_jobs()
    health = load_runner_health(stale_after_seconds=RUNNER_STALE_SECONDS)
    tmux_status = runner_tmux_status(cfg)
    queue_pressure = runner_queue_pressure_band(queue_counts, settings["max_queue_size"])
    queued = max(0, int(queue_counts.get("queued", 0) or 0))
    running = max(0, int(queue_counts.get("running", 0) or 0))
    active = queued + running
    allow_ondemand = bool(settings.get("legacy_runner_fallback", True))
    resolution = {
        "runner_pool_enabled": bool(settings["enabled"]),
        "max_queue_size": int(settings["max_queue_size"]),
        "per_user_concurrency": int(settings["per_user_concurrency"]),
        "lease_timeout_seconds": int(settings["lease_timeout_seconds"]),
        "busy_strategy": str(settings["busy_strategy"]),
        "legacy_runner_fallback": bool(settings["legacy_runner_fallback"]),
        "queue_counts": {
            "queued": queued,
            "running": running,
            "done": max(0, int(queue_counts.get("done", 0) or 0)),
            "failed": max(0, int(queue_counts.get("failed", 0) or 0)),
            "total": max(0, int(queue_counts.get("total", 0) or 0)),
            "active": active,
        },
        "recovered_stale_running_jobs": int(recovered.get("recovered_count", 0) or 0),
        "queue_pressure_band": queue_pressure,
        "runner_health_snapshot": health if isinstance(health, dict) else {},
        "resident_runtime": tmux_status,
        "dispatch_mode": runner_mode,
        "can_dispatch": True,
        "block_reason": "",
        "block_detail": "",
        "fallback_permitted": False,
    }
    if not settings["enabled"]:
        resolution["can_dispatch"] = False
        resolution["dispatch_mode"] = "deferred"
        resolution["block_reason"] = "runner_pool_disabled"
        resolution["block_detail"] = "runner lane selected but runtime_policy.runner_pool is disabled, so no runner job was materialized."
        return resolution
    normalized_session_key = str(session_key or "").strip()
    if settings["per_user_concurrency"] > 0 and normalized_session_key:
        session_active = [
            job for job in active_jobs
            if str(job.get("session_key", "") or "").strip() == normalized_session_key
        ]
        resolution["session_active_jobs"] = [
            {
                "id": str(job.get("id", "") or ""),
                "status": str(job.get("status", "") or ""),
                "worker_id": str(job.get("worker_id", "") or ""),
            }
            for job in session_active
        ]
        if len(session_active) >= settings["per_user_concurrency"]:
            resolution["can_dispatch"] = False
            resolution["dispatch_mode"] = "deferred"
            resolution["block_reason"] = "runner_per_user_concurrency_exceeded"
            resolution["block_detail"] = (
                f"session already has {len(session_active)} active runner job(s), reaching per_user_concurrency="
                f"{settings['per_user_concurrency']}."
            )
            return resolution
    if active >= settings["max_queue_size"]:
        resolution["can_dispatch"] = False
        resolution["dispatch_mode"] = "deferred"
        resolution["block_reason"] = "runner_queue_full"
        resolution["block_detail"] = (
            f"runner queue is at capacity ({active}/{settings['max_queue_size']}); "
            "dispatch is deferred until capacity becomes available."
        )
        return resolution
    if runner_mode == "daemon":
        tmux_required = bool(tmux_status.get("required"))
        if not tmux_required:
            if bool((health or {}).get("healthy")):
                resolution["dispatch_mode"] = "daemon"
                resolution["can_dispatch"] = True
                resolution["fallback_permitted"] = False
                return resolution
            if allow_ondemand:
                resolution["dispatch_mode"] = "ondemand"
                resolution["fallback_permitted"] = True
                return resolution
            resolution["can_dispatch"] = False
            resolution["dispatch_mode"] = "deferred"
            resolution["block_reason"] = "runner_worker_unhealthy"
            resolution["block_detail"] = (
                f"runner heartbeat is unavailable or stale ({str((health or {}).get('reason', '') or 'unknown')}); "
                "dispatch is deferred until a healthy runner is available."
            )
            return resolution
        if tmux_required and not bool(tmux_status.get("healthy")):
            bootstrap = ensure_runner_daemon(cfg)
            resolution["resident_bootstrap"] = bootstrap
            tmux_status = runner_tmux_status(cfg)
            health = load_runner_health(stale_after_seconds=RUNNER_STALE_SECONDS)
            resolution["resident_runtime"] = tmux_status
            resolution["runner_health_snapshot"] = health if isinstance(health, dict) else {}
        if bool(tmux_status.get("healthy")):
            resolution["dispatch_mode"] = "daemon"
            resolution["can_dispatch"] = True
            resolution["fallback_permitted"] = False
            return resolution
        if allow_ondemand:
            resolution["dispatch_mode"] = "ondemand"
            resolution["fallback_permitted"] = True
            resolution["block_reason"] = "runner_resident_unavailable"
            resolution["block_detail"] = (
                f"resident runner is unavailable ({str(tmux_status.get('reason', '') or 'unknown')}); "
                "falling back to on-demand bootstrap."
            )
            return resolution
        resolution["can_dispatch"] = False
        resolution["dispatch_mode"] = "deferred"
        resolution["block_reason"] = "runner_resident_unavailable"
        resolution["block_detail"] = (
            f"resident runner is unavailable ({str(tmux_status.get('reason', '') or 'unknown')}); "
            "dispatch is deferred until the tmux runner session is healthy."
        )
        return resolution
    if not bool((health or {}).get("healthy")):
        if allow_ondemand:
            resolution["dispatch_mode"] = "ondemand"
            resolution["fallback_permitted"] = True
            return resolution
        resolution["can_dispatch"] = False
        resolution["dispatch_mode"] = "deferred"
        resolution["block_reason"] = "runner_worker_unhealthy"
        resolution["block_detail"] = (
            f"runner heartbeat is unavailable or stale ({str((health or {}).get('reason', '') or 'unknown')}); "
            "dispatch is deferred to avoid queuing work onto an unhealthy worker."
        )
        return resolution
    return resolution


def build_runner_gate_handoff(*, reason: str, detail: str, queue_pressure_band: str, dispatch_mode: str) -> dict:
    labels = {
        "runner_pool_disabled": "runner pool 已禁用",
        "runner_queue_full": "runner 队列已满",
        "runner_worker_unhealthy": "runner worker 不健康",
        "runner_resident_unavailable": "runner 常驻执行面不可用",
        "runner_per_user_concurrency_exceeded": "当前会话 runner 并发已满",
        "runner_bootstrap_failed": "runner 自举失败",
    }
    summary = labels.get(reason, "runner 当前不可派发")
    suffix = f"（queue={queue_pressure_band or 'unknown'} / mode={dispatch_mode or 'deferred'}）"
    return {
        "kind": "plan",
        "status": "failed",
        "summary": f"{summary}{suffix}",
        "reply_text": f"这次任务还没真正派发到 runner。原因是：{detail}",
        "report_path": "",
        "user_safe": True,
    }


def run_runner_on_demand(job_id: str) -> dict:
    worker_id = f"runner-ondemand-{job_id or now_compact()}"
    env = {
        **os.environ,
        "WORKSPACE": WORKSPACE,
        "OCTOCLAW_ENABLE_LEGACY_LOOPS": "1",
        "RUNNER_MAX_JOBS_PER_WORKER": "1",
        "RUNNER_MAX_IDLE_SECONDS": "1",
        "RUNNER_POLL_INTERVAL_SECONDS": "1",
        "RUNNER_HEARTBEAT_INTERVAL_SECONDS": "1",
        "RUNNER_WORKER_ID": worker_id,
    }
    runner_timeout = int(os.environ.get("OCTOCLAW_RUNNER_TIMEOUT_SECONDS", "120"))
    try:
        result = subprocess.run(
            ["bash", RUNNER_LOOP_SH],
            capture_output=True,
            text=True,
            check=False,
            env=env,
            timeout=runner_timeout,
        )
    except subprocess.TimeoutExpired:
        return {
            "triggered": True,
            "worker_id": worker_id,
            "returncode": -1,
            "ok": False,
            "timeout": True,
        }
    return {
        "triggered": True,
        "worker_id": worker_id,
        "returncode": int(result.returncode),
        "ok": result.returncode == 0,
    }


def kick_runner_on_demand_background(job_id: str) -> dict:
    worker_id = f"runner-bootstrap-{job_id or now_compact()}"
    env = {
        **os.environ,
        "WORKSPACE": WORKSPACE,
        "OCTOCLAW_ENABLE_LEGACY_LOOPS": "1",
        "RUNNER_MAX_JOBS_PER_WORKER": "1",
        "RUNNER_MAX_IDLE_SECONDS": "30",
        "RUNNER_POLL_INTERVAL_SECONDS": "1",
        "RUNNER_HEARTBEAT_INTERVAL_SECONDS": "1",
        "RUNNER_WORKER_ID": worker_id,
        "RUNNER_PREFERRED_JOB_ID": str(job_id or ""),
    }
    try:
        proc = subprocess.Popen(
            ["bash", RUNNER_LOOP_SH],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
            start_new_session=True,
        )
        time.sleep(0.2)
        returncode = proc.poll()
        if returncode is not None:
            return {
                "triggered": False,
                "worker_id": worker_id,
                "pid": int(proc.pid or 0),
                "ok": False,
                "mode": "background_bootstrap",
                "returncode": int(returncode),
                "error": f"runner bootstrap exited immediately with code {int(returncode)}",
            }
        observed_status = ""
        for _ in range(8):
            queue = load_json(RUNNER_QUEUE_FILE)
            jobs = queue.get("jobs", []) if isinstance(queue, dict) else []
            for job in jobs:
                if not isinstance(job, dict):
                    continue
                if str(job.get("id", "") or "").strip() != str(job_id or "").strip():
                    continue
                observed_status = str(job.get("status", "") or "").strip().lower()
                break
            if observed_status in {"running", "done", "failed"}:
                break
            if proc.poll() is not None:
                returncode = int(proc.poll() or 0)
                return {
                    "triggered": False,
                    "worker_id": worker_id,
                    "pid": int(proc.pid or 0),
                    "ok": False,
                    "mode": "background_bootstrap",
                    "returncode": returncode,
                    "observed_status": observed_status,
                    "error": f"runner bootstrap exited before claiming {job_id or 'job'}",
                }
            time.sleep(0.4)
        return {
            "triggered": True,
            "worker_id": worker_id,
            "pid": int(proc.pid or 0),
            "ok": True,
            "mode": "background_bootstrap",
            "observed_status": observed_status,
        }
    except OSError as exc:
        return {
            "triggered": False,
            "worker_id": worker_id,
            "pid": 0,
            "ok": False,
            "mode": "background_bootstrap",
            "error": str(exc),
        }


def mark_runner_bootstrap_failed(job_id: str, summary: str, failure_reason: str) -> None:
    normalized_job_id = str(job_id or "").strip()
    if not normalized_job_id:
        return
    failure_summary = summary or f"Runner bootstrap failed · {normalized_job_id}"
    subprocess.run(
        [
            "python3",
            RUNNER_QUEUE_PY,
            "complete",
            "--id",
            normalized_job_id,
            "--status",
            "failed",
            "--summary",
            failure_summary,
            "--exit-code",
            "125",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        [
            "python3",
            TASK_STATE_PY,
            "failed",
            "--id",
            normalized_job_id,
            "--summary",
            failure_summary,
            "--blocked-reason",
            failure_reason,
            "--observability-health",
            "degraded",
        ],
        check=False,
        capture_output=True,
        text=True,
    )


def dispatch_runner(args) -> dict:
    decision = getattr(args, "_policy_decision", {}) or {}
    identity = octoclaw_identity_fields(decision)
    playbook = getattr(args, "_runner_playbook", None)
    if not isinstance(playbook, dict) or not playbook:
        playbook = decision_runner_playbook(decision)
    command = args.command
    summary = args.summary
    if not command and not playbook:
        playbook = infer_runner_playbook(args.task, runner_playbook_hints(decision))
    if playbook:
        command = command or str(playbook.get("command", "") or "")
        if not summary:
            summary = str(playbook.get("summary", "") or "")
    goal_contract = build_runner_goal_contract(
        task=args.task,
        command=command,
        summary=args.task[:80] or summary,
        timeout_seconds=args.timeout_seconds,
        decision=decision,
        playbook=playbook,
        session_key=str(identity.get("session_key", "") or ""),
        runner_job_id=args.id or "",
        task_id=args.id or "",
    )
    runtime_resolution = runner_dispatch_runtime_resolution(wait=bool(args.wait), session_key=str(identity.get("session_key", "") or ""))
    if not bool(runtime_resolution.get("can_dispatch")):
        failure = build_capability_bound_failure(
            "runner",
            str(runtime_resolution.get("block_reason", "") or "runner_dispatch_blocked"),
            detail=str(runtime_resolution.get("block_detail", "") or "runner dispatch blocked by runtime readiness gate."),
            missing_capabilities=[
                "runner_capacity"
                if runtime_resolution.get("block_reason") == "runner_queue_full"
                else ("runner_concurrency_slot" if runtime_resolution.get("block_reason") == "runner_per_user_concurrency_exceeded" else "runner_worker")
            ],
            fallback_permitted=bool(runtime_resolution.get("fallback_permitted", False)),
        )
        response = apply_policy_fields({
            "route": "runner",
            "executed": False,
            "job": {},
            "reason": str(runtime_resolution.get("block_reason", "") or "runner_dispatch_blocked"),
            "runner_execution_mode": str(runtime_resolution.get("dispatch_mode", "") or "deferred"),
            "goal_contract": goal_contract,
            "runner_runtime_resolution": runtime_resolution,
            "capability_failure": failure,
            "materialization": build_runner_materialization(
                execution_contract="inspect_report",
                session_key=str(identity.get("session_key", "") or ""),
                job_id=str(args.id or ""),
                executed=False,
                failure=failure,
            ),
        }, decision)
        if playbook:
            response["runner_plan"] = playbook
            response["playbook"] = playbook
        response["handoff"] = build_runner_gate_handoff(
            reason=str(runtime_resolution.get("block_reason", "") or ""),
            detail=str(runtime_resolution.get("block_detail", "") or ""),
            queue_pressure_band=str(runtime_resolution.get("queue_pressure_band", "") or ""),
            dispatch_mode=str(runtime_resolution.get("dispatch_mode", "") or ""),
        )
        return response

    dispatch_cmd = [
        "python3",
        RUNNER_DISPATCH_PY,
        "--id",
        args.id or f"runner-{now_compact()}",
        "--command",
        command,
        "--cwd",
        args.cwd,
        "--summary",
        args.task[:80] or summary,
        "--timeout-seconds",
        str(args.timeout_seconds),
        "--model-band",
        args.model_band or "fast",
        "--task-description",
        args.task,
    ]
    if playbook:
        dispatch_cmd.extend(["--playbook-json", json.dumps(playbook, ensure_ascii=False)])
    dispatch_cmd.extend(["--goal-contract-json", json.dumps(goal_contract, ensure_ascii=False)])
    if str(identity.get("session_key", "") or "").strip():
        dispatch_cmd.extend(["--session-key", str(identity["session_key"])])
    if str(identity.get("session_id", "") or "").strip():
        dispatch_cmd.extend(["--session-id", str(identity["session_id"])])
    if str(identity.get("agent_id", "") or "").strip():
        dispatch_cmd.extend(["--agent-id", str(identity["agent_id"])])
    if str(identity.get("agent_namespace", "") or "").strip():
        dispatch_cmd.extend(["--agent-namespace", str(identity["agent_namespace"])])
    if str(identity.get("managed_by_octoclaw", "") or "").strip():
        dispatch_cmd.extend(["--managed-by-octoclaw", str(identity["managed_by_octoclaw"])])
    if str(getattr(args, "_dispatch_key", "") or "").strip():
        dispatch_cmd.extend(["--dispatch-key", str(args._dispatch_key)])
    if str(getattr(args, "_lane_key", "") or "").strip():
        dispatch_cmd.extend(["--lane-key", str(args._lane_key)])
    if str(getattr(args, "_capacity_group", "") or "").strip():
        dispatch_cmd.extend(["--capacity-group", str(args._capacity_group)])
    try:
        result = subprocess.run(dispatch_cmd, capture_output=True, text=True, check=False, timeout=30)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"runner dispatch timed out after 30s: {exc.cmd}") from exc
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "runner dispatch failed")
    payload = json.loads(result.stdout.strip() or "{}")
    if isinstance(payload, dict) and isinstance(payload.get("goal_contract"), dict):
        goal_contract = dict(payload.get("goal_contract"))
    elif isinstance(payload, dict):
        payload_job_id = str(payload.get("id", "") or "")
        if payload_job_id:
            goal_contract["runner_job_id"] = payload_job_id
            goal_contract["task_id"] = str(goal_contract.get("task_id", "") or payload_job_id)
            binding = goal_contract.get("native_task_binding", {})
            if not isinstance(binding, dict):
                binding = {}
            binding["task_id"] = str(binding.get("task_id", "") or goal_contract["task_id"])
            goal_contract["native_task_binding"] = binding
    response = apply_policy_fields({
        "route": "runner",
        "executed": True,
        "job": payload,
        "reason": "lightweight_task",
        "runner_execution_mode": str(runtime_resolution.get("dispatch_mode", "") or "daemon"),
        "goal_contract": goal_contract,
        "runner_runtime_resolution": runtime_resolution,
        "materialization": build_runner_materialization(
            execution_contract="inspect_report",
            session_key=str(identity.get("session_key", "") or ""),
            job_id=str(payload.get("id", "") or ""),
            executed=True,
        ),
    }, decision)
    if playbook:
        response["runner_plan"] = playbook
        response["playbook"] = playbook
    if response.get("runner_execution_mode") == "ondemand":
        response["runner_execution_mode"] = "ondemand"
        if args.wait:
            response["runner_execution"] = run_runner_on_demand(str(payload.get("id", "") or ""))
            append_runtime_task_event(
                str(payload.get("id", "") or ""),
                "progress_note",
                "runner switched to on-demand worker",
                event_json={
                    "runner_job_id": str(payload.get("id", "") or ""),
                    "execution_backend": "runner_queue",
                    "progress_state": "ondemand",
                },
            )
        else:
            response["runner_execution"] = kick_runner_on_demand_background(str(payload.get("id", "") or ""))
            if response["runner_execution"].get("ok"):
                append_runtime_task_event(
                    str(payload.get("id", "") or ""),
                    "progress_note",
                    "runner background worker bootstrapped",
                    event_json={
                        "runner_job_id": str(payload.get("id", "") or ""),
                        "execution_backend": "runner_queue",
                        "progress_state": "background_bootstrap",
                    },
                )
            else:
                job_id = str(payload.get("id", "") or "")
                failure_reason = "runner_bootstrap_failed"
                detail = str(response["runner_execution"].get("error", "") or "runner on-demand bootstrap failed before claiming the job.")
                append_runtime_task_event(
                    job_id,
                    "progress_note",
                    "runner background worker bootstrap failed",
                    event_json={
                        "runner_job_id": job_id,
                        "execution_backend": "runner_queue",
                        "progress_state": "bootstrap_failed",
                        "error": detail,
                    },
                )
                mark_runner_bootstrap_failed(
                    job_id,
                    f"Runner bootstrap failed · {detail}",
                    failure_reason,
                )
                failure = build_capability_bound_failure(
                    "runner",
                    failure_reason,
                    detail=detail,
                    missing_capabilities=["runner_worker"],
                    fallback_permitted=False,
                )
                response["executed"] = False
                response["reason"] = failure_reason
                response["capability_failure"] = failure
                response["materialization"] = build_runner_materialization(
                    execution_contract="inspect_report",
                    session_key=str(identity.get("session_key", "") or ""),
                    job_id=job_id,
                    executed=False,
                    failure=failure,
                )
                response["handoff"] = build_runner_gate_handoff(
                    reason=failure_reason,
                    detail=detail,
                    queue_pressure_band=str(runtime_resolution.get("queue_pressure_band", "") or ""),
                    dispatch_mode="deferred",
                )
                return response
    if args.wait:
        route = response.get("route", "")
        explicit_timeout = args.wait_timeout_seconds
        if explicit_timeout > 0:
            wait_timeout = explicit_timeout
        else:
            wait_timeout = route_timeout_seconds(route)
        if response.get("runner_execution_mode") == "ondemand":
            wait_timeout = 1
        response["wait"] = wait_for_runner_result(payload.get("id", ""), wait_timeout)
    response["handoff"] = build_runner_handoff(args.task, response, response.get("wait"))
    return response


def recommend_spawn(args, task: str) -> dict:
    decision = getattr(args, "_policy_decision", {}) or {}
    route_meta = decision_route(decision)
    model_meta = decision_model(decision)
    requested_model_band = getattr(args, "model_band", "") or ""
    spawn_spec = build_spawn_spec(
        task,
        route="spawn_single",
        model_band=requested_model_band or str(model_meta.get("model_band", "") or ""),
        selector_band=str(model_meta.get("selector_band", "") or ""),
        worker_pool=str(route_meta.get("worker_pool", "") or ""),
        work_type=str(route_meta.get("work_type", "") or ""),
        phase=str(route_meta.get("phase", "") or ""),
        profile=str(model_meta.get("profile", "") or ""),
        parent_id=args.id or "",
        session_key=getattr(args, "session_key", "") or "",
        register=True,
        execute=None,
        policy_decision=decision,
    )
    return apply_policy_fields({
        "route": "spawn_single",
        "executed": bool(spawn_spec.get("executed", False)),
        "model": spawn_spec["model"],
        "profile": spawn_spec.get("profile", ""),
        "model_band": spawn_spec.get("model_band", ""),
        "selector_band": spawn_spec.get("selector_band", ""),
        "reason": "needs_subagent" if not spawn_spec.get("execution_error") else "subagent_spawn_failed",
        "task": task,
        "handoff": spawn_spec["handoff"],
        "materialization": spawn_spec.get("materialization", {}),
        "spawn_spec": spawn_spec,
        "dispatch_key": str(getattr(args, "_dispatch_key", "") or ""),
        "lane_key": str(getattr(args, "_lane_key", "") or ""),
        "capacity_group": str(getattr(args, "_capacity_group", "") or ""),
    }, decision)


def recommend_multi_spawn(args, task: str) -> dict:
    decision = getattr(args, "_policy_decision", {}) or {}
    multi_exec_backend = configured_spawn_backend()
    multi_exec_enabled = bool(multi_exec_backend)
    requested_model_band = getattr(args, "model_band", "") or ""
    primary_spawn = build_spawn_spec(
        task,
        route="spawn_multi",
        model_band=requested_model_band or str(decision_model(decision).get("model_band", "") or ""),
        selector_band=str(decision_model(decision).get("selector_band", "") or ""),
        worker_pool=str(decision_route(decision).get("worker_pool", "") or ""),
        work_type=str(decision_route(decision).get("work_type", "") or ""),
        phase=str(decision_route(decision).get("phase", "") or ""),
        profile=str(decision_model(decision).get("profile", "") or ""),
        parent_id=args.id or "",
        session_key=getattr(args, "session_key", "") or "",
        task_kind="team_parent",
        register=False,
        policy_decision=decision,
    )
    planner_decision = synthesize_multi_step_decision(decision, "planner")
    worker_decision = clone_worker_step_decision(decision)
    plan = {
        "planner": compat_spawn_step_from_decision(planner_decision),
        "worker": compat_spawn_step_from_decision(worker_decision, fallback=primary_spawn),
    }
    if decision_review(decision).get("required", False):
        review_decision = synthesize_multi_step_decision(decision, "review")
        plan["review"] = compat_spawn_step_from_decision(review_decision)
    execution = execute_multi_spawn_plan(args, task, plan, parent_task_id=str(primary_spawn.get("task_id", "") or f"octoclaw-team-{now_compact()}"))
    parent_runtime = multi_exec_backend if multi_exec_enabled else "plan"
    primary_spawn["runtime"] = parent_runtime
    primary_spawn["task_kind"] = "team_parent"
    primary_spawn["child_ids"] = [
        str(step.get("task_id", "") or "").strip()
        for step in execution.get("steps", [])
        if str(step.get("task_id", "") or "").strip()
    ]
    capability_failure = {}
    if isinstance(execution.get("capability_failure"), dict) and execution.get("capability_failure"):
        capability_failure = dict(execution.get("capability_failure"))
    materialization = dict(execution.get("materialization", {})) if isinstance(execution.get("materialization"), dict) and execution.get("materialization") else {}
    if materialization and not str(materialization.get("session_key", "") or "").strip():
        materialization["session_key"] = str(octoclaw_identity_fields(decision).get("session_key", "") or "")
    chain = execution_chain_source(execution)
    if materialization:
        for key, value in chain.items():
            if value and not str(materialization.get(key, "") or "").strip():
                materialization[key] = value
        latest_truth = reconcile_latest_truth_packet(materialization, execution)
        if latest_truth:
            materialization["latest_truth"] = latest_truth
    primary_spawn["capability_failure"] = capability_failure
    primary_spawn.update(chain)
    primary_spawn["materialization"] = materialization if materialization else build_spawn_materialization(
        route="spawn_multi",
        execution_contract="coordinated_work",
        session_key=str(octoclaw_identity_fields(decision).get("session_key", "") or ""),
        task_id=str(primary_spawn.get("task_id", "") or ""),
        executed=bool(execution.get("executed", False)),
        failure=capability_failure,
        controller_execution_id=str(chain.get("controller_execution_id", "") or ""),
        supersedes=str(chain.get("supersedes", "") or ""),
        superseded_by=str(chain.get("superseded_by", "") or ""),
        replacement_reason=str(chain.get("replacement_reason", "") or ""),
        latest_truth=reconcile_latest_truth_packet(execution if isinstance(execution, dict) else None),
    )
    primary_spawn["latest_truth"] = reconcile_latest_truth_packet(primary_spawn.get("materialization"), execution)
    register_multi_parent_task(
        task=task,
        parent_spec=primary_spawn,
        decision=decision,
        plan=plan,
        execution=execution,
        backend=parent_runtime,
        parent_parent_id=args.id or "",
    )
    return apply_policy_fields({
        "route": "spawn_multi",
        "task_id": primary_spawn.get("task_id", ""),
        "executed": bool(execution.get("executed", False)),
        "model": primary_spawn["model"],
        "profile": primary_spawn.get("profile", ""),
        "model_band": primary_spawn.get("model_band", ""),
        "selector_band": primary_spawn.get("selector_band", ""),
        "runtime": parent_runtime,
        "task_kind": "team_parent",
        "reason": "parallel_or_staged_workflow",
        "task": task,
        "report_path": primary_spawn.get("report_path", ""),
        "plan": plan,
        "handoff": execution.get("handoff", primary_spawn["handoff"]),
        "steps": execution.get("steps", []),
        "capability_failure": capability_failure,
        "materialization": dict(primary_spawn.get("materialization", {})) if isinstance(primary_spawn.get("materialization"), dict) else {},
        "latest_truth": reconcile_latest_truth_packet(primary_spawn.get("materialization"), execution),
        "spawn_spec": primary_spawn,
        "dispatch_key": str(getattr(args, "_dispatch_key", "") or ""),
        "lane_key": str(getattr(args, "_lane_key", "") or ""),
        "capacity_group": str(getattr(args, "_capacity_group", "") or ""),
    }, decision)


def main():
    parser = argparse.ArgumentParser(description="Unified OctoClaw dispatcher")
    parser.add_argument("--task", required=True)
    parser.add_argument("--command", default="")
    parser.add_argument("--cwd", default=WORKSPACE)
    parser.add_argument("--summary", default="")
    parser.add_argument("--timeout-seconds", dest="timeout_seconds", type=int, default=120)
    parser.add_argument("--id", default="")
    parser.add_argument("--model-band", dest="model_band", default="")
    parser.add_argument("--force-route", choices=["auto", "direct", "runner", "spawn_single", "spawn_multi"], default="auto")
    parser.add_argument("--session-key", dest="session_key", default="")
    parser.add_argument("--metadata-json", dest="metadata_json", default="")
    parser.add_argument("--policy-json", default="")
    parser.add_argument("--parent-turn-id", dest="parent_turn_id", default="")
    parser.add_argument("--wait", action="store_true")
    parser.add_argument("--wait-timeout-seconds", dest="wait_timeout_seconds", type=int, default=0)
    args = parser.parse_args()

    task = args.task.strip()
    decision = None
    legacy_policy_fallback_used = False
    forced_route = ""
    if args.force_route != "auto":
        forced_route = args.force_route
    metadata: dict[str, object] = {}
    if args.metadata_json:
        try:
            parsed = json.loads(args.metadata_json)
            if isinstance(parsed, dict):
                metadata.update(parsed)
        except json.JSONDecodeError:
            metadata = metadata
    if args.session_key:
        metadata["session_key"] = args.session_key
    inherited_session_key_from_policy = (
        not metadata.get("session_key")
        and args.policy_json
    )
    if inherited_session_key_from_policy:
        try:
            parsed_policy = json.loads(args.policy_json)
            if isinstance(parsed_policy, dict):
                inherited = str(
                    (parsed_policy.get("request", {}) or {}).get("session_key", "")
                    or ((parsed_policy.get("request", {}) or {}).get("metadata", {}) or {}).get("session_key", "")
                    or parsed_policy.get("session_key", "")
                ).strip()
                if inherited:
                    metadata["session_key"] = inherited
        except (json.JSONDecodeError, AttributeError):
            pass
    if args.policy_json:
        try:
            parsed = json.loads(args.policy_json)
            if isinstance(parsed, dict):
                decision = parsed
        except json.JSONDecodeError:
            decision = None
    if not isinstance(decision, dict):
        if legacy_policy_fallback_enabled():
            decision = build_legacy_policy_decision(task, args.command, metadata, force_route=forced_route)
            legacy_policy_fallback_used = True
        else:
            payload = build_dispatch_policy_required_failure(task, force_route=forced_route)
            print(json.dumps(payload, ensure_ascii=False))
            return
    decision = merge_runtime_metadata_into_decision(decision, metadata, session_key=args.session_key)
    decision["legacy_policy_fallback_used"] = legacy_policy_fallback_used
    if forced_route and forced_route != "auto":
        if "route_decision" not in decision or not isinstance(decision.get("route_decision"), dict):
            decision["route_decision"] = {}
        decision["route_decision"]["route"] = forced_route
    args._policy_decision = decision
    route = decision_route(decision)
    model_meta = decision_model(decision)
    final_route = str(route.get("route", "direct") or "direct")

    dispatch_key = ""
    lane_key = ""
    capacity_group = ""
    if generate_dispatch_key is not None and normalize_task_text_for_key is not None:
        identity = octoclaw_identity_fields(decision)
        dispatch_key = generate_dispatch_key(
            parent_session_key=str(identity.get("session_key", "") or ""),
            parent_turn_id=str(metadata.get("turn_id", "") or metadata.get("parent_turn_id", "") or args.parent_turn_id or ""),
            normalized_task_text=normalize_task_text_for_key(task),
            route=final_route,
            worker_pool=str(route.get("worker_pool", "") or ""),
            model_lane=str(model_meta.get("model_band", "") or ""),
        )
    try:
        wp = str(route.get("worker_pool", "") or "")
        sm = str(model_meta.get("selected_model", "") or "")
        wt = str(route.get("work_type", "") or "")
        mb = str(model_meta.get("model_band", "") or "")
        if generate_lane_key is not None and resolve_capacity_group is not None:
            lane_key = generate_lane_key(final_route, wp, resolve_capacity_group(final_route, wp))
            capacity_group = resolve_capacity_group(final_route, wp, wt, mb)
    except Exception:
        lane_key = ""
        capacity_group = ""
    args._dispatch_key = dispatch_key
    args._lane_key = lane_key
    args._capacity_group = capacity_group

    if dispatch_key:
        dedup_result = check_dispatch_dedup(dispatch_key, workspace=WORKSPACE)
        if dedup_result and dedup_result.get("dedup"):
            payload = apply_policy_fields({
                "executed": False,
                "dispatch_dedup_hit": True,
                "existing_task_id": dedup_result["existing_task_id"],
                "dispatch_key": dispatch_key,
                "lane_key": lane_key,
                "capacity_group": capacity_group,
                "reason": f"dedup: active task {dedup_result['existing_task_id']} already has this dispatch_key",
            }, decision)
            print(json.dumps(payload, ensure_ascii=False))
            return

    if final_route == "direct":
        payload = apply_policy_fields(
            {
                "route": "direct",
                "executed": False,
                "handoff": {
                    "kind": "final",
                    "status": "success",
                    "summary": "当前任务适合主 agent 直接处理。",
                    "reply_text": "",
                    "report_path": "",
                    "user_safe": False,
                },
                "task": task,
            },
            decision,
        )
        print(json.dumps(payload, ensure_ascii=False))
        return

    if final_route == "runner":
        playbook = decision_runner_playbook(decision)
        if not args.command and not playbook:
            playbook = infer_runner_playbook(task, runner_playbook_hints(decision))
        if not args.command and not playbook:
            failure = build_capability_bound_failure(
                "runner",
                "runner_playbook_missing",
                detail="runner lane was selected but no registered playbook or explicit command could materialize the workflow.",
                missing_capabilities=["registered_runner_playbook"],
                fallback_permitted=False,
            )
            payload = apply_policy_fields(
                {
                    "route": "runner",
                    "executed": False,
                    "task": task,
                    "should_wait": route.get("should_wait", False),
                    "wait_timeout_seconds": route.get("wait_timeout_seconds", 0),
                    "materialization": build_runner_materialization(
                        execution_contract="inspect_report",
                        session_key=str(octoclaw_identity_fields(decision).get("session_key", "") or ""),
                        failure=failure,
                    ),
                    "capability_failure": failure,
                    "handoff": {
                        "kind": "plan",
                        "status": "failed",
                        "summary": "runner workflow 无法 materialize：缺少可执行 playbook。",
                        "reply_text": "当前任务判定应走 runner，但缺少已注册 playbook 或显式命令，因此没有真正派发执行。",
                        "report_path": "",
                        "user_safe": True,
                    },
                },
                decision,
            )
            print(json.dumps(payload, ensure_ascii=False))
            return
        if playbook and not args.summary:
            args.summary = playbook.get("summary", "")
        if playbook:
            args.command = args.command or str(playbook.get("command", "") or "")
            args._runner_playbook = playbook
        if not args.wait and route.get("should_wait"):
            args.wait = True
            args.wait_timeout_seconds = route.get("wait_timeout_seconds", args.wait_timeout_seconds)
        if not args.model_band:
            args.model_band = str(model_meta.get("model_band", "") or args.model_band or "fast")
        payload = dispatch_runner(args)
        payload = apply_policy_fields(payload, decision)
        print(json.dumps(payload, ensure_ascii=False))
        return

    if final_route == "spawn_multi":
        payload = recommend_multi_spawn(args, task)
    else:
        payload = recommend_spawn(args, task)
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
