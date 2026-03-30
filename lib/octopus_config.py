#!/usr/bin/env python3
"""Shared OctoClaw config helpers."""

from __future__ import annotations

import json
import os
from typing import Any

WORKSPACE = os.environ.get("WORKSPACE", "/workspace")
CONFIG_FILE = f"{WORKSPACE}/tmp/octoclaw-config.json"
LEGACY_CONFIG_FILE = f"{WORKSPACE}/tmp/octopus-config.json"
MODE_FILE = f"{WORKSPACE}/tmp/octoclaw-mode.json"
LEGACY_MODE_FILE = f"{WORKSPACE}/tmp/octopus-mode.json"
MODEL_CATALOG_FILE = f"{WORKSPACE}/tmp/octopus/model-catalog.json"
MODEL_POLICY_FILE = f"{WORKSPACE}/tmp/octopus/model-policy.json"
MODEL_HEALTH_FILE = f"{WORKSPACE}/tmp/octopus/model-health.json"
MODEL_SPEED_FILE = f"{WORKSPACE}/tmp/octopus/model-speed.json"
MODEL_PLAN_STATE_FILE = f"{WORKSPACE}/tmp/octopus/model-plan-state.json"
MODEL_BENCHMARKS_FILE = f"{WORKSPACE}/tmp/octopus/model-benchmarks.json"
MODEL_SOURCES_FILE = f"{WORKSPACE}/tmp/octopus/model-sources.json"
MODEL_ALIASES_FILE = f"{WORKSPACE}/tmp/octopus-model-aliases.json"
TASK_STATE_FILE = f"{WORKSPACE}/tmp/octopus/task-state.json"
CLAWTEAM_BRIDGE_DIR = f"{WORKSPACE}/tmp/octopus/clawteam-bridge"
RUNNER_QUEUE_FILE = f"{WORKSPACE}/tmp/octopus/runner-queue.json"
RUNNER_HEALTH_FILE = f"{WORKSPACE}/tmp/octopus/runner-health.json"
RUNNER_RESULTS_DIR = f"{WORKSPACE}/tmp/octopus/runner-results"
SHARED_DIR = f"{WORKSPACE}/tmp/octopus/shared"
CONTEXT_DIR = f"{WORKSPACE}/tmp/octopus/context"
ROUTE_STICKINESS_FILE = f"{WORKSPACE}/tmp/octopus/route-stickiness.json"

SESSIONS_FILE = os.path.expanduser("~/.openclaw/sessions.json")
MAIN_AGENT_SESSIONS_FILE = os.path.expanduser("~/.openclaw/agents/main/sessions/sessions.json")

DEFAULT_CONFIG: dict[str, Any] = {
    "version": "v1.2.0",
    "notification": {
        "backend": "auto",
        "panel_enabled": True,
        "event_enabled": True,
        "text_enabled": True,
    },
    "main_session": {
        "strategy": "latest_user_session",
        "origin": "",
        "target": "",
        "session_key": "",
    },
    "model_auto": {
        "enabled": True,
        "prefer_private": False,
        "prefer_low_cost": False,
        "main_selection": {
            "min_reasoning": 0.82,
            "min_coding": 0.82,
            "min_openclaw": 0.80,
            "min_reliability": 0.82,
            "min_benchmark_support": 0.78,
            "min_capability_score": 0.86,
            "min_size_class": "base",
            "relax_step": 0.03,
            "max_relax_rounds": 2,
        },
    },
    "model_health": {
        "enabled": True,
        "degraded_thresholds": {
            "rate_limit": 2,
            "timeout": 2,
            "failover": 2,
        },
        "cooldown_thresholds": {
            "rate_limit": 3,
            "timeout": 3,
            "failover": 3,
        },
        "cooldown_minutes": 20,
        "latency_thresholds_ms": {
            "interactive": 3000,
            "code": 5000,
            "batch": 6500,
        },
        "quota_pressure_penalty": {
            "high": 0.10,
            "critical": 0.22,
        },
        "quota_pressure_high_used_percent": 85.0,
        "quota_pressure_critical_used_percent": 95.0,
        "main_session_drift": {
            "enabled": True,
            "auto_recover": False,
            "notify_cooldown_seconds": 3600,
        },
        "degraded_penalty_by_selector_role": {
            "runner": 0.22,
            "main": 0.20,
            "code": 0.12,
            "review": 0.12,
            "research": 0.08,
            "writer": 0.06,
            "inspect": 0.10,
            "team": 0.12,
        },
        "cooldown_penalty_by_selector_role": {
            "runner": 0.85,
            "main": 0.80,
            "code": 0.70,
            "review": 0.70,
            "research": 0.55,
            "writer": 0.45,
            "inspect": 0.60,
            "team": 0.70,
        },
    },
    "runtime_policy": {
        "enabled": True,
        "switches": {
            "hard_runner_only": True,
            "route_hint_required": False,
            "replay_logging": True,
            "direct_model_override": False,
            "delegation_enforcement": False,
        },
        "route_stickiness": {
            "enabled": False,
            "ttl_minutes": 180,
            "apply_on_followup_only": True,
            "ack_followup_enabled": True,
        },
        "route_language_packs": {
            "enabled": ["zh", "en"],
            "available": ["zh", "en", "ja", "ko", "es", "pt", "ru"],
        },
        "default_reasoning_effort_by_model_band": {
            "fast": "low",
            "normal": "medium",
            "strong": "high",
            "heavy": "high",
        },
        "hooks": {
            "before_model_resolve": False,
            "before_prompt_build": True,
            "before_tool_call": False,
            "agent_end": True,
        },
        "skill_bundles": {
            "ops": ["shell", "logs", "status"],
            "research": ["web", "docs", "report"],
            "code": ["repo", "test", "review"],
            "review": ["review", "risk", "regression"],
            "writer": ["writer", "feishu", "office", "delivery"],
        },
        "profiles": {
            "ops-fast": {
                "skill_bundle_keys": ["ops"],
                "reasoning_effort": "low",
            },
            "research": {
                "skill_bundle_keys": ["research"],
                "reasoning_effort": "medium",
            },
            "code": {
                "skill_bundle_keys": ["code"],
                "reasoning_effort": "medium",
            },
            "review": {
                "skill_bundle_keys": ["review"],
                "reasoning_effort": "high",
            },
            "writer": {
                "skill_bundle_keys": ["research", "writer"],
                "reasoning_effort": "medium",
            },
        },
    },
    "replay_automation": {
        "enabled": False,
        "schedule_hour_local": 2,
        "summary_enabled": True,
        "review_enabled": True,
        "curate_enabled": True,
        "llm_review_enabled": False,
        "llm_review_max_cases": 24,
        "output_dir": f"{WORKSPACE}/tmp/octopus/replay-nightly",
    },
    "clawteam_bridge": {
        "enabled": False,
        "backend": "mirror",
        "team_name": "octoclaw-validation",
        "inbox_owner": "main",
        "emit_result_mail": True,
        "clawteam_bin": "clawteam",
        "clawteam_data_dir": "",
        "auto_create_team": True,
        "team_description": "OctoClaw validation bridge team",
        "leader_name": "main",
        "commands": {
            "create_team": "{clawteam_bin_q} team spawn-team {team_q} -d {team_description_q} -n {leader_q}",
            "task_sync": "",
            "inbox_send": "{clawteam_bin_q} inbox send {team_q} {recipient_q} {message_q}",
        },
    },
    "spawn_execution": {
        "enabled": False,
        "backend": "plan",
        "backend_name": "tmux",
        "team_name": "",
        "workspace": False,
        "agent_name_prefix": "octo",
        "openclaw_bin": "openclaw",
        "default_profile": "",
        "profile_by_model_prefix": {},
    },
    "workbench": {
        "supervisor_mode": "auto",
        "tmux_session_name": "octoclaw-runtime",
        "tmux_runner_window_name": "runner",
        "tmux_patrol_window_name": "patrol",
    },
    "runner": {
        "enabled": True,
        "poll_interval_seconds": 3,
        "heartbeat_interval_seconds": 10,
        "default_timeout_seconds": 120,
        "max_age_minutes": 120,
        "max_idle_seconds": 900,
        "max_jobs_per_worker": 30,
    },
}


def _load_json_file(path: str) -> dict[str, Any] | list[Any] | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def _legacy_alias_path(path: str) -> str:
    aliases = {
        CONFIG_FILE: LEGACY_CONFIG_FILE,
        MODE_FILE: LEGACY_MODE_FILE,
    }
    return aliases.get(path, "")


def load_json(path: str) -> dict[str, Any] | list[Any] | None:
    data = _load_json_file(path)
    if data is not None:
        return data
    alias = _legacy_alias_path(path)
    if alias:
        return _load_json_file(alias)
    return None


def save_json(path: str, data: dict[str, Any] | list[Any]) -> bool:
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp_path = path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, path)
        return True
    except OSError:
        return False


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def load_octopus_config() -> dict[str, Any]:
    data = load_json(CONFIG_FILE)
    if isinstance(data, dict):
        if not os.path.exists(CONFIG_FILE):
            save_json(CONFIG_FILE, data)
        return deep_merge(DEFAULT_CONFIG, data)
    return json.loads(json.dumps(DEFAULT_CONFIG))


def model_health_config(config: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = config or load_octopus_config()
    section = cfg.get("model_health", {})
    return section if isinstance(section, dict) else {}


def workbench_config(config: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = config or load_octopus_config()
    section = cfg.get("workbench", {})
    return section if isinstance(section, dict) else {}


def tmux_attach_hint(session_name: str) -> str:
    session = str(session_name or "").strip()
    if not session:
        return ""
    return f"tmux attach -t {session}"


def runner_operator_surface(config: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = config or load_octopus_config()
    workbench = workbench_config(cfg)
    mode = str(workbench.get("supervisor_mode", "auto") or "auto").strip() or "auto"
    session_name = str(workbench.get("tmux_session_name", "") or "").strip()
    window_name = str(workbench.get("tmux_runner_window_name", "runner") or "runner").strip() or "runner"
    surface = {
        "kind": "runner",
        "supervisor_mode": mode,
        "tmux_session_name": session_name,
        "tmux_window_name": window_name,
    }
    if mode == "tmux" and session_name:
        surface["attach_hint"] = tmux_attach_hint(session_name)
        surface["operator_hint"] = f"tmux {session_name}:{window_name}"
    else:
        surface["attach_hint"] = ""
        surface["operator_hint"] = f"{mode} runner-daemon"
    return surface


def spawn_operator_surface(
    *,
    agent_name: str = "",
    team_name: str = "",
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    cfg = config or load_octopus_config()
    spawn_cfg = cfg.get("spawn_execution", {})
    if not isinstance(spawn_cfg, dict):
        spawn_cfg = {}
    bridge_cfg = cfg.get("clawteam_bridge", {})
    if not isinstance(bridge_cfg, dict):
        bridge_cfg = {}
    workbench = workbench_config(cfg)
    backend = str(spawn_cfg.get("backend", "plan") or "plan").strip() or "plan"
    backend_name = str(spawn_cfg.get("backend_name", "tmux") or "tmux").strip() or "tmux"
    session_name = str(workbench.get("tmux_session_name", "") or "").strip()
    team_value = str(team_name or spawn_cfg.get("team_name", "") or bridge_cfg.get("team_name", "") or "").strip()
    surface = {
        "kind": "spawn",
        "backend": backend,
        "backend_name": backend_name,
        "team_name": team_value,
        "agent_name": str(agent_name or "").strip(),
        "tmux_session_name": session_name,
    }
    if backend == "clawteam":
        hint = f"clawteam/{backend_name}"
        if team_value:
            hint += f" {team_value}"
        if agent_name:
            hint += f"/{agent_name}"
        surface["operator_hint"] = hint
    else:
        surface["operator_hint"] = backend or "plan"
    surface["attach_hint"] = tmux_attach_hint(session_name) if backend_name == "tmux" and session_name else ""
    return surface


def get_notification_backend(config: dict[str, Any] | None = None) -> str:
    cfg = config or load_octopus_config()
    backend = str(cfg.get("notification", {}).get("backend", "auto") or "auto").lower()
    if backend != "auto":
        return backend
    if any(str(item.get("origin", "") or "") == "feishu" for item in load_session_descriptors()):
        return "feishu"
    return "none"


def notification_enabled(kind: str, config: dict[str, Any] | None = None) -> bool:
    cfg = config or load_octopus_config()
    if get_notification_backend(cfg) == "none":
        return False
    mapping = {
        "panel": "panel_enabled",
        "event": "event_enabled",
        "text": "text_enabled",
    }
    field = mapping.get(kind, f"{kind}_enabled")
    return bool(cfg.get("notification", {}).get(field, False))


def load_session_keys() -> list[str]:
    return [key for key in (session_control_key(item) for item in load_session_descriptors()) if key]


def infer_session_origin(value: Any) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return ""
    if text.startswith("agent:"):
        return ""
    for separator in (":", "/", "|"):
        if separator in text:
            return text.split(separator, 1)[0].strip()
    return text


def _session_updated_sort_value(value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return 0.0
        if text.isdigit():
            return float(text)
        try:
            from datetime import datetime

            return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return 0.0
    return 0.0


def _merge_session_descriptor(current: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    merged = dict(current)
    for key, value in incoming.items():
        if value in (None, "", []):
            continue
        existing = merged.get(key)
        if existing in (None, "", []):
            merged[key] = value
            continue
        if key == "updated_sort":
            merged[key] = max(float(existing or 0.0), float(value or 0.0))
    return merged


def load_session_descriptors() -> list[dict[str, Any]]:
    descriptors: dict[str, dict[str, Any]] = {}

    def register(session_key: str, value: dict[str, Any]) -> None:
        key = str(session_key or "").strip()
        if not key or not isinstance(value, dict):
            return
        channel_session_key = str(value.get("channelSessionKey", "") or "").strip()
        control_key = channel_session_key or key
        origin = (
            infer_session_origin(channel_session_key)
            or infer_session_origin(value.get("messageProvider"))
            or infer_session_origin(value.get("channelId"))
            or infer_session_origin(control_key)
        )
        entry = {
            "session_key": key,
            "control_key": control_key,
            "channel_session_key": channel_session_key,
            "origin": origin,
            "label": str(value.get("label", "") or "").strip(),
            "session_id": str(value.get("sessionId", "") or value.get("id", "") or "").strip(),
            "run_id": str(value.get("runId", "") or value.get("activeRunId", "") or "").strip(),
            "agent_id": str(value.get("agentId", "") or value.get("agentName", "") or "").strip(),
            "updated_at": value.get("updatedAt"),
            "updated_sort": _session_updated_sort_value(value.get("updatedAt")),
            "is_subagent": "subagent" in key.lower() or "subagent" in str(value.get("agentId", "") or "").lower(),
            "is_user_facing": not control_key.startswith("agent:"),
            "is_main_agent": key == "agent:main:main",
        }
        descriptors[key] = _merge_session_descriptor(descriptors.get(key, {}), entry)

    raw = load_json(SESSIONS_FILE)
    if isinstance(raw, dict):
        for key, value in raw.items():
            register(str(key), value if isinstance(value, dict) else {})

    keys: list[str] = []
    main_raw = load_json(MAIN_AGENT_SESSIONS_FILE)
    if isinstance(main_raw, dict):
        for key, value in main_raw.items():
            if isinstance(key, str):
                keys.append(key)
            if isinstance(value, dict):
                register(str(key), value)
                channel = value.get("channelSessionKey")
                if isinstance(channel, str) and channel:
                    keys.append(channel)
    deduped: list[str] = []
    seen = set()
    for key in keys:
        if key and key not in seen:
            seen.add(key)
            deduped.append(key)
    for key in deduped:
        if key not in descriptors:
            register(key, {"channelSessionKey": key})
    items = list(descriptors.values())
    items.sort(key=lambda item: (float(item.get("updated_sort", 0.0) or 0.0), str(item.get("control_key", "") or "")), reverse=True)
    return items


def session_control_key(descriptor: dict[str, Any]) -> str:
    return str(descriptor.get("control_key", "") or descriptor.get("channel_session_key", "") or descriptor.get("session_key", "") or "").strip()


def _session_match_texts(descriptor: dict[str, Any]) -> list[str]:
    return [
        str(descriptor.get("session_key", "") or "").lower(),
        str(descriptor.get("control_key", "") or "").lower(),
        str(descriptor.get("channel_session_key", "") or "").lower(),
        str(descriptor.get("label", "") or "").lower(),
        str(descriptor.get("agent_id", "") or "").lower(),
        str(descriptor.get("origin", "") or "").lower(),
    ]


def _pick_preferred_session(candidates: list[dict[str, Any]]) -> str:
    if not candidates:
        return ""
    preferred = sorted(
        candidates,
        key=lambda item: (
            bool(item.get("is_user_facing")),
            not bool(item.get("is_subagent")),
            float(item.get("updated_sort", 0.0) or 0.0),
            str(item.get("control_key", "") or ""),
        ),
        reverse=True,
    )
    return session_control_key(preferred[0])


def resolve_main_session_key(config: dict[str, Any] | None = None) -> str:
    cfg = config or load_octopus_config()
    main_cfg = cfg.get("main_session", {})
    explicit = str(main_cfg.get("session_key", "") or "").strip()
    if explicit:
        return explicit

    descriptors = load_session_descriptors()
    if not descriptors:
        return ""

    target = str(main_cfg.get("target", "") or "").strip().lower()
    origin = str(main_cfg.get("origin", "") or main_cfg.get("channel", "") or "").strip().lower()
    strategy = str(main_cfg.get("strategy", "") or "").strip().lower()
    if not strategy:
        strategy = "origin_match" if origin else "latest_user_session"

    if target:
        matched = [item for item in descriptors if any(target in text for text in _session_match_texts(item))]
        resolved = _pick_preferred_session(matched)
        if resolved:
            return resolved

    if strategy == "disabled":
        return ""
    if strategy in {"origin_match", "auto"} and origin:
        matched = [item for item in descriptors if str(item.get("origin", "") or "").lower() == origin]
        resolved = _pick_preferred_session(matched)
        if resolved:
            return resolved
    if strategy == "main_agent":
        matched = [item for item in descriptors if item.get("is_main_agent")]
        resolved = _pick_preferred_session(matched)
        if resolved:
            return resolved
    if strategy == "latest_any_session":
        resolved = _pick_preferred_session(descriptors)
        if resolved:
            return resolved

    user_facing = [item for item in descriptors if item.get("is_user_facing") and not item.get("is_subagent")]
    resolved = _pick_preferred_session(user_facing)
    if resolved:
        return resolved
    non_subagent = [item for item in descriptors if not item.get("is_subagent")]
    resolved = _pick_preferred_session(non_subagent)
    if resolved:
        return resolved
    return _pick_preferred_session(descriptors)
