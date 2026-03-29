#!/usr/bin/env python3
"""Backfill OctoClaw model health quota pressure from provider usage snapshots."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from octopus_config import MODEL_CATALOG_FILE, MODEL_HEALTH_FILE, load_json, load_octopus_config, model_health_config, save_json


DEFAULT_HIGH_USED_PERCENT = 85.0
DEFAULT_CRITICAL_USED_PERCENT = 95.0

PROVIDER_COMPAT_MAP = {
    "openai-codex": {"openai", "omniroute"},
    "anthropic": {"anthropic"},
    "google-gemini-cli": {"google", "gemini"},
    "minimax": {"minimax", "minimax-portal"},
    "zai": {"zhipu", "z-ai", "zai", "glm"},
    "github-copilot": {"github-copilot", "copilot"},
    "xiaomi": {"xiaomi"},
}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _load_usage_summary(path: str) -> dict[str, Any] | None:
    payload = load_json(path)
    if not isinstance(payload, dict):
        return None
    if isinstance(payload.get("providers"), list):
        return payload
    usage = payload.get("usage")
    if isinstance(usage, dict) and isinstance(usage.get("providers"), list):
        return usage
    return None


def _normalize_provider_models(catalog_file: str = MODEL_CATALOG_FILE) -> dict[str, list[str]]:
    payload = load_json(catalog_file)
    provider_models: dict[str, list[str]] = {}
    models = payload.get("models", []) if isinstance(payload, dict) else []
    if not isinstance(models, list):
        return provider_models
    for item in models:
        if not isinstance(item, dict):
            continue
        model_id = str(item.get("id", "") or "").strip()
        provider = str(item.get("provider", "") or "").strip().lower()
        if not model_id or not provider:
            continue
        provider_models.setdefault(provider, []).append(model_id)
    return provider_models


def _classify_quota_pressure(
    used_percent: float,
    *,
    high_threshold: float,
    critical_threshold: float,
) -> str:
    if used_percent >= critical_threshold:
        return "critical"
    if used_percent >= high_threshold:
        return "high"
    return ""


def summarize_provider_usage(
    summary: dict[str, Any],
    *,
    config: dict[str, Any] | None = None,
) -> dict[str, dict[str, Any]]:
    cfg = model_health_config(config or load_octopus_config())
    high_threshold = float(cfg.get("quota_pressure_high_used_percent", DEFAULT_HIGH_USED_PERCENT) or DEFAULT_HIGH_USED_PERCENT)
    critical_threshold = float(cfg.get("quota_pressure_critical_used_percent", DEFAULT_CRITICAL_USED_PERCENT) or DEFAULT_CRITICAL_USED_PERCENT)
    providers = summary.get("providers", []) if isinstance(summary, dict) else []
    result: dict[str, dict[str, Any]] = {}
    if not isinstance(providers, list):
        return result

    for entry in providers:
        if not isinstance(entry, dict):
            continue
        provider = str(entry.get("provider", "") or "").strip().lower()
        windows = entry.get("windows", [])
        if not provider or not isinstance(windows, list):
            continue
        peak_used = 0.0
        hottest_label = ""
        for window in windows:
            if not isinstance(window, dict):
                continue
            try:
                used = float(window.get("usedPercent", 0) or 0)
            except (TypeError, ValueError):
                used = 0.0
            if used >= peak_used:
                peak_used = used
                hottest_label = str(window.get("label", "") or "").strip()
        pressure = _classify_quota_pressure(
            peak_used,
            high_threshold=high_threshold,
            critical_threshold=critical_threshold,
        )
        result[provider] = {
            "provider": provider,
            "display_name": str(entry.get("displayName", "") or "").strip(),
            "plan": str(entry.get("plan", "") or "").strip(),
            "peak_used_percent": round(peak_used, 2),
            "hottest_window": hottest_label,
            "quota_pressure": pressure,
            "error": str(entry.get("error", "") or "").strip(),
        }
    return result


def apply_quota_summary_to_health(
    usage_summary: dict[str, Any],
    *,
    health_file: str = MODEL_HEALTH_FILE,
    catalog_file: str = MODEL_CATALOG_FILE,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    provider_summary = summarize_provider_usage(usage_summary, config=config)
    payload = load_json(health_file)
    if not isinstance(payload, dict):
        payload = {}
    models = payload.setdefault("models", {})
    if not isinstance(models, dict):
        models = {}
        payload["models"] = models

    for entry in models.values():
        if isinstance(entry, dict) and entry.get("quota_snapshot_backfill"):
            entry["quota_pressure"] = ""

    provider_models = _normalize_provider_models(catalog_file)
    updates: dict[str, dict[str, Any]] = {}

    for provider, usage in provider_summary.items():
        pressure = str(usage.get("quota_pressure", "") or "").strip().lower()
        if not pressure:
            continue
        compat_keys = PROVIDER_COMPAT_MAP.get(provider, {provider})
        matched_model_ids: list[str] = []
        for compat_key in compat_keys:
            matched_model_ids.extend(provider_models.get(compat_key, []))
        for model_id in sorted(set(matched_model_ids)):
            entry = models.setdefault(model_id, {})
            if not isinstance(entry, dict):
                entry = {}
                models[model_id] = entry
            entry["quota_pressure"] = pressure
            entry["quota_snapshot_backfill"] = {
                "updated_at": now_iso(),
                "provider": provider,
                "peak_used_percent": usage.get("peak_used_percent", 0),
                "hottest_window": usage.get("hottest_window", ""),
            }
            updates[model_id] = {
                "provider": provider,
                "quota_pressure": pressure,
                "peak_used_percent": usage.get("peak_used_percent", 0),
            }

    payload["generated_at"] = now_iso()
    payload["sources"] = payload.get("sources", {}) if isinstance(payload.get("sources"), dict) else {}
    payload["sources"]["provider_usage_quota_backfill"] = {
        "updated_at": payload["generated_at"],
        "providers": provider_summary,
    }
    save_json(health_file, payload)
    return {
        "generated_at": payload["generated_at"],
        "provider_summary": provider_summary,
        "models_updated": updates,
        "health_file": str(Path(health_file).expanduser().resolve()),
    }


def run_quota_backfill(
    *,
    usage_summary_file: str = "",
    health_file: str = MODEL_HEALTH_FILE,
    catalog_file: str = MODEL_CATALOG_FILE,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not usage_summary_file:
        return {
            "skipped": True,
            "reason": "usage_summary_missing",
            "health_file": str(Path(health_file).expanduser().resolve()),
        }
    usage_path = Path(usage_summary_file).expanduser().resolve()
    if not usage_path.exists():
        return {
            "skipped": True,
            "reason": "usage_summary_missing",
            "usage_summary_file": str(usage_path),
            "health_file": str(Path(health_file).expanduser().resolve()),
        }
    usage_summary = _load_usage_summary(str(usage_path))
    if not isinstance(usage_summary, dict):
        return {
            "skipped": True,
            "reason": "usage_summary_invalid",
            "usage_summary_file": str(usage_path),
            "health_file": str(Path(health_file).expanduser().resolve()),
        }
    result = apply_quota_summary_to_health(
        usage_summary,
        health_file=health_file,
        catalog_file=catalog_file,
        config=config,
    )
    return {
        "skipped": False,
        "reason": "",
        "usage_summary_file": str(usage_path),
        **result,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Backfill OctoClaw model-health from provider usage summary")
    parser.add_argument("--usage-summary-file", default="")
    parser.add_argument("--health-file", default=MODEL_HEALTH_FILE)
    parser.add_argument("--catalog-file", default=MODEL_CATALOG_FILE)
    parser.add_argument("--format", choices=("text", "json"), default="text")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    result = run_quota_backfill(
        usage_summary_file=args.usage_summary_file,
        health_file=args.health_file,
        catalog_file=args.catalog_file,
    )
    if args.format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        if result.get("skipped"):
            print(f"Model health quota backfill skipped: {result.get('reason')}")
        else:
            print(
                "OctoClaw Model Health Quota Backfill\n"
                f"- providers: {len(result.get('provider_summary', {}) or {})}\n"
                f"- models_updated: {len(result.get('models_updated', {}) or {})}\n"
                f"- health_file: {result.get('health_file')}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
