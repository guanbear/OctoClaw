#!/usr/bin/env python3
"""
budget.py — OctoClaw policy-first budget tracker.

This module no longer estimates cost from legacy task tiers. Instead it tracks
budget pressure from the runtime decision truth we now have:

- selected model
- model band
- worker pool
- route
- phase / protocol

It can still be called from patrol, and it also annotates task-state records
with a compact human-readable `cost_estimate` plus a structured
`artifacts.budget` payload for retrieval and status surfaces.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any

try:
    from model_pricing import estimate_task_cost_usd
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.model_pricing import estimate_task_cost_usd

try:
    from octopus_config import TASK_STATE_FILE, WORKSPACE
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.octopus_config import TASK_STATE_FILE, WORKSPACE

try:
    from runtime_task_record import normalize_task_record
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.runtime_task_record import normalize_task_record


BUDGET_LOG_FILE = f"{WORKSPACE}/tmp/octoclaw-budget.json"
BUDGET_CONFIG_FILE = f"{WORKSPACE}/tmp/octoclaw-budget-config.json"

DEFAULT_TOKENS_BY_MODEL_BAND: dict[str, int] = {
    "fast": 1400,
    "normal": 5200,
    "strong": 9800,
    "heavy": 18000,
}

WORKER_POOL_MULTIPLIER: dict[str, float] = {
    "octoclaw-main": 0.65,
    "octoclaw-runner": 0.35,
    "octoclaw-research": 1.00,
    "octoclaw-code": 1.10,
    "octoclaw-review": 0.90,
}

ROUTE_MULTIPLIER: dict[str, float] = {
    "direct": 0.60,
    "runner": 0.35,
    "spawn_single": 1.00,
    "spawn_multi": 1.20,
}

PHASE_MULTIPLIER: dict[str, float] = {
    "inspect": 0.75,
    "collect": 1.00,
    "report": 1.15,
    "implement": 1.20,
    "verify": 0.90,
}

PROTOCOL_MULTIPLIER: dict[str, float] = {
    "normal": 1.00,
    "heavy": 1.75,
}

FALLBACK_USD_PER_1M_TOKENS_BY_MODEL_KEYWORD: dict[str, float] = {
    "minimax": 0.50,
    "glm-5": 1.20,
    "glm-4.7": 0.28,
    "glm": 0.40,
    "gpt-5.4": 3.40,
    "gpt": 2.00,
    "sonnet": 3.20,
    "opus": 14.00,
}

FALLBACK_USD_PER_1M_TOKENS_BY_MODEL_BAND: dict[str, float] = {
    "fast": 0.45,
    "normal": 0.90,
    "strong": 2.40,
    "heavy": 5.50,
}

DEFAULT_CONFIG = {
    "daily_limit_usd": 5.0,
    "monthly_limit_usd": 50.0,
    "warn_threshold": 0.80,
    "enabled": True,
}


def _load_json(path: str) -> dict[str, Any] | list[Any] | None:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _save_json(path: str, payload: dict[str, Any] | list[Any]) -> bool:
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        temp_path = path + ".tmp"
        with open(temp_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        os.replace(temp_path, path)
        return True
    except OSError as exc:
        print(f"WARNING: budget.py failed to write {path}: {exc}", file=sys.stderr)
        return False


def _load_budget_log(path: str = BUDGET_LOG_FILE) -> dict[str, Any]:
    payload = _load_json(path)
    if not isinstance(payload, dict):
        payload = {}
    payload.setdefault("schema_version", "octoclaw.budget_log/v2")
    payload.setdefault("updated_at", "")
    payload.setdefault("daily", {})
    payload.setdefault("monthly", {})
    payload.setdefault("tasks", [])
    return payload


def _get_config(path: str = BUDGET_CONFIG_FILE) -> dict[str, Any]:
    cfg = _load_json(path)
    if isinstance(cfg, dict):
        merged = dict(DEFAULT_CONFIG)
        merged.update(cfg)
        return merged
    return dict(DEFAULT_CONFIG)


def _text(value: Any) -> str:
    return str(value or "").strip()


def _int_like(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _band(value: str) -> str:
    text = _text(value).lower()
    return text if text in DEFAULT_TOKENS_BY_MODEL_BAND else "normal"


def _cost_keyword(model_id: str) -> str:
    lowered = _text(model_id).lower()
    for keyword in FALLBACK_USD_PER_1M_TOKENS_BY_MODEL_KEYWORD:
        if keyword in lowered:
            return keyword
    return ""


def _estimate_tokens(
    *,
    model_band: str,
    worker_pool: str,
    route: str,
    phase: str,
    protocol: str,
    tokens: int | None = None,
) -> int:
    if tokens and tokens > 0:
        return int(tokens)
    band = _band(model_band)
    estimate = float(DEFAULT_TOKENS_BY_MODEL_BAND.get(band, DEFAULT_TOKENS_BY_MODEL_BAND["normal"]))
    estimate *= WORKER_POOL_MULTIPLIER.get(_text(worker_pool), 1.0)
    estimate *= ROUTE_MULTIPLIER.get(_text(route).lower(), 1.0)
    estimate *= PHASE_MULTIPLIER.get(_text(phase).lower(), 1.0)
    estimate *= PROTOCOL_MULTIPLIER.get(_text(protocol).lower(), 1.0)
    return max(400, int(round(estimate)))


def estimate_cost(
    *,
    model: str,
    model_band: str,
    worker_pool: str,
    route: str,
    phase: str,
    protocol: str,
    tokens: int | None = None,
) -> tuple[float, int]:
    token_estimate = _estimate_tokens(
        model_band=model_band,
        worker_pool=worker_pool,
        route=route,
        phase=phase,
        protocol=protocol,
        tokens=tokens,
    )
    normalized_cost = estimate_task_cost_usd(model, token_estimate)
    if normalized_cost is not None:
        return round(normalized_cost, 6), token_estimate

    keyword = _cost_keyword(model)
    usd_per_1m = FALLBACK_USD_PER_1M_TOKENS_BY_MODEL_KEYWORD.get(
        keyword,
        FALLBACK_USD_PER_1M_TOKENS_BY_MODEL_BAND.get(_band(model_band), 0.90),
    )
    return round((token_estimate / 1_000_000) * usd_per_1m, 6), token_estimate


def _task_record_map(log: dict[str, Any]) -> dict[str, dict[str, Any]]:
    records = log.get("tasks", [])
    if not isinstance(records, list):
        return {}
    result: dict[str, dict[str, Any]] = {}
    for item in records:
        if isinstance(item, dict):
            task_id = _text(item.get("id"))
            if task_id:
                result[task_id] = item
    return result


def _format_cost_estimate(entry: dict[str, Any]) -> str:
    cost = float(entry.get("cost_usd", 0.0) or 0.0)
    band = _text(entry.get("model_band"))
    pool = _text(entry.get("worker_pool"))
    route = _text(entry.get("route"))
    descriptor = "/".join(part for part in (band, pool.replace("octoclaw-", ""), route) if part)
    return f"${cost:.4f}" + (f" · {descriptor}" if descriptor else "")


def record_task(
    task_id: str,
    model: str,
    *,
    model_band: str = "",
    worker_pool: str = "",
    route: str = "",
    phase: str = "",
    protocol: str = "",
    tokens: int | None = None,
    status: str = "",
    path: str = BUDGET_LOG_FILE,
) -> dict[str, Any]:
    log = _load_budget_log(path)
    existing = _task_record_map(log).get(task_id)
    if existing:
        payload = dict(existing)
        payload["already_recorded"] = True
        return payload

    cost_usd, token_estimate = estimate_cost(
        model=model,
        model_band=model_band,
        worker_pool=worker_pool,
        route=route,
        phase=phase,
        protocol=protocol,
        tokens=tokens,
    )
    now = datetime.now(timezone.utc)
    day_key = now.strftime("%Y-%m-%d")
    month_key = now.strftime("%Y-%m")

    log["daily"][day_key] = round(float(log["daily"].get(day_key, 0.0) or 0.0) + cost_usd, 6)
    log["monthly"][month_key] = round(float(log["monthly"].get(month_key, 0.0) or 0.0) + cost_usd, 6)

    entry = {
        "id": task_id,
        "model": _text(model),
        "model_band": _band(model_band),
        "worker_pool": _text(worker_pool),
        "route": _text(route),
        "phase": _text(phase),
        "protocol": _text(protocol) or "normal",
        "status": _text(status),
        "tokens_estimate": int(token_estimate),
        "cost_usd": cost_usd,
        "recorded_at": now.astimezone().isoformat(),
        "already_recorded": False,
    }
    log["tasks"].append(entry)
    if len(log["tasks"]) > 500:
        log["tasks"] = log["tasks"][-500:]
    log["updated_at"] = now.astimezone().isoformat()
    _save_json(path, log)
    return entry


def get_status(*, log_path: str = BUDGET_LOG_FILE, config_path: str = BUDGET_CONFIG_FILE) -> dict[str, Any]:
    cfg = _get_config(config_path)
    log = _load_budget_log(log_path)
    now = datetime.now(timezone.utc)
    day_key = now.strftime("%Y-%m-%d")
    month_key = now.strftime("%Y-%m")

    today_usd = float(log["daily"].get(day_key, 0.0) or 0.0)
    month_usd = float(log["monthly"].get(month_key, 0.0) or 0.0)
    daily_limit = float(cfg["daily_limit_usd"])
    monthly_limit = float(cfg["monthly_limit_usd"])
    warn_pct = float(cfg["warn_threshold"])

    daily_pct = today_usd / daily_limit if daily_limit > 0 else 0.0
    monthly_pct = month_usd / monthly_limit if monthly_limit > 0 else 0.0
    max_pct = max(daily_pct, monthly_pct)

    if not cfg.get("enabled", True):
        alert_level = "disabled"
    elif max_pct >= 1.0:
        alert_level = "over"
    elif max_pct >= warn_pct:
        alert_level = "warn"
    else:
        alert_level = "ok"

    return {
        "today_usd": round(today_usd, 4),
        "month_usd": round(month_usd, 4),
        "daily_limit_usd": daily_limit,
        "monthly_limit_usd": monthly_limit,
        "daily_pct": round(daily_pct * 100, 1),
        "monthly_pct": round(monthly_pct * 100, 1),
        "alert_level": alert_level,
        "warn_threshold_pct": round(warn_pct * 100, 1),
        "enabled": bool(cfg.get("enabled", True)),
        "tracked_tasks": len(log.get("tasks", [])) if isinstance(log.get("tasks", []), list) else 0,
    }


def check_budget(*, log_path: str = BUDGET_LOG_FILE, config_path: str = BUDGET_CONFIG_FILE) -> tuple[int, str]:
    status = get_status(log_path=log_path, config_path=config_path)
    level = status["alert_level"]
    today = status["today_usd"]
    dlimit = status["daily_limit_usd"]
    month = status["month_usd"]
    mlimit = status["monthly_limit_usd"]

    if level == "disabled":
        return 3, "OctoClaw budget tracking disabled"
    if level == "over":
        return 2, (
            f"Budget over limit. Today: ${today:.3f}/${dlimit} ({status['daily_pct']}%), "
            f"Month: ${month:.3f}/${mlimit} ({status['monthly_pct']}%)"
        )
    if level == "warn":
        return 1, (
            f"Budget warning. Today: ${today:.3f}/${dlimit} ({status['daily_pct']}%), "
            f"Month: ${month:.3f}/${mlimit} ({status['monthly_pct']}%)"
        )
    return 0, (
        f"Budget healthy. Today ${today:.3f}/${dlimit} ({status['daily_pct']}%), "
        f"Month ${month:.3f}/${mlimit} ({status['monthly_pct']}%)"
    )


def _load_task_container(path: str = TASK_STATE_FILE) -> tuple[str, Any, list[dict[str, Any]]]:
    payload = _load_json(path)
    if isinstance(payload, dict) and isinstance(payload.get("tasks"), list):
        tasks = [item for item in payload.get("tasks", []) if isinstance(item, dict)]
        return "state", payload, tasks
    if isinstance(payload, dict) and "id" in payload:
        return "single", payload, [payload]
    if isinstance(payload, dict):
        values = [item for item in payload.values() if isinstance(item, dict)]
        return "keyed", payload, values
    if isinstance(payload, list):
        tasks = [item for item in payload if isinstance(item, dict)]
        return "list", payload, tasks
    return "", None, []


def _save_task_container(kind: str, container: Any, tasks: list[dict[str, Any]], path: str = TASK_STATE_FILE) -> None:
    if kind == "state" and isinstance(container, dict):
        container["tasks"] = tasks
        _save_json(path, container)
        return
    if kind == "single" and isinstance(container, dict):
        _save_json(path, tasks[0] if tasks else container)
        return
    if kind == "keyed" and isinstance(container, dict):
        rebuilt = dict(container)
        rebuilt.clear()
        for item in tasks:
            task_id = _text(item.get("id"))
            rebuilt[task_id or f"task-{len(rebuilt)+1}"] = item
        _save_json(path, rebuilt)
        return
    if kind == "list":
        _save_json(path, tasks)


def _is_budget_trackable(task: dict[str, Any]) -> bool:
    normalized = normalize_task_record(task)
    lifecycle_state = _text(normalized.get("lifecycle_state")).lower()
    outcome_state = _text(normalized.get("outcome_state")).lower()
    if lifecycle_state not in {"finished", "cancelled"}:
        return False
    return outcome_state in {"done", "failed", "blocked", "partial"}


def _annotate_task_with_budget(task: dict[str, Any], entry: dict[str, Any]) -> dict[str, Any]:
    task["cost_estimate"] = _format_cost_estimate(entry)
    artifacts = task.get("artifacts") if isinstance(task.get("artifacts"), dict) else {}
    budget_artifact = {
        "model": _text(entry.get("model")),
        "model_band": _text(entry.get("model_band")),
        "worker_pool": _text(entry.get("worker_pool")),
        "route": _text(entry.get("route")),
        "phase": _text(entry.get("phase")),
        "protocol": _text(entry.get("protocol")) or "normal",
        "status": _text(entry.get("status")),
        "tokens_estimate": int(entry.get("tokens_estimate", 0) or 0),
        "cost_usd": float(entry.get("cost_usd", 0.0) or 0.0),
        "recorded_at": _text(entry.get("recorded_at")),
    }
    artifacts["budget"] = budget_artifact
    task["artifacts"] = artifacts
    return task


def sync_from_task_state(*, state_path: str = TASK_STATE_FILE, log_path: str = BUDGET_LOG_FILE) -> int:
    kind, container, tasks = _load_task_container(state_path)
    if not tasks:
        return 0

    synced = 0
    changed = False
    for task in tasks:
        if not isinstance(task, dict) or not _is_budget_trackable(task):
            continue
        normalized = normalize_task_record(task)
        task_id = _text(normalized.get("id"))
        model = _text(normalized.get("model"))
        if not task_id or not model:
            continue
        existing_budget = (
            (task.get("artifacts") or {}) if isinstance(task.get("artifacts"), dict) else {}
        ).get("budget")
        entry = record_task(
            task_id,
            model,
            model_band=_text(normalized.get("model_band")),
            worker_pool=_text(normalized.get("worker_pool")),
            route=_text(normalized.get("route")),
            phase=_text(normalized.get("phase")),
            protocol=_text(normalized.get("protocol")) or "normal",
            tokens=_int_like(((existing_budget or {}) if isinstance(existing_budget, dict) else {}).get("tokens_estimate")),
            status=_text(normalized.get("status")),
            path=log_path,
        )
        if not entry.get("already_recorded"):
            synced += 1
        before = _text(task.get("cost_estimate"))
        _annotate_task_with_budget(task, entry)
        if before != _text(task.get("cost_estimate")) or not isinstance(existing_budget, dict):
            changed = True

    if changed and kind:
        _save_task_container(kind, container, tasks, state_path)
    return synced


def main() -> None:
    parser = argparse.ArgumentParser(description="OctoClaw budget tracker")
    subparsers = parser.add_subparsers(dest="cmd")

    subparsers.add_parser("status", help="show current budget status")
    subparsers.add_parser("check", help="check budget (exit 0=ok, 1=warn, 2=over)")
    subparsers.add_parser("sync", help="sync finished tasks from task-state")
    subparsers.add_parser("reset", help="reset today's budget usage")

    rec_parser = subparsers.add_parser("record", help="record a single task cost")
    rec_parser.add_argument("--task-id", required=True, help="task id")
    rec_parser.add_argument("--model", required=True, help="selected model id")
    rec_parser.add_argument("--model-band", default="normal", choices=["fast", "normal", "strong", "heavy"])
    rec_parser.add_argument("--worker-pool", default="")
    rec_parser.add_argument("--route", default="")
    rec_parser.add_argument("--phase", default="")
    rec_parser.add_argument("--protocol", default="normal")
    rec_parser.add_argument("--status", default="")
    rec_parser.add_argument("--tokens", type=int, default=0, help="actual token count if known")

    args = parser.parse_args()

    if args.cmd == "status":
        print(json.dumps(get_status(), ensure_ascii=False, indent=2))
        return

    if args.cmd == "check":
        code, message = check_budget()
        print(message)
        sys.exit(code)

    if args.cmd == "sync":
        count = sync_from_task_state()
        print(f"ok synced={count}")
        return

    if args.cmd == "record":
        tokens = args.tokens if args.tokens > 0 else None
        entry = record_task(
            args.task_id,
            args.model,
            model_band=args.model_band,
            worker_pool=args.worker_pool,
            route=args.route,
            phase=args.phase,
            protocol=args.protocol,
            status=args.status,
            tokens=tokens,
        )
        if entry.get("already_recorded"):
            print(f"skip existing task={args.task_id}")
        else:
            print(f"ok task={args.task_id} cost=${float(entry['cost_usd']):.6f}")
        return

    if args.cmd == "reset":
        log = _load_budget_log()
        day_key = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if day_key in log["daily"]:
            del log["daily"][day_key]
        _save_json(BUDGET_LOG_FILE, log)
        print(f"ok reset_day={day_key}")
        return

    parser.print_help()


if __name__ == "__main__":
    main()
