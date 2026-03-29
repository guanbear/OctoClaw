#!/usr/bin/env python3
"""Shared pricing helpers for OctoClaw."""

from __future__ import annotations

import re
from typing import Any

from octopus_config import WORKSPACE, load_json, save_json

MODEL_PRICING_FILE = f"{WORKSPACE}/tmp/octopus/model-pricing.json"
CNY_PER_USD = 7.2

DEFAULT_MODEL_PRICING: dict[str, Any] = {
    "updated_at": "2026-03-19T00:00:00Z",
    "currency_note": {
        "base_currency": "CNY",
        "fx_usd_cny": CNY_PER_USD,
    },
    "models": [
        {
            "match_patterns": ["gpt-5.4", "gpt5.4", "openai/gpt-5.4"],
            "model_key": "gpt-5.4-plus-seat",
            "pricing_mode": "subscription_seat_plan",
            "billing_cycle": "monthly",
            "actual_monthly_price_cny": 144.0,
            "official_monthly_price_usd": 20.0,
            "seats": 2,
            "effective_monthly_price_cny": 288.0,
            "effective_cny_per_1m_tokens": 24.0,
            "cost_score": 4,
            "notes": [
                "ChatGPT Plus + Codex 登录共享额度",
                "你的实际配置是两个 Plus 账号",
            ],
            "source_refs": [
                "user_report_2026-03-18",
                "openai_chatgpt_plus_2026-03",
                "openai_codex_plan_2026-03",
            ],
        },
        {
            "match_patterns": ["glm-4.7", "glm4.7", "kivy-glm-4.7", "glm-4-7"],
            "model_key": "glm-4.7-coding-lite",
            "pricing_mode": "subscription_prompt_plan",
            "billing_cycle": "yearly",
            "actual_monthly_price_cny": 16.7,
            "official_monthly_price_cny": 49.0,
            "effective_monthly_price_cny": 16.7,
            "grandfathered": True,
            "prompt_limit_per_5h": 80,
            "prompt_limit_per_week": 400,
            "cost_score": 1,
            "notes": [
                "你是老包年，年费不到 200 元，折月约 16.7 元",
                "官方现价口径 49 元/月",
                "官方文档当前 Lite 套餐每 5 小时约 80 prompts，每周约 400 prompts",
            ],
            "source_refs": [
                "user_report_2026-03-18",
                "bigmodel_coding_plan_2026-03",
            ],
        },
        {
            "match_patterns": ["minimax", "m2.7", "minimax-m2.7"],
            "model_key": "minimax-m2.7-plus-highspeed",
            "pricing_mode": "subscription_request_plan",
            "billing_cycle": "monthly",
            "actual_monthly_price_cny": 98.0,
            "official_monthly_price_cny": 98.0,
            "effective_monthly_price_cny": 98.0,
            "request_limit_per_5h": 1500,
            "request_limit_window_hours": 5,
            "speed_claim_tps": 100,
            "effective_cny_per_1m_tokens": 3.5,
            "cost_score": 2,
            "notes": [
                "Plus-极速版月度套餐",
                "1500 次模型调用 / 5 小时",
                "支持 MiniMax-M2.7-highspeed",
            ],
            "source_refs": [
                "user_report_2026-03-18",
                "minimax_token_plan_2026-03",
            ],
        },
    ],
}


def ensure_pricing_file() -> dict[str, Any]:
    data = load_json(MODEL_PRICING_FILE)
    if isinstance(data, dict) and isinstance(data.get("models"), list):
        return data
    save_json(MODEL_PRICING_FILE, DEFAULT_MODEL_PRICING)
    return DEFAULT_MODEL_PRICING


def load_pricing_file() -> dict[str, Any]:
    return ensure_pricing_file()


def get_pricing_entry(model_id: str) -> dict[str, Any] | None:
    model_lower = model_id.lower()
    data = ensure_pricing_file()
    for entry in data.get("models", []):
        patterns = entry.get("match_patterns", [])
        if any(re.search(pattern, model_lower) for pattern in patterns):
            return entry
    return None


def infer_effective_cny_per_1m_tokens(model_id: str, tokens: int | None = None) -> float | None:
    entry = get_pricing_entry(model_id)
    if not entry:
        return None

    mode = entry.get("pricing_mode")
    if mode == "token_pack":
        value = entry.get("effective_cny_per_1m_tokens")
        return float(value) if isinstance(value, (int, float)) else None

    if mode == "subscription_prompt_plan":
        monthly = float(entry.get("effective_monthly_price_cny", entry.get("actual_monthly_price_cny", 0.0)))
        prompts_week = float(entry.get("prompt_limit_per_week", 0))
        avg_tokens_per_prompt = float(tokens or 12000)
        if monthly > 0 and prompts_week > 0 and avg_tokens_per_prompt > 0:
            monthly_prompts = prompts_week * 4.0
            monthly_tokens = monthly_prompts * avg_tokens_per_prompt
            if monthly_tokens > 0:
                return monthly / (monthly_tokens / 1_000_000)
        return None

    if mode == "subscription_request_plan":
        explicit = entry.get("effective_cny_per_1m_tokens")
        if isinstance(explicit, (int, float)) and explicit > 0:
            return float(explicit)
        monthly = float(entry.get("effective_monthly_price_cny", entry.get("actual_monthly_price_cny", 0.0)))
        requests_per_5h = float(entry.get("request_limit_per_5h", 0))
        avg_tokens_per_request = float(tokens or 8000)
        if monthly > 0 and requests_per_5h > 0 and avg_tokens_per_request > 0:
            windows_per_month = 30 * 24 / float(entry.get("request_limit_window_hours", 5))
            monthly_tokens = windows_per_month * requests_per_5h * avg_tokens_per_request
            if monthly_tokens > 0:
                return monthly / (monthly_tokens / 1_000_000)
        return None

    if mode == "subscription_seat_plan":
        explicit = entry.get("effective_cny_per_1m_tokens")
        if isinstance(explicit, (int, float)) and explicit > 0:
            return float(explicit)
        monthly = float(entry.get("effective_monthly_price_cny", 0.0))
        assumed_monthly_tokens = float(entry.get("assumed_monthly_tokens", 12_000_000))
        if monthly > 0 and assumed_monthly_tokens > 0:
            return monthly / (assumed_monthly_tokens / 1_000_000)
        return None

    return None


def estimate_task_cost_cny(model_id: str, total_tokens: int) -> float | None:
    per_1m = infer_effective_cny_per_1m_tokens(model_id, tokens=total_tokens)
    if per_1m is None:
        return None
    return round((total_tokens / 1_000_000) * per_1m, 6)


def estimate_task_cost_usd(model_id: str, total_tokens: int) -> float | None:
    cost_cny = estimate_task_cost_cny(model_id, total_tokens)
    if cost_cny is None:
        return None
    return round(cost_cny / CNY_PER_USD, 6)
