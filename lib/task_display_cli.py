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

from runtime_task_record import normalize_task_records
from task_display import build_task_actions, build_task_anchor, build_task_detail, build_task_queue_view, build_task_retrieval_bundle, render_task_anchor_text

WORKSPACE = os.environ.get("WORKSPACE", "/workspace")
TASK_STATE_FILE = f"{WORKSPACE}/tmp/octopus/task-state.json"


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
    return normalize_task_records(tasks if isinstance(tasks, list) else [])


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
    lineage = detail.get("lineage", {}) if isinstance(detail.get("lineage"), dict) else {}
    if lineage.get("child_task_ids"):
        lines.append("Children: " + ", ".join(str(item) for item in lineage.get("child_task_ids", [])))
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
    summary = str(bundle.get("user_safe_summary", "") or bundle.get("summary", "") or "").strip()
    if summary:
        lines.append(f"Summary: {summary}")
    next_step = str(bundle.get("next_step", "") or "").strip()
    if next_step and next_step.lower() != "none":
        lines.append(f"Next: {next_step}")
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

    sub.add_parser("queue")

    args = parser.parse_args()
    tasks = load_tasks(args.state_file)

    if args.command == "queue":
        queue_view = build_task_queue_view(tasks)
        if args.format == "json":
            print_json(queue_view)
        else:
            print(render_queue_text(queue_view))
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

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
