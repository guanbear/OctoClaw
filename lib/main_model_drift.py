#!/usr/bin/env python3
"""Helpers for detecting OctoClaw main session model drift."""

from __future__ import annotations

from typing import Any

from octopus_config import MAIN_AGENT_SESSIONS_FILE, MODE_FILE, MODEL_POLICY_FILE, load_json, load_octopus_config, model_health_config, resolve_main_session_key


def main_session_drift_config(config: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = model_health_config(config or load_octopus_config())
    section = cfg.get("main_session_drift", {})
    return section if isinstance(section, dict) else {}


def load_mode_data(mode_file: str = MODE_FILE) -> dict[str, Any]:
    data = load_json(mode_file)
    return data if isinstance(data, dict) else {}


def load_policy_main_model(policy_file: str = MODEL_POLICY_FILE) -> str:
    data = load_json(policy_file)
    if not isinstance(data, dict):
        return ""
    return str(data.get("main_model", "") or "").strip()


def load_current_main_override(
    main_session: str,
    *,
    sessions_file: str = MAIN_AGENT_SESSIONS_FILE,
) -> str:
    data = load_json(sessions_file)
    if not isinstance(data, dict):
        return ""
    for key, value in data.items():
        channel_session_key = key
        if isinstance(value, dict) and value.get("channelSessionKey"):
            channel_session_key = value.get("channelSessionKey")
        if channel_session_key == main_session and isinstance(value, dict):
            return str(value.get("modelOverride", "") or "").strip()
    return ""


def resolve_expected_main_model(
    *,
    mode_data: dict[str, Any] | None = None,
    mode_file: str = MODE_FILE,
    policy_file: str = MODEL_POLICY_FILE,
) -> tuple[str, str]:
    payload = mode_data if isinstance(mode_data, dict) else load_mode_data(mode_file)
    current_mode = str(payload.get("mode", "auto") or "auto").strip()
    if current_mode == "auto":
        return current_mode, load_policy_main_model(policy_file)
    if current_mode in {"custom", "custom_explicit"}:
        custom_models = payload.get("customModels", {})
        if isinstance(custom_models, dict):
            return current_mode, str(custom_models.get("main", "") or "").strip()
        return current_mode, ""
    return current_mode, ""


def assess_main_model_drift(
    *,
    config: dict[str, Any] | None = None,
    main_session: str = "",
    sessions_file: str = MAIN_AGENT_SESSIONS_FILE,
    mode_file: str = MODE_FILE,
    policy_file: str = MODEL_POLICY_FILE,
) -> dict[str, Any]:
    cfg = config or load_octopus_config()
    drift_cfg = main_session_drift_config(cfg)
    enabled = bool(drift_cfg.get("enabled", True))
    auto_recover = bool(drift_cfg.get("auto_recover", False))

    session_key = str(main_session or resolve_main_session_key(cfg) or "").strip()
    if not enabled:
        return {"enabled": False, "auto_recover": auto_recover, "drift": False, "reason": "disabled"}
    if not session_key:
        return {"enabled": True, "auto_recover": auto_recover, "drift": False, "reason": "main_session_missing"}

    mode_data = load_mode_data(mode_file)
    current_mode, expected_model = resolve_expected_main_model(
        mode_data=mode_data,
        mode_file=mode_file,
        policy_file=policy_file,
    )
    if current_mode not in {"auto", "custom", "custom_explicit"}:
        return {
            "enabled": True,
            "auto_recover": auto_recover,
            "drift": False,
            "reason": "mode_not_managed",
            "current_mode": current_mode,
            "session_key": session_key,
        }
    if not expected_model:
        return {
            "enabled": True,
            "auto_recover": auto_recover,
            "drift": False,
            "reason": "expected_model_missing",
            "current_mode": current_mode,
            "session_key": session_key,
        }

    current_override = load_current_main_override(session_key, sessions_file=sessions_file)
    drift = current_override != expected_model
    return {
        "enabled": True,
        "auto_recover": auto_recover,
        "drift": drift,
        "reason": "drift_detected" if drift else "aligned",
        "current_mode": current_mode,
        "session_key": session_key,
        "expected_model": expected_model,
        "current_override": current_override,
    }


if __name__ == "__main__":
    import json

    print(json.dumps(assess_main_model_drift(), ensure_ascii=False, indent=2))
