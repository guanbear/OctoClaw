#!/usr/bin/env python3
"""Normalize local speed metrics for Octopus auto routing."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone

from octopus_config import MODEL_SPEED_FILE, load_json, save_json

IRONCLAW_LATENCY_FILE = "/tmp/ironclaw-model-latency.json"


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_latency_models() -> dict:
    data = load_json(IRONCLAW_LATENCY_FILE)
    if isinstance(data, dict) and isinstance(data.get("models"), dict):
        return data["models"]
    return {}


def build_speed_file() -> dict:
    latency_models = load_latency_models()
    existing = load_json(MODEL_SPEED_FILE)
    if not isinstance(existing, dict):
        existing = {"generated_at": "", "models": {}}
    models = existing.get("models", {})
    if not isinstance(models, dict):
        models = {}

    for model_id, info in latency_models.items():
        if not isinstance(info, dict):
            continue
        current = models.get(model_id, {})
        current["ttft_ms"] = info.get("ttft_ms", info.get("latency_ms", current.get("ttft_ms", 0)))
        if "output_tps" in info:
            current["output_tps"] = info["output_tps"]
        elif "tokens_per_second" in info:
            current["output_tps"] = info["tokens_per_second"]
        current["error_rate"] = info.get("error_rate", current.get("error_rate", 0.0))
        current["available"] = info.get("available", current.get("available", True))
        current["source"] = "ironclaw-latency"
        current["updated_at"] = now_iso()
        models[model_id] = current

    payload = {"generated_at": now_iso(), "models": models}
    save_json(MODEL_SPEED_FILE, payload)
    return payload


def set_override(model_id: str, ttft_ms: float | None, output_tps: float | None, error_rate: float | None):
    payload = build_speed_file()
    models = payload.setdefault("models", {})
    current = models.get(model_id, {})
    if ttft_ms is not None:
        current["ttft_ms"] = ttft_ms
    if output_tps is not None:
        current["output_tps"] = output_tps
    if error_rate is not None:
        current["error_rate"] = error_rate
    current["source"] = "manual-override"
    current["updated_at"] = now_iso()
    models[model_id] = current
    payload["generated_at"] = now_iso()
    save_json(MODEL_SPEED_FILE, payload)


def main():
    parser = argparse.ArgumentParser(description="Sync Octopus local speed metrics")
    parser.add_argument("command", choices=["sync", "set"])
    parser.add_argument("--model")
    parser.add_argument("--ttft-ms", type=float)
    parser.add_argument("--output-tps", type=float)
    parser.add_argument("--error-rate", type=float)
    args = parser.parse_args()

    if args.command == "sync":
        payload = build_speed_file()
        print(json.dumps({"file": MODEL_SPEED_FILE, "count": len(payload.get("models", {}))}, ensure_ascii=False))
        return

    if not args.model:
        parser.error("--model is required for set")
    set_override(args.model, args.ttft_ms, args.output_tps, args.error_rate)
    print(json.dumps({"file": MODEL_SPEED_FILE, "model": args.model, "status": "updated"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
