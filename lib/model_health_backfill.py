#!/usr/bin/env python3
"""Backfill OctoClaw model health from OpenClaw model_fallback_decision logs."""

from __future__ import annotations

import argparse
import json
import os
import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from model_health import now_iso
from octopus_config import MODEL_HEALTH_FILE, load_json, save_json


DEFAULT_OPENCLAW_HOME = Path(os.environ.get("OPENCLAW_HOME") or Path.home() / ".openclaw").expanduser()
DEFAULT_LOG_DIR = DEFAULT_OPENCLAW_HOME / "logs"
DEFAULT_LOOKBACK_HOURS = 24
DEFAULT_MAX_FILES = 7
DEFAULT_REFRESH_STALE_AFTER_SECONDS = 120

PLAINTEXT_FALLBACK_PATTERN = re.compile(
    r"^(?P<time>\S+)\s+\[model-fallback/decision\]\s+model fallback decision:\s+"
    r"decision=(?P<decision>\S+)\s+requested=(?P<requested>\S+)\s+candidate=(?P<candidate>\S+)\s+"
    r"reason=(?P<reason>\S+)\s+next=(?P<next>\S+)",
    re.IGNORECASE,
)


def parse_timestamp(raw: str | None) -> datetime | None:
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def discover_log_files(
    *,
    log_file: str = "",
    log_dir: str = "",
    max_files: int = DEFAULT_MAX_FILES,
) -> list[Path]:
    if log_file:
        path = Path(log_file).expanduser().resolve()
        return [path] if path.exists() else []

    directory = Path(log_dir).expanduser().resolve() if log_dir else DEFAULT_LOG_DIR.resolve()
    if not directory.exists():
        return []

    seen: set[Path] = set()
    candidates: list[Path] = []
    for pattern in ("openclaw*.log*", "gateway*.log*"):
        for path in directory.glob(pattern):
            if not path.is_file() or path in seen:
                continue
            seen.add(path)
            candidates.append(path)
    candidates.sort(key=lambda item: item.stat().st_mtime, reverse=True)
    return candidates[: max(1, int(max_files or DEFAULT_MAX_FILES))]


def _maybe_decision_payload(record: dict[str, Any]) -> dict[str, Any] | None:
    if str(record.get("event", "") or "").strip() == "model_fallback_decision":
        return record
    for value in record.values():
        if isinstance(value, dict) and str(value.get("event", "") or "").strip() == "model_fallback_decision":
            return value
    return None


def _split_model_id(raw: str | None) -> tuple[str, str]:
    text = str(raw or "").strip()
    if "/" not in text:
        return "", text
    provider, model = text.split("/", 1)
    return provider.strip(), model.strip()


def extract_fallback_event(record: dict[str, Any]) -> dict[str, Any] | None:
    payload = _maybe_decision_payload(record)
    if not isinstance(payload, dict):
        return None
    provider = str(payload.get("candidateProvider", "") or "").strip()
    model = str(payload.get("candidateModel", "") or "").strip()
    if not provider or not model:
        return None
    return {
        "time": record.get("time")
        or payload.get("time")
        or (record.get("_meta", {}) or {}).get("date")
        or "",
        "decision": str(payload.get("decision", "") or "").strip().lower(),
        "reason": str(payload.get("reason", "") or "").strip().lower(),
        "status": payload.get("status"),
        "code": str(payload.get("code", "") or "").strip().lower(),
        "candidate_provider": provider,
        "candidate_model": model,
        "model_id": f"{provider}/{model}",
        "next_candidate_provider": str(payload.get("nextCandidateProvider", "") or "").strip(),
        "next_candidate_model": str(payload.get("nextCandidateModel", "") or "").strip(),
        "allow_transient_cooldown_probe": bool(payload.get("allowTransientCooldownProbe")),
        "raw": payload,
    }


def extract_plaintext_fallback_event(line: str) -> dict[str, Any] | None:
    match = PLAINTEXT_FALLBACK_PATTERN.search(str(line or "").strip())
    if not match:
        return None
    provider, model = _split_model_id(match.group("candidate"))
    if not provider or not model:
        return None
    next_provider, next_model = _split_model_id(match.group("next"))
    return {
        "time": match.group("time"),
        "decision": str(match.group("decision") or "").strip().lower(),
        "reason": str(match.group("reason") or "").strip().lower(),
        "status": None,
        "code": "",
        "candidate_provider": provider,
        "candidate_model": model,
        "model_id": f"{provider}/{model}",
        "next_candidate_provider": next_provider,
        "next_candidate_model": next_model,
        "allow_transient_cooldown_probe": False,
        "raw": {
            "decision": match.group("decision"),
            "requested": match.group("requested"),
            "candidate": match.group("candidate"),
            "reason": match.group("reason"),
            "next": match.group("next"),
            "source": "plaintext_gateway_log",
        },
    }


def load_fallback_events(
    *,
    log_file: str = "",
    log_dir: str = "",
    lookback_hours: int = DEFAULT_LOOKBACK_HOURS,
    max_files: int = DEFAULT_MAX_FILES,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    files = discover_log_files(log_file=log_file, log_dir=log_dir, max_files=max_files)
    if not files:
        return [], {"files": [], "missing": True}

    explicit_log_file = bool(str(log_file or "").strip())
    cutoff = None if explicit_log_file else (
        datetime.now(timezone.utc) - timedelta(hours=max(1, int(lookback_hours or DEFAULT_LOOKBACK_HOURS)))
    )
    events: list[dict[str, Any]] = []
    invalid_lines = 0
    scanned_lines = 0

    for path in files:
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line in lines:
            text = line.strip()
            if not text:
                continue
            scanned_lines += 1
            try:
                record = json.loads(text)
            except json.JSONDecodeError:
                event = extract_plaintext_fallback_event(text)
                if not event:
                    invalid_lines += 1
                    continue
                timestamp = parse_timestamp(str(event.get("time", "") or ""))
                if cutoff is not None and timestamp and timestamp < cutoff:
                    continue
                events.append(event)
                continue
            if not isinstance(record, dict):
                invalid_lines += 1
                continue
            event = extract_fallback_event(record)
            if not event:
                continue
            timestamp = parse_timestamp(str(event.get("time", "") or ""))
            if cutoff is not None and timestamp and timestamp < cutoff:
                continue
            events.append(event)

    meta = {
        "files": [str(path) for path in files],
        "missing": False,
        "scanned_lines": scanned_lines,
        "invalid_lines": invalid_lines,
        "explicit_log_file": explicit_log_file,
        "lookback_hours": int(lookback_hours or DEFAULT_LOOKBACK_HOURS),
        "cutoff": cutoff.strftime("%Y-%m-%dT%H:%M:%SZ") if cutoff is not None else "",
    }
    return events, meta


def classify_failure(event: dict[str, Any]) -> str:
    reason = str(event.get("reason", "") or "").strip().lower()
    code = str(event.get("code", "") or "").strip().lower()
    status = event.get("status")
    try:
        status_code = int(status) if status is not None else 0
    except (TypeError, ValueError):
        status_code = 0

    if status_code == 429 or "rate_limit" in reason or "rate" in code:
        return "rate_limit"
    if status_code in {408, 504} or reason in {"timeout", "overloaded"} or "timeout" in code:
        return "timeout"
    return "failover"


def _reset_backfill_managed_counts(entry: dict[str, Any]) -> None:
    for key in ("recent_429_count", "recent_timeout_count", "recent_failover_count", "recent_success_count"):
        entry[key] = 0
    if entry.get("fallback_log_backfill"):
        entry["last_error_reason"] = ""


def apply_fallback_events_to_health(
    events: list[dict[str, Any]],
    *,
    output_path: str = MODEL_HEALTH_FILE,
    source_meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = load_json(output_path)
    if not isinstance(payload, dict):
        payload = {}
    models = payload.setdefault("models", {})
    if not isinstance(models, dict):
        models = {}
        payload["models"] = models

    for entry in models.values():
        if isinstance(entry, dict) and entry.get("fallback_log_backfill"):
            _reset_backfill_managed_counts(entry)

    counters: dict[str, Counter[str]] = defaultdict(Counter)
    last_errors: dict[str, str] = {}
    last_degraded_at: dict[str, str] = {}
    last_seen_at: dict[str, str] = {}

    for event in events:
        model_id = str(event.get("model_id", "") or "").strip()
        if not model_id:
            continue
        decision = str(event.get("decision", "") or "").strip().lower()
        event_time = str(event.get("time", "") or "").strip()
        if decision == "candidate_succeeded":
            counters[model_id]["recent_success_count"] += 1
        elif decision == "candidate_failed":
            kind = classify_failure(event)
            if kind == "rate_limit":
                counters[model_id]["recent_429_count"] += 1
            elif kind == "timeout":
                counters[model_id]["recent_timeout_count"] += 1
            else:
                counters[model_id]["recent_failover_count"] += 1
            last_errors[model_id] = kind
            if event_time:
                last_degraded_at[model_id] = event_time
        if event_time:
            last_seen_at[model_id] = event_time

    for model_id, counter in counters.items():
        entry = models.setdefault(model_id, {})
        if not isinstance(entry, dict):
            entry = {}
            models[model_id] = entry
        _reset_backfill_managed_counts(entry)
        for key in ("recent_429_count", "recent_timeout_count", "recent_failover_count", "recent_success_count"):
            entry[key] = int(counter.get(key, 0))
        entry["fallback_log_backfill"] = {
            "updated_at": now_iso(),
            "recent_event_count": int(sum(counter.values())),
            "last_seen_at": last_seen_at.get(model_id, ""),
        }
        if model_id in last_errors:
            entry["last_error_reason"] = last_errors[model_id]
        if model_id in last_degraded_at:
            entry["last_degraded_at"] = last_degraded_at[model_id]

    payload["generated_at"] = now_iso()
    payload["sources"] = payload.get("sources", {}) if isinstance(payload.get("sources"), dict) else {}
    payload["sources"]["model_fallback_log_backfill"] = {
        "updated_at": payload["generated_at"],
        "event_count": len(events),
        **(source_meta or {}),
    }
    save_json(output_path, payload)
    return payload


def _feedback_updated_at(payload: dict[str, Any]) -> datetime | None:
    if not isinstance(payload, dict):
        return None
    sources = payload.get("sources", {}) if isinstance(payload.get("sources"), dict) else {}
    source = sources.get("model_fallback_log_backfill", {}) if isinstance(sources.get("model_fallback_log_backfill"), dict) else {}
    return (
        parse_timestamp(str(source.get("updated_at", "") or ""))
        or parse_timestamp(str(payload.get("generated_at", "") or ""))
    )


def refresh_model_health_feedback_if_stale(
    *,
    feedback_cfg: dict[str, Any] | None = None,
    health_file: str = MODEL_HEALTH_FILE,
    now: datetime | None = None,
) -> dict[str, Any]:
    cfg = feedback_cfg if isinstance(feedback_cfg, dict) else {}
    if not bool(cfg.get("enabled", False)):
        return {"enabled": False, "refreshed": False, "reason": "disabled"}

    log_file = str(cfg.get("log_file", "") or "").strip()
    log_dir = str(cfg.get("log_dir", "") or "").strip()
    if not log_file and not log_dir:
        return {"enabled": True, "refreshed": False, "reason": "missing_log_target"}

    stale_after_seconds = max(0, int(cfg.get("stale_after_seconds", DEFAULT_REFRESH_STALE_AFTER_SECONDS) or DEFAULT_REFRESH_STALE_AFTER_SECONDS))
    current = now or datetime.now(timezone.utc)
    existing_payload = load_json(health_file)
    updated_at = _feedback_updated_at(existing_payload if isinstance(existing_payload, dict) else {})
    if updated_at is not None and stale_after_seconds > 0:
        age_seconds = max(0, int((current - updated_at).total_seconds()))
        if age_seconds < stale_after_seconds:
            return {
                "enabled": True,
                "refreshed": False,
                "reason": "fresh",
                "updated_at": updated_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "age_seconds": age_seconds,
            }

    result = run_backfill(
        log_file=log_file,
        log_dir=log_dir,
        health_file=health_file,
        lookback_hours=int(cfg.get("lookback_hours", DEFAULT_LOOKBACK_HOURS) or DEFAULT_LOOKBACK_HOURS),
        max_files=int(cfg.get("max_files", DEFAULT_MAX_FILES) or DEFAULT_MAX_FILES),
    )
    return {
        "enabled": True,
        "refreshed": not bool(result.get("skipped")),
        "reason": str(result.get("reason", "") or ""),
        "result": result,
    }


def run_backfill(
    *,
    log_file: str = "",
    log_dir: str = "",
    health_file: str = MODEL_HEALTH_FILE,
    lookback_hours: int = DEFAULT_LOOKBACK_HOURS,
    max_files: int = DEFAULT_MAX_FILES,
) -> dict[str, Any]:
    target_health_file = health_file or MODEL_HEALTH_FILE
    events, meta = load_fallback_events(
        log_file=log_file,
        log_dir=log_dir,
        lookback_hours=lookback_hours,
        max_files=max_files,
    )
    if meta.get("missing"):
        return {
            "skipped": True,
            "reason": "openclaw_log_missing",
            "health_file": str(Path(target_health_file).expanduser().resolve()),
            "event_count": 0,
            **meta,
        }
    payload = apply_fallback_events_to_health(events, output_path=target_health_file, source_meta=meta)
    by_model = {
        model_id: {
            "recent_429_count": int((entry or {}).get("recent_429_count", 0) or 0),
            "recent_timeout_count": int((entry or {}).get("recent_timeout_count", 0) or 0),
            "recent_failover_count": int((entry or {}).get("recent_failover_count", 0) or 0),
            "recent_success_count": int((entry or {}).get("recent_success_count", 0) or 0),
        }
        for model_id, entry in sorted((payload.get("models", {}) or {}).items())
        if isinstance(entry, dict) and entry.get("fallback_log_backfill")
    }
    return {
        "skipped": False,
        "reason": "",
        "health_file": str(Path(target_health_file).expanduser().resolve()),
        "event_count": len(events),
        "models_updated": len(by_model),
        "by_model": by_model,
        **meta,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Backfill OctoClaw model-health from OpenClaw fallback logs")
    parser.add_argument("--log-file", default="")
    parser.add_argument("--log-dir", default="")
    parser.add_argument("--health-file", default=MODEL_HEALTH_FILE)
    parser.add_argument("--lookback-hours", type=int, default=DEFAULT_LOOKBACK_HOURS)
    parser.add_argument("--max-files", type=int, default=DEFAULT_MAX_FILES)
    parser.add_argument("--format", choices=("text", "json"), default="text")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    result = run_backfill(
        log_file=args.log_file,
        log_dir=args.log_dir,
        health_file=args.health_file,
        lookback_hours=args.lookback_hours,
        max_files=args.max_files,
    )
    if args.format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        if result.get("skipped"):
            print(f"Model health backfill skipped: {result.get('reason')}")
        else:
            print(
                "OctoClaw Model Health Backfill\n"
                f"- events: {result.get('event_count')}\n"
                f"- models_updated: {result.get('models_updated')}\n"
                f"- health_file: {result.get('health_file')}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
