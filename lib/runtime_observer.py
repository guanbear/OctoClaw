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
    from patrol import observe_runtime_read_model
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.patrol import observe_runtime_read_model

try:
    from status_render import summarize_taskflow_substrate
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.status_render import summarize_taskflow_substrate

try:
    from task_display import build_task_anchor, build_task_detail
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.task_display import build_task_anchor, build_task_detail


ACTIVE_STATUSES = {"queued", "running", "dispatched", "pending_confirm"}
PENDING_SURFACE_STATES = {"pending_confirm", "needs_approval"}


def _surface_counts(tasks: list[dict[str, Any]]) -> dict[str, int]:
    counts = Counter()
    for task in tasks:
        if not isinstance(task, dict):
            continue
        anchor = build_task_anchor(task)
        state = str(anchor.get("state", "") or "").strip().lower()
        if state == "running":
            counts["running"] += 1
            counts["active"] += 1
        elif state == "queued":
            counts["queued"] += 1
            counts["active"] += 1
        elif state in PENDING_SURFACE_STATES:
            counts["pending"] += 1
            counts["active"] += 1
        elif state in {"done", "completed", "delivered"}:
            counts["done"] += 1
            counts["final"] += 1
        elif state in {"failed", "deferred", "cancelled", "partial", "blocked"}:
            counts["failed"] += 1
            counts["final"] += 1
    return {key: int(value or 0) for key, value in counts.items()}


def _create_path_summary(preference: str, status: str) -> str:
    preference = str(preference or "").strip()
    status = str(status or "").strip()
    return " | ".join(
        part
        for part in [
            f"preference {preference}" if preference else "",
            f"status {status}" if status else "",
        ]
        if part
    )


def _active_substrate_views(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    views: list[dict[str, Any]] = []
    for task in tasks:
        if not isinstance(task, dict):
            continue
        status = str(task.get("status", "") or "").strip().lower()
        if status not in ACTIVE_STATUSES:
            continue
        detail = build_task_detail(task, all_tasks=tasks)
        substrate = detail.get("substrate", {}) if isinstance(detail.get("substrate"), dict) else {}
        flow_id = str(substrate.get("flow_id", "") or "").strip()
        taskflow_task_id = str(substrate.get("task_id", "") or "").strip()
        substrate_summary = str(substrate.get("summary", "") or "").strip()
        if not (flow_id or taskflow_task_id or substrate_summary):
            continue
        views.append(
            {
                "task_id": str(detail.get("task_id", "") or "").strip(),
                "state": str(detail.get("state", "") or "").strip(),
                "route": str((detail.get("anchor", {}) if isinstance(detail.get("anchor"), dict) else {}).get("route", "") or "").strip(),
                "taskflow_target": f"flow {flow_id}" if flow_id else (f"task {taskflow_task_id}" if taskflow_task_id else ""),
                "substrate_summary": substrate_summary,
                "create_path": _create_path_summary(substrate.get("create_preference", ""), substrate.get("create_status", "")),
                "task_summary": detail.get("task_summary", {}) if isinstance(detail.get("task_summary"), dict) else {},
            }
        )
    return views[:5]


def _review_surface_views(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    views: list[dict[str, Any]] = []
    for task in tasks:
        if not isinstance(task, dict):
            continue
        if str(task.get("worker_pool", "") or "").strip().lower() == "octoclaw-review":
            continue
        detail = build_task_detail(task, all_tasks=tasks)
        review = detail.get("review", {}) if isinstance(detail.get("review"), dict) else {}
        if not bool(review.get("required")):
            continue
        views.append(
            {
                "task_id": str(detail.get("task_id", "") or "").strip(),
                "state_label": str(review.get("state_label", "") or "").strip(),
                "review_task_id": str(review.get("task_id", "") or "").strip(),
                "substrate_summary": str(review.get("substrate_summary", "") or "").strip(),
                "action_hint": str(review.get("action_hint", "") or "").strip(),
            }
        )
    return views[:5]

def observe_runtime_once(*, workspace: str = WORKSPACE) -> dict[str, Any]:
    payload = observe_runtime_read_model(workspace=workspace)
    tasks = payload.get("tasks", []) if isinstance(payload.get("tasks", []), list) else []
    surface_counts = _surface_counts(tasks)
    return {
        "observed_at": str(payload.get("observed_at", "") or datetime.now(timezone.utc).astimezone().isoformat()),
        "workspace": workspace,
        "runner_health": payload.get("runner_health", {}),
        "runner_execution_mode": str(payload.get("runner_execution_mode", "") or "ondemand"),
        "queue_counts": payload.get("queue_counts", {}) if isinstance(payload.get("queue_counts", {}), dict) else {},
        "workbench": payload.get("workbench", {}) if isinstance(payload.get("workbench", {}), dict) else {},
        "substrate": summarize_taskflow_substrate(tasks),
        "surface_status": {
            "display": "substrate_first",
            "retrieve": "substrate_first",
            "observer": "substrate_aware",
            "review": "substrate_aware",
        },
        "active_substrate_tasks": _active_substrate_views(tasks),
        "review_surfaces": _review_surface_views(tasks),
        "changes": {
            "progress_hydrated": int(payload.get("progress_hydrated", 0) or 0),
            "results_hydrated": int(payload.get("results_hydrated", 0) or 0),
            "heartbeat_reassigned": len(payload.get("heartbeat_reassigned", []) or []),
            "dead_agent_recovered": len(payload.get("recovered", []) or []),
        },
        "counts": {
            "total": len([task for task in tasks if isinstance(task, dict)]),
            "queued": int(surface_counts.get("queued", 0) or 0),
            "running": int(surface_counts.get("running", 0) or 0),
            "pending": int(surface_counts.get("pending", 0) or 0),
            "done": int(surface_counts.get("done", 0) or 0),
            "failed": int(surface_counts.get("failed", 0) or 0),
            "active": int(surface_counts.get("active", 0) or 0),
            "final": int(surface_counts.get("final", 0) or 0),
        },
        "recovered_task_ids": [str(item.get("id", "") or "").strip() for item in (payload.get("recovered", []) or []) if isinstance(item, dict)],
        "heartbeat_reassigned_task_ids": [str(item.get("id", "") or "").strip() for item in (payload.get("heartbeat_reassigned", []) or []) if isinstance(item, dict)],
    }


def render_runner_status_text(payload: dict[str, Any]) -> str:
    runner = payload.get("runner_health", {}) if isinstance(payload.get("runner_health", {}), dict) and payload.get("runner_health") else {}
    if not runner:
        runner = payload.get("runner", {}) if isinstance(payload.get("runner", {}), dict) else {}
    queue_counts = payload.get("queue_counts", {}) if isinstance(payload.get("queue_counts", {}), dict) else {}
    mode = str(payload.get("runner_execution_mode", "") or "").strip() or str(runner.get("mode", "") or "").strip() or "ondemand"
    state = str((payload.get("runner", {}) if isinstance(payload.get("runner", {}), dict) else {}).get("state", "") or runner.get("reason", "") or "on-demand").strip()
    lines = [
        f"Runner status [{str(payload.get('observed_at', '') or '').strip()}]",
        f"- Mode: {mode}",
        f"- State: {state}",
        (
            f"- Queue: queued {int(queue_counts.get('queued', 0) or 0)} · "
            f"running {int(queue_counts.get('running', 0) or 0)} · "
            f"done {int(queue_counts.get('done', 0) or 0)} · "
            f"failed {int(queue_counts.get('failed', 0) or 0)} · "
            f"total {int(queue_counts.get('total', 0) or 0)}"
        ),
    ]
    worker_id = str(runner.get("worker_id", "") or "").strip()
    job_id = str(runner.get("job_id", "") or "").strip()
    age = runner.get("age_seconds")
    details = []
    if worker_id:
        details.append(f"worker {worker_id}")
    if job_id:
        details.append(f"job {job_id}")
    if isinstance(age, int):
        details.append(f"age {age}s")
    if details:
        lines.append("- " + " · ".join(details))
    return "\n".join(lines)


def render_observer_text(payload: dict[str, Any]) -> str:
    runner = payload.get("runner_health", {}) if isinstance(payload.get("runner_health", {}), dict) and payload.get("runner_health") else {}
    if not runner:
        runner = payload.get("runner", {}) if isinstance(payload.get("runner", {}), dict) else {}
    counts = payload.get("counts", {}) if isinstance(payload.get("counts", {}), dict) else {}
    changes = payload.get("changes", {}) if isinstance(payload.get("changes", {}), dict) else {}
    substrate = payload.get("substrate", {}) if isinstance(payload.get("substrate", {}), dict) else {}
    surface_status = payload.get("surface_status", {}) if isinstance(payload.get("surface_status", {}), dict) else {}
    workbench = payload.get("workbench", {}) if isinstance(payload.get("workbench", {}), dict) else {}
    if not surface_status:
        surface_status = {
            "display": "substrate_first",
            "retrieve": "substrate_first",
            "observer": "substrate_aware",
            "review": "substrate_aware",
        }
    active_substrate_tasks = payload.get("active_substrate_tasks", []) if isinstance(payload.get("active_substrate_tasks", []), list) else []
    review_surfaces = payload.get("review_surfaces", []) if isinstance(payload.get("review_surfaces", []), list) else []
    runner_mode = str(payload.get("runner_execution_mode", "") or "").strip() or ("daemon" if runner.get("present", False) else "ondemand")
    runner_state = "healthy"
    if not runner.get("present", False):
        runner_state = "on-demand"
    elif not runner.get("healthy", False):
        runner_state = str(runner.get("reason", "stale") or "stale")
    age = runner.get("age_seconds")
    age_text = f" age={age}s" if isinstance(age, int) else ""
    lines = [
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
        (
            f"- Substrate: tracked {int(substrate.get('tracked', 0) or 0)} · "
            f"managed {int(substrate.get('managed', 0) or 0)} · "
            f"native bound {int(substrate.get('native_bound', 0) or 0)}"
        ),
    ]
    if surface_status:
        lines.append(
            "- Surfaces: "
            + " · ".join(
                [
                    f"display {str(surface_status.get('display', '') or '').strip()}",
                    f"retrieve {str(surface_status.get('retrieve', '') or '').strip()}",
                    f"observer {str(surface_status.get('observer', '') or '').strip()}",
                    f"review {str(surface_status.get('review', '') or '').strip()}",
                ]
            )
        )
    if bool(workbench.get("optional_backend")):
        session_name = str(workbench.get("tmux_session_name", "") or "").strip()
        lines.append(f"- Optional workbench: tmux {session_name}" if session_name else "- Optional workbench: enabled")
    if active_substrate_tasks:
        lines.append("- Active substrate tasks:")
        for item in active_substrate_tasks[:3]:
            if not isinstance(item, dict):
                continue
            task_summary = item.get("task_summary", {}) if isinstance(item.get("task_summary", {}), dict) else {}
            bits = [
                str(item.get("task_id", "") or "").strip(),
                str(item.get("state", "") or "").strip(),
                str(item.get("route", "") or "").strip(),
                str(item.get("taskflow_target", "") or "").strip(),
                str(item.get("substrate_summary", "") or "").strip(),
                str(item.get("create_path", "") or "").strip(),
            ]
            if int(task_summary.get("child_count", 0) or 0):
                bits.append(
                    f"{int(task_summary.get('active_child_count', 0) or 0)} active child / {int(task_summary.get('completed_child_count', 0) or 0)} completed child"
                )
            lines.append("- " + " | ".join(bit for bit in bits if bit))
    if review_surfaces:
        lines.append("- Review surfaces:")
        for item in review_surfaces[:3]:
            if not isinstance(item, dict):
                continue
            lines.append(
                "- "
                + " | ".join(
                    bit
                    for bit in [
                        str(item.get("task_id", "") or "").strip(),
                        str(item.get("state_label", "") or "").strip(),
                        f"review task {str(item.get('review_task_id', '') or '').strip()}" if str(item.get("review_task_id", "") or "").strip() else "",
                        str(item.get("substrate_summary", "") or "").strip(),
                        str(item.get("action_hint", "") or "").strip(),
                    ]
                    if bit
                )
            )
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Observe OctoClaw runtime state once")
    parser.add_argument("--workspace", default=WORKSPACE)
    parser.add_argument("--format", choices=["text", "json", "runner"], default="text")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    payload = observe_runtime_once(workspace=args.workspace)
    if args.format == "json":
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    elif args.format == "runner":
        print(render_runner_status_text(payload))
    else:
        print(render_observer_text(payload))


if __name__ == "__main__":
    main()
