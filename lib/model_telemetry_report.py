#!/usr/bin/env python3
"""Render a compact local model telemetry comparison report for runner workflows."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

from octopus_config import MODEL_BENCHMARKS_FILE, MODEL_HEALTH_FILE, MODEL_POLICY_FILE, MODEL_SPEED_FILE, load_json


MODEL_REFERENCE_REGEX = re.compile(
    r"(?:[a-z0-9_.-]+/[a-z0-9_.-]+|(?:gpt|glm|minimax|claude|qwen|kimi|deepseek|gemini|sonnet|opus)[-a-z0-9_.]*)",
    re.IGNORECASE,
)


def normalize_text(text: str) -> str:
    return " ".join(str(text or "").lower().split())


def model_aliases(model_id: str) -> set[str]:
    text = str(model_id or "").strip().lower()
    if not text:
        return set()
    aliases = {text, text.replace("_", "-")}
    if "/" in text:
        short = text.split("/", 1)[1]
        aliases.add(short)
        aliases.add(short.replace("_", "-"))
    return {alias for alias in aliases if len(alias) >= 5}


def load_benchmark_models() -> dict[str, Any]:
    payload = load_json(MODEL_BENCHMARKS_FILE)
    models = payload.get("models", {}) if isinstance(payload, dict) else {}
    if isinstance(models, dict) and models:
        return models
    seed_file = Path(__file__).with_name("model-benchmarks.json")
    try:
        seed_payload = json.loads(seed_file.read_text(encoding="utf-8"))
    except Exception:
        return {}
    seed_models = seed_payload.get("models", {}) if isinstance(seed_payload, dict) else {}
    return seed_models if isinstance(seed_models, dict) else {}


def known_models() -> dict[str, dict[str, Any]]:
    speed = load_json(MODEL_SPEED_FILE)
    health_payload = load_json(MODEL_HEALTH_FILE)
    health = health_payload.get("models", {}) if isinstance(health_payload, dict) else {}
    policy = load_json(MODEL_POLICY_FILE)
    benchmarks = load_benchmark_models()

    model_ids: set[str] = set()
    if isinstance(speed, dict):
        model_ids.update(str(key) for key in speed.keys())
    if isinstance(health, dict):
        model_ids.update(str(key) for key in health.keys())
    if isinstance(benchmarks, dict):
        model_ids.update(str(key) for key in benchmarks.keys())
    if isinstance(policy, dict):
        model_ids.update(str(key) for key in (policy.get("worker_pools", {}) or {}).values() if str(key or "").strip())
        model_ids.update(str(key) for key in (policy.get("family_routing", {}) or {}).keys())
        main_model = str(policy.get("main_model", "") or "").strip()
        if main_model:
            model_ids.add(main_model)

    merged: dict[str, dict[str, Any]] = {}
    for model_id in sorted(model_ids):
        merged[model_id] = {
            "speed": (speed or {}).get(model_id, {}) if isinstance(speed, dict) else {},
            "health": (health or {}).get(model_id, {}) if isinstance(health, dict) else {},
            "benchmark": (benchmarks or {}).get(model_id, {}) if isinstance(benchmarks, dict) else {},
        }
    return merged


def extract_requested_models(task: str, catalog: dict[str, dict[str, Any]]) -> list[str]:
    normalized = normalize_text(task)
    direct_refs = {str(value or "").strip().lower() for value in MODEL_REFERENCE_REGEX.findall(normalized)}
    matched: list[str] = []
    for model_id in sorted(catalog):
        aliases = model_aliases(model_id)
        if not aliases:
            continue
        if any(alias in normalized for alias in aliases) or any(ref in aliases for ref in direct_refs):
            matched.append(model_id)
    return matched


def _format_ms(value: Any) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "n/a"
    if number <= 0:
        return "n/a"
    return f"{number:.0f} ms"


def _format_tps(value: Any) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "n/a"
    if number <= 0:
        return "n/a"
    return f"{number:.1f} tok/s"


def build_model_record(model_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    speed = payload.get("speed", {}) if isinstance(payload.get("speed"), dict) else {}
    health = payload.get("health", {}) if isinstance(payload.get("health"), dict) else {}
    benchmark = payload.get("benchmark", {}) if isinstance(payload.get("benchmark"), dict) else {}
    ttft_ms = speed.get("ttft_ms", health.get("first_token_p50_ms", 0))
    output_tps = speed.get("output_tps", 0)
    return {
        "model_id": model_id,
        "ttft_ms": ttft_ms,
        "output_tps": output_tps,
        "health_state": str(health.get("state", "unknown") or "unknown"),
        "last_error_reason": str(health.get("last_error_reason", "") or ""),
        "recent_timeout_count": int(health.get("recent_timeout_count", 0) or 0),
        "recent_failover_count": int(health.get("recent_failover_count", 0) or 0),
        "recent_429_count": int(health.get("recent_429_count", 0) or 0),
        "recent_success_count": int(health.get("recent_success_count", 0) or 0),
        "last_degraded_at": str(health.get("last_degraded_at", "") or ""),
        "last_seen_at": str(((health.get("fallback_log_backfill", {}) or {}).get("last_seen_at", "")) or ""),
        "pinchbench": float(((benchmark.get("benchmark_scores", {}) or {}).get("pinchbench", 0.0)) or 0.0),
    }


def render_report(task: str) -> str:
    catalog = known_models()
    requested = extract_requested_models(task, catalog)
    if not requested:
        known = ", ".join(f"`{model_id}`" for model_id in list(sorted(catalog))[:8])
        return (
            "# Model Telemetry Report\n\n"
            f"- Task: `{task}`\n"
            "- No requested model ids matched the local catalog.\n"
            f"- Known examples: {known or '(none)'}\n"
            "- This workflow reads local telemetry and health snapshots; it does not start a live benchmark request.\n"
        )

    records = [build_model_record(model_id, catalog.get(model_id, {})) for model_id in requested]
    ttft_candidates = [record for record in records if str(_format_ms(record["ttft_ms"])) != "n/a"]
    throughput_candidates = [record for record in records if str(_format_tps(record["output_tps"])) != "n/a"]
    fastest_ttft = min(ttft_candidates, key=lambda item: float(item["ttft_ms"])) if ttft_candidates else None
    fastest_tps = max(throughput_candidates, key=lambda item: float(item["output_tps"])) if throughput_candidates else None
    risky = [record for record in records if record["health_state"] in {"degraded", "cooldown"} or record["recent_failover_count"] > 0]

    requested_labels = ", ".join(f"`{record['model_id']}`" for record in records)
    lines = [
        "# Model Telemetry Report",
        "",
        f"- Task: `{task}`",
        f"- Requested models: {requested_labels}",
        "- Mode: local telemetry / health snapshot inspection (workflow-first, no live benchmark request)",
    ]
    if fastest_ttft:
        lines.append(f"- Fastest TTFT snapshot: `{fastest_ttft['model_id']}` · {_format_ms(fastest_ttft['ttft_ms'])}")
    else:
        lines.append("- Fastest TTFT snapshot: unavailable")
    if fastest_tps:
        lines.append(f"- Highest throughput snapshot: `{fastest_tps['model_id']}` · {_format_tps(fastest_tps['output_tps'])}")
    else:
        lines.append("- Highest throughput snapshot: unavailable")
    if risky:
        lines.append("- Health watch: " + ", ".join(
            f"`{record['model_id']}`({record['health_state'] or 'unknown'}:{record['last_error_reason'] or 'no-reason'})"
            for record in risky
        ))
    else:
        lines.append("- Health watch: none")

    lines.extend(["", "## Per Model", ""])
    for record in records:
        lines.extend(
            [
                f"### {record['model_id']}",
                f"- TTFT snapshot: {_format_ms(record['ttft_ms'])}",
                f"- Throughput snapshot: {_format_tps(record['output_tps'])}",
                f"- Health state: `{record['health_state']}`",
                f"- Last error: `{record['last_error_reason'] or 'none'}`",
                (
                    "- Recent failures: "
                    f"timeout={record['recent_timeout_count']} / failover={record['recent_failover_count']} / rate_limit={record['recent_429_count']}"
                ),
                f"- Recent successes: {record['recent_success_count']}",
                f"- Last degraded at: `{record['last_degraded_at'] or 'n/a'}`",
                f"- Last seen in fallback log: `{record['last_seen_at'] or 'n/a'}`",
                f"- PinchBench support: {record['pinchbench']:.2f}" if record['pinchbench'] > 0 else "- PinchBench support: n/a",
                "",
            ]
        )
    return "\n".join(lines).rstrip() + "\n"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Render a local model telemetry comparison report")
    parser.add_argument("--task", required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    print(render_report(args.task))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
