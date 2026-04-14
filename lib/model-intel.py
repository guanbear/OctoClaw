#!/usr/bin/env python3
"""Build OctoClaw model catalog and auto-routing policy."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from model_health import resolve_model_health, selection_penalty_for_role
from openclaw_paths import resolve_openclaw_config_path, resolve_openclaw_main_agent_dir
from octopus_config import MODEL_BENCHMARKS_FILE, MODEL_CATALOG_FILE, MODEL_HEALTH_FILE, MODEL_INTEL_MODELS_DEV_FILE, MODEL_INTEL_MODELS_DEV_LAST_GOOD_FILE, MODEL_INTEL_OPENROUTER_CATALOG_FILE, MODEL_INTEL_OPENROUTER_CATALOG_LAST_GOOD_FILE, MODEL_INTEL_OPENROUTER_RANKINGS_FILE, MODEL_INTEL_OPENROUTER_RANKINGS_LAST_GOOD_FILE, MODEL_INTEL_SOURCE_STATUS_FILE, MODEL_PLAN_STATE_FILE, MODEL_POLICY_FILE, MODEL_SOURCES_FILE, MODEL_SPEED_FILE, WORKSPACE, load_json, load_octopus_config, save_json
from model_plan_state import compute_plan_value_score, ensure_plan_state_file, get_plan_state_entry, preferred_fallback_model, should_fallback_due_to_plan
from model_pricing import MODEL_PRICING_FILE, ensure_pricing_file, get_pricing_entry, infer_effective_cny_per_1m_tokens, load_pricing_file

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

SELECTOR_ROLE_SIZE_PREFERENCE = {
    "runner": {"nano": 1.00, "mini": 0.98, "base": 0.92, "strong": 0.72},
    "research": {"nano": 0.65, "mini": 0.86, "base": 0.98, "strong": 0.92},
    "writer": {"nano": 0.72, "mini": 0.90, "base": 1.00, "strong": 0.90},
    "code": {"nano": 0.45, "mini": 0.70, "base": 0.95, "strong": 1.00},
    "review": {"nano": 0.55, "mini": 0.78, "base": 0.96, "strong": 1.00},
    "inspect": {"nano": 0.30, "mini": 0.56, "base": 0.88, "strong": 1.00},
    "team": {"nano": 0.20, "mini": 0.45, "base": 0.82, "strong": 1.00},
    "main": {"nano": 0.18, "mini": 0.40, "base": 0.78, "strong": 1.00},
}

DEFAULT_MAIN_SELECTION = {
    "min_reasoning": 0.82,
    "min_coding": 0.82,
    "min_openclaw": 0.80,
    "min_reliability": 0.82,
    "min_benchmark_support": 0.78,
    "min_capability_score": 0.86,
    "min_size_class": "strong",
    "relax_step": 0.03,
    "max_relax_rounds": 2,
}

PROVIDER_AUTH_EQUIVALENTS = {
    "omniroute": {"omniroute", "openai-codex", "openai"},
    "openai-codex": {"openai-codex", "omniroute", "openai"},
    "openai": {"openai", "openai-codex", "omniroute"},
    "zai": {"zai", "zhipu"},
    "zhipu": {"zhipu", "zai"},
    "minimax": {"minimax", "minimax-portal"},
    "minimax-portal": {"minimax-portal", "minimax"},
}

COMMON_OPENCLAW_BIN_CANDIDATES = [
    "/opt/homebrew/bin/openclaw",
    "/usr/local/bin/openclaw",
]


def openclaw_config_path() -> Path:
    return resolve_openclaw_config_path()


def main_agent_auth_profiles_path() -> Path:
    return resolve_openclaw_main_agent_dir() / "auth-profiles.json"

MODEL_INTEL_CATALOG_SCHEMA_VERSION = "octoclaw.model_intel.catalog/v1"
MODEL_INTEL_SOURCE_STATUS_SCHEMA_VERSION = "octoclaw.model_intel.source_status/v1"
MODEL_INTEL_SOURCE_PRECEDENCE = {
    "identity": ["operator_override", "curated_local_catalog", "external_model_registry"],
    "capabilities": ["operator_override", "external_model_registry", "curated_local_catalog", "built_in_defaults"],
    "pricing": ["operator_override", "external_model_registry", "secondary_sync_source", "built_in_defaults"],
    "runtime": ["provider_runtime_observation", "operator_override", "built_in_defaults"],
}
SOURCE_STATUS_FILE_HINTS = {
    "openrouter_catalog": MODEL_INTEL_OPENROUTER_CATALOG_FILE,
    "openrouter_rankings": MODEL_INTEL_OPENROUTER_RANKINGS_FILE,
    "models_dev_registry": MODEL_INTEL_MODELS_DEV_FILE,
    "artificial_analysis_coding": MODEL_BENCHMARKS_FILE,
    "pinchbench": MODEL_BENCHMARKS_FILE,
    "claw_eval": MODEL_BENCHMARKS_FILE,
    "openclaw_live_compat": MODEL_BENCHMARKS_FILE,
    "local_speed": MODEL_SPEED_FILE,
    "plan_state": MODEL_PLAN_STATE_FILE,
    "runtime_health": MODEL_HEALTH_FILE,
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


def iso_from_timestamp(timestamp: float | int | None) -> str | None:
    if not isinstance(timestamp, (int, float)) or timestamp <= 0:
        return None
    return datetime.fromtimestamp(float(timestamp), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def file_updated_at(path: str) -> str | None:
    try:
        stat = os.stat(path)
    except OSError:
        return None
    return iso_from_timestamp(stat.st_mtime)


def freshness_state(updated_at: str | None, *, fresh_days: int = 14, stale_days: int = 45) -> str:
    parsed = parse_iso_datetime(updated_at)
    if parsed is None:
        return "missing"
    age_days = (datetime.now(timezone.utc) - parsed).total_seconds() / 86400.0
    if age_days <= fresh_days:
        return "fresh"
    if age_days <= stale_days:
        return "aging"
    return "stale"


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


def resolve_openclaw_bin(runtime_config: dict | None = None) -> str:
    config = runtime_config if isinstance(runtime_config, dict) else load_octopus_config()
    spawn_cfg = config.get("spawn_execution", {}) if isinstance(config, dict) else {}
    configured_bin = ""
    if isinstance(spawn_cfg, dict):
        configured_bin = str(spawn_cfg.get("openclaw_bin", "") or "").strip()

    candidates = [
        str(os.environ.get("OPENCLAW_BIN", "") or "").strip(),
        configured_bin,
        shutil.which("openclaw") or "",
        *COMMON_OPENCLAW_BIN_CANDIDATES,
    ]
    for candidate in candidates:
        normalized = str(candidate or "").strip()
        if not normalized:
            continue
        if os.path.isabs(normalized):
            if os.path.exists(normalized):
                return normalized
            continue
        resolved = shutil.which(normalized)
        if resolved:
            return resolved
    return "openclaw"


def load_models_from_openclaw() -> list[str]:
    try:
        env = dict(os.environ)
        path_entries = [entry for entry in str(env.get("PATH", "") or "").split(os.pathsep) if entry]
        for entry in ["/opt/homebrew/bin", "/usr/local/bin"]:
            if entry not in path_entries:
                path_entries.insert(0, entry)
        env["PATH"] = os.pathsep.join(path_entries)
        result = subprocess.run(
            [resolve_openclaw_bin(), "models", "list", "--json"],
            capture_output=True,
            env=env,
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


def load_openclaw_primary_model() -> str:
    payload = load_json(str(openclaw_config_path()))
    if not isinstance(payload, dict):
        return ""
    agents = payload.get("agents", {})
    if not isinstance(agents, dict):
        return ""
    defaults = agents.get("defaults", {})
    if not isinstance(defaults, dict):
        return ""
    model_cfg = defaults.get("model", {})
    if not isinstance(model_cfg, dict):
        return ""
    return str(model_cfg.get("primary", "") or "").strip()


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

    if ordered:
        return ordered

    for source in sources:
        if not isinstance(source, dict):
            continue
        for model_id in source.keys():
            if "/" in str(model_id or ""):
                remember(str(model_id))

    return ordered


def resolve_benchmark_override(model_id: str, overrides: dict[str, dict]) -> tuple[str, dict]:
    if not isinstance(overrides, dict):
        return "", {}
    if model_id in overrides and isinstance(overrides.get(model_id), dict):
        return model_id, dict(overrides[model_id])

    model_lower = str(model_id or "").strip().lower()
    for key, value in overrides.items():
        if str(key or "").strip().lower() == model_lower and isinstance(value, dict):
            return str(key), dict(value)

    target_prior = match_prior(model_id)
    target_short_name = str(target_prior.get("short_name", "") or "").strip().lower()
    if not target_short_name:
        return "", {}
    target_family = str(infer_family_metadata(model_id, {}).get("family", "") or "").strip().lower()
    target_provider = model_lower.split("/", 1)[0] if "/" in model_lower else ""

    candidates: list[tuple[int, float, str, dict]] = []
    for key, value in overrides.items():
        if not isinstance(value, dict):
            continue
        candidate_key = str(key or "").strip()
        if "/" not in candidate_key:
            continue
        candidate_prior = match_prior(candidate_key)
        candidate_short_name = str(candidate_prior.get("short_name", "") or "").strip().lower()
        if candidate_short_name != target_short_name:
            continue
        candidate_family = str(infer_family_metadata(candidate_key, value).get("family", "") or "").strip().lower()
        score = 0
        if candidate_family and candidate_family == target_family:
            score += 4
        candidate_provider = candidate_key.lower().split("/", 1)[0]
        if target_provider and candidate_provider == target_provider:
            score += 2
        benchmark_meta = value.get("benchmark_meta", {})
        confidence_sum = 0.0
        if isinstance(benchmark_meta, dict):
            for meta in benchmark_meta.values():
                if isinstance(meta, dict):
                    confidence_sum += float(meta.get("confidence", 0.0) or 0.0)
        candidates.append((score, confidence_sum, candidate_key, dict(value)))

    if not candidates:
        return "", {}

    _, _, selected_key, selected_value = max(candidates, key=lambda item: (item[0], item[1], item[2]))
    return selected_key, selected_value


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
    seed_file = os.path.join(os.path.dirname(__file__), "model-sources.json")
    seed = load_json(seed_file)
    if isinstance(data, dict) and isinstance(data.get("sources"), dict):
        payload = dict(data)
        if isinstance(seed, dict) and isinstance(seed.get("sources"), dict):
            merged_sources = dict(seed.get("sources", {}))
            merged_sources.update(payload.get("sources", {}))
            if merged_sources != payload.get("sources", {}):
                payload["sources"] = merged_sources
                payload["updated_at"] = now_iso()
                save_json(MODEL_SOURCES_FILE, payload)
            return payload
        return data
    if isinstance(seed, dict):
        save_json(MODEL_SOURCES_FILE, seed)
        return seed

    payload = {"updated_at": now_iso(), "sources": {}}
    save_json(MODEL_SOURCES_FILE, payload)
    return payload


def load_snapshot_with_last_good(primary_path: str, last_good_path: str) -> tuple[dict[str, Any], str]:
    primary = load_json(primary_path)
    if isinstance(primary, dict) and isinstance(primary.get("records"), list):
        return primary, primary_path
    last_good = load_json(last_good_path)
    if isinstance(last_good, dict) and isinstance(last_good.get("records"), list):
        return last_good, last_good_path
    return {}, ""


def normalize_model_lookup_key(value: Any) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return ""
    text = re.sub(r"\(free\)", "", text)
    text = re.sub(r"^[^:]+:\s*", "", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def build_model_lookup_keys(*values: Any) -> list[str]:
    keys: list[str] = []

    def remember(raw: Any) -> None:
        text = str(raw or "").strip()
        if not text:
            return
        variants = [text, text.lower()]
        if "/" in text:
            suffix = text.split("/", 1)[1]
            variants.append(suffix)
            variants.append(text.rsplit("/", 1)[-1])
        for variant in variants:
            normalized = normalize_model_lookup_key(variant)
            if normalized and normalized not in keys:
                keys.append(normalized)

    for value in values:
        if isinstance(value, list):
            for item in value:
                remember(item)
            continue
        remember(value)
    return keys


def index_snapshot_records(records: list[dict[str, Any]], *, fields: list[str]) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for record in records:
        if not isinstance(record, dict):
            continue
        for field in fields:
            value = record.get(field)
            keys = build_model_lookup_keys(value)
            for key in keys:
                index.setdefault(key, record)
    return index


def load_external_model_intel_snapshots() -> dict[str, dict[str, Any]]:
    snapshot_specs = {
        "models_dev_registry": {
            "primary": MODEL_INTEL_MODELS_DEV_FILE,
            "last_good": MODEL_INTEL_MODELS_DEV_LAST_GOOD_FILE,
            "fields": ["full_id", "model_id", "name", "family"],
        },
        "openrouter_catalog": {
            "primary": MODEL_INTEL_OPENROUTER_CATALOG_FILE,
            "last_good": MODEL_INTEL_OPENROUTER_CATALOG_LAST_GOOD_FILE,
            "fields": ["id", "canonical_slug", "name", "normalized_name"],
        },
        "openrouter_rankings": {
            "primary": MODEL_INTEL_OPENROUTER_RANKINGS_FILE,
            "last_good": MODEL_INTEL_OPENROUTER_RANKINGS_LAST_GOOD_FILE,
            "fields": ["model_id", "name"],
        },
    }
    snapshots: dict[str, dict[str, Any]] = {}
    for source_name, spec in snapshot_specs.items():
        payload, source_file = load_snapshot_with_last_good(spec["primary"], spec["last_good"])
        records = payload.get("records", []) if isinstance(payload, dict) and isinstance(payload.get("records"), list) else []
        snapshots[source_name] = {
            "payload": payload if isinstance(payload, dict) else {},
            "records": records,
            "lookup": index_snapshot_records(records, fields=list(spec["fields"])),
            "source_file": source_file,
            "updated_at": str((payload or {}).get("generated_at", "") or file_updated_at(source_file) or "").strip(),
            "last_good": bool(source_file and source_file == spec["last_good"]),
        }
    return snapshots


def resolve_external_record(snapshot: dict[str, Any], *keys: Any) -> dict[str, Any]:
    lookup = snapshot.get("lookup", {}) if isinstance(snapshot, dict) else {}
    if not isinstance(lookup, dict):
        return {}
    for key in build_model_lookup_keys(*keys):
        record = lookup.get(key)
        if isinstance(record, dict):
            return record
    return {}


def extract_external_metadata(
    *,
    model_id: str,
    short_name: str,
    snapshots: dict[str, dict[str, Any]],
    source_registry: dict[str, Any],
) -> dict[str, Any]:
    models_dev = resolve_external_record(snapshots.get("models_dev_registry", {}), model_id, short_name)
    openrouter_catalog = resolve_external_record(snapshots.get("openrouter_catalog", {}), model_id, short_name)
    openrouter_rankings = resolve_external_record(snapshots.get("openrouter_rankings", {}), model_id, short_name)
    capability_hints = {
        "tool_call": bool(models_dev.get("tool_call")) or "tools" in {
            str(item).strip().lower() for item in openrouter_catalog.get("supported_parameters", [])
        },
        "reasoning": bool(models_dev.get("reasoning")),
        "open_weights": bool(models_dev.get("open_weights")),
    }
    input_modalities = list(models_dev.get("input_modalities") or []) or list(openrouter_catalog.get("input_modalities") or [])
    output_modalities = list(models_dev.get("output_modalities") or []) or list(openrouter_catalog.get("output_modalities") or [])
    limits = {
        "context_length": int(openrouter_catalog.get("context_length") or models_dev.get("context_length") or 0),
        "max_completion_tokens": int(openrouter_catalog.get("max_completion_tokens") or models_dev.get("output_limit") or 0),
        "output_limit": int(models_dev.get("output_limit") or openrouter_catalog.get("max_completion_tokens") or 0),
    }
    source_refs: list[str] = []
    if models_dev:
        source_refs.append("models_dev_registry_sync")
    if openrouter_catalog:
        source_refs.append("openrouter_catalog_sync")
    if openrouter_rankings:
        source_refs.append("openrouter_rankings_sync")
    ranking_meta = {}
    if openrouter_rankings:
        rankings_payload = snapshots.get("openrouter_rankings", {}).get("payload", {})
        ranking_filters = rankings_payload.get("filters", {}) if isinstance(rankings_payload, dict) else {}
        ranking_counts = rankings_payload.get("counts", {}) if isinstance(rankings_payload, dict) else {}
        ranking_meta = {
            "source_model": str(openrouter_rankings.get("model_id") or openrouter_rankings.get("name") or "").strip(),
            "confidence": float(
                source_registry.get("openrouter_rankings", {}).get("default_confidence", 0.55)
                if isinstance(source_registry, dict)
                else 0.55
            ),
            "updated_at": str(snapshots.get("openrouter_rankings", {}).get("updated_at", "") or "").strip(),
            "filtered_free_models": bool(ranking_filters.get("exclude_free_models", True)),
            "filter_policy": str(ranking_filters.get("policy", "paid_only_ecosystem_signal") or "paid_only_ecosystem_signal"),
            "counts": dict(ranking_counts) if isinstance(ranking_counts, dict) else {},
        }
    return {
        "models_dev": models_dev,
        "openrouter_catalog": openrouter_catalog,
        "openrouter_rankings": openrouter_rankings,
        "capability_hints": capability_hints,
        "modalities": {
            "input": input_modalities,
            "output": output_modalities,
            "primary": str(openrouter_catalog.get("modality") or "").strip(),
        },
        "limits": limits,
        "ranking_meta": ranking_meta,
        "source_refs": source_refs,
    }


def summarize_benchmark_sources(benchmark_overrides: dict[str, Any]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for override in benchmark_overrides.values():
        if not isinstance(override, dict):
            continue
        benchmark_scores = override.get("benchmark_scores", {})
        if not isinstance(benchmark_scores, dict):
            continue
        for source_name, value in benchmark_scores.items():
            if isinstance(value, (int, float)):
                counts[source_name] = counts.get(source_name, 0) + 1
    return counts


def summarize_source_status(
    *,
    source_registry: dict[str, Any],
    benchmark_overrides: dict[str, Any],
    configured_ids: list[str],
    speed_data: dict[str, Any],
    health_state: dict[str, Any],
    external_snapshots: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    pricing_data = load_pricing_file()
    plan_state_data = load_json(MODEL_PLAN_STATE_FILE)
    benchmark_source_counts = summarize_benchmark_sources(benchmark_overrides)
    speed_models = speed_data if isinstance(speed_data, dict) else {}
    health_models = health_state.get("models", {}) if isinstance(health_state, dict) else {}
    plan_models = plan_state_data.get("models", {}) if isinstance(plan_state_data, dict) else {}
    pricing_models = pricing_data.get("models", []) if isinstance(pricing_data, dict) else []
    openrouter_catalog_records = external_snapshots.get("openrouter_catalog", {}).get("records", [])
    openrouter_ranking_records = external_snapshots.get("openrouter_rankings", {}).get("records", [])
    models_dev_records = external_snapshots.get("models_dev_registry", {}).get("records", [])

    observed_counts = {
        "openrouter_catalog": len(openrouter_catalog_records) if isinstance(openrouter_catalog_records, list) else 0,
        "openrouter_rankings": len(openrouter_ranking_records) if isinstance(openrouter_ranking_records, list) else benchmark_source_counts.get("openrouter_rankings", 0),
        "models_dev_registry": len(models_dev_records) if isinstance(models_dev_records, list) else 0,
        "artificial_analysis_coding": benchmark_source_counts.get("artificial_analysis_coding", 0),
        "pinchbench": benchmark_source_counts.get("pinchbench", 0),
        "claw_eval": benchmark_source_counts.get("claw_eval", 0),
        "openclaw_live_compat": max(benchmark_source_counts.get("openclaw_live_compat", 0), len(configured_ids)),
        "local_speed": len(speed_models),
        "plan_state": len(plan_models) if isinstance(plan_models, dict) else 0,
        "runtime_health": len(health_models) if isinstance(health_models, dict) else 0,
    }

    sources: dict[str, Any] = {}
    for source_name, source_meta in source_registry.items():
        meta = dict(source_meta) if isinstance(source_meta, dict) else {}
        hint_file = SOURCE_STATUS_FILE_HINTS.get(source_name, MODEL_SOURCES_FILE)
        embedded_updated_at = None
        if source_name in external_snapshots:
            embedded_updated_at = external_snapshots.get(source_name, {}).get("updated_at")
            hint_file = str(external_snapshots.get(source_name, {}).get("source_file", "") or hint_file)
        elif hint_file == MODEL_PRICING_FILE and isinstance(pricing_data, dict):
            embedded_updated_at = pricing_data.get("updated_at")
        elif hint_file == MODEL_PLAN_STATE_FILE and isinstance(plan_state_data, dict):
            embedded_updated_at = plan_state_data.get("updated_at")
        elif hint_file == MODEL_HEALTH_FILE and isinstance(health_state, dict):
            embedded_updated_at = health_state.get("generated_at") or health_state.get("updated_at")
        observed_models = int(observed_counts.get(source_name, 0) or 0)
        updated_at = str(embedded_updated_at or file_updated_at(hint_file) or "")
        sources[source_name] = {
            "role": str(meta.get("role", "") or "").strip(),
            "description": str(meta.get("description", "") or "").strip(),
            "default_confidence": float(meta.get("default_confidence", 0.0) or 0.0),
            "decay_days": int(meta.get("decay_days", 0) or 0),
            "min_factor": float(meta.get("min_factor", 0.0) or 0.0),
            "source_file": hint_file,
            "updated_at": updated_at,
            "freshness": freshness_state(updated_at),
            "active": observed_models > 0,
            "observed_models": observed_models,
        }

    payload = {
        "generated_at": now_iso(),
        "schema_version": MODEL_INTEL_SOURCE_STATUS_SCHEMA_VERSION,
        "source_precedence": MODEL_INTEL_SOURCE_PRECEDENCE,
        "sources": sources,
    }
    save_json(MODEL_INTEL_SOURCE_STATUS_FILE, payload)
    return payload


def build_facts_plane_summary(source_status: dict[str, Any]) -> dict[str, Any]:
    sources = source_status.get("sources", {}) if isinstance(source_status, dict) else {}
    active_sources = sorted(name for name, entry in sources.items() if isinstance(entry, dict) and entry.get("active"))
    stale_sources = sorted(name for name, entry in sources.items() if isinstance(entry, dict) and entry.get("freshness") == "stale")
    return {
        "catalog_schema_version": MODEL_INTEL_CATALOG_SCHEMA_VERSION,
        "source_status_schema_version": MODEL_INTEL_SOURCE_STATUS_SCHEMA_VERSION,
        "source_precedence": MODEL_INTEL_SOURCE_PRECEDENCE,
        "source_status_file": MODEL_INTEL_SOURCE_STATUS_FILE,
        "active_sources": active_sources,
        "stale_sources": stale_sources,
    }


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


def compute_openrouter_rankings_factor(model: dict[str, Any]) -> tuple[float, dict[str, Any]]:
    benchmark_scores = model.get("benchmark_scores", {}) if isinstance(model.get("benchmark_scores"), dict) else {}
    benchmark_meta = model.get("benchmark_meta", {}) if isinstance(model.get("benchmark_meta"), dict) else {}
    source_factors = model.get("source_factors", {}) if isinstance(model.get("source_factors"), dict) else {}
    local_truth_signals = model.get("local_truth_signals", {}) if isinstance(model.get("local_truth_signals"), dict) else {}
    base_factor = float(source_factors.get("openrouter_rankings", 1.0) or 1.0)
    applied_factor = base_factor
    cap_reasons: list[str] = []
    cap_limit = 1.0

    if bool(local_truth_signals.get("openclaw_live_compat")) or bool(local_truth_signals.get("runtime_health")):
        cap_limit = min(cap_limit, 0.35)
        cap_reasons.append("local_truth:compat_or_runtime")
    if bool(local_truth_signals.get("local_speed")):
        cap_limit = min(cap_limit, 0.40)
        cap_reasons.append("local_truth:local_speed")
    if bool(local_truth_signals.get("configured")):
        cap_limit = min(cap_limit, 0.50)
        cap_reasons.append("local_truth:configured")
    if bool(local_truth_signals.get("plan_state")):
        cap_limit = min(cap_limit, 0.55)
        cap_reasons.append("local_truth:plan_state")

    if cap_limit < 1.0:
        applied_factor = min(applied_factor, cap_limit)

    meta = benchmark_meta.get("openrouter_rankings", {}) if isinstance(benchmark_meta, dict) else {}
    return (
        applied_factor,
        {
            "present": "openrouter_rankings" in benchmark_scores,
            "base_factor": round(base_factor, 6),
            "applied_factor": round(applied_factor, 6),
            "capped": applied_factor < base_factor,
            "cap_reasons": cap_reasons,
            "filtered_free_models": bool(meta.get("filtered_free_models")),
            "filter_policy": str(meta.get("filter_policy", "") or ""),
            "counts": dict(meta.get("counts", {})) if isinstance(meta.get("counts"), dict) else {},
            "local_truth_signals": {key: bool(value) for key, value in local_truth_signals.items()},
        },
    )


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
    default_min_size_class = str(DEFAULT_MAIN_SELECTION.get("min_size_class", "strong") or "strong").strip() or "strong"
    merged["min_size_class"] = str(merged.get("min_size_class", default_min_size_class) or default_min_size_class).strip() or default_min_size_class
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
    main_capable: bool,
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
    default_min_size_class = str(DEFAULT_MAIN_SELECTION.get("min_size_class", "strong") or "strong").strip() or "strong"
    min_size_class = str(config.get("min_size_class", default_min_size_class) or default_min_size_class).strip() or default_min_size_class
    min_size_rank = SIZE_CLASS_ORDER.get(min_size_class, SIZE_CLASS_ORDER[default_min_size_class])
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
    if not main_capable:
        failed_checks.append("main_capable")
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
            "main_capable": bool(main_capable),
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
    external_snapshots = load_external_model_intel_snapshots()
    configured_ids = load_models_from_openclaw()
    health_state = load_json(MODEL_HEALTH_FILE)
    health_models = health_state.get("models", {}) if isinstance(health_state, dict) else {}
    configured_set = {str(model_id).strip() for model_id in configured_ids}
    model_ids = collect_candidate_model_ids(
        configured_ids,
        latency_data,
        speed_data,
        benchmark_overrides,
    )

    records = []
    for model_id in model_ids:
        prior = match_prior(model_id)
        latency = latency_data.get(model_id, {})
        benchmark_source_model, override = resolve_benchmark_override(model_id, benchmark_overrides)
        benchmark_scores = dict(override.get("benchmark_scores", {}))
        benchmark_meta = dict(override.get("benchmark_meta", {}))
        family_meta = infer_family_metadata(model_id, override)
        external_meta = extract_external_metadata(
            model_id=model_id,
            short_name=override.get("short_name", prior["short_name"]),
            snapshots=external_snapshots,
            source_registry=source_registry,
        )

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
        if external_meta["capability_hints"].get("reasoning"):
            scores["reasoning_capable"] = True
        if external_meta["capability_hints"].get("tool_call"):
            scores["tool_capable"] = True

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

        ranking_record = external_meta.get("openrouter_rankings", {})
        if isinstance(ranking_record, dict) and ranking_record and "openrouter_rankings" not in benchmark_scores:
            ranking_score = ranking_record.get("score")
            if isinstance(ranking_score, (int, float)):
                benchmark_scores["openrouter_rankings"] = float(ranking_score)
                benchmark_meta["openrouter_rankings"] = external_meta.get("ranking_meta", {})

        plan_state = get_plan_state_entry(model_id) or {}
        local_truth_signals = {
            "configured": model_id in configured_set,
            "openclaw_live_compat": "openclaw_live_compat" in benchmark_scores,
            "local_speed": isinstance(local_speed, dict) and bool(local_speed),
            "runtime_health": isinstance(health_models, dict) and bool(health_models.get(model_id)),
            "plan_state": bool(plan_state),
        }
        source_refs = sorted(
            set(prior.get("source_refs", []) + override.get("source_refs", []) + external_meta.get("source_refs", []))
        )

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
                "configured": model_id in configured_set,
                "benchmark_source_model": benchmark_source_model,
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
                "source_refs": source_refs,
                "pricing_entry": pricing_entry or {},
                "plan_state": plan_state,
                "capability_hints": external_meta.get("capability_hints", {}),
                "modalities": external_meta.get("modalities", {}),
                "limits": external_meta.get("limits", {}),
                "external_metadata": {
                    "models_dev": external_meta.get("models_dev", {}),
                    "openrouter_catalog": external_meta.get("openrouter_catalog", {}),
                    "openrouter_rankings": external_meta.get("openrouter_rankings", {}),
                },
                "local_truth_signals": local_truth_signals,
            }
        )

    source_status = summarize_source_status(
        source_registry=source_registry,
        benchmark_overrides=benchmark_overrides,
        configured_ids=configured_ids,
        speed_data=speed_data,
        health_state=health_state if isinstance(health_state, dict) else {},
        external_snapshots=external_snapshots,
    )
    catalog = {
        "generated_at": now_iso(),
        "schema_version": MODEL_INTEL_CATALOG_SCHEMA_VERSION,
        "facts_plane": build_facts_plane_summary(source_status),
        "models": records,
    }
    save_json(MODEL_CATALOG_FILE, catalog)
    return catalog


def load_available_auth_providers() -> set[str]:
    providers: set[str] = set()

    def consume_profiles(payload: dict) -> None:
        if not isinstance(payload, dict):
            return
        profiles = payload.get("profiles", {})
        if not isinstance(profiles, dict):
            return
        for entry in profiles.values():
            if not isinstance(entry, dict):
                continue
            provider = str(entry.get("provider", "") or "").strip().lower()
            if provider:
                providers.add(provider)

    agent_auth = load_json(str(main_agent_auth_profiles_path()))
    consume_profiles(agent_auth)

    openclaw_cfg = load_json(str(openclaw_config_path()))
    if isinstance(openclaw_cfg, dict):
        auth_cfg = openclaw_cfg.get("auth", {})
        if isinstance(auth_cfg, dict):
            consume_profiles(auth_cfg)

    return providers


def filter_models_for_available_auth(models: list[dict], available_providers: set[str]) -> list[dict]:
    if not available_providers:
        return list(models)
    normalized_available: set[str] = set()
    for provider in available_providers:
        provider_name = str(provider or "").strip().lower()
        if not provider_name:
            continue
        normalized_available.update(PROVIDER_AUTH_EQUIVALENTS.get(provider_name, {provider_name}))
    filtered = [
        model
        for model in models
        if bool(model.get("configured"))
        or str(model.get("provider", "") or "").strip().lower() in normalized_available
    ]
    return filtered or list(models)


def is_main_capable_model(model: dict) -> bool:
    preferred_use = model.get("preferred_use", [])
    preferred_tags = {
        str(item or "").strip().lower()
        for item in preferred_use
        if isinstance(item, str)
    }
    if "main" in preferred_tags:
        return True
    size_class = str(model.get("size_class", "base") or "base").strip().lower()
    return SIZE_CLASS_ORDER.get(size_class, SIZE_CLASS_ORDER["base"]) >= SIZE_CLASS_ORDER["strong"]


def compute_policy(catalog: dict, mode: str = "auto", config: dict | None = None) -> dict:
    runtime_config = config if isinstance(config, dict) else load_octopus_config()
    main_selection_cfg = resolve_main_selection_config(runtime_config)
    facts_plane = catalog.get("facts_plane", {}) if isinstance(catalog.get("facts_plane"), dict) else {
        "catalog_schema_version": MODEL_INTEL_CATALOG_SCHEMA_VERSION,
        "source_status_schema_version": MODEL_INTEL_SOURCE_STATUS_SCHEMA_VERSION,
        "source_precedence": MODEL_INTEL_SOURCE_PRECEDENCE,
        "source_status_file": MODEL_INTEL_SOURCE_STATUS_FILE,
        "active_sources": [],
        "stale_sources": [],
    }
    all_models = [m for m in catalog.get("models", []) if m.get("available", True)]
    available_auth_providers = load_available_auth_providers()
    models = filter_models_for_available_auth(all_models, available_auth_providers)
    configured_primary_model = load_openclaw_primary_model()
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
            "facts_plane": facts_plane,
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
        raw_pinchbench = float(benchmark_scores.get("pinchbench", openclaw))
        raw_aa_coding = float(benchmark_scores.get("artificial_analysis_coding", coding))
        raw_claw_eval = float(benchmark_scores.get("claw_eval", benchmark_scores.get("openclaw_live_compat", openclaw)))
        raw_openrouter_rankings = float(benchmark_scores.get("openrouter_rankings", 0.5))
        raw_openclaw_live_compat = float(benchmark_scores.get("openclaw_live_compat", raw_claw_eval))
        pinchbench = raw_pinchbench * float(source_factors.get("pinchbench", 1.0))
        aa_coding = raw_aa_coding * float(source_factors.get("artificial_analysis_coding", 1.0))
        claw_eval = raw_claw_eval * float(source_factors.get("claw_eval", 1.0))
        openrouter_rankings_factor, ranking_signal_policy = compute_openrouter_rankings_factor(model)
        openrouter_rankings = raw_openrouter_rankings * openrouter_rankings_factor
        openclaw_live_compat = raw_openclaw_live_compat * float(source_factors.get("openclaw_live_compat", 1.0))
        raw_benchmark_support = 0.35 * raw_pinchbench + 0.30 * raw_aa_coding + 0.25 * raw_claw_eval + 0.10 * raw_openrouter_rankings
        weighted_benchmark_support = 0.35 * pinchbench + 0.30 * aa_coding + 0.25 * claw_eval + 0.10 * openrouter_rankings
        evidence_confidence = (
            0.35 * float(source_factors.get("pinchbench", 0.55))
            + 0.30 * float(source_factors.get("artificial_analysis_coding", 0.55))
            + 0.25 * float(source_factors.get("claw_eval", 0.55))
            + 0.10 * openrouter_rankings_factor
        )
        plan_value_score = compute_plan_value_score(model["id"])
        availability_score = 0.0 if should_fallback_due_to_plan(model["id"]) else 1.0
        size_class = str(model.get("size_class", "base") or "base")
        size_preference = SELECTOR_ROLE_SIZE_PREFERENCE
        main_capability_score = compute_main_capability_score(
            reasoning=reasoning,
            coding=coding,
            openclaw=openclaw,
            reliability=reliability,
            benchmark_support=raw_benchmark_support,
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
            for role in ("runner", "research", "writer", "code", "review", "inspect", "team", "main")
        }
        health_models[model["id"]] = health_entry
        health_penalties[model["id"]] = role_health_penalties
        main_candidate_evaluations[model["id"]] = evaluate_main_candidate(
            model_id=model["id"],
            size_class=size_class,
            main_capable=is_main_capable_model(model),
            reasoning=reasoning,
            coding=coding,
            openclaw=openclaw,
            reliability=reliability,
            benchmark_support=raw_benchmark_support,
            capability_score=main_capability_score,
            config=main_selection_cfg,
            relax_round=0,
        )

        role_scores = {
            "runner": (
                (
                    0.48 * ttft_score
                    + 0.20 * throughput_score
                    + 0.10 * plan_value_score
                    + 0.08 * price_score
                    + 0.06 * reliability
                    + 0.04 * openclaw_live_compat
                    + 0.02 * evidence_confidence
                    + 0.02 * size_preference["runner"].get(size_class, 0.80)
                ) * local_speed_boost
                + fast_lane_bonus
            ) - role_health_penalties["runner"],
            "research": 0.18 * openclaw + 0.17 * reasoning + 0.15 * writing + 0.12 * weighted_benchmark_support + 0.08 * reliability + 0.08 * price_score + 0.08 * plan_value_score + 0.06 * evidence_confidence + 0.04 * size_preference["research"].get(size_class, 0.80) - role_health_penalties["research"],
            "writer": 0.24 * writing + 0.18 * reasoning + 0.12 * throughput_score + 0.10 * price_score + 0.10 * plan_value_score + 0.08 * weighted_benchmark_support + 0.08 * reliability + 0.05 * evidence_confidence + 0.05 * size_preference["writer"].get(size_class, 0.80) - role_health_penalties["writer"],
            "code": 0.23 * coding + 0.16 * openclaw + 0.12 * reasoning + 0.10 * raw_benchmark_support + 0.09 * openclaw_live_compat + 0.09 * reliability + 0.08 * price_score + 0.06 * plan_value_score + 0.04 * evidence_confidence + 0.03 * size_preference["code"].get(size_class, 0.80) - role_health_penalties["code"],
            "review": 0.21 * coding + 0.17 * reasoning + 0.16 * openclaw + 0.10 * raw_benchmark_support + 0.09 * openclaw_live_compat + 0.09 * reliability + 0.07 * price_score + 0.05 * plan_value_score + 0.03 * evidence_confidence + 0.03 * size_preference["review"].get(size_class, 0.80) - role_health_penalties["review"],
            "inspect": 0.22 * reasoning + 0.16 * coding + 0.15 * openclaw + 0.12 * weighted_benchmark_support + 0.09 * reliability + 0.07 * price_score + 0.06 * evidence_confidence + 0.05 * throughput_score + 0.04 * size_preference["inspect"].get(size_class, 0.80) - role_health_penalties["inspect"],
            "team": 0.19 * reasoning + 0.17 * coding + 0.15 * openclaw + 0.12 * weighted_benchmark_support + 0.10 * reliability + 0.07 * price_score + 0.06 * evidence_confidence + 0.06 * plan_value_score + 0.04 * size_preference["team"].get(size_class, 0.80) - role_health_penalties["team"],
            "main": 0.30 * main_capability_score + 0.18 * coding + 0.16 * reasoning + 0.12 * openclaw + 0.10 * raw_benchmark_support + 0.05 * evidence_confidence + 0.05 * reliability + 0.03 * ttft_score + 0.01 * availability_score - role_health_penalties["main"],
        }
        model["ranking_signal_policy"] = ranking_signal_policy
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
            main_capable_ordered = [item for item in ordered if is_main_capable_model(item[0])]
            candidate_pool = main_capable_ordered or list(ordered)
            candidate_pool_ids = {model["id"] for model, _ in candidate_pool}
            selected_round = 0
            eligible_ordered: list[tuple[dict, dict]] = []
            candidate_rows: list[dict] = []
            for relax_round in range(int(main_selection_cfg.get("max_relax_rounds", 0) or 0) + 1):
                candidate_rows = []
                eligible_ordered = []
                for model, scores in full_ordered:
                    evaluation = evaluate_main_candidate(
                        model_id=model["id"],
                        size_class=str(model.get("size_class", "base") or "base"),
                        main_capable=is_main_capable_model(model),
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
                    if evaluation["eligible"] and model["id"] in candidate_pool_ids:
                        eligible_ordered.append((model, scores))
                if eligible_ordered:
                    selected_round = relax_round
                    break
            if eligible_ordered:
                ordered = eligible_ordered
                main_selection_meta["selection_path"] = "capability_gate"
            else:
                ordered = candidate_pool
                main_selection_meta["selection_path"] = "capability_ranked_fallback" if main_capable_ordered else "ranked_no_main_capable"
            main_selection_meta["relax_round"] = selected_round
            main_selection_meta["candidates"] = candidate_rows
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
        "research": pick("research"),
        "writer": pick("writer"),
        "code": pick("code"),
        "review": pick("review"),
    }
    main_model = pick("main")
    if configured_primary_model:
        preferred_main = next(
            (
                str(model.get("id", "") or "").strip()
                for model in models
                if str(model.get("id", "") or "").strip() == configured_primary_model
            ),
            "",
        )
        if preferred_main:
            main_model = preferred_main
            main_selection_meta["selected_model"] = preferred_main
            main_selection_meta["selection_path"] = "configured_primary"
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
            "collect": pick("research"),
            "inspect": pick("inspect"),
            "report": pick("writer"),
        },
        "octoclaw-code": {
            "implement": pick("code"),
            "verify": pick("review"),
        },
        "octoclaw-review": {
            "verify": pick("review"),
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
            "available_auth_providers": sorted(available_auth_providers),
        },
        "facts_plane": facts_plane,
        "sources": sources,
        "source_policy": load_source_registry(),
    }
    save_json(MODEL_POLICY_FILE, policy)
    return policy


def sync_external_model_intel_sources() -> dict[str, Any]:
    script_path = Path(__file__).with_name("model-intel-sync.mjs")
    env = dict(os.environ)
    env["WORKSPACE"] = WORKSPACE
    path_entries = [entry for entry in str(env.get("PATH", "") or "").split(os.pathsep) if entry]
    for entry in ["/opt/homebrew/bin", "/usr/local/bin"]:
        if entry not in path_entries:
            path_entries.insert(0, entry)
    env["PATH"] = os.pathsep.join(path_entries)
    result = subprocess.run(
        ["node", str(script_path), "refresh"],
        capture_output=True,
        text=True,
        cwd=str(script_path.parent.parent),
        env=env,
        timeout=120,
        check=True,
    )
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description="Build OctoClaw model intelligence files")
    parser.add_argument("command", choices=["refresh", "sync"])
    parser.add_argument("--mode", default="auto")
    args = parser.parse_args()

    sync_result = None
    if args.command == "sync":
        sync_result = sync_external_model_intel_sources()
    catalog = build_catalog()
    policy = compute_policy(catalog, mode=args.mode, config=load_octopus_config())
    print(
        json.dumps(
            {
                "catalog": MODEL_CATALOG_FILE,
                "policy": MODEL_POLICY_FILE,
                "main_model": policy.get("main_model", ""),
                "sync": sync_result,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
