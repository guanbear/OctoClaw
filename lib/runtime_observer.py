#!/usr/bin/env python3
"""Unified runtime observation pass for OctoClaw."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import datetime, timezone
from typing import Any

try:
    from octopus_config import WORKSPACE
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.octopus_config import WORKSPACE

try:
    from patrol import observe_runtime_state_once
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.patrol import observe_runtime_state_once

def observe_runtime_once(*, workspace: str = WORKSPACE) -> dict[str, Any]:
    payload = observe_runtime_state_once(workspace=workspace)
    tasks = payload.get("tasks", []) if isinstance(payload.get("tasks", []), list) else []
    counts = Counter(str(task.get("status", "") or "").strip().lower() for task in tasks if isinstance(task, dict))
    active_tasks = int(counts.get("queued", 0) or 0) + int(counts.get("running", 0) or 0) + int(counts.get("dispatched", 0) or 0) + int(counts.get("pending_confirm", 0) or 0)
    final_tasks = int(counts.get("done", 0) or 0) + int(counts.get("completed", 0) or 0) + int(counts.get("failed", 0) or 0) + int(counts.get("blocked", 0) or 0) + int(counts.get("deferred", 0) or 0)
    return {
        "observed_at": datetime.now(timezone.utc).astimezone().isoformat(),
        "workspace": workspace,
        "runner_health": payload.get("runner_health", {}),
        "runner_execution_mode": str(payload.get("runner_execution_mode", "") or "daemon"),
        "changes": {
            "progress_hydrated": int(payload.get("progress_hydrated", 0) or 0),
            "results_hydrated": int(payload.get("results_hydrated", 0) or 0),
            "heartbeat_reassigned": len(payload.get("heartbeat_reassigned", []) or []),
            "dead_agent_recovered": len(payload.get("recovered", []) or []),
        },
        "counts": {
            "total": len([task for task in tasks if isinstance(task, dict)]),
            "queued": int(counts.get("queued", 0) or 0),
            "running": int(counts.get("running", 0) or 0) + int(counts.get("dispatched", 0) or 0),
            "pending": int(counts.get("pending_confirm", 0) or 0),
            "done": int(counts.get("done", 0) or 0) + int(counts.get("completed", 0) or 0),
            "failed": int(counts.get("failed", 0) or 0) + int(counts.get("blocked", 0) or 0) + int(counts.get("deferred", 0) or 0),
            "active": active_tasks,
            "final": final_tasks,
        },
        "recovered_task_ids": [str(item.get("id", "") or "").strip() for item in (payload.get("recovered", []) or []) if isinstance(item, dict)],
        "heartbeat_reassigned_task_ids": [str(item.get("id", "") or "").strip() for item in (payload.get("heartbeat_reassigned", []) or []) if isinstance(item, dict)],
    }


def render_observer_text(payload: dict[str, Any]) -> str:
    runner = payload.get("runner_health", {}) if isinstance(payload.get("runner_health", {}), dict) else {}
    counts = payload.get("counts", {}) if isinstance(payload.get("counts", {}), dict) else {}
    changes = payload.get("changes", {}) if isinstance(payload.get("changes", {}), dict) else {}
    runner_mode = str(payload.get("runner_execution_mode", "") or "").strip() or ("daemon" if runner.get("present", False) else "on_demand")
    runner_state = "healthy"
    if not runner.get("present", False):
        runner_state = "on-demand"
    elif not runner.get("healthy", False):
        runner_state = str(runner.get("reason", "stale") or "stale")
    age = runner.get("age_seconds")
    age_text = f" age={age}s" if isinstance(age, int) else ""
    return "\n".join(
        [
            f"Runtime observer [{str(payload.get('observed_at', '') or '').strip()}]",
            f"- Runner: {runner_state}{age_text} mode={runner_mode}",
            (
                f"- Counts: active {int(counts.get('active', 0) or 0)} · queued {int(counts.get('queued', 0) or 0)} · "
                f"running {int(counts.get('running', 0) or 0)} · pending {int(counts.get('pending', 0) or 0)} · "
                f"final {int(counts.get('final', 0) or 0)}"
            ),
            (
                f"- Changes: progress {int(changes.get('progress_hydrated', 0) or 0)} · "
                f"results {int(changes.get('results_hydrated', 0) or 0)} · "
                f"heartbeat {int(changes.get('heartbeat_reassigned', 0) or 0)} · "
                f"recovered {int(changes.get('dead_agent_recovered', 0) or 0)}"
            ),
        ]
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Observe and refresh OctoClaw runtime state once")
    parser.add_argument("--workspace", default=WORKSPACE)
    parser.add_argument("--format", choices=["text", "json"], default="text")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    payload = observe_runtime_once(workspace=args.workspace)
    if args.format == "json":
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(render_observer_text(payload))


if __name__ == "__main__":
    main()
