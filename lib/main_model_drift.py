#!/usr/bin/env python3
"""Helpers for detecting OctoClaw main session model drift."""

from __future__ import annotations

import json
import os
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


def _is_real_inference_model(provider: str, model_id: str) -> bool:
    provider = str(provider or "").strip().lower()
    model_id = str(model_id or "").strip().lower()
    full = f"{provider}/{model_id}" if provider else model_id
    if not model_id:
        return False
    if full.startswith(("openclaw/", "system/")):
        return False
    if model_id in {"delivery-mirror", "tool-result"}:
        return False
    return True


def extract_session_model_from_file(session_file: str) -> tuple[str, str]:
    if not session_file or not os.path.exists(session_file):
        return ("", "")
    try:
        with open(session_file, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except Exception:
        return ("", "")

    for raw in reversed(lines[-400:]):
        try:
            event = json.loads(raw)
        except Exception:
            continue
        if event.get("type") == "custom" and event.get("customType") == "model-snapshot":
            data = event.get("data") or {}
            provider = str(data.get("provider") or "").strip()
            model_id = str(data.get("modelId") or "").strip()
            if _is_real_inference_model(provider, model_id):
                return (f"{provider}/{model_id}" if provider else model_id, "model-snapshot")
        if event.get("type") == "model_change":
            provider = str(event.get("provider") or "").strip()
            model_id = str(event.get("modelId") or "").strip()
            if _is_real_inference_model(provider, model_id):
                return (f"{provider}/{model_id}" if provider else model_id, "model_change")
        if event.get("type") == "message":
            msg = event.get("message") or {}
            if msg.get("role") != "assistant":
                continue
            provider = str(msg.get("provider") or "").strip()
            model_id = str(msg.get("model") or "").strip()
            if _is_real_inference_model(provider, model_id):
                return (f"{provider}/{model_id}" if provider else model_id, "assistant-message")
    return ("", "")


def load_actual_main_model(
    main_session: str,
    *,
    sessions_file: str = MAIN_AGENT_SESSIONS_FILE,
) -> dict[str, str]:
    data = load_json(sessions_file)
    if not isinstance(data, dict):
        data = {}
    session_entry: dict[str, Any] = {}
    if main_session and isinstance(data.get(main_session), dict):
        session_entry = data.get(main_session) or {}
    if not session_entry and main_session:
        for value in data.values():
            if isinstance(value, dict) and str(value.get("channelSessionKey", "") or "").strip() == main_session:
                session_entry = value
                break
    if not session_entry and main_session != "agent:main:main":
        fallback = data.get("agent:main:main")
        if isinstance(fallback, dict):
            session_entry = fallback
    session_file = str(session_entry.get("sessionFile") or "").strip()
    model_path, source = extract_session_model_from_file(session_file)
    return {
        "session_key": str(main_session or "").strip(),
        "session_file": session_file,
        "model_path": model_path,
        "source": source,
    }


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
    actual_model: str = "",
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
    actual_snapshot = load_actual_main_model(session_key, sessions_file=sessions_file)
    actual_model_value = str(actual_model or actual_snapshot.get("model_path", "") or "").strip()
    compared_model = actual_model_value or current_override
    compared_source = "actual_model" if actual_model_value else "current_override"
    if not compared_model:
        return {
            "enabled": True,
            "auto_recover": auto_recover,
            "drift": True,
            "reason": "current_model_missing",
            "current_mode": current_mode,
            "session_key": session_key,
            "expected_model": expected_model,
            "current_override": current_override,
            "actual_model": actual_model_value,
            "actual_model_source": str(actual_snapshot.get("source", "") or "").strip(),
            "compared_model": "",
            "comparison_source": "",
            "override_present": bool(current_override),
            "override_drift": False,
        }

    drift = compared_model != expected_model
    override_drift = bool(current_override and current_override != expected_model)
    return {
        "enabled": True,
        "auto_recover": auto_recover,
        "drift": drift,
        "reason": "drift_detected" if drift else "aligned",
        "current_mode": current_mode,
        "session_key": session_key,
        "expected_model": expected_model,
        "current_override": current_override,
        "actual_model": actual_model_value,
        "actual_model_source": str(actual_snapshot.get("source", "") or "").strip(),
        "compared_model": compared_model,
        "comparison_source": compared_source,
        "override_present": bool(current_override),
        "override_drift": override_drift,
    }


if __name__ == "__main__":
    import json

    print(json.dumps(assess_main_model_drift(), ensure_ascii=False, indent=2))
