#!/usr/bin/env python3
"""OctoClaw runner queue helpers."""

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
    WORKSPACE,
    load_json,
)

TERMINAL_JOB_STATUSES = {"done", "failed"}
TERMINAL_JOB_RETENTION_HOURS = 48
MAX_TERMINAL_JOBS = 200
DEFAULT_HEARTBEAT_STALE_SECONDS = 120
DEFAULT_LEASE_TIMEOUT_SECONDS = 90


def parse_json_arg(value: str) -> dict[str, Any]:
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise argparse.ArgumentTypeError(f"invalid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise argparse.ArgumentTypeError("expected JSON object")
    return parsed


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


def _running_job_is_stale(
    job: dict[str, Any],
    *,
    now: datetime,
    health: dict[str, Any],
    lease_timeout_seconds: int,
    heartbeat_stale_seconds: int,
) -> bool:
    if not isinstance(job, dict) or str(job.get("status", "") or "").strip().lower() != "running":
        return False
    started = parse_iso(str(job.get("started_at", "") or ""))
    if started and started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    worker_id = str(job.get("worker_id", "") or "").strip()
    if started is None:
        return True
    age_seconds = max(0, int((now - started.astimezone(timezone.utc)).total_seconds()))
    if age_seconds < max(1, int(lease_timeout_seconds or DEFAULT_LEASE_TIMEOUT_SECONDS)):
        return False
    health_worker_id = str(health.get("worker_id", "") or "").strip()
    heartbeat = parse_iso(str(health.get("last_heartbeat_at", "") or ""))
    heartbeat_fresh = False
    if heartbeat is not None:
        if heartbeat.tzinfo is None:
            heartbeat = heartbeat.replace(tzinfo=timezone.utc)
        heartbeat_age = max(0, int((now - heartbeat.astimezone(timezone.utc)).total_seconds()))
        heartbeat_fresh = heartbeat_age <= max(1, int(heartbeat_stale_seconds or DEFAULT_HEARTBEAT_STALE_SECONDS))
    if not worker_id:
        return True
    if not health_worker_id:
        return True
    if worker_id != health_worker_id:
        return True
    return not heartbeat_fresh


def recover_stale_running_jobs(
    *,
    lease_timeout_seconds: int = DEFAULT_LEASE_TIMEOUT_SECONDS,
    heartbeat_stale_seconds: int = DEFAULT_HEARTBEAT_STALE_SECONDS,
) -> dict[str, Any]:
    health = load_json(RUNNER_HEALTH_FILE)
    health = health if isinstance(health, dict) else {}
    now = datetime.now(timezone.utc)

    def mutate(state):
        recovered: list[dict[str, Any]] = []
        for job in state.get("jobs", []):
            if not _running_job_is_stale(
                job,
                now=now,
                health=health,
                lease_timeout_seconds=lease_timeout_seconds,
                heartbeat_stale_seconds=heartbeat_stale_seconds,
            ):
                continue
            worker_id = str(job.get("worker_id", "") or "").strip()
            job["status"] = "failed"
            job["finished_at"] = now_iso()
            job["exit_code"] = 124
            job["summary"] = f"Runner lease expired before completion · worker={worker_id or 'unknown'}"
            job["failure_reason"] = "runner_lease_expired"
            recovered.append(
                {
                    "id": str(job.get("id", "") or ""),
                    "worker_id": worker_id,
                    "failure_reason": "runner_lease_expired",
                }
            )
        return recovered

    recovered = with_queue_lock(mutate)
    return {
        "recovered_count": len(recovered),
        "jobs": recovered,
        "health_worker_id": str(health.get("worker_id", "") or ""),
    }


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
        worker_pool_model = policy.get("worker_pools", {}).get("octoclaw-runner")
        if isinstance(worker_pool_model, str) and worker_pool_model:
            return worker_pool_model
        main_model = str(policy.get("main_model", "") or "").strip()
        if main_model:
            return main_model
    return ""


def _promote_taskflow_fields(job: dict[str, Any], artifacts: dict[str, Any]) -> None:
    if not isinstance(job, dict) or not isinstance(artifacts, dict):
        return
    binding = artifacts.get("openclaw_taskflow", {})
    if not isinstance(binding, dict) or not binding:
        return
    job["openclaw_taskflow"] = dict(binding)
    job["openclaw_taskflow_backend"] = str(binding.get("backend", "") or "")
    job["openclaw_taskflow_state"] = str(binding.get("binding_state", "") or "")
    job["openclaw_task_runtime"] = str(binding.get("task_runtime", "") or "")
    job["openclaw_flow_runtime"] = str(binding.get("flow_runtime", "") or "")
    job["openclaw_task_id"] = str(binding.get("task_id", "") or "")
    job["openclaw_flow_id"] = str(binding.get("flow_id", "") or "")
    job["openclaw_flow_kind"] = str(binding.get("flow_kind", "") or "")


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
        artifacts = dict(args.artifacts_json) if isinstance(args.artifacts_json, dict) else {}
        job = {
            "id": args.id,
            "summary": args.summary or args.id,
            "command": args.shell_command,
            "cwd": args.cwd or WORKSPACE,
            "timeout_seconds": args.timeout_seconds,
            "status": "queued",
            "model_band": args.model_band or "fast",
            "source": "octoclaw",
            "enqueued_at": now_iso(),
            "model": args.model or runner_model(),
            "task_description": args.task_description or args.shell_command,
            "worker_pool": "octoclaw-runner",
            "work_type": "ops",
            "phase": "inspect",
            "session_key": args.session_key or "",
            "session_id": args.session_id or "",
            "agent_id": args.agent_id or "",
            "agent_namespace": args.agent_namespace or "",
            "managed_by_octoclaw": args.managed_by_octoclaw or "",
            "route": "runner",
            "runtime": "runner",
            "executor": "runner",
            "artifacts": artifacts,
        }
        _promote_taskflow_fields(job, artifacts)
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
    existing = load_json(RUNNER_HEALTH_FILE)
    existing = existing if isinstance(existing, dict) else {}
    previous_worker_id = str(existing.get("worker_id", "") or "").strip()
    same_worker = previous_worker_id and previous_worker_id == args.worker_id
    base_failure_streak = int(existing.get("failure_streak", 0) or 0) if same_worker else 0
    job_status = str(args.job_status or "").strip().lower()
    failure_streak = base_failure_streak
    if job_status == "failed":
        failure_streak += 1
    elif job_status == "done":
        failure_streak = 0

    payload = {
        "worker_id": args.worker_id,
        "pid": args.pid,
        "job_id": args.job_id or "",
        "jobs_completed": args.jobs_completed,
        "started_at": args.started_at or now_iso(),
        "last_heartbeat_at": now_iso(),
        "failure_streak": failure_streak,
        "last_job_status": job_status or str(existing.get("last_job_status", "") or ""),
        "last_job_id": args.job_id or str(existing.get("last_job_id", "") or ""),
    }
    if job_status == "failed":
        payload["last_failure_at"] = now_iso()
        if same_worker and str(existing.get("last_success_at", "") or "").strip():
            payload["last_success_at"] = str(existing.get("last_success_at", "") or "")
    elif job_status == "done":
        payload["last_success_at"] = now_iso()
        if same_worker and str(existing.get("last_failure_at", "") or "").strip():
            payload["last_failure_at"] = str(existing.get("last_failure_at", "") or "")
    else:
        if same_worker and str(existing.get("last_failure_at", "") or "").strip():
            payload["last_failure_at"] = str(existing.get("last_failure_at", "") or "")
        if same_worker and str(existing.get("last_success_at", "") or "").strip():
            payload["last_success_at"] = str(existing.get("last_success_at", "") or "")
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


def cmd_reap_stale(args):
    print(
        json.dumps(
            recover_stale_running_jobs(
                lease_timeout_seconds=args.lease_timeout_seconds,
                heartbeat_stale_seconds=args.heartbeat_stale_seconds,
            ),
            ensure_ascii=False,
        )
    )


def main():
    parser = argparse.ArgumentParser(description="OctoClaw runner queue")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("ensure")

    p_enqueue = sub.add_parser("enqueue")
    p_enqueue.add_argument("--id", required=True)
    p_enqueue.add_argument("--command", dest="shell_command", required=True)
    p_enqueue.add_argument("--summary", default="")
    p_enqueue.add_argument("--cwd", default=WORKSPACE)
    p_enqueue.add_argument("--timeout-seconds", dest="timeout_seconds", type=int, default=120)
    p_enqueue.add_argument("--model-band", dest="model_band", default="fast")
    p_enqueue.add_argument("--model", default="")
    p_enqueue.add_argument("--task-description", dest="task_description", default="")
    p_enqueue.add_argument("--session-key", dest="session_key", default="")
    p_enqueue.add_argument("--session-id", dest="session_id", default="")
    p_enqueue.add_argument("--agent-id", dest="agent_id", default="")
    p_enqueue.add_argument("--agent-namespace", dest="agent_namespace", default="")
    p_enqueue.add_argument("--managed-by-octoclaw", dest="managed_by_octoclaw", default="")
    p_enqueue.add_argument("--artifacts-json", dest="artifacts_json", type=parse_json_arg, default={})

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
    p_heartbeat.add_argument("--job-status", dest="job_status", choices=["done", "failed"], default="")

    sub.add_parser("status")

    p_reap_stale = sub.add_parser("reap-stale")
    p_reap_stale.add_argument("--lease-timeout-seconds", dest="lease_timeout_seconds", type=int, default=DEFAULT_LEASE_TIMEOUT_SECONDS)
    p_reap_stale.add_argument("--heartbeat-stale-seconds", dest="heartbeat_stale_seconds", type=int, default=DEFAULT_HEARTBEAT_STALE_SECONDS)

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
    elif args.command == "reap-stale":
        cmd_reap_stale(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
