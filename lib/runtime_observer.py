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
    from patrol import (
        annotate_tasks_with_session_state,
        check_runner_health,
        hydrate_completed_session_results,
        hydrate_session_progress_markers,
        load_tasks,
        patrol_heartbeat_check,
        recover_dead_agent_tasks,
        refresh_openclaw_taskflow_bindings,
    )
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.patrol import (
        annotate_tasks_with_session_state,
        check_runner_health,
        hydrate_completed_session_results,
        hydrate_session_progress_markers,
        load_tasks,
        patrol_heartbeat_check,
        recover_dead_agent_tasks,
        refresh_openclaw_taskflow_bindings,
    )

try:
    from runtime_task_record import task_is_final
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.runtime_task_record import task_is_final


def _task_counts(tasks: list[dict[str, Any]]) -> dict[str, int]:
    counts = Counter(str(task.get("status", "") or "").strip().lower() for task in tasks if isinstance(task, dict))
    return {
        "total": len([task for task in tasks if isinstance(task, dict)]),
        "queued": int(counts.get("queued", 0) or 0),
        "running": int(counts.get("running", 0) or 0) + int(counts.get("dispatched", 0) or 0),
        "pending": int(counts.get("pending_confirm", 0) or 0),
        "done": int(counts.get("done", 0) or 0) + int(counts.get("completed", 0) or 0),
        "failed": int(counts.get("failed", 0) or 0) + int(counts.get("blocked", 0) or 0) + int(counts.get("deferred", 0) or 0),
    }


def _reload_observed_tasks() -> list[dict[str, Any]]:
    tasks = load_tasks()
    if not tasks:
        return []
    tasks = annotate_tasks_with_session_state(tasks)
    refresh_openclaw_taskflow_bindings(tasks)
    return tasks


def observe_runtime_once(*, workspace: str = WORKSPACE) -> dict[str, Any]:
    runner = check_runner_health()
    runner_mode = "daemon" if runner.get("present", False) else "on_demand"
    tasks = _reload_observed_tasks()

    progress_hydrated = hydrate_session_progress_markers(tasks)
    if progress_hydrated > 0:
        tasks = _reload_observed_tasks()

    result_hydrated = hydrate_completed_session_results(tasks)
    if result_hydrated > 0:
        tasks = _reload_observed_tasks()

    heartbeat_reassigned = patrol_heartbeat_check(workspace)
    if heartbeat_reassigned:
        tasks = _reload_observed_tasks()

    recovered = recover_dead_agent_tasks(tasks)
    if recovered:
        tasks = _reload_observed_tasks()

    counts = _task_counts(tasks)
    final_tasks = len([task for task in tasks if isinstance(task, dict) and task_is_final(task)])
    active_tasks = counts["queued"] + counts["running"] + counts["pending"]
    return {
        "observed_at": datetime.now(timezone.utc).astimezone().isoformat(),
        "workspace": workspace,
        "runner_health": runner,
        "runner_execution_mode": runner_mode,
        "changes": {
            "progress_hydrated": int(progress_hydrated or 0),
            "results_hydrated": int(result_hydrated or 0),
            "heartbeat_reassigned": len(heartbeat_reassigned),
            "dead_agent_recovered": len(recovered),
        },
        "counts": {
            **counts,
            "active": active_tasks,
            "final": final_tasks,
        },
        "recovered_task_ids": [str(item.get("id", "") or "").strip() for item in recovered if isinstance(item, dict)],
        "heartbeat_reassigned_task_ids": [str(item.get("id", "") or "").strip() for item in heartbeat_reassigned if isinstance(item, dict)],
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
