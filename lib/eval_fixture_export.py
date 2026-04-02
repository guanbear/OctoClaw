#!/usr/bin/env python3
"""Export eval fixtures from successful runtime task events.

Reads task-state.json to extract successfully completed tasks, then exports
them as eval fixture entries compatible with eval/tasks-minimal.json format.

Successful tasks become regression test cases: if the router would send
a real task down route X, it should keep doing so after code changes.

Usage:
    python3 eval_fixture_export.py [--output path] [--merge] [--dry-run]
    python3 eval_fixture_export.py --state-file /path/to/task-state.json --dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


WORKSPACE = os.environ.get("WORKSPACE", "/workspace")
SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent

TASK_STATE_FILE = Path(os.environ.get(
    "OCTOCLAW_TASK_STATE_FILE",
    f"{WORKSPACE}/tmp/octopus/task-state.json",
))
TASK_EVENTS_FILE = Path(os.environ.get(
    "OCTOCLAW_EVENTS_FILE",
    f"{WORKSPACE}/tmp/octopus/task-events.jsonl",
))
DEFAULT_OUTPUT = PROJECT_DIR / "eval" / "tasks-from-runtime.json"

VALID_ROUTES = {"direct", "runner", "spawn_single", "spawn_multi"}

# Derive expect_work_contract from the actual route used.
# This is intentionally simple: the route is the ground truth
# from a real successful run.
_ROUTE_TO_CONTRACT: dict[str, str] = {
    "direct": "answer_now",
    "runner": "inspect_report",
    "spawn_single": "deliverable_work",
    "spawn_multi": "coordinated_work",
}


def _text(value: object) -> str:
    return str(value or "").strip()


def _load_state_file(path: Path) -> list[dict]:
    """Load tasks from task-state.json. Returns empty list on any error."""
    if not path.exists():
        return []
    try:
        raw = path.read_text("utf-8")
        data = json.loads(raw)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"warning: could not read {path}: {exc}", file=sys.stderr)
        return []
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        tasks = data.get("tasks", [])
        return tasks if isinstance(tasks, list) else []
    return []


def _load_events_file(path: Path) -> list[dict]:
    """Load events from task-events.jsonl. Returns empty list on any error."""
    if not path.exists():
        return []
    events: list[dict] = []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError as exc:
        print(f"warning: could not read {path}: {exc}", file=sys.stderr)
    return events


def _build_elapsed_map(events: list[dict]) -> dict[str, int]:
    """Build task_id → elapsed_ms map from start/complete event pairs."""
    start_times: dict[str, str] = {}
    end_times: dict[str, str] = {}
    for evt in events:
        task_id = _text(evt.get("task_id"))
        if not task_id:
            continue
        kind = _text(evt.get("kind"))
        ts = _text(evt.get("time"))
        if not ts:
            continue
        if kind in ("task_started", "dispatch_started") and task_id not in start_times:
            start_times[task_id] = ts
        if kind in ("task_completed", "result_ready", "handoff_ready"):
            end_times[task_id] = ts
    elapsed: dict[str, int] = {}
    for task_id, end_ts in end_times.items():
        start_ts = start_times.get(task_id)
        if not start_ts:
            continue
        try:
            t0 = datetime.fromisoformat(start_ts.replace("Z", "+00:00"))
            t1 = datetime.fromisoformat(end_ts.replace("Z", "+00:00"))
            ms = int((t1 - t0).total_seconds() * 1000)
            if ms > 0:
                elapsed[task_id] = ms
        except ValueError:
            continue
    return elapsed


def _derive_fixture_id(task: dict) -> str:
    """Derive a short, readable fixture id from task fields."""
    task_id = _text(task.get("id"))
    worker_pool = _text(task.get("worker_pool"))
    route = _text(task.get("route"))

    # Strip common octoclaw-* prefix from worker_pool
    pool_slug = worker_pool.replace("octoclaw-", "") if worker_pool.startswith("octoclaw-") else worker_pool
    if not pool_slug:
        pool_slug = route or "task"

    # Use last 8 chars of task_id as suffix to keep ids short but unique
    suffix = task_id[-8:] if len(task_id) >= 8 else task_id
    return f"rt-{pool_slug}-{suffix}"


def _route_to_work_contract(route: str, work_type: str = "") -> str:
    """Map route (and optionally work_type) to expect_work_contract."""
    contract = _ROUTE_TO_CONTRACT.get(route, "")
    if contract:
        return contract
    # Fallback: infer from work_type keywords
    wt = work_type.lower()
    if any(k in wt for k in ("inspect", "check", "status", "log", "monitor")):
        return "inspect_report"
    if any(k in wt for k in ("explain", "answer", "translate", "describe")):
        return "answer_now"
    if any(k in wt for k in ("coordinate", "multi", "plan", "research")):
        return "coordinated_work"
    return "deliverable_work"


def extract_fixtures(
    tasks: list[dict],
    elapsed_map: dict[str, int] | None = None,
) -> list[dict]:
    """Extract eval fixtures from a list of task state records.

    Only includes tasks that:
    - have lifecycle_state == "finished" and outcome_state == "done"
    - have a non-empty task_description
    - have a known valid route
    """
    elapsed_map = elapsed_map or {}
    fixtures: list[dict] = []

    for task in tasks:
        if not isinstance(task, dict):
            continue

        lifecycle = _text(task.get("lifecycle_state"))
        outcome = _text(task.get("outcome_state"))
        if lifecycle != "finished" or outcome != "done":
            continue

        task_description = _text(task.get("task_description"))
        if not task_description:
            continue

        route = _text(task.get("route"))
        if route not in VALID_ROUTES:
            continue

        task_id = _text(task.get("id"))
        work_type = _text(task.get("work_type"))
        model = _text(task.get("model"))
        worker_pool = _text(task.get("worker_pool"))
        exported_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        fixture: dict = {
            "id": _derive_fixture_id(task),
            "task": task_description,
            "expect_route": route,
            "expect_work_contract": _route_to_work_contract(route, work_type),
            # Metadata fields (prefixed with _ to distinguish from eval fields)
            "_source": "runtime",
            "_task_id": task_id,
            "_worker_pool": worker_pool,
            "_model": model,
            "_work_type": work_type,
            "_exported_at": exported_at,
        }
        if task_id in elapsed_map:
            fixture["_elapsed_ms"] = elapsed_map[task_id]

        fixtures.append(fixture)

    return fixtures


def merge_fixtures(
    existing: list[dict],
    new_fixtures: list[dict],
) -> tuple[list[dict], int]:
    """Merge new fixtures into existing list, deduplicating by _task_id.

    Returns (merged_list, count_added).
    """
    existing_task_ids = {
        f.get("_task_id", "")
        for f in existing
        if f.get("_source") == "runtime" and f.get("_task_id")
    }
    existing_ids = {f.get("id", "") for f in existing}

    merged = list(existing)
    added = 0

    for fixture in new_fixtures:
        task_id = fixture.get("_task_id", "")
        if task_id and task_id in existing_task_ids:
            continue  # already exported

        # Ensure fixture id is unique
        base_id = fixture["id"]
        uid = base_id
        counter = 2
        while uid in existing_ids:
            uid = f"{base_id}-{counter}"
            counter += 1
        fixture = {**fixture, "id": uid}

        existing_ids.add(uid)
        if task_id:
            existing_task_ids.add(task_id)

        merged.append(fixture)
        added += 1

    return merged, added


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Export eval fixtures from OctoClaw runtime task state",
    )
    parser.add_argument(
        "--state-file",
        default=str(TASK_STATE_FILE),
        help=f"Path to task-state.json (default: {TASK_STATE_FILE})",
    )
    parser.add_argument(
        "--events-file",
        default=str(TASK_EVENTS_FILE),
        help="Path to task-events.jsonl for elapsed-time metadata (optional)",
    )
    parser.add_argument(
        "--output", "-o",
        default=str(DEFAULT_OUTPUT),
        help=f"Output fixture file (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--merge",
        action="store_true",
        help="Merge with existing output file instead of overwriting",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print extracted fixtures to stdout without writing",
    )
    parser.add_argument(
        "--min-tasks",
        type=int,
        default=0,
        help="Exit with code 0 but skip write if fewer than N fixtures found",
    )
    parser.add_argument(
        "--no-elapsed",
        action="store_true",
        help="Skip reading task-events.jsonl (faster, no elapsed metadata)",
    )
    args = parser.parse_args(argv)

    tasks = _load_state_file(Path(args.state_file))
    if not tasks:
        print(f"No tasks found in {args.state_file}", file=sys.stderr)
        return 0

    elapsed_map: dict[str, int] = {}
    if not args.no_elapsed:
        events = _load_events_file(Path(args.events_file))
        if events:
            elapsed_map = _build_elapsed_map(events)

    fixtures = extract_fixtures(tasks, elapsed_map)

    if not fixtures:
        print("No exportable fixtures (no finished+done tasks with task_description)", file=sys.stderr)
        return 0

    if len(fixtures) < args.min_tasks:
        print(
            f"Only {len(fixtures)} fixtures found, below --min-tasks={args.min_tasks}; skipping write",
            file=sys.stderr,
        )
        return 0

    if args.dry_run:
        print(json.dumps(fixtures, ensure_ascii=False, indent=2))
        return 0

    output_path = Path(args.output)

    if args.merge and output_path.exists():
        try:
            existing = json.loads(output_path.read_text("utf-8"))
            if not isinstance(existing, list):
                existing = []
        except (OSError, json.JSONDecodeError):
            existing = []
        result, added = merge_fixtures(existing, fixtures)
        print(f"Merged: +{added} new fixtures (total {len(result)}) → {output_path}")
    else:
        result = fixtures
        added = len(fixtures)
        print(f"Exporting {added} fixtures → {output_path}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), "utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
