#!/usr/bin/env python3
"""Sync Codex/GPT-5.4 plan state from OmniRoute SQLite.

This first version is heuristic-driven:
- Read OmniRoute SQLite connection state and recent usage.
- Estimate Codex remaining_ratio_estimate conservatively.
- Write back into model-plan-state.json for OctoClaw scoring.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from octopus_config import MODEL_PLAN_STATE_FILE, load_json, save_json

DEFAULT_DB_PATH = "/root/.omniroute/data/storage.sqlite"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def now_iso() -> str:
    return now_utc().strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        return datetime.fromisoformat(value)
    except Exception:
        return None


def load_plan_state() -> dict[str, Any]:
    data = load_json(MODEL_PLAN_STATE_FILE)
    if isinstance(data, dict) and isinstance(data.get("models"), list):
        return data
    payload = {"updated_at": now_iso(), "models": []}
    save_json(MODEL_PLAN_STATE_FILE, payload)
    return payload


def find_codex_entry(plan_state: dict[str, Any]) -> dict[str, Any] | None:
    for entry in plan_state.get("models", []):
        key = str(entry.get("model_key", ""))
        plan_type = str(entry.get("plan_type", ""))
        patterns = entry.get("match_patterns", [])
        if "gpt-5.4" in key or plan_type == "subscription_seat_plan" or any("gpt-5" in str(p) for p in patterns):
            return entry
    return None


def connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def query_rows(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    cur = conn.cursor()
    cur.execute(sql, params)
    return [dict(r) for r in cur.fetchall()]


def estimate_codex_remaining(conn: sqlite3.Connection) -> dict[str, Any]:
    now = now_utc()
    connections = query_rows(
        conn,
        """
        select
          id,
          provider,
          name,
          email,
          is_active,
          rate_limited_until,
          last_error,
          provider_specific_data
        from provider_connections
        where provider = 'codex' and is_active = 1
        """,
    )
    recent_5h = query_rows(
        conn,
        """
        select
          connection_id,
          count(*) as requests_5h,
          sum(case when success = 0 then 1 else 0 end) as failures_5h
        from usage_history
        where provider = 'codex'
          and timestamp >= datetime('now','-5 hours')
        group by connection_id
        """,
    )
    recent_7d = query_rows(
        conn,
        """
        select
          connection_id,
          count(*) as requests_7d
        from usage_history
        where provider = 'codex'
          and timestamp >= datetime('now','-7 days')
        group by connection_id
        """,
    )

    by_5h = {row["connection_id"]: row for row in recent_5h}
    by_7d = {row["connection_id"]: row for row in recent_7d}
    per_connection: list[dict[str, Any]] = []

    for row in connections:
        conn_id = row["id"]
        reqs_5h = int((by_5h.get(conn_id) or {}).get("requests_5h") or 0)
        fails_5h = int((by_5h.get(conn_id) or {}).get("failures_5h") or 0)
        reqs_7d = int((by_7d.get(conn_id) or {}).get("requests_7d") or 0)
        rate_limited_until = parse_dt(row.get("rate_limited_until"))

        ratio = 0.72
        if reqs_5h >= 80:
            ratio -= 0.30
        elif reqs_5h >= 50:
            ratio -= 0.20
        elif reqs_5h >= 25:
            ratio -= 0.10

        if reqs_7d >= 400:
            ratio -= 0.18
        elif reqs_7d >= 250:
            ratio -= 0.10

        if fails_5h >= 3:
            ratio -= 0.20
        elif fails_5h >= 1:
            ratio -= 0.08

        if rate_limited_until and rate_limited_until > now:
            ratio = min(ratio, 0.08)
        elif rate_limited_until and rate_limited_until > now - timedelta(days=1):
            ratio = min(ratio, 0.30)

        ratio = max(0.05, min(0.95, ratio))
        per_connection.append(
            {
                "connection_id": conn_id,
                "account": row.get("email") or row.get("name") or conn_id,
                "requests_5h": reqs_5h,
                "requests_7d": reqs_7d,
                "failures_5h": fails_5h,
                "rate_limited_until": row.get("rate_limited_until"),
                "estimated_remaining_ratio": round(ratio, 3),
            }
        )

    if not per_connection:
        return {
            "remaining_ratio_estimate": 0.5,
            "per_connection": [],
            "method": "omniroute_sqlite_heuristic",
            "notes": ["No active codex connections found in OmniRoute SQLite."],
        }

    best_ratio = max(item["estimated_remaining_ratio"] for item in per_connection)
    return {
        "remaining_ratio_estimate": round(best_ratio, 3),
        "per_connection": per_connection,
        "method": "omniroute_sqlite_heuristic",
        "notes": [
            "Estimated from OmniRoute SQLite active codex connections, recent request volume, failure count, and recent rate-limit state.",
            "This is conservative and should be upgraded to authenticated quota APIs later.",
        ],
    }


def sync(db_path: str) -> dict[str, Any]:
    conn = connect(db_path)
    estimate = estimate_codex_remaining(conn)
    plan_state = load_plan_state()
    entry = find_codex_entry(plan_state)
    if entry is None:
        raise SystemExit("Could not find GPT-5.4/Codex entry in model-plan-state.json")

    entry["remaining_ratio_estimate"] = estimate["remaining_ratio_estimate"]
    entry["sync_source"] = "omniroute_sqlite"
    entry["last_synced_at"] = now_iso()
    entry["sync_details"] = {
        "method": estimate["method"],
        "per_connection": estimate["per_connection"],
        "notes": estimate["notes"],
    }
    plan_state["updated_at"] = now_iso()
    save_json(MODEL_PLAN_STATE_FILE, plan_state)
    return {
        "plan_file": MODEL_PLAN_STATE_FILE,
        "remaining_ratio_estimate": estimate["remaining_ratio_estimate"],
        "per_connection": estimate["per_connection"],
        "method": estimate["method"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync GPT-5.4/Codex remaining ratio from OmniRoute SQLite")
    parser.add_argument("command", choices=["sync"])
    parser.add_argument("--db-path", default=DEFAULT_DB_PATH)
    args = parser.parse_args()

    if not Path(args.db_path).exists():
        raise SystemExit(f"OmniRoute SQLite not found: {args.db_path}")

    result = sync(args.db_path)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
