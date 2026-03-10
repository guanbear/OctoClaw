#!/usr/bin/env python3
"""
task-state-update.py — atomic task-state.json writer with file lock.
Prevents concurrent sub-agent corruption of task-state.json.
"""

import argparse
import fcntl
import json
import os
import sys
from datetime import datetime, timezone, timedelta

STATE_FILE = "/workspace/tmp/octopus/task-state.json"


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def load_state(fp) -> dict:
    """Read and parse state file; tolerate bare list or malformed JSON."""
    fp.seek(0)
    raw = fp.read().strip()
    if not raw:
        return {"tasks": [], "updated_at": ""}
    try:
        data = json.loads(raw)
        if isinstance(data, list):
            return {"tasks": data, "updated_at": ""}
        if isinstance(data, dict) and "tasks" in data:
            return data
        return {"tasks": [], "updated_at": ""}
    except json.JSONDecodeError:
        return {"tasks": [], "updated_at": ""}


def save_state(fp, state: dict):
    """Truncate and rewrite the state file."""
    state["updated_at"] = now_iso()
    fp.seek(0)
    fp.truncate()
    fp.write(json.dumps(state, ensure_ascii=False, indent=2))
    fp.flush()


def cleanup_old(tasks: list) -> list:
    """Remove done/failed/deferred records older than 7 days."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=7)
    result = []
    for t in tasks:
        if t.get("status") in ("done", "failed", "deferred"):
            completed = t.get("completed_at") or t.get("spawned_at") or ""
            if completed:
                try:
                    dt = datetime.fromisoformat(completed)
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=timezone.utc)
                    if dt < cutoff:
                        continue
                except ValueError:
                    pass
        result.append(t)
    return result


def resolve_expected_done(value: str) -> str:
    """Convert '+Nmin' / '+Nh' offsets or return as-is."""
    if not value:
        return ""
    if value.startswith("+"):
        offset = value[1:]
        minutes = 0
        if offset.endswith("min"):
            minutes = int(offset[:-3])
        elif offset.endswith("h"):
            minutes = int(offset[:-1]) * 60
        else:
            minutes = int(offset)
        dt = datetime.now(timezone.utc).astimezone() + timedelta(minutes=minutes)
        return dt.isoformat()
    return value


def cmd_upsert(args):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "a+") as fp:
        fcntl.flock(fp, fcntl.LOCK_EX)
        state = load_state(fp)
        tasks = state["tasks"]

        # Find existing task by id
        existing = next((t for t in tasks if t.get("id") == args.id), None)

        if existing:
            # Update fields if provided
            if args.label:
                existing["label"] = args.label
            if args.model:
                existing["model"] = args.model
            if args.status:
                old_status = existing.get("status", "")
                existing["status"] = args.status
                if args.status == "running" and old_status != "running":
                    existing["started_at"] = now_iso()
            if args.summary:
                existing["summary"] = args.summary
            if args.files:
                existing["files_changed"] = [f.strip() for f in args.files.split(",") if f.strip()]
            if args.deps:
                existing["deps"] = [d.strip() for d in args.deps.split(",") if d.strip()]
            if args.expected_done:
                existing["expected_done_at"] = resolve_expected_done(args.expected_done)
            if args.tier:
                existing["tier"] = args.tier
            if args.task_description:
                existing["task_description"] = args.task_description
            if args.source:
                existing["source"] = args.source
            existing["updated_at"] = now_iso()
        else:
            record = {
                "id": args.id,
                "label": args.label or "",
                "model": args.model or "",
                "status": args.status or "dispatched",
                "summary": args.summary or "",
                "spawned_at": now_iso(),
                "updated_at": now_iso(),
            }
            if args.status == "running":
                record["started_at"] = now_iso()
            if args.files:
                record["files_changed"] = [f.strip() for f in args.files.split(",") if f.strip()]
            if args.deps:
                record["deps"] = [d.strip() for d in args.deps.split(",") if d.strip()]
            if args.expected_done:
                record["expected_done_at"] = resolve_expected_done(args.expected_done)
            if args.tier:
                record["tier"] = args.tier
            if args.task_description:
                record["task_description"] = args.task_description
            # 默认 source 为 octopus（八爪鱼任务）
            record["source"] = args.source if args.source else "octopus"
            tasks.append(record)

        state["tasks"] = tasks
        save_state(fp, state)
    print(f"[ok] upsert id={args.id} status={args.status or 'dispatched'}")


def cmd_done(args):
    _finish(args.id, "done", args.summary)


def cmd_failed(args):
    _finish(args.id, "failed", args.summary)


def _finish(task_id: str, status: str, summary: str):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "a+") as fp:
        fcntl.flock(fp, fcntl.LOCK_EX)
        state = load_state(fp)
        tasks = state["tasks"]

        existing = next((t for t in tasks if t.get("id") == task_id), None)
        if existing:
            existing["status"] = status
            existing["completed_at"] = now_iso()
            existing["updated_at"] = now_iso()
            if summary:
                existing["summary"] = summary
        else:
            tasks.append({
                "id": task_id,
                "status": status,
                "summary": summary or "",
                "completed_at": now_iso(),
                "spawned_at": now_iso(),
                "updated_at": now_iso(),
            })

        # Clean up old done/failed records
        state["tasks"] = cleanup_old(tasks)
        save_state(fp, state)
    print(f"[ok] {status} id={task_id}")


def cmd_list(args):
    if not os.path.exists(STATE_FILE):
        print("(no task-state.json found)")
        return
    with open(STATE_FILE, "r") as fp:
        fcntl.flock(fp, fcntl.LOCK_SH)
        state = load_state(fp)

    tasks = state.get("tasks", [])
    if not tasks:
        print("(no tasks)")
        return

    STATUS_ICON = {
        "dispatched": "🟡",
        "running":    "🔵",
        "done":       "✅",
        "failed":     "❌",
        "queued":     "⏸️",
        "pending_confirm": "❓",
        "deferred":   "⏳",
    }

    print(f"{'ID':<35} {'STATUS':<12} {'MODEL':<20} {'SUMMARY'}")
    print("-" * 90)
    for t in tasks:
        icon = STATUS_ICON.get(t.get("status", ""), "❔")
        sid = (t.get("id") or "")[:34]
        status = f"{icon} {t.get('status','')}"
        model = (t.get("model") or "")[:19]
        summary = (t.get("summary") or "")[:50]
        print(f"{sid:<35} {status:<14} {model:<20} {summary}")


def main():
    parser = argparse.ArgumentParser(description="Atomic task-state.json updater")
    sub = parser.add_subparsers(dest="command")

    # upsert
    p_upsert = sub.add_parser("upsert")
    p_upsert.add_argument("--id", required=True)
    p_upsert.add_argument("--label")
    p_upsert.add_argument("--model")
    p_upsert.add_argument("--status")
    p_upsert.add_argument("--summary")
    p_upsert.add_argument("--files")
    p_upsert.add_argument("--deps")
    p_upsert.add_argument("--expected-done", dest="expected_done")
    p_upsert.add_argument("--tier")
    p_upsert.add_argument("--task-description", dest="task_description")
    p_upsert.add_argument("--source")

    # done
    p_done = sub.add_parser("done")
    p_done.add_argument("--id", required=True)
    p_done.add_argument("--summary", default="")

    # failed
    p_failed = sub.add_parser("failed")
    p_failed.add_argument("--id", required=True)
    p_failed.add_argument("--summary", default="")

    # list
    sub.add_parser("list")

    args = parser.parse_args()
    if args.command == "upsert":
        cmd_upsert(args)
    elif args.command == "done":
        cmd_done(args)
    elif args.command == "failed":
        cmd_failed(args)
    elif args.command == "list":
        cmd_list(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
