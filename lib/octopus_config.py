#!/usr/bin/env python3
"""Shared Octopus config helpers."""

from __future__ import annotations

import json
import os
from typing import Any

WORKSPACE = os.environ.get("WORKSPACE", "/workspace")
CONFIG_FILE = f"{WORKSPACE}/tmp/octopus-config.json"
MODE_FILE = f"{WORKSPACE}/tmp/octopus-mode.json"
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
        "channel": "auto",
        "target": "",
        "session_key": "",
    },
    "model_auto": {
        "enabled": True,
        "prefer_private": False,
        "prefer_low_cost": False,
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
        "degraded_penalty_by_role": {
            "runner": 0.22,
            "router": 0.20,
            "main": 0.20,
            "fix": 0.12,
            "test": 0.12,
            "scout": 0.08,
            "writer": 0.06,
            "analyze": 0.10,
            "power": 0.12,
        },
        "cooldown_penalty_by_role": {
            "runner": 0.85,
            "router": 0.80,
            "main": 0.80,
            "fix": 0.70,
            "test": 0.70,
            "scout": 0.55,
            "writer": 0.45,
            "analyze": 0.60,
            "power": 0.70,
        },
    },
    "runtime_policy": {
        "enabled": True,
        "switches": {
            "hard_runner_only": True,
            "route_hint_required": True,
            "replay_logging": True,
            "direct_model_override": True,
            "delegation_enforcement": True,
        },
        "route_stickiness": {
            "enabled": True,
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
            "before_model_resolve": True,
            "before_prompt_build": True,
            "before_tool_call": True,
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
        "team_name": "octopus-validation",
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


def load_json(path: str) -> dict[str, Any] | list[Any] | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
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
    session_keys = load_session_keys()
    if any(key.startswith("feishu:dm:") for key in session_keys):
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
    keys: list[str] = []
    raw = load_json(SESSIONS_FILE)
    if isinstance(raw, dict):
        keys.extend([str(k) for k in raw.keys()])
    main_raw = load_json(MAIN_AGENT_SESSIONS_FILE)
    if isinstance(main_raw, dict):
        for key, value in main_raw.items():
            if isinstance(key, str) and not key.startswith("agent:main:subagent:"):
                keys.append(key)
            elif isinstance(value, dict):
                channel = value.get("channelSessionKey")
                if isinstance(channel, str) and channel:
                    keys.append(channel)
    deduped: list[str] = []
    seen = set()
    for key in keys:
        if key and key not in seen:
            seen.add(key)
            deduped.append(key)
    return deduped


def resolve_main_session_key(config: dict[str, Any] | None = None) -> str:
    cfg = config or load_octopus_config()
    main_cfg = cfg.get("main_session", {})
    explicit = str(main_cfg.get("session_key", "") or "").strip()
    if explicit:
        return explicit

    channel = str(main_cfg.get("channel", "auto") or "auto").lower()
    target = str(main_cfg.get("target", "") or "").strip()
    session_keys = load_session_keys()
    if not session_keys:
        return ""

    if target:
        for key in session_keys:
            if target in key:
                return key

    channel_prefixes = {
        "feishu": ["feishu:dm:"],
        "discord": ["discord:"],
        "telegram": ["telegram:"],
        "slack": ["slack:"],
        "auto": ["feishu:dm:", "discord:", "telegram:", "slack:"],
    }
    prefixes = channel_prefixes.get(channel, [f"{channel}:"])
    for prefix in prefixes:
        for key in session_keys:
            if key.startswith(prefix):
                return key

    return session_keys[0]
