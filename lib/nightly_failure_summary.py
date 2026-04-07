#!/usr/bin/env python3
"""Render an analysis-only summary for failed OctoClaw tasks."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

try:
    from octopus_config import TASK_STATE_FILE
except ModuleNotFoundError:  # pragma: no cover
    from lib.octopus_config import TASK_STATE_FILE


FAILURE_STATUSES = {"failed", "timeout", "cancelled", "canceled", "error"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Summarize failed OctoClaw tasks for nightly analysis")
    parser.add_argument("--task-state", default=TASK_STATE_FILE)
    parser.add_argument("--day", required=True, help="Local day in YYYY-MM-DD")
    parser.add_argument("--timezone", default="Asia/Shanghai")
    parser.add_argument("--output", default="")
    parser.add_argument("--json-output", default="")
    return parser.parse_args()


def _parse_iso(value: str) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        if raw.endswith("Z"):
            return datetime.fromisoformat(raw.replace("Z", "+00:00"))
        parsed = datetime.fromisoformat(raw)
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed
    except ValueError:
        return None


def _task_local_timestamp(task: dict[str, Any], tz: ZoneInfo) -> datetime | None:
    for key in ("completed_at", "timed_out_at", "updated_at", "started_at", "spawned_at", "created_at"):
        parsed = _parse_iso(str(task.get(key, "") or ""))
        if parsed is not None:
            return parsed.astimezone(tz)
    return None


def _day_bounds(day: str, timezone_name: str) -> tuple[datetime, datetime]:
    tz = ZoneInfo(timezone_name)
    start = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=tz)
    end = start + timedelta(days=1)
    return start, end


def _load_task_rows(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    tasks = payload.get("tasks", []) if isinstance(payload, dict) else []
    return [row for row in tasks if isinstance(row, dict)]


def summarize_failures(task_rows: list[dict[str, Any]], *, day: str, timezone_name: str) -> dict[str, Any]:
    start, end = _day_bounds(day, timezone_name)
    tz = ZoneInfo(timezone_name)
    failures: list[dict[str, Any]] = []

    for row in task_rows:
        status = str(row.get("status", "") or "").strip().lower()
        if status not in FAILURE_STATUSES:
            continue
        local_ts = _task_local_timestamp(row, tz)
        if local_ts is None or not (start <= local_ts < end):
            continue
        failures.append(
            {
                "id": str(row.get("id", "") or ""),
                "status": status,
                "route": str(row.get("route", "") or ""),
                "worker_pool": str(row.get("worker_pool", "") or ""),
                "model": str(row.get("model", "") or ""),
                "timeout_reason": str(row.get("timeout_reason", "") or ""),
                "recovery_action": str(row.get("recovery_action", "") or ""),
                "summary": str(row.get("summary", "") or ""),
                "local_time": local_ts.strftime("%Y-%m-%d %H:%M:%S %Z"),
            }
        )

    by_route = Counter(row["route"] or "unknown" for row in failures)
    by_pool = Counter(row["worker_pool"] or "unknown" for row in failures)
    by_reason = Counter(
        row["timeout_reason"] or row["recovery_action"] or row["status"] or "unknown"
        for row in failures
    )

    return {
        "day": day,
        "timezone": timezone_name,
        "failure_count": len(failures),
        "by_route": dict(by_route),
        "by_worker_pool": dict(by_pool),
        "by_reason": dict(by_reason),
        "tasks": failures,
    }


def render_markdown(summary: dict[str, Any]) -> str:
    day = str(summary.get("day", "") or "")
    timezone_name = str(summary.get("timezone", "") or "")
    tasks = summary.get("tasks", []) if isinstance(summary.get("tasks", []), list) else []
    by_route = summary.get("by_route", {}) if isinstance(summary.get("by_route", {}), dict) else {}
    by_pool = summary.get("by_worker_pool", {}) if isinstance(summary.get("by_worker_pool", {}), dict) else {}
    by_reason = summary.get("by_reason", {}) if isinstance(summary.get("by_reason", {}), dict) else {}

    lines = [
        f"# Nightly Failure Summary ({day})",
        "",
        f"- Timezone: `{timezone_name}`",
        f"- Failed tasks: `{len(tasks)}`",
        "",
        "## Breakdown",
        "",
    ]

    if by_route:
        lines.append(f"- By route: {', '.join(f'`{key}`={value}' for key, value in sorted(by_route.items()))}")
    else:
        lines.append("- By route: none")
    if by_pool:
        lines.append(f"- By worker pool: {', '.join(f'`{key}`={value}' for key, value in sorted(by_pool.items()))}")
    else:
        lines.append("- By worker pool: none")
    if by_reason:
        lines.append(f"- By reason: {', '.join(f'`{key}`={value}' for key, value in sorted(by_reason.items()))}")
    else:
        lines.append("- By reason: none")

    lines.extend(["", "## Failed Tasks", ""])
    if not tasks:
        lines.append("- No failed tasks matched this day.")
        return "\n".join(lines) + "\n"

    for row in tasks[:20]:
        summary_text = row.get("summary", "")
        reason = row.get("timeout_reason") or row.get("recovery_action") or row.get("status")
        lines.append(
            f"- `{row.get('id', '')}` · `{row.get('route', '') or 'unknown'}` · `{row.get('worker_pool', '') or 'unknown'}` · "
            f"{row.get('local_time', '')} · reason=`{reason}`"
        )
        if summary_text:
            lines.append(f"  summary: {summary_text[:220]}")

    if len(tasks) > 20:
        lines.extend(["", f"_Only first 20 tasks shown; total failures: {len(tasks)}._"])
    return "\n".join(lines) + "\n"


def main() -> int:
    args = parse_args()
    task_rows = _load_task_rows(Path(args.task_state))
    summary = summarize_failures(task_rows, day=args.day, timezone_name=args.timezone)
    markdown = render_markdown(summary)

    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(markdown, encoding="utf-8")
    if args.json_output:
        json_path = Path(args.json_output)
        json_path.parent.mkdir(parents=True, exist_ok=True)
        json_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(markdown, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
