#!/usr/bin/env python3
"""Build Octopus model catalog and auto-routing policy."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from datetime import datetime, timezone

from octopus_config import MODEL_CATALOG_FILE, MODEL_POLICY_FILE, MODEL_SPEED_FILE, load_json, save_json
from model_pricing import ensure_pricing_file, get_pricing_entry, infer_effective_cny_per_1m_tokens

LATENCY_FILE = "/tmp/ironclaw-model-latency.json"
BENCHMARK_SNAPSHOT_FILE = "/workspace/tmp/octopus/model-benchmarks.json"
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


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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
    data = load_json(BENCHMARK_SNAPSHOT_FILE)
    return data if isinstance(data, dict) else {}


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


def build_catalog() -> dict:
    ensure_pricing_file()
    model_ids = load_models_from_openclaw()
    latency_data = load_latency_data()
    speed_data = load_speed_data()
    benchmark_overrides = load_benchmark_overrides()

    records = []
    for model_id in model_ids:
        prior = match_prior(model_id)
        latency = latency_data.get(model_id, {})
        override = benchmark_overrides.get(model_id, {})

        pricing = dict(prior["pricing"])
        pricing.update(override.get("pricing", {}))
        pricing_entry = get_pricing_entry(model_id)
        if pricing_entry:
            pricing["pricing_mode"] = pricing_entry.get("pricing_mode")
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

        records.append(
            {
                "id": model_id,
                "short_name": override.get("short_name", prior["short_name"]),
                "available": bool(local_speed.get("available", latency.get("available", True))) if isinstance(local_speed, dict) else bool(latency.get("available", True)),
                "pricing": pricing,
                "scores": scores,
                "speed": speed,
                "provider": model_id.split("/")[0] if "/" in model_id else "unknown",
                "private": any(token in model_id.lower() for token in ("lixiang-", "kivy-", "bailian", "private")),
                "source_refs": sorted(set(prior.get("source_refs", []) + override.get("source_refs", []))),
                "pricing_entry": pricing_entry or {},
            }
        )

    catalog = {"generated_at": now_iso(), "models": records}
    save_json(MODEL_CATALOG_FILE, catalog)
    return catalog


def compute_policy(catalog: dict, mode: str = "auto") -> dict:
    models = [m for m in catalog.get("models", []) if m.get("available", True)]
    if not models:
        policy = {"generated_at": now_iso(), "mode": mode, "main_model": "", "tiers": {}, "labels": {}, "sources": []}
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

        role_scores = {
            "runner": 0.50 * ttft_score + 0.20 * reliability + 0.15 * price_score + 0.15 * throughput_score,
            "fix": 0.35 * coding + 0.25 * openclaw + 0.20 * reliability + 0.10 * price_score + 0.10 * ttft_score,
            "test": 0.33 * coding + 0.27 * openclaw + 0.20 * reliability + 0.10 * price_score + 0.10 * ttft_score,
            "scout": 0.30 * openclaw + 0.25 * reasoning + 0.20 * writing + 0.15 * price_score + 0.10 * reliability,
            "writer": 0.35 * writing + 0.25 * reasoning + 0.15 * price_score + 0.15 * throughput_score + 0.10 * reliability,
            "analyze": 0.35 * reasoning + 0.25 * coding + 0.20 * openclaw + 0.10 * reliability + 0.10 * price_score,
            "power": 0.30 * reasoning + 0.25 * coding + 0.20 * openclaw + 0.15 * reliability + 0.10 * price_score,
            "main": 0.35 * coding + 0.25 * openclaw + 0.20 * reasoning + 0.10 * reliability + 0.10 * ttft_score,
        }
        enriched.append((model, role_scores))

    def pick(role: str) -> str:
        return max(enriched, key=lambda item: item[1][role])[0]["id"]

    labels = {
        "octopus-runner": pick("runner"),
        "octopus-fix": pick("fix"),
        "octopus-test": pick("test"),
        "octopus-scout": pick("scout"),
        "octopus-writer": pick("writer"),
        "octopus-analyze": pick("analyze"),
        "octopus-power": pick("power"),
        "octopus-feishu": pick("runner"),
    }
    tiers = {
        "trivial": labels["octopus-runner"],
        "simple": labels["octopus-runner"],
        "normal": labels["octopus-fix"],
        "hard": labels["octopus-analyze"],
        "deep": labels["octopus-power"],
    }
    sources = sorted({ref for model in models for ref in model.get("source_refs", [])})
    policy = {
        "generated_at": now_iso(),
        "mode": mode,
        "main_model": pick("main"),
        "tiers": tiers,
        "labels": labels,
        "sources": sources,
    }
    save_json(MODEL_POLICY_FILE, policy)
    return policy


def main():
    parser = argparse.ArgumentParser(description="Build Octopus model intelligence files")
    parser.add_argument("command", choices=["refresh"])
    parser.add_argument("--mode", default="auto")
    args = parser.parse_args()

    catalog = build_catalog()
    policy = compute_policy(catalog, mode=args.mode)
    print(json.dumps({"catalog": MODEL_CATALOG_FILE, "policy": MODEL_POLICY_FILE, "main_model": policy.get("main_model", "")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
