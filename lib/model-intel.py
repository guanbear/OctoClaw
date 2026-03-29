#!/usr/bin/env python3
"""Build OctoClaw model catalog and auto-routing policy."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from datetime import datetime, timezone

from model_health import resolve_model_health, selection_penalty_for_role
from octopus_config import MODEL_BENCHMARKS_FILE, MODEL_CATALOG_FILE, MODEL_HEALTH_FILE, MODEL_PLAN_STATE_FILE, MODEL_POLICY_FILE, MODEL_SOURCES_FILE, MODEL_SPEED_FILE, load_json, load_octopus_config, save_json
from model_plan_state import compute_plan_value_score, ensure_plan_state_file, get_plan_state_entry, preferred_fallback_model, should_fallback_due_to_plan
from model_pricing import ensure_pricing_file, get_pricing_entry, infer_effective_cny_per_1m_tokens

LATENCY_FILE = "/tmp/ironclaw-model-latency.json"
RETIRED_MODEL_PATTERNS = [r"glm-5-turbo", r"glm5-turbo"]

MODEL_PRIORS = [
    {
        "patterns": [r"gpt-5\.4", r"gpt5\.4"],
        "short_name": "gpt-5.4",
        "pricing": {"input": 4.8, "output": 19.2},
        "scores": {"coding": 0.97, "reasoning": 0.96, "openclaw": 0.93, "writing": 0.90, "reliability": 0.92},
        "speed": {"ttft_ms": 5200, "output_tps": 68},
        "source_refs": ["openai_gpt54_2026-03-05", "pinchbench_2026-03-18"],
    },
    {
        "patterns": [r"glm-5", r"kivy-glm-5"],
        "short_name": "glm-5",
        "pricing": {"input": 1.0, "output": 3.2},
        "scores": {"coding": 0.89, "reasoning": 0.92, "openclaw": 0.88, "writing": 0.84, "reliability": 0.86},
        "speed": {"ttft_ms": 4800, "output_tps": 37},
        "source_refs": ["bigmodel_glm5_docs_2026-03", "artificial_analysis_glm5_2026-03"],
    },
    {
        "patterns": [r"glm-4\.7", r"glm4\.7", r"kivy-glm-4\.7", r"glm-4-7"],
        "short_name": "glm-4.7",
        "pricing": {"input": 0.45, "output": 1.2},
        "scores": {"coding": 0.83, "reasoning": 0.82, "openclaw": 0.81, "writing": 0.78, "reliability": 0.83},
        "speed": {"ttft_ms": 2600, "output_tps": 72},
        "source_refs": ["glm47_release_2025-12", "artificial_analysis_glm47_2026-03"],
    },
    {
        "patterns": [r"minimax.*m2\.7.*highspeed", r"m2\.7.*highspeed", r"minimax-m2\.7-highspeed"],
        "short_name": "minimax-m2.7-highspeed",
        "pricing": {"input": 0.55, "output": 1.6},
        "scores": {"coding": 0.81, "reasoning": 0.82, "openclaw": 0.81, "writing": 0.88, "reliability": 0.84},
        "speed": {"ttft_ms": 1200, "output_tps": 100},
        "source_refs": ["minimax_m2_highspeed_2026-03", "local_plan_plus_highspeed_2026-03"],
    },
    {
        "patterns": [r"minimax.*m2\.7", r"m2\.7", r"minimax-m2\.7"],
        "short_name": "minimax-m2.7",
        "pricing": {"input": 0.55, "output": 1.6},
        "scores": {"coding": 0.80, "reasoning": 0.81, "openclaw": 0.79, "writing": 0.88, "reliability": 0.82},
        "speed": {"ttft_ms": 1800, "output_tps": 54},
        "source_refs": ["minimax_m2_family_2026-03", "pinchbench_minimax_family_2026-03"],
    },
    {
        "patterns": [r"sonnet"],
        "short_name": "sonnet",
        "pricing": {"input": 3.0, "output": 15.0},
        "scores": {"coding": 0.92, "reasoning": 0.89, "openclaw": 0.91, "writing": 0.86, "reliability": 0.90},
        "speed": {"ttft_ms": 2800, "output_tps": 65},
        "source_refs": ["anthropic_sonnet_baseline"],
    },
    {
        "patterns": [r"opus"],
        "short_name": "opus",
        "pricing": {"input": 15.0, "output": 75.0},
        "scores": {"coding": 0.94, "reasoning": 0.95, "openclaw": 0.92, "writing": 0.90, "reliability": 0.91},
        "speed": {"ttft_ms": 6200, "output_tps": 42},
        "source_refs": ["anthropic_opus_baseline"],
    },
    {
        "patterns": [r"kimi"],
        "short_name": "kimi",
        "pricing": {"input": 0.15, "output": 0.45},
        "scores": {"coding": 0.78, "reasoning": 0.77, "openclaw": 0.84, "writing": 0.85, "reliability": 0.80},
        "speed": {"ttft_ms": 1700, "output_tps": 58},
        "source_refs": ["moonshot_kimi_baseline"],
    },
]

SIZE_CLASS_ORDER = {
    "nano": 0,
    "mini": 1,
    "base": 2,
    "strong": 3,
}

ROLE_SIZE_PREFERENCE = {
    "runner": {"nano": 1.00, "mini": 0.98, "base": 0.92, "strong": 0.72},
    "router": {"nano": 0.82, "mini": 1.00, "base": 0.95, "strong": 0.68},
    "fix": {"nano": 0.45, "mini": 0.70, "base": 0.95, "strong": 1.00},
    "test": {"nano": 0.55, "mini": 0.78, "base": 0.96, "strong": 1.00},
    "scout": {"nano": 0.65, "mini": 0.86, "base": 0.98, "strong": 0.92},
    "writer": {"nano": 0.72, "mini": 0.90, "base": 1.00, "strong": 0.90},
    "analyze": {"nano": 0.30, "mini": 0.56, "base": 0.88, "strong": 1.00},
    "power": {"nano": 0.20, "mini": 0.45, "base": 0.82, "strong": 1.00},
    "main": {"nano": 0.18, "mini": 0.40, "base": 0.78, "strong": 1.00},
}

DEFAULT_MAIN_SELECTION = {
    "min_reasoning": 0.82,
    "min_coding": 0.82,
    "min_openclaw": 0.80,
    "min_reliability": 0.82,
    "min_benchmark_support": 0.78,
    "min_capability_score": 0.86,
    "min_size_class": "base",
    "relax_step": 0.03,
    "max_relax_rounds": 2,
}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def parse_openclaw_json_output(raw: str):
    raw = (raw or "").strip()
    if not raw:
        raise ValueError("empty output")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    for idx, ch in enumerate(raw):
        if ch not in "[{":
            continue
        try:
            return json.loads(raw[idx:])
        except json.JSONDecodeError:
            continue
    raise ValueError("no JSON payload found in output")


def match_prior(model_id: str) -> dict:
    model_lower = model_id.lower()
    for item in MODEL_PRIORS:
        if any(re.search(pattern, model_lower) for pattern in item["patterns"]):
            return item
    return {
        "short_name": model_id.split("/")[-1][:24],
        "pricing": {"input": 1.0, "output": 3.0},
        "scores": {"coding": 0.65, "reasoning": 0.65, "openclaw": 0.65, "writing": 0.65, "reliability": 0.70},
        "speed": {"ttft_ms": 3000, "output_tps": 45},
        "source_refs": ["octopus_default_prior"],
    }


def is_retired_model(model_id: str) -> bool:
    model_lower = model_id.lower()
    return any(re.search(pattern, model_lower) for pattern in RETIRED_MODEL_PATTERNS)


def infer_family_metadata(model_id: str, override: dict) -> dict:
    lower = model_id.lower()

    family = override.get("family")
    if not family:
        if "gpt-5.4" in lower or "gpt_5_4" in lower:
            family = "gpt-5.4"
        elif "glm-5" in lower or "kivy-glm-5" in lower:
            family = "glm"
        elif "glm-4.7" in lower or "glm4.7" in lower or "glm-4-7" in lower:
            family = "glm"
        elif "minimax" in lower or "m2.7" in lower:
            family = "minimax"
        elif "sonnet" in lower or "opus" in lower:
            family = "claude"
        elif "kimi" in lower:
            family = "kimi"
        elif "gemini" in lower:
            family = "gemini"
        else:
            family = "unknown"

    size_class = override.get("size_class")
    if not size_class:
        if "nano" in lower:
            size_class = "nano"
        elif "mini" in lower or "flash-lite" in lower or "lite" in lower:
            size_class = "mini"
        elif "strong" in lower or "opus" in lower or "sonnet" in lower or "gpt-5.4" in lower or "glm-5" in lower:
            size_class = "strong"
        else:
            size_class = "base"

    preferred_use = override.get("preferred_use")
    if not isinstance(preferred_use, list):
        if size_class == "nano":
            preferred_use = ["direct", "runner", "fast"]
        elif size_class == "mini":
            preferred_use = ["direct", "runner", "report", "fast"]
        elif size_class == "base":
            preferred_use = ["runner", "research", "report", "normal"]
        else:
            preferred_use = ["main", "code", "review", "strong", "heavy"]

    upgrade_path = override.get("upgrade_path")
    if not isinstance(upgrade_path, list):
        upgrade_path = []
    fallback_path = override.get("fallback_path")
    if not isinstance(fallback_path, list):
        fallback_path = []

    return {
        "family": family,
        "size_class": size_class,
        "preferred_use": preferred_use,
        "upgrade_path": upgrade_path,
        "fallback_path": fallback_path,
    }


def load_models_from_openclaw() -> list[str]:
    try:
        result = subprocess.run(
            ["openclaw", "models", "list", "--json"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode != 0:
            return []
        data = parse_openclaw_json_output(result.stdout)
    except Exception:
        return []

    ids: list[str] = []
    if isinstance(data, list):
        ids = [str(item) for item in data if isinstance(item, str)]
    elif isinstance(data, dict):
        if isinstance(data.get("models"), list):
            for item in data["models"]:
                if isinstance(item, dict) and item.get("key"):
                    ids.append(str(item["key"]))
        else:
            ids = [str(key) for key in data.keys()]
    return [model_id for model_id in ids if not is_retired_model(model_id)]


def collect_candidate_model_ids(primary_ids: list[str], *sources: dict) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []

    def remember(model_id: str) -> None:
        normalized = str(model_id or "").strip()
        if not normalized or normalized in seen or is_retired_model(normalized):
            return
        seen.add(normalized)
        ordered.append(normalized)

    for model_id in primary_ids:
        remember(model_id)

    for source in sources:
        if not isinstance(source, dict):
            continue
        for model_id in source.keys():
            if "/" in str(model_id or ""):
                remember(str(model_id))

    return ordered


def load_latency_data() -> dict:
    data = load_json(LATENCY_FILE)
    if isinstance(data, dict):
        models = data.get("models")
        if isinstance(models, dict):
            return models
    return {}


def load_speed_data() -> dict:
    data = load_json(MODEL_SPEED_FILE)
    if isinstance(data, dict):
        models = data.get("models")
        if isinstance(models, dict):
            return models
    return {}


def load_benchmark_overrides() -> dict:
    data = load_json(MODEL_BENCHMARKS_FILE)
    if isinstance(data, dict):
        models = data.get("models")
        if isinstance(models, dict):
            return models
    return {}


def load_source_registry() -> dict:
    data = load_json(MODEL_SOURCES_FILE)
    if isinstance(data, dict):
        sources = data.get("sources")
        if isinstance(sources, dict):
            return sources
    return {}


def ensure_source_registry_file() -> dict:
    data = load_json(MODEL_SOURCES_FILE)
    if isinstance(data, dict) and isinstance(data.get("sources"), dict):
        return data

    seed_file = os.path.join(os.path.dirname(__file__), "model-sources.json")
    seed = load_json(seed_file)
    if isinstance(seed, dict):
        save_json(MODEL_SOURCES_FILE, seed)
        return seed

    payload = {"updated_at": now_iso(), "sources": {}}
    save_json(MODEL_SOURCES_FILE, payload)
    return payload


def ensure_benchmark_snapshot_file() -> dict:
    data = load_json(MODEL_BENCHMARKS_FILE)
    if isinstance(data, dict) and isinstance(data.get("models"), dict):
        return data

    seed_file = os.path.join(os.path.dirname(__file__), "model-benchmarks.json")
    seed = load_json(seed_file)
    if isinstance(seed, dict):
        save_json(MODEL_BENCHMARKS_FILE, seed)
        return seed

    payload = {"updated_at": now_iso(), "sources": [], "models": {}}
    save_json(MODEL_BENCHMARKS_FILE, payload)
    return payload


def normalize(values: list[float], value: float, reverse: bool = False) -> float:
    valid = [v for v in values if isinstance(v, (int, float))]
    if not valid:
        return 0.5
    lo = min(valid)
    hi = max(valid)
    if hi == lo:
        return 0.5
    ratio = (value - lo) / (hi - lo)
    return 1 - ratio if reverse else ratio


def compute_source_factor(source_name: str, source_registry: dict, benchmark_meta: dict) -> float:
    policy = source_registry.get(source_name, {}) if isinstance(source_registry, dict) else {}
    meta = benchmark_meta.get(source_name, {}) if isinstance(benchmark_meta, dict) else {}

    default_confidence = float(policy.get("default_confidence", 0.8))
    meta_confidence = float(meta.get("confidence", default_confidence))
    confidence_factor = max(0.35, min(1.0, default_confidence * meta_confidence))

    updated_at = parse_iso_datetime(meta.get("updated_at") or "")
    if updated_at is None:
        updated_at = parse_iso_datetime(policy.get("updated_at") or "")
    age_days = 0.0
    if updated_at is not None:
        age_days = max(0.0, (datetime.now(timezone.utc) - updated_at).total_seconds() / 86400.0)

    decay_days = float(policy.get("decay_days", 60))
    min_factor = float(policy.get("min_factor", 0.55))
    freshness_factor = 1.0
    if decay_days > 0:
        freshness_factor = max(min_factor, 1.0 - age_days / decay_days)

    family_penalty = 0.82 if bool(meta.get("family_inferred")) else 1.0
    return max(0.2, min(1.0, confidence_factor * freshness_factor * family_penalty))


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def resolve_main_selection_config(config: dict | None = None) -> dict:
    cfg = config if isinstance(config, dict) else load_octopus_config()
    section = cfg.get("model_auto", {}) if isinstance(cfg, dict) else {}
    if not isinstance(section, dict):
        section = {}
    override = section.get("main_selection", {})
    if not isinstance(override, dict):
        override = {}
    merged = dict(DEFAULT_MAIN_SELECTION)
    merged.update(override)
    merged["min_size_class"] = str(merged.get("min_size_class", "base") or "base").strip() or "base"
    merged["relax_step"] = max(0.0, float(merged.get("relax_step", DEFAULT_MAIN_SELECTION["relax_step"]) or 0.0))
    merged["max_relax_rounds"] = max(0, int(merged.get("max_relax_rounds", DEFAULT_MAIN_SELECTION["max_relax_rounds"]) or 0))
    for key in (
        "min_reasoning",
        "min_coding",
        "min_openclaw",
        "min_reliability",
        "min_benchmark_support",
        "min_capability_score",
    ):
        merged[key] = clamp01(merged.get(key, DEFAULT_MAIN_SELECTION[key]))
    return merged


def compute_main_capability_score(
    *,
    reasoning: float,
    coding: float,
    openclaw: float,
    reliability: float,
    benchmark_support: float,
) -> float:
    return clamp01(
        0.28 * reasoning
        + 0.24 * coding
        + 0.20 * openclaw
        + 0.14 * reliability
        + 0.14 * benchmark_support
    )


def evaluate_main_candidate(
    *,
    model_id: str,
    size_class: str,
    reasoning: float,
    coding: float,
    openclaw: float,
    reliability: float,
    benchmark_support: float,
    capability_score: float,
    config: dict,
    relax_round: int = 0,
) -> dict:
    relax_step = float(config.get("relax_step", 0.0) or 0.0)
    relax_offset = relax_step * max(0, relax_round)
    min_size_class = str(config.get("min_size_class", "base") or "base").strip() or "base"
    min_size_rank = SIZE_CLASS_ORDER.get(min_size_class, SIZE_CLASS_ORDER["base"])
    actual_size_rank = SIZE_CLASS_ORDER.get(size_class, SIZE_CLASS_ORDER["base"])
    thresholds = {
        "reasoning": max(0.0, float(config.get("min_reasoning", 0.0) or 0.0) - relax_offset),
        "coding": max(0.0, float(config.get("min_coding", 0.0) or 0.0) - relax_offset),
        "openclaw": max(0.0, float(config.get("min_openclaw", 0.0) or 0.0) - relax_offset),
        "reliability": max(0.0, float(config.get("min_reliability", 0.0) or 0.0) - relax_offset),
        "benchmark_support": max(0.0, float(config.get("min_benchmark_support", 0.0) or 0.0) - relax_offset),
        "capability_score": max(0.0, float(config.get("min_capability_score", 0.0) or 0.0) - relax_offset),
        "size_class": min_size_class,
    }
    failed_checks: list[str] = []
    if actual_size_rank < min_size_rank:
        failed_checks.append(f"size_class<{min_size_class}")
    if reasoning < thresholds["reasoning"]:
        failed_checks.append("reasoning")
    if coding < thresholds["coding"]:
        failed_checks.append("coding")
    if openclaw < thresholds["openclaw"]:
        failed_checks.append("openclaw")
    if reliability < thresholds["reliability"]:
        failed_checks.append("reliability")
    if benchmark_support < thresholds["benchmark_support"]:
        failed_checks.append("benchmark_support")
    if capability_score < thresholds["capability_score"]:
        failed_checks.append("capability_score")
    return {
        "model": model_id,
        "eligible": not failed_checks,
        "relax_round": max(0, relax_round),
        "failed_checks": failed_checks,
        "thresholds": thresholds,
        "metrics": {
            "reasoning": round(reasoning, 6),
            "coding": round(coding, 6),
            "openclaw": round(openclaw, 6),
            "reliability": round(reliability, 6),
            "benchmark_support": round(benchmark_support, 6),
            "capability_score": round(capability_score, 6),
            "size_class": size_class,
        },
    }


def build_catalog() -> dict:
    ensure_pricing_file()
    ensure_plan_state_file()
    ensure_benchmark_snapshot_file()
    ensure_source_registry_file()
    latency_data = load_latency_data()
    speed_data = load_speed_data()
    benchmark_overrides = load_benchmark_overrides()
    source_registry = load_source_registry()
    model_ids = collect_candidate_model_ids(
        load_models_from_openclaw(),
        latency_data,
        speed_data,
        benchmark_overrides,
    )

    records = []
    for model_id in model_ids:
        prior = match_prior(model_id)
        latency = latency_data.get(model_id, {})
        override = benchmark_overrides.get(model_id, {})
        benchmark_scores = dict(override.get("benchmark_scores", {}))
        benchmark_meta = dict(override.get("benchmark_meta", {}))
        family_meta = infer_family_metadata(model_id, override)

        pricing = dict(prior["pricing"])
        pricing.update(override.get("pricing", {}))
        pricing_entry = get_pricing_entry(model_id)
        if pricing_entry:
            pricing["pricing_mode"] = pricing_entry.get("pricing_mode")
            pricing["billing_cycle"] = pricing_entry.get("billing_cycle")
            pricing["cost_score"] = pricing_entry.get("cost_score")
            pricing["effective_monthly_price_cny"] = pricing_entry.get("effective_monthly_price_cny")
            pricing["effective_cny_per_1m_tokens"] = infer_effective_cny_per_1m_tokens(model_id)

        scores = dict(prior["scores"])
        scores.update(override.get("scores", {}))

        speed = dict(prior["speed"])
        speed.update(override.get("speed", {}))
        speed["ttft_ms"] = latency.get("ttft_ms", latency.get("latency_ms", speed["ttft_ms"]))
        speed["output_tps"] = latency.get("output_tps", latency.get("tokens_per_second", speed["output_tps"]))
        local_speed = speed_data.get(model_id, {})
        if isinstance(local_speed, dict):
            speed["ttft_ms"] = local_speed.get("ttft_ms", speed["ttft_ms"])
            speed["output_tps"] = local_speed.get("output_tps", speed["output_tps"])

        error_rate = latency.get("error_rate")
        if isinstance(local_speed, dict):
            error_rate = local_speed.get("error_rate", error_rate)
        if isinstance(error_rate, (int, float)):
            scores["reliability"] = max(0.0, min(1.0, 1.0 - float(error_rate)))

        plan_state = get_plan_state_entry(model_id) or {}

        records.append(
            {
                "id": model_id,
                "short_name": override.get("short_name", prior["short_name"]),
                "family": family_meta["family"],
                "size_class": family_meta["size_class"],
                "preferred_use": family_meta["preferred_use"],
                "upgrade_path": family_meta["upgrade_path"],
                "fallback_path": family_meta["fallback_path"],
                "available": bool(local_speed.get("available", latency.get("available", True))) if isinstance(local_speed, dict) else bool(latency.get("available", True)),
                "pricing": pricing,
                "scores": scores,
                "benchmark_scores": benchmark_scores,
                "benchmark_meta": benchmark_meta,
                "source_factors": {
                    source_name: compute_source_factor(source_name, source_registry, benchmark_meta)
                    for source_name in benchmark_scores.keys()
                },
                "speed": speed,
                "provider": model_id.split("/")[0] if "/" in model_id else "unknown",
                "private": any(token in model_id.lower() for token in ("lixiang-", "kivy-", "bailian", "private")),
                "source_refs": sorted(set(prior.get("source_refs", []) + override.get("source_refs", []))),
                "pricing_entry": pricing_entry or {},
                "plan_state": plan_state,
            }
        )

    catalog = {"generated_at": now_iso(), "models": records}
    save_json(MODEL_CATALOG_FILE, catalog)
    return catalog


def compute_policy(catalog: dict, mode: str = "auto", config: dict | None = None) -> dict:
    runtime_config = config if isinstance(config, dict) else load_octopus_config()
    main_selection_cfg = resolve_main_selection_config(runtime_config)
    models = [m for m in catalog.get("models", []) if m.get("available", True)]
    if not models:
        policy = {
            "generated_at": now_iso(),
            "mode": mode,
            "main_model": "",
            "profiles": {},
            "worker_pools": {},
            "worker_pool_phases": {},
            "main_selection": {
                "selected_model": "",
                "relax_round": 0,
                "thresholds": dict(main_selection_cfg),
                "candidates": [],
            },
            "health": {
                "generated_at": now_iso(),
                "source_file": MODEL_HEALTH_FILE,
                "models": {},
                "selection_penalties": {},
            },
            "sources": [],
        }
        save_json(MODEL_POLICY_FILE, policy)
        return policy

    price_values = []
    ttft_values = []
    tps_values = []
    for model in models:
        pricing = model.get("pricing", {})
        effective = pricing.get("effective_cny_per_1m_tokens")
        if isinstance(effective, (int, float)) and effective > 0:
            price_values.append(float(effective))
        else:
            price_values.append(pricing.get("input", 1.0) * 0.75 + pricing.get("output", 3.0) * 0.25)
        ttft_values.append(model.get("speed", {}).get("ttft_ms", 3000))
        tps_values.append(model.get("speed", {}).get("output_tps", 45))

    health_state = load_json(MODEL_HEALTH_FILE)
    health_models: dict[str, dict] = {}
    health_penalties: dict[str, dict] = {}
    main_candidate_evaluations: dict[str, dict] = {}
    enriched = []
    for model in models:
        pricing = model.get("pricing", {})
        scores = model.get("scores", {})
        speed = model.get("speed", {})
        blended_price = pricing.get("effective_cny_per_1m_tokens")
        if not isinstance(blended_price, (int, float)) or blended_price <= 0:
            blended_price = pricing.get("input", 1.0) * 0.75 + pricing.get("output", 3.0) * 0.25
        price_score = normalize(price_values, blended_price, reverse=True)
        ttft_score = normalize(ttft_values, speed.get("ttft_ms", 3000), reverse=True)
        throughput_score = normalize(tps_values, speed.get("output_tps", 45))
        reliability = float(scores.get("reliability", 0.7))
        coding = float(scores.get("coding", 0.65))
        reasoning = float(scores.get("reasoning", 0.65))
        openclaw = float(scores.get("openclaw", 0.65))
        writing = float(scores.get("writing", 0.65))
        benchmark_scores = model.get("benchmark_scores", {})
        source_factors = model.get("source_factors", {})
        pinchbench = float(benchmark_scores.get("pinchbench", openclaw)) * float(source_factors.get("pinchbench", 1.0))
        aa_coding = float(benchmark_scores.get("artificial_analysis_coding", coding)) * float(source_factors.get("artificial_analysis_coding", 1.0))
        claw_eval = float(benchmark_scores.get("claw_eval", benchmark_scores.get("openclaw_live_compat", openclaw))) * float(source_factors.get("claw_eval", 1.0))
        openrouter_rankings = float(benchmark_scores.get("openrouter_rankings", 0.5)) * float(source_factors.get("openrouter_rankings", 1.0))
        openclaw_live_compat = float(benchmark_scores.get("openclaw_live_compat", claw_eval)) * float(source_factors.get("openclaw_live_compat", 1.0))
        benchmark_support = 0.35 * pinchbench + 0.30 * aa_coding + 0.25 * claw_eval + 0.10 * openrouter_rankings
        plan_value_score = compute_plan_value_score(model["id"])
        availability_score = 0.0 if should_fallback_due_to_plan(model["id"]) else 1.0
        size_class = str(model.get("size_class", "base") or "base")
        size_preference = ROLE_SIZE_PREFERENCE
        main_capability_score = compute_main_capability_score(
            reasoning=reasoning,
            coding=coding,
            openclaw=openclaw,
            reliability=reliability,
            benchmark_support=benchmark_support,
        )
        local_speed_present = isinstance(speed.get("ttft_ms"), (int, float)) and isinstance(speed.get("output_tps"), (int, float))
        local_speed_boost = 1.0 if local_speed_present else 0.88
        fast_lane_bonus = 0.0
        if speed.get("ttft_ms", 99999) <= 1800:
            fast_lane_bonus += 0.08
        if speed.get("output_tps", 0) >= 80:
            fast_lane_bonus += 0.05
        if should_fallback_due_to_plan(model["id"]):
            reliability = max(0.0, reliability - 0.20)

        health_entry = resolve_model_health(
            model["id"],
            state=health_state,
            speed_snapshot=speed,
            plan_should_fallback=should_fallback_due_to_plan(model["id"]),
        )
        role_health_penalties = {
            role: selection_penalty_for_role(health_entry, role)
            for role in ("runner", "router", "fix", "test", "scout", "writer", "analyze", "power", "main")
        }
        health_models[model["id"]] = health_entry
        health_penalties[model["id"]] = role_health_penalties
        main_candidate_evaluations[model["id"]] = evaluate_main_candidate(
            model_id=model["id"],
            size_class=size_class,
            reasoning=reasoning,
            coding=coding,
            openclaw=openclaw,
            reliability=reliability,
            benchmark_support=benchmark_support,
            capability_score=main_capability_score,
            config=main_selection_cfg,
            relax_round=0,
        )

        role_scores = {
            "runner": (
                (
                    0.64 * ttft_score
                    + 0.20 * throughput_score
                    + 0.05 * reliability
                    + 0.05 * plan_value_score
                    + 0.02 * price_score
                    + 0.01 * claw_eval
                    + 0.01 * size_preference["runner"].get(size_class, 0.80)
                ) * local_speed_boost
                + fast_lane_bonus
            ) - role_health_penalties["runner"],
            "router": (
                (
                    0.52 * ttft_score
                    + 0.18 * throughput_score
                    + 0.08 * reliability
                    + 0.10 * reasoning
                    + 0.04 * openclaw
                    + 0.04 * plan_value_score
                    + 0.01 * price_score
                    + 0.01 * size_preference["router"].get(size_class, 0.80)
                    + 0.02 * availability_score
                ) * local_speed_boost
                + fast_lane_bonus
            ) - role_health_penalties["router"],
            "fix": 0.24 * coding + 0.16 * openclaw + 0.15 * reliability + 0.13 * claw_eval + 0.10 * aa_coding + 0.08 * openclaw_live_compat + 0.06 * price_score + 0.04 * plan_value_score + 0.04 * size_preference["fix"].get(size_class, 0.80) - role_health_penalties["fix"],
            "test": 0.22 * coding + 0.18 * openclaw + 0.15 * reliability + 0.13 * claw_eval + 0.10 * aa_coding + 0.08 * openclaw_live_compat + 0.06 * price_score + 0.04 * plan_value_score + 0.04 * size_preference["test"].get(size_class, 0.80) - role_health_penalties["test"],
            "scout": 0.19 * openclaw + 0.17 * reasoning + 0.17 * writing + 0.14 * pinchbench + 0.10 * claw_eval + 0.08 * reliability + 0.07 * price_score + 0.04 * plan_value_score + 0.04 * size_preference["scout"].get(size_class, 0.80) - role_health_penalties["scout"],
            "writer": 0.26 * writing + 0.18 * reasoning + 0.13 * throughput_score + 0.10 * pinchbench + 0.08 * claw_eval + 0.08 * reliability + 0.07 * price_score + 0.06 * plan_value_score + 0.04 * size_preference["writer"].get(size_class, 0.80) - role_health_penalties["writer"],
            "analyze": 0.21 * reasoning + 0.16 * coding + 0.15 * openclaw + 0.14 * pinchbench + 0.12 * claw_eval + 0.08 * aa_coding + 0.07 * reliability + 0.04 * price_score + 0.03 * size_preference["analyze"].get(size_class, 0.80) - role_health_penalties["analyze"],
            "power": 0.19 * reasoning + 0.16 * coding + 0.15 * openclaw + 0.14 * pinchbench + 0.12 * claw_eval + 0.08 * aa_coding + 0.08 * reliability + 0.04 * price_score + 0.04 * size_preference["power"].get(size_class, 0.80) - role_health_penalties["power"],
            "main": 0.19 * coding + 0.16 * openclaw + 0.15 * reasoning + 0.14 * pinchbench + 0.12 * claw_eval + 0.08 * aa_coding + 0.07 * reliability + 0.05 * ttft_score + 0.02 * availability_score + 0.02 * size_preference["main"].get(size_class, 0.80) - role_health_penalties["main"],
        }
        enriched.append((model, role_scores))

    main_selection_meta = {
        "selected_model": "",
        "relax_round": 0,
        "thresholds": dict(main_selection_cfg),
        "candidates": [],
        "selection_path": "ranked",
    }

    def pick(role: str) -> str:
        ordered = sorted(enriched, key=lambda item: item[1][role], reverse=True)
        full_ordered = list(ordered)
        if role == "main":
            selected_round = 0
            eligible_ordered: list[tuple[dict, dict]] = []
            candidate_rows: list[dict] = []
            for relax_round in range(int(main_selection_cfg.get("max_relax_rounds", 0) or 0) + 1):
                candidate_rows = []
                eligible_ordered = []
                for model, scores in ordered:
                    evaluation = evaluate_main_candidate(
                        model_id=model["id"],
                        size_class=str(model.get("size_class", "base") or "base"),
                        reasoning=float(model.get("scores", {}).get("reasoning", 0.65)),
                        coding=float(model.get("scores", {}).get("coding", 0.65)),
                        openclaw=float(model.get("scores", {}).get("openclaw", 0.65)),
                        reliability=float(model.get("scores", {}).get("reliability", 0.70)),
                        benchmark_support=main_candidate_evaluations.get(model["id"], {}).get("metrics", {}).get("benchmark_support", 0.0),
                        capability_score=main_candidate_evaluations.get(model["id"], {}).get("metrics", {}).get("capability_score", 0.0),
                        config=main_selection_cfg,
                        relax_round=relax_round,
                    )
                    row = dict(evaluation)
                    row["score"] = round(float(scores["main"]), 6)
                    candidate_rows.append(row)
                    if evaluation["eligible"]:
                        eligible_ordered.append((model, scores))
                if eligible_ordered:
                    selected_round = relax_round
                    break
            if eligible_ordered:
                ordered = eligible_ordered
            main_selection_meta["relax_round"] = selected_round
            main_selection_meta["candidates"] = candidate_rows
            main_selection_meta["selection_path"] = "capability_gate"
        cooldown_candidates: list[str] = []
        for model, _ in ordered:
            health_entry = health_models.get(model["id"], {})
            if str(health_entry.get("state", "healthy") or "healthy").strip().lower() == "cooldown":
                cooldown_candidates.append(model["id"])
                continue
            if should_fallback_due_to_plan(model["id"]):
                fallback = preferred_fallback_model(model["id"])
                if fallback:
                    for candidate, _ in ordered:
                        if candidate["id"] == fallback:
                            if role == "main":
                                main_selection_meta["selected_model"] = candidate["id"]
                            return candidate["id"]
                    continue
            if role == "main":
                main_selection_meta["selected_model"] = model["id"]
            return model["id"]
        if role == "main":
            for model, _ in full_ordered:
                if model["id"] in cooldown_candidates:
                    continue
                health_entry = health_models.get(model["id"], {})
                if str(health_entry.get("state", "healthy") or "healthy").strip().lower() == "cooldown":
                    continue
                if should_fallback_due_to_plan(model["id"]):
                    fallback = preferred_fallback_model(model["id"])
                    if fallback:
                        for candidate, _ in full_ordered:
                            if candidate["id"] == fallback:
                                main_selection_meta["selected_model"] = candidate["id"]
                                main_selection_meta["selection_path"] = "health_fallback"
                                return candidate["id"]
                        continue
                main_selection_meta["selected_model"] = model["id"]
                main_selection_meta["selection_path"] = "health_fallback"
                return model["id"]
        if cooldown_candidates:
            if role == "main":
                main_selection_meta["selected_model"] = cooldown_candidates[0]
                main_selection_meta["selection_path"] = "cooldown_only"
            return cooldown_candidates[0]
        if ordered:
            if role == "main":
                main_selection_meta["selected_model"] = ordered[0][0]["id"]
            return ordered[0][0]["id"]
        return ""

    profiles = {
        "ops-fast": pick("runner"),
        "research": pick("scout"),
        "writer": pick("writer"),
        "code": pick("fix"),
        "review": pick("test"),
    }
    main_model = pick("main")
    main_selection_meta["selected_model"] = main_model
    worker_pools = {
        "octoclaw-runner": profiles["ops-fast"],
        "octoclaw-research": profiles["research"],
        "octoclaw-code": profiles["code"],
        "octoclaw-review": profiles["review"],
        "octoclaw-main": main_model,
    }
    worker_pool_phases = {
        "octoclaw-runner": {
            "inspect": pick("runner"),
        },
        "octoclaw-research": {
            "collect": pick("scout"),
            "inspect": pick("analyze"),
            "report": pick("writer"),
        },
        "octoclaw-code": {
            "implement": pick("fix"),
            "verify": pick("test"),
        },
        "octoclaw-review": {
            "verify": pick("test"),
        },
        "octoclaw-main": {
            "orchestrate": main_model,
        },
    }
    sources = sorted({ref for model in models for ref in model.get("source_refs", [])})
    policy = {
        "generated_at": now_iso(),
        "mode": mode,
        "main_model": main_model,
        "profiles": profiles,
        "worker_pools": worker_pools,
        "worker_pool_phases": worker_pool_phases,
        "main_selection": main_selection_meta,
        "family_routing": {
            model["id"]: {
                "family": model.get("family"),
                "size_class": model.get("size_class"),
                "preferred_use": model.get("preferred_use", []),
                "upgrade_path": model.get("upgrade_path", []),
                "fallback_path": model.get("fallback_path", []),
            }
            for model in models
        },
        "health": {
            "generated_at": now_iso(),
            "source_file": MODEL_HEALTH_FILE,
            "models": health_models,
            "selection_penalties": health_penalties,
        },
        "sources": sources,
        "source_policy": load_source_registry(),
    }
    save_json(MODEL_POLICY_FILE, policy)
    return policy


def main():
    parser = argparse.ArgumentParser(description="Build OctoClaw model intelligence files")
    parser.add_argument("command", choices=["refresh"])
    parser.add_argument("--mode", default="auto")
    args = parser.parse_args()

    catalog = build_catalog()
    policy = compute_policy(catalog, mode=args.mode, config=load_octopus_config())
    print(json.dumps({"catalog": MODEL_CATALOG_FILE, "policy": MODEL_POLICY_FILE, "main_model": policy.get("main_model", "")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
