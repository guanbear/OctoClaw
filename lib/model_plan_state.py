#!/usr/bin/env python3
"""Shared subscription plan state helpers for OctoClaw."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from octopus_config import MODEL_PLAN_STATE_FILE, load_json, save_json


DEFAULT_MODEL_PLAN_STATE: dict[str, Any] = {
    "updated_at": "2026-03-22T00:00:00Z",
    "models": [
        {
            "match_patterns": ["gpt-5\\.4", "gpt5\\.4", "openai/gpt-5.4"],
            "model_key": "gpt-5.4-plus-seat",
            "plan_type": "subscription_seat_plan",
            "billing_cycle": "monthly",
            "renewal_at": "",
            "remaining_ratio_estimate": 0.55,
            "availability_bias": 0.0,
            "sunk_cost_bias": 0.08,
            "fallback_model": "",
            "notes": [
                "Plus seat 不是典型 hard quota，更适合保守估算 remaining_ratio。",
                "更适合作 main/deep，不建议靠它吃快任务流量。"
            ]
        },
        {
            "match_patterns": ["glm-4\\.7", "glm4\\.7", "kivy-glm-4\\.7", "glm-4-7"],
            "model_key": "glm-4.7-coding-lite",
            "plan_type": "subscription_prompt_plan",
            "billing_cycle": "yearly",
            "renewal_at": "",
            "remaining_ratio_estimate": 0.95,
            "availability_bias": -0.03,
            "peak_hour_throttle_penalty": 0.06,
            "sunk_cost_bias": 0.04,
            "fallback_model": "",
            "notes": [
                "包年老套餐，边际成本极低。",
                "高峰期有轻微限速，runner 选模应考虑这点。"
            ]
        },
        {
            "match_patterns": ["minimax", "m2\\.7", "minimax-m2\\.7"],
            "model_key": "minimax-m2.7-plus-highspeed",
            "plan_type": "subscription_request_plan",
            "billing_cycle": "monthly",
            "renewal_at": "",
            "remaining_ratio_estimate": 0.75,
            "availability_bias": 0.02,
            "sunk_cost_bias": 0.18,
            "use_before_expiry": True,
            "fallback_when_remaining_ratio_below": 0.10,
            "fallback_model": "zhipu/GLM-4.7",
            "notes": [
                "包月高速度套餐，不用会浪费，应适度优先消耗。",
                "额度接近用尽时回退到 GLM-4.7。"
            ]
        }
    ]
}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ensure_plan_state_file() -> dict[str, Any]:
    data = load_json(MODEL_PLAN_STATE_FILE)
    if isinstance(data, dict) and isinstance(data.get("models"), list):
        return data
    save_json(MODEL_PLAN_STATE_FILE, DEFAULT_MODEL_PLAN_STATE)
    return DEFAULT_MODEL_PLAN_STATE


def load_plan_state_file() -> dict[str, Any]:
    return ensure_plan_state_file()


def get_plan_state_entry(model_id: str) -> dict[str, Any] | None:
    model_lower = model_id.lower()
    data = ensure_plan_state_file()
    for entry in data.get("models", []):
        patterns = entry.get("match_patterns", [])
        if any(re.search(pattern, model_lower) for pattern in patterns):
            return entry
    return None


def compute_plan_value_score(model_id: str) -> float:
    entry = get_plan_state_entry(model_id)
    if not entry:
        return 0.0

    remaining_ratio = float(entry.get("remaining_ratio_estimate", 0.5) or 0.5)
    remaining_ratio = max(0.0, min(1.0, remaining_ratio))
    sunk_cost_bias = float(entry.get("sunk_cost_bias", 0.0) or 0.0)
    availability_bias = float(entry.get("availability_bias", 0.0) or 0.0)
    throttle_penalty = float(entry.get("peak_hour_throttle_penalty", 0.0) or 0.0)

    score = 0.35 * remaining_ratio + sunk_cost_bias + availability_bias - throttle_penalty

    if entry.get("use_before_expiry"):
        score += 0.10

    floor_ratio = entry.get("fallback_when_remaining_ratio_below")
    if isinstance(floor_ratio, (int, float)) and remaining_ratio < float(floor_ratio):
        score -= 0.35

    return max(0.0, min(1.0, score))


def should_fallback_due_to_plan(model_id: str) -> bool:
    entry = get_plan_state_entry(model_id)
    if not entry:
        return False
    floor_ratio = entry.get("fallback_when_remaining_ratio_below")
    remaining_ratio = entry.get("remaining_ratio_estimate")
    if isinstance(floor_ratio, (int, float)) and isinstance(remaining_ratio, (int, float)):
        return float(remaining_ratio) < float(floor_ratio)
    return False


def preferred_fallback_model(model_id: str) -> str:
    entry = get_plan_state_entry(model_id) or {}
    fallback = entry.get("fallback_model")
    return str(fallback or "")

