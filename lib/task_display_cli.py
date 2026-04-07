#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from octopus_config import TASK_STATE_FILE
from runtime_task_record import normalize_task_records
from task_display import (
    build_task_actions,
    build_task_anchor,
    build_task_artifact_explorer,
    build_task_detail,
    build_task_graph,
    build_task_queue_view,
    build_task_retrieval_bundle,
    build_task_timeline,
    render_task_anchor_text,
)
from openclaw_taskflow_adapter import cleanup_taskflow_mirror, describe_taskflow_cleanup, summarize_taskflow_inventory

def load_tasks(path: str) -> list[dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            loaded = json.load(fh)
    except FileNotFoundError:
        return []
    except Exception:
        return []
    if isinstance(loaded, dict):
        tasks = loaded.get("tasks", [])
    elif isinstance(loaded, list):
        tasks = loaded
    else:
        tasks = []
    raw_tasks = tasks if isinstance(tasks, list) else []
    normalized = normalize_task_records(raw_tasks)
    for raw, item in zip(raw_tasks, normalized):
        if not isinstance(raw, dict) or not isinstance(item, dict):
            continue
        if isinstance(raw.get("task_events_preview"), list):
            item["task_events_preview"] = [event for event in raw.get("task_events_preview", []) if isinstance(event, dict)]
        if isinstance(raw.get("task_event_summary"), dict):
            item["task_event_summary"] = dict(raw.get("task_event_summary", {}))
    return normalized


def find_task(tasks: list[dict[str, Any]], task_id: str) -> dict[str, Any] | None:
    wanted = str(task_id or "").strip()
    if not wanted:
        return None
    for task in tasks:
        if str(task.get("id", "") or "").strip() == wanted:
            return task
    return None


def print_json(data: Any) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2))


def render_detail_text(task: dict[str, Any], detail: dict[str, Any]) -> str:
    anchor = detail.get("anchor", {}) if isinstance(detail.get("anchor"), dict) else {}
    lines = [render_task_anchor_text(anchor, build_task_actions(task))]
    substrate = detail.get("substrate", {}) if isinstance(detail.get("substrate"), dict) else {}
    taskflow_flow_id = str(substrate.get("flow_id", "") or "").strip()
    taskflow_task_id = str(substrate.get("task_id", "") or "").strip()
    if taskflow_flow_id:
        lines.append(f"TaskFlow target: flow {taskflow_flow_id}")
    elif taskflow_task_id:
        lines.append(f"TaskFlow target: task {taskflow_task_id}")
    substrate_summary = str(substrate.get("summary", "") or "").strip()
    if substrate_summary:
        lines.append(f"Substrate detail: {substrate_summary}")
    task_runtime = str(substrate.get("task_runtime", "") or "").strip()
    flow_runtime = str(substrate.get("flow_runtime", "") or "").strip()
    runtime_summary = "/".join(part for part in [task_runtime, flow_runtime] if part)
    if taskflow_task_id or taskflow_flow_id or runtime_summary:
        lines.append(
            "OpenClaw binding: "
            + " | ".join(
                part
                for part in [
                    f"task {taskflow_task_id}" if taskflow_task_id else "",
                    f"flow {taskflow_flow_id}" if taskflow_flow_id else "",
                    f"runtime {runtime_summary}" if runtime_summary else "",
                ]
                if part
            )
        )
    create_preference = str(substrate.get("create_preference", "") or "").strip()
    create_status = str(substrate.get("create_status", "") or "").strip()
    if create_preference or create_status:
        lines.append(
            "Create path: "
            + " | ".join(part for part in [f"preference {create_preference}" if create_preference else "", f"status {create_status}" if create_status else ""] if part)
        )
    task_summary = detail.get("task_summary", {}) if isinstance(detail.get("task_summary"), dict) else {}
    if int(task_summary.get("child_count", 0) or 0):
        lines.append(
            "Task summary: "
            + " | ".join(
                [
                    f"{int(task_summary.get('active_child_count', 0) or 0)} active child",
                    f"{int(task_summary.get('completed_child_count', 0) or 0)} completed child",
                    f"{int(task_summary.get('child_count', 0) or 0)} linked",
                ]
            )
        )
    review = detail.get("review", {}) if isinstance(detail.get("review"), dict) else {}
    if bool(review.get("required")):
        review_bits = [str(review.get("state_label", "") or "Review required").strip()]
        if str(review.get("task_id", "") or "").strip():
            review_bits.append(f"task {str(review.get('task_id', '') or '').strip()}")
        if str(review.get("substrate_summary", "") or "").strip():
            review_bits.append(str(review.get("substrate_summary", "") or "").strip())
        lines.append("Review surface: " + " | ".join(bit for bit in review_bits if bit))
    lineage = detail.get("lineage", {}) if isinstance(detail.get("lineage"), dict) else {}
    if lineage.get("child_task_ids"):
        lines.append("Children: " + ", ".join(str(item) for item in lineage.get("child_task_ids", [])))
    runner_plan = detail.get("runner_plan", {}) if isinstance(detail.get("runner_plan", {}), dict) else {}
    if runner_plan:
        plan_kind = str(runner_plan.get("kind", "") or "").strip()
        plan_command = str(runner_plan.get("command", "") or "").strip()
        summary = " | ".join(part for part in [plan_kind, plan_command] if part)
        if summary:
            lines.append(f"Runner plan: {summary}")
    checklist = detail.get("checklist", {}) if isinstance(detail.get("checklist"), dict) else {}
    checklist_items = checklist.get("items", []) if isinstance(checklist.get("items"), list) else []
    if checklist_items:
        lines.append("Checklist:")
        for item in checklist_items[:5]:
            if not isinstance(item, dict):
                continue
            state = str(item.get("state", "") or "pending").strip().lower()
            marker = {
                "done": "[x]",
                "failed": "[!]",
                "blocked": "[-]",
                "in_progress": "[>]",
            }.get(state, "[ ]")
            title = str(item.get("title", "") or item.get("id", "item")).strip()
            lines.append(f"- {marker} {title}")
    artifacts = detail.get("artifacts", []) if isinstance(detail.get("artifacts"), list) else []
    if artifacts:
        lines.append("Artifacts:")
        for artifact in artifacts[:5]:
            if not isinstance(artifact, dict):
                continue
            title = str(artifact.get("title", "") or artifact.get("artifact_id", "artifact")).strip()
            path = str(artifact.get("path", "") or artifact.get("preview", "") or "").strip()
            lines.append(f"- {title}: {path}".rstrip(": "))
    return "\n".join(lines)


def render_retrieval_text(bundle: dict[str, Any]) -> str:
    lines = [
        f"Task: {str(bundle.get('task_id', '') or '').strip()}",
        f"State: {str(bundle.get('state', '') or '').strip()} | Route: {str(bundle.get('route', '') or '').strip()} | Pool: {str(bundle.get('worker_pool', '') or '').strip()}",
    ]
    substrate = bundle.get("substrate", {}) if isinstance(bundle.get("substrate"), dict) else {}
    taskflow_flow_id = str(substrate.get("flow_id", "") or "").strip()
    taskflow_task_id = str(substrate.get("task_id", "") or "").strip()
    if taskflow_flow_id:
        lines.append(f"TaskFlow target: flow {taskflow_flow_id}")
    elif taskflow_task_id:
        lines.append(f"TaskFlow target: task {taskflow_task_id}")
    substrate_summary = str(substrate.get("summary", "") or "").strip()
    if substrate_summary:
        lines.append(f"Substrate: {substrate_summary}")
    create_preference = str(substrate.get("create_preference", "") or "").strip()
    create_status = str(substrate.get("create_status", "") or "").strip()
    if create_preference or create_status:
        lines.append(
            "Create path: "
            + " | ".join(part for part in [f"preference {create_preference}" if create_preference else "", f"status {create_status}" if create_status else ""] if part)
        )
    task_summary = bundle.get("task_summary", {}) if isinstance(bundle.get("task_summary"), dict) else {}
    if int(task_summary.get("child_count", 0) or 0):
        lines.append(
            "Task summary: "
            + " | ".join(
                [
                    f"{int(task_summary.get('active_child_count', 0) or 0)} active child",
                    f"{int(task_summary.get('completed_child_count', 0) or 0)} completed child",
                    f"{int(task_summary.get('child_count', 0) or 0)} linked",
                ]
            )
        )
    review = bundle.get("review", {}) if isinstance(bundle.get("review"), dict) else {}
    if bool(review.get("required")):
        review_bits = [str(review.get("state_label", "") or "Review required").strip()]
        if str(review.get("task_id", "") or "").strip():
            review_bits.append(f"task {str(review.get('task_id', '') or '').strip()}")
        if str(review.get("substrate_summary", "") or "").strip():
            review_bits.append(str(review.get("substrate_summary", "") or "").strip())
        lines.append("Review surface: " + " | ".join(bit for bit in review_bits if bit))
    runner_plan = bundle.get("runner_plan", {}) if isinstance(bundle.get("runner_plan", {}), dict) else {}
    if runner_plan:
        plan_kind = str(runner_plan.get("kind", "") or "").strip()
        plan_command = str(runner_plan.get("command", "") or "").strip()
        summary = " | ".join(part for part in [plan_kind, plan_command] if part)
        if summary:
            lines.append(f"Runner plan: {summary}")
    summary = str(bundle.get("user_safe_summary", "") or bundle.get("summary", "") or "").strip()
    if summary:
        lines.append(f"Summary: {summary}")
    next_step = str(bundle.get("next_step", "") or "").strip()
    if next_step and next_step.lower() != "none":
        lines.append(f"Next: {next_step}")
    read_order = bundle.get("recommended_read_order", []) if isinstance(bundle.get("recommended_read_order"), list) else []
    if read_order:
        lines.append("Read order:")
        for item in read_order[:5]:
            lines.append(f"- {str(item or '').strip()}")
    primary_report = str(bundle.get("primary_report", "") or "").strip()
    if primary_report:
        lines.append(f"Primary report: {primary_report}")
    context_pack_path = str(bundle.get("context_pack_path", "") or "").strip()
    if context_pack_path:
        lines.append(f"Context pack: {context_pack_path}")
    context_path = str(bundle.get("context_path", "") or "").strip()
    if context_path:
        lines.append(f"Context: {context_path}")
    checklist = bundle.get("checklist", {}) if isinstance(bundle.get("checklist"), dict) else {}
    if checklist:
        lines.append(
            f"Checklist: {int(checklist.get('completed_count', 0) or 0)} done / {int(checklist.get('open_count', 0) or 0)} open"
        )
    primary_artifacts = bundle.get("primary_artifacts", []) if isinstance(bundle.get("primary_artifacts"), list) else []
    if primary_artifacts:
        lines.append("Primary artifacts:")
        for artifact in primary_artifacts[:3]:
            if not isinstance(artifact, dict):
                continue
            lines.append(f"- {str(artifact.get('kind', '') or '').strip()}: {str(artifact.get('path', '') or artifact.get('preview', '') or '').strip()}".rstrip(": "))
    related_artifacts = bundle.get("related_thread_artifacts", []) if isinstance(bundle.get("related_thread_artifacts"), list) else []
    if related_artifacts:
        lines.append("Related thread artifacts:")
        for artifact in related_artifacts[:3]:
            if not isinstance(artifact, dict):
                continue
            lines.append(f"- {str(artifact.get('task_id', '') or '').strip()} · {str(artifact.get('kind', '') or '').strip()}: {str(artifact.get('path', '') or artifact.get('preview', '') or '').strip()}".rstrip(": "))
    return "\n".join(lines)


def render_queue_text(view: dict[str, Any]) -> str:
    lines: list[str] = []
    for section in ("running", "queued", "blocked", "recently_completed"):
        items = view.get(section, []) if isinstance(view.get(section), list) else []
        if not items:
            continue
        lines.append(f"[{section}]")
        for anchor in items:
            lines.append(f"- {render_task_anchor_text(anchor).splitlines()[0]}")
    return "\n".join(lines) if lines else "(no tasks)"


def render_graph_text(graph: dict[str, Any]) -> str:
    summary = graph.get("summary", {}) if isinstance(graph.get("summary"), dict) else {}
    nodes = graph.get("nodes", []) if isinstance(graph.get("nodes"), list) else []
    edges = graph.get("edges", []) if isinstance(graph.get("edges"), list) else []
    lines = [
        f"Task graph: {str(graph.get('root_task_id', '') or '').strip()}",
        f"Nodes: {int(summary.get('node_count', 0) or 0)} | Edges: {int(summary.get('edge_count', 0) or 0)} | Active: {int(summary.get('active_count', 0) or 0)}",
    ]
    if summary.get("route_counts"):
        lines.append(f"Routes: {json.dumps(summary['route_counts'], ensure_ascii=False)}")
    if summary.get("worker_pool_counts"):
        lines.append(f"Pools: {json.dumps(summary['worker_pool_counts'], ensure_ascii=False)}")
    if nodes:
        lines.append("Nodes:")
        current_task_id = str(graph.get("current_task_id", "") or "").strip()
        for node in nodes[:8]:
            if not isinstance(node, dict):
                continue
            marker = "*" if str(node.get("task_id", "") or "").strip() == current_task_id else "-"
            title = str(node.get("title", "") or node.get("task_id", "")).strip()
            state = str(node.get("state_label", "") or node.get("state", "")).strip()
            route = str(node.get("route", "") or "").strip()
            lines.append(f"{marker} {str(node.get('task_id', '') or '').strip()} | {state} | {route} | {title}")
    if edges:
        lines.append("Edges:")
        for edge in edges[:12]:
            if not isinstance(edge, dict):
                continue
            lines.append(f"- {str(edge.get('source', '') or '').strip()} -> {str(edge.get('target', '') or '').strip()}")
    return "\n".join(lines)


def render_timeline_text(timeline: dict[str, Any]) -> str:
    summary = timeline.get("summary", {}) if isinstance(timeline.get("summary"), dict) else {}
    events = timeline.get("events", []) if isinstance(timeline.get("events"), list) else []
    lines = [
        f"Timeline: {str(timeline.get('task_id', '') or '').strip()}",
        f"Events: {int(summary.get('event_count', 0) or 0)}",
    ]
    if summary.get("kind_counts"):
        lines.append(f"Kinds: {json.dumps(summary['kind_counts'], ensure_ascii=False)}")
    for event in events[:12]:
        if not isinstance(event, dict):
            continue
        when = str(event.get("time", "") or "").strip() or "?"
        kind = str(event.get("kind", "") or "").strip() or "event"
        task_id = str(event.get("task_id", "") or "").strip()
        message = str(event.get("message", "") or "").strip()
        lines.append(f"- {when} | {kind} | {task_id} | {message}".rstrip(" |"))
    return "\n".join(lines)


def render_explorer_text(explorer: dict[str, Any]) -> str:
    lines = [
        f"Artifact explorer: {str(explorer.get('task_id', '') or '').strip()}",
    ]
    summary = str(explorer.get("summary", "") or "").strip()
    if summary:
        lines.append(f"Summary: {summary}")
    if explorer.get("primary_report"):
        lines.append(f"Primary report: {str(explorer.get('primary_report', '') or '').strip()}")
    if explorer.get("context_pack_path"):
        lines.append(f"Context pack: {str(explorer.get('context_pack_path', '') or '').strip()}")
    if explorer.get("by_kind"):
        lines.append(f"Kinds: {json.dumps(explorer['by_kind'], ensure_ascii=False)}")
    read_order = explorer.get("recommended_read_order", []) if isinstance(explorer.get("recommended_read_order"), list) else []
    if read_order:
        lines.append("Read order:")
        for item in read_order[:5]:
            lines.append(f"- {str(item or '').strip()}")
    primary = explorer.get("primary_artifacts", []) if isinstance(explorer.get("primary_artifacts"), list) else []
    if primary:
        lines.append("Primary artifacts:")
        for artifact in primary[:6]:
            if not isinstance(artifact, dict):
                continue
            lines.append(f"- {str(artifact.get('kind', '') or '').strip()}: {str(artifact.get('path', '') or artifact.get('preview', '') or '').strip()}".rstrip(": "))
    related = explorer.get("related_thread_artifacts", []) if isinstance(explorer.get("related_thread_artifacts"), list) else []
    if related:
        lines.append("Related thread artifacts:")
        for artifact in related[:6]:
            if not isinstance(artifact, dict):
                continue
            lines.append(f"- {str(artifact.get('task_id', '') or '').strip()} · {str(artifact.get('kind', '') or '').strip()}: {str(artifact.get('path', '') or artifact.get('preview', '') or '').strip()}".rstrip(": "))
    return "\n".join(lines)


def render_substrate_text(summary: dict[str, Any]) -> str:
    lines = [
        "Substrate inventory",
        f"- Total tasks: `{int(summary.get('total_tasks', 0) or 0)}`",
        f"- Taskflow tracked: `{int(summary.get('taskflow_tracked', 0) or 0)}`",
        f"- Native bound: `{int(summary.get('native_bound', 0) or 0)}`",
        f"- Native preferred: `{int(summary.get('native_preferred', 0) or 0)}`",
        f"- Mirror only: `{int(summary.get('mirror_only', 0) or 0)}`",
        f"- Native unavailable fallback mirror: `{int(summary.get('native_unavailable_fallback_mirror', 0) or 0)}`",
        f"- Cleanup candidates: `{int(summary.get('cleanup_candidates', 0) or 0)}`",
        f"- Cleanup retention hours: `{int(summary.get('cleanup_retention_hours', 48) or 48)}`",
    ]
    if summary.get("route_counts"):
        lines.append(f"- Routes: `{json.dumps(summary['route_counts'], ensure_ascii=False)}`")
    if summary.get("flow_kind_counts"):
        lines.append(f"- Flow kinds: `{json.dumps(summary['flow_kind_counts'], ensure_ascii=False)}`")
    return "\n".join(lines)


def render_substrate_cleanup_text(payload: dict[str, Any], *, applied: bool = False) -> str:
    lines = [
        "Substrate cleanup" + (" (applied)" if applied else " (preview)"),
        f"- Retention hours: `{int(payload.get('retention_hours', 0) or 0)}`",
        f"- Candidates: `{int(payload.get('candidate_count', 0) or 0)}`",
    ]
    if applied:
        lines.append(f"- Removed: `{int(payload.get('removed_count', 0) or 0)}`")
        removed = payload.get("removed_task_ids", []) if isinstance(payload.get("removed_task_ids"), list) else []
        if removed:
            lines.append("- Removed task ids: `" + ", ".join(str(item) for item in removed) + "`")
    else:
        lines.append(f"- Eligible now: `{int(payload.get('eligible_count', 0) or 0)}`")
        candidates = payload.get("candidates", []) if isinstance(payload.get("candidates"), list) else []
        if candidates:
            lines.append("Candidates:")
            for item in candidates[:8]:
                if not isinstance(item, dict):
                    continue
                eligible = "eligible" if bool(item.get("eligible_now")) else "wait"
                age_hours = item.get("age_hours")
                age_label = f"{int(age_hours)}h" if isinstance(age_hours, int) else "unknown"
                task_id = str(item.get("task_id", "") or "").strip()
                route = str(item.get("route", "") or "").strip()
                create_status = str(item.get("create_status", "") or "").strip()
                lines.append(
                    f"- {task_id} | {route} | {create_status} | {age_label} | {eligible}"
                )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="OctoClaw task display CLI")
    parser.add_argument("--state-file", default=TASK_STATE_FILE)
    parser.add_argument("--format", choices=("text", "json"), default="text")
    sub = parser.add_subparsers(dest="command", required=True)

    p_anchor = sub.add_parser("anchor")
    p_anchor.add_argument("--id", required=True)

    p_detail = sub.add_parser("detail")
    p_detail.add_argument("--id", required=True)

    p_artifacts = sub.add_parser("artifacts")
    p_artifacts.add_argument("--id", required=True)

    p_retrieve = sub.add_parser("retrieve")
    p_retrieve.add_argument("--id", required=True)

    p_graph = sub.add_parser("graph")
    p_graph.add_argument("--id", required=True)

    p_timeline = sub.add_parser("timeline")
    p_timeline.add_argument("--id", required=True)

    p_explorer = sub.add_parser("explorer")
    p_explorer.add_argument("--id", required=True)

    sub.add_parser("queue")
    p_substrate = sub.add_parser("substrate")
    p_substrate.add_argument("--cleanup-preview", action="store_true")
    p_substrate.add_argument("--cleanup-apply", action="store_true")

    args = parser.parse_args()
    tasks = load_tasks(args.state_file)

    if args.command == "queue":
        queue_view = build_task_queue_view(tasks)
        if args.format == "json":
            print_json(queue_view)
        else:
            print(render_queue_text(queue_view))
        return 0

    if args.command == "substrate":
        if args.cleanup_apply:
            payload = cleanup_taskflow_mirror(tasks)
            if args.format == "json":
                print_json(payload)
            else:
                print(render_substrate_cleanup_text(payload, applied=True))
            return 0
        if args.cleanup_preview:
            payload = describe_taskflow_cleanup(tasks)
            if args.format == "json":
                print_json(payload)
            else:
                print(render_substrate_cleanup_text(payload, applied=False))
            return 0
        summary = summarize_taskflow_inventory(tasks)
        if args.format == "json":
            print_json(summary)
        else:
            print(render_substrate_text(summary))
        return 0

    task = find_task(tasks, getattr(args, "id", ""))
    if not task:
        print(f"task not found: {getattr(args, 'id', '')}", file=sys.stderr)
        return 1

    if args.command == "anchor":
        anchor = build_task_anchor(task)
        if args.format == "json":
            print_json(anchor)
        else:
            print(render_task_anchor_text(anchor, build_task_actions(task)))
        return 0

    if args.command == "detail":
        detail = build_task_detail(task, all_tasks=tasks)
        if args.format == "json":
            print_json(detail)
        else:
            print(render_detail_text(task, detail))
        return 0

    if args.command == "artifacts":
        detail = build_task_detail(task, all_tasks=tasks)
        artifacts = detail.get("artifacts", [])
        if args.format == "json":
            print_json(artifacts)
        else:
            if not artifacts:
                print("(no artifacts)")
            else:
                for artifact in artifacts:
                    title = str(artifact.get("title", "") or artifact.get("artifact_id", "artifact")).strip()
                    path = str(artifact.get("path", "") or artifact.get("preview", "") or "").strip()
                    print(f"- {title}: {path}".rstrip(": "))
        return 0

    if args.command == "retrieve":
        bundle = build_task_retrieval_bundle(task, all_tasks=tasks)
        if args.format == "json":
            print_json(bundle)
        else:
            print(render_retrieval_text(bundle))
        return 0

    if args.command == "graph":
        graph = build_task_graph(task, all_tasks=tasks)
        if args.format == "json":
            print_json(graph)
        else:
            print(render_graph_text(graph))
        return 0

    if args.command == "timeline":
        timeline = build_task_timeline(task, all_tasks=tasks)
        if args.format == "json":
            print_json(timeline)
        else:
            print(render_timeline_text(timeline))
        return 0

    if args.command == "explorer":
        explorer = build_task_artifact_explorer(task, all_tasks=tasks)
        if args.format == "json":
            print_json(explorer)
        else:
            print(render_explorer_text(explorer))
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
