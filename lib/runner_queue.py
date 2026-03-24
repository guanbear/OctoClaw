#!/usr/bin/env python3
"""Octopus runner queue helpers."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Any

from octopus_config import (
    MODEL_POLICY_FILE,
    RUNNER_HEALTH_FILE,
    RUNNER_QUEUE_FILE,
    RUNNER_RESULTS_DIR,
    load_json,
)

TERMINAL_JOB_STATUSES = {"done", "failed"}
TERMINAL_JOB_RETENTION_HOURS = 48
MAX_TERMINAL_JOBS = 200


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def ensure_parent(path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)


def load_state(fp) -> dict[str, Any]:
    fp.seek(0)
    raw = fp.read().strip()
    if not raw:
        return {"jobs": [], "updated_at": ""}
    try:
        data = json.loads(raw)
        if isinstance(data, dict) and isinstance(data.get("jobs"), list):
            return data
    except json.JSONDecodeError:
        pass
    return {"jobs": [], "updated_at": ""}


def save_state(fp, state: dict[str, Any]) -> None:
    state["jobs"] = prune_jobs(state.get("jobs", []))
    state["updated_at"] = now_iso()
    fp.seek(0)
    fp.truncate()
    fp.write(json.dumps(state, ensure_ascii=False, indent=2))
    fp.flush()


def parse_iso(value: str):
    if not value:
        return None
    try:
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        return datetime.fromisoformat(value)
    except Exception:
        return None


def cleanup_result_artifacts(job: dict[str, Any]) -> None:
    result_path = str(job.get("result_path", "") or "")
    meta = load_json(result_path) if result_path else None
    for path in [
        result_path,
        str((meta or {}).get("stdout_file", "") or ""),
        str((meta or {}).get("stderr_file", "") or ""),
    ]:
        if not path:
            continue
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass


def prune_jobs(jobs: list[Any]) -> list[Any]:
    normalized = [job for job in jobs if isinstance(job, dict)]
    if not normalized:
        return []

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=TERMINAL_JOB_RETENTION_HOURS)
    kept: list[dict[str, Any]] = []
    terminal_jobs: list[dict[str, Any]] = []

    for job in normalized:
        status = str(job.get("status", "") or "")
        if status in TERMINAL_JOB_STATUSES:
            terminal_jobs.append(job)
            continue
        kept.append(job)

    fresh_terminal: list[dict[str, Any]] = []
    stale_terminal: list[dict[str, Any]] = []
    for job in terminal_jobs:
        finished = parse_iso(str(job.get("finished_at", "") or ""))
        if finished and finished.tzinfo is None:
            finished = finished.replace(tzinfo=timezone.utc)
        if finished and finished.astimezone(timezone.utc) < cutoff:
            stale_terminal.append(job)
        else:
            fresh_terminal.append(job)

    fresh_terminal.sort(key=lambda item: str(item.get("finished_at", "") or item.get("started_at", "") or item.get("enqueued_at", "")))
    overflow = max(0, len(fresh_terminal) - MAX_TERMINAL_JOBS)
    if overflow:
        stale_terminal.extend(fresh_terminal[:overflow])
        fresh_terminal = fresh_terminal[overflow:]

    for job in stale_terminal:
        cleanup_result_artifacts(job)

    kept.extend(fresh_terminal)
    return kept


def runner_model() -> str:
    policy = load_json(MODEL_POLICY_FILE) or {}
    if isinstance(policy, dict):
        label_model = policy.get("labels", {}).get("octopus-runner")
        if isinstance(label_model, str) and label_model:
            return label_model
    return ""


def cmd_ensure(_args):
    ensure_parent(RUNNER_QUEUE_FILE)
    ensure_parent(RUNNER_HEALTH_FILE)
    os.makedirs(RUNNER_RESULTS_DIR, exist_ok=True)
    if not os.path.exists(RUNNER_QUEUE_FILE):
        with open(RUNNER_QUEUE_FILE, "w", encoding="utf-8") as fp:
            json.dump({"jobs": [], "updated_at": now_iso()}, fp, ensure_ascii=False, indent=2)
    print(json.dumps({"queue": RUNNER_QUEUE_FILE, "results_dir": RUNNER_RESULTS_DIR}, ensure_ascii=False))


def with_queue_lock(fn):
    ensure_parent(RUNNER_QUEUE_FILE)
    with open(RUNNER_QUEUE_FILE, "a+", encoding="utf-8") as fp:
        fcntl.flock(fp, fcntl.LOCK_EX)
        state = load_state(fp)
        result = fn(state)
        save_state(fp, state)
        fcntl.flock(fp, fcntl.LOCK_UN)
    return result


def cmd_enqueue(args):
    def mutate(state):
        jobs = state["jobs"]
        existing = next((job for job in jobs if job.get("id") == args.id), None)
        job = {
            "id": args.id,
            "label": "octopus-runner",
            "summary": args.summary or args.id,
            "command": args.shell_command,
            "cwd": args.cwd or "/workspace",
            "timeout_seconds": args.timeout_seconds,
            "status": "queued",
            "tier": args.tier or "trivial",
            "source": "octopus",
            "enqueued_at": now_iso(),
            "model": args.model or runner_model(),
            "task_description": args.task_description or args.shell_command,
        }
        if existing:
            existing.update(job)
        else:
            jobs.append(job)
        return job

    job = with_queue_lock(mutate)
    print(json.dumps(job, ensure_ascii=False))


def cmd_claim(args):
    def mutate(state):
        for job in state["jobs"]:
            if job.get("status") == "queued":
                job["status"] = "running"
                job["worker_id"] = args.worker_id
                job["started_at"] = now_iso()
                return job
        return {}

    print(json.dumps(with_queue_lock(mutate), ensure_ascii=False))


def cmd_complete(args):
    def mutate(state):
        for job in state["jobs"]:
            if job.get("id") == args.id:
                job["status"] = args.status
                job["finished_at"] = now_iso()
                job["exit_code"] = args.exit_code
                if args.result_path:
                    job["result_path"] = args.result_path
                if args.summary:
                    job["summary"] = args.summary
                return job
        return {}

    print(json.dumps(with_queue_lock(mutate), ensure_ascii=False))


def cmd_heartbeat(args):
    ensure_parent(RUNNER_HEALTH_FILE)
    payload = {
        "worker_id": args.worker_id,
        "pid": args.pid,
        "job_id": args.job_id or "",
        "jobs_completed": args.jobs_completed,
        "started_at": args.started_at or now_iso(),
        "last_heartbeat_at": now_iso(),
    }
    with open(RUNNER_HEALTH_FILE, "w", encoding="utf-8") as fp:
        json.dump(payload, fp, ensure_ascii=False, indent=2)
    print(json.dumps(payload, ensure_ascii=False))


def cmd_status(_args):
    raw = load_json(RUNNER_QUEUE_FILE) or {}
    health = load_json(RUNNER_HEALTH_FILE) or {}
    jobs = raw.get("jobs", []) if isinstance(raw, dict) else []
    payload = {
        "queued": len([job for job in jobs if job.get("status") == "queued"]),
        "running": len([job for job in jobs if job.get("status") == "running"]),
        "done": len([job for job in jobs if job.get("status") == "done"]),
        "failed": len([job for job in jobs if job.get("status") == "failed"]),
        "health": health,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Octopus runner queue")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("ensure")

    p_enqueue = sub.add_parser("enqueue")
    p_enqueue.add_argument("--id", required=True)
    p_enqueue.add_argument("--command", dest="shell_command", required=True)
    p_enqueue.add_argument("--summary", default="")
    p_enqueue.add_argument("--cwd", default="/workspace")
    p_enqueue.add_argument("--timeout-seconds", dest="timeout_seconds", type=int, default=120)
    p_enqueue.add_argument("--tier", default="trivial")
    p_enqueue.add_argument("--model", default="")
    p_enqueue.add_argument("--task-description", dest="task_description", default="")

    p_claim = sub.add_parser("claim")
    p_claim.add_argument("--worker-id", required=True)

    p_complete = sub.add_parser("complete")
    p_complete.add_argument("--id", required=True)
    p_complete.add_argument("--status", choices=["done", "failed"], required=True)
    p_complete.add_argument("--summary", default="")
    p_complete.add_argument("--exit-code", dest="exit_code", type=int, default=0)
    p_complete.add_argument("--result-path", dest="result_path", default="")

    p_heartbeat = sub.add_parser("heartbeat")
    p_heartbeat.add_argument("--worker-id", required=True)
    p_heartbeat.add_argument("--pid", type=int, required=True)
    p_heartbeat.add_argument("--job-id", default="")
    p_heartbeat.add_argument("--jobs-completed", dest="jobs_completed", type=int, default=0)
    p_heartbeat.add_argument("--started-at", dest="started_at", default="")

    sub.add_parser("status")

    args = parser.parse_args()
    if args.command == "ensure":
        cmd_ensure(args)
    elif args.command == "enqueue":
        cmd_enqueue(args)
    elif args.command == "claim":
        cmd_claim(args)
    elif args.command == "complete":
        cmd_complete(args)
    elif args.command == "heartbeat":
        cmd_heartbeat(args)
    elif args.command == "status":
        cmd_status(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
