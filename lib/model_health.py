#!/usr/bin/env python3
"""Cross-run model health helpers for policy-first selection."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
from typing import Any

from octopus_config import MODEL_HEALTH_FILE, load_json, load_octopus_config, model_health_config, save_json


SELECTOR_ROLE_LATENCY_CLASS = {
    "runner": "interactive",
    "main": "interactive",
    "code": "code",
    "review": "code",
    "inspect": "code",
    "team": "code",
    "research": "batch",
    "writer": "batch",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(value: str | None) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _future_timestamp(value: str | None, *, now: datetime) -> tuple[str, bool]:
    raw = str(value or "").strip()
    dt = _parse_iso(raw)
    return raw, bool(dt and dt > now)


def load_model_health_state() -> dict[str, Any]:
    data = load_json(MODEL_HEALTH_FILE)
    if isinstance(data, dict):
        return data
    return {"generated_at": "", "models": {}}


def model_health_marker(state: dict[str, Any] | None = None) -> str:
    payload = state if isinstance(state, dict) else load_model_health_state()
    return str(payload.get("generated_at", "") or "").strip()


def resolve_model_health(
    model_id: str,
    *,
    state: dict[str, Any] | None = None,
    speed_snapshot: dict[str, Any] | None = None,
    plan_should_fallback: bool = False,
    config: dict[str, Any] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    current = now or datetime.now(timezone.utc)
    runtime_cfg = config or model_health_config(load_octopus_config())
    degraded_thresholds = runtime_cfg.get("degraded_thresholds", {}) if isinstance(runtime_cfg, dict) else {}
    cooldown_thresholds = runtime_cfg.get("cooldown_thresholds", {}) if isinstance(runtime_cfg, dict) else {}
    quota_penalty = runtime_cfg.get("quota_pressure_penalty", {}) if isinstance(runtime_cfg, dict) else {}

    payload = state if isinstance(state, dict) else load_model_health_state()
    models = payload.get("models", {}) if isinstance(payload, dict) else {}
    raw = models.get(model_id, {}) if isinstance(models, dict) else {}
    if not isinstance(raw, dict):
        raw = {}

    cooldown_until, cooldown_active = _future_timestamp(raw.get("cooldown_until"), now=current)
    disabled_until, disabled_active = _future_timestamp(raw.get("disabled_until"), now=current)
    recent_429 = int(raw.get("recent_429_count", 0) or 0)
    recent_timeout = int(raw.get("recent_timeout_count", 0) or 0)
    recent_failover = int(raw.get("recent_failover_count", 0) or 0)
    recent_success = int(raw.get("recent_success_count", 0) or 0)
    quota_pressure = str(raw.get("quota_pressure", "") or "").strip().lower()
    if not quota_pressure and plan_should_fallback:
        quota_pressure = "high"

    state_name = str(raw.get("state", "healthy") or "healthy").strip().lower()
    reasons = [str(item).strip() for item in raw.get("reason_codes", []) if str(item or "").strip()]

    if disabled_active:
        state_name = "cooldown"
        reasons.append("disabled_until_active")
    elif cooldown_active:
        state_name = "cooldown"
        reasons.append("cooldown_active")
    else:
        if recent_429 >= int(cooldown_thresholds.get("rate_limit", 3) or 3):
            state_name = "cooldown"
            reasons.append("rate_limit_recent")
        elif recent_timeout >= int(cooldown_thresholds.get("timeout", 3) or 3):
            state_name = "cooldown"
            reasons.append("timeout_recent")
        elif recent_failover >= int(cooldown_thresholds.get("failover", 3) or 3):
            state_name = "cooldown"
            reasons.append("failover_recent")
        elif (
            recent_429 >= int(degraded_thresholds.get("rate_limit", 2) or 2)
            or recent_timeout >= int(degraded_thresholds.get("timeout", 2) or 2)
            or recent_failover >= int(degraded_thresholds.get("failover", 2) or 2)
            or quota_pressure in {"high", "critical"}
        ):
            state_name = "degraded"
            if recent_429 >= int(degraded_thresholds.get("rate_limit", 2) or 2):
                reasons.append("rate_limit_recent")
            if recent_timeout >= int(degraded_thresholds.get("timeout", 2) or 2):
                reasons.append("timeout_recent")
            if recent_failover >= int(degraded_thresholds.get("failover", 2) or 2):
                reasons.append("failover_recent")
            if quota_pressure in {"high", "critical"}:
                reasons.append(f"quota_pressure:{quota_pressure}")
        else:
            state_name = "healthy"

    entry = {
        "state": state_name,
        "cooldown_until": cooldown_until,
        "disabled_until": disabled_until,
        "reason_codes": sorted(set(reasons)),
        "recent_429_count": recent_429,
        "recent_timeout_count": recent_timeout,
        "recent_failover_count": recent_failover,
        "recent_success_count": recent_success,
        "first_token_p50_ms": int(raw.get("first_token_p50_ms", 0) or 0),
        "first_token_p95_ms": int(raw.get("first_token_p95_ms", 0) or 0),
        "total_latency_p50_ms": int(raw.get("total_latency_p50_ms", 0) or 0),
        "quota_pressure": quota_pressure,
        "last_error_reason": str(raw.get("last_error_reason", "") or "").strip(),
        "last_degraded_at": str(raw.get("last_degraded_at", "") or "").strip(),
    }

    if speed_snapshot and isinstance(speed_snapshot, dict):
        if not entry["first_token_p50_ms"]:
            entry["first_token_p50_ms"] = int(speed_snapshot.get("ttft_ms", 0) or 0)
        if not entry["first_token_p95_ms"]:
            entry["first_token_p95_ms"] = int(speed_snapshot.get("ttft_ms", 0) or 0)
        if not entry["total_latency_p50_ms"]:
            output_tps = float(speed_snapshot.get("output_tps", 0) or 0)
            if output_tps > 0:
                entry["total_latency_p50_ms"] = int(entry["first_token_p50_ms"] + 4000)

    if quota_pressure in quota_penalty and f"quota_pressure:{quota_pressure}" not in entry["reason_codes"]:
        entry["reason_codes"].append(f"quota_pressure:{quota_pressure}")
    entry["reason_codes"] = sorted(set(entry["reason_codes"]))
    return entry


def selection_penalty_for_role(
    health_entry: dict[str, Any],
    role: str,
    *,
    config: dict[str, Any] | None = None,
) -> float:
    runtime_cfg = config or model_health_config(load_octopus_config())
    degraded = runtime_cfg.get("degraded_penalty_by_selector_role", {}) if isinstance(runtime_cfg, dict) else {}
    cooldown = runtime_cfg.get("cooldown_penalty_by_selector_role", {}) if isinstance(runtime_cfg, dict) else {}
    latency_thresholds = runtime_cfg.get("latency_thresholds_ms", {}) if isinstance(runtime_cfg, dict) else {}
    quota_penalty = runtime_cfg.get("quota_pressure_penalty", {}) if isinstance(runtime_cfg, dict) else {}

    selector_role = str(role or "").strip().lower()
    state_name = str(health_entry.get("state", "healthy") or "healthy").strip().lower()
    penalty = 0.0
    if state_name == "cooldown":
        penalty += float(cooldown.get(selector_role, 0.70) or 0.70)
    elif state_name == "degraded":
        penalty += float(degraded.get(selector_role, 0.10) or 0.10)

    quota_pressure = str(health_entry.get("quota_pressure", "") or "").strip().lower()
    penalty += float(quota_penalty.get(quota_pressure, 0.0) or 0.0)

    latency_class = SELECTOR_ROLE_LATENCY_CLASS.get(selector_role, "batch")
    threshold = float(latency_thresholds.get(latency_class, 0) or 0)
    p95 = float(health_entry.get("first_token_p95_ms", 0) or 0)
    if threshold > 0 and p95 > threshold:
        penalty += min(0.25, ((p95 - threshold) / threshold) * 0.18)

    return round(min(0.95, penalty), 4)


def model_in_cooldown(health_entry: dict[str, Any]) -> bool:
    return str(health_entry.get("state", "healthy") or "healthy").strip().lower() == "cooldown"


def record_model_health_event(
    model_id: str,
    *,
    event: str,
    first_token_ms: int | None = None,
    total_latency_ms: int | None = None,
    cooldown_minutes: int | None = None,
) -> dict[str, Any]:
    payload = load_model_health_state()
    models = payload.setdefault("models", {})
    entry = models.setdefault(model_id, {})
    if not isinstance(entry, dict):
        entry = {}
        models[model_id] = entry

    now = datetime.now(timezone.utc)
    event_name = str(event or "").strip().lower()
    if event_name == "rate_limit":
        entry["recent_429_count"] = int(entry.get("recent_429_count", 0) or 0) + 1
        entry["last_error_reason"] = "rate_limit"
        entry["last_degraded_at"] = now_iso()
    elif event_name == "timeout":
        entry["recent_timeout_count"] = int(entry.get("recent_timeout_count", 0) or 0) + 1
        entry["last_error_reason"] = "timeout"
        entry["last_degraded_at"] = now_iso()
    elif event_name == "failover":
        entry["recent_failover_count"] = int(entry.get("recent_failover_count", 0) or 0) + 1
        entry["last_error_reason"] = "failover"
        entry["last_degraded_at"] = now_iso()
    elif event_name == "success":
        entry["recent_success_count"] = int(entry.get("recent_success_count", 0) or 0) + 1
    elif event_name == "quota_high":
        entry["quota_pressure"] = "high"
        entry["last_degraded_at"] = now_iso()
    elif event_name == "quota_critical":
        entry["quota_pressure"] = "critical"
        entry["last_degraded_at"] = now_iso()

    if isinstance(first_token_ms, int) and first_token_ms > 0:
        entry["first_token_p50_ms"] = first_token_ms
        entry["first_token_p95_ms"] = max(first_token_ms, int(entry.get("first_token_p95_ms", 0) or 0))
    if isinstance(total_latency_ms, int) and total_latency_ms > 0:
        entry["total_latency_p50_ms"] = total_latency_ms
    if isinstance(cooldown_minutes, int) and cooldown_minutes > 0:
        entry["cooldown_until"] = (now + timedelta(minutes=cooldown_minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")
    payload["generated_at"] = now_iso()
    save_json(MODEL_HEALTH_FILE, payload)
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description="OctoClaw model health helpers")
    subparsers = parser.add_subparsers(dest="command", required=True)

    show_parser = subparsers.add_parser("show")
    show_parser.add_argument("--model", default="")

    record_parser = subparsers.add_parser("record")
    record_parser.add_argument("--model", required=True)
    record_parser.add_argument("--event", required=True)
    record_parser.add_argument("--first-token-ms", type=int, default=0)
    record_parser.add_argument("--total-latency-ms", type=int, default=0)
    record_parser.add_argument("--cooldown-minutes", type=int, default=0)

    args = parser.parse_args()
    if args.command == "show":
        payload = load_model_health_state()
        if args.model:
            print(json.dumps(payload.get("models", {}).get(args.model, {}), ensure_ascii=False, indent=2))
        else:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        return

    if args.command == "record":
        payload = record_model_health_event(
            args.model,
            event=args.event,
            first_token_ms=args.first_token_ms or None,
            total_latency_ms=args.total_latency_ms or None,
            cooldown_minutes=args.cooldown_minutes or None,
        )
        print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
