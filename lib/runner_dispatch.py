#!/usr/bin/env python3
"""High-level dispatcher for Octopus runner jobs."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

from octopus_config import RUNNER_QUEUE_FILE, load_json, runner_operator_surface

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
QUEUE_PY = os.path.join(SCRIPT_DIR, "runner_queue.py")
TASK_STATE_PY = os.path.join(SCRIPT_DIR, "task-state-update.py")
RESOLVE_MODEL_PY = os.path.join(SCRIPT_DIR, "resolve-model.py")

ACTIVE_JOB_STATUSES = {"queued", "running"}
RECENT_DONE_REUSE_MINUTES = 10


def now_compact() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")


def expected_done_offset(timeout_seconds: int) -> str:
    # Runner jobs are lightweight; default ETA is a conservative fraction of timeout.
    eta_seconds = max(10, min(max(30, int(timeout_seconds * 0.25)), timeout_seconds))
    dt = datetime.now(timezone.utc).astimezone() + timedelta(seconds=eta_seconds)
    return dt.isoformat()


def run_json(cmd: list[str]) -> dict:
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"command failed: {' '.join(cmd)}")
    text = result.stdout.strip() or "{}"
    return json.loads(text)


def normalize_text(text: str) -> str:
    return " ".join((text or "").lower().split())


def parse_iso(value: str):
    if not value:
        return None
    try:
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def recent_minutes(value: str) -> float | None:
    dt = parse_iso(value)
    if dt is None:
        return None
    now = datetime.now(timezone.utc)
    return max(0.0, (now - dt.astimezone(timezone.utc)).total_seconds() / 60.0)


def find_reusable_job(command: str, task_description: str) -> dict | None:
    queue = load_json(RUNNER_QUEUE_FILE)
    if not isinstance(queue, dict):
        return None

    command_key = normalize_text(command)
    task_key = normalize_text(task_description)
    if not command_key and not task_key:
        return None

    for job in queue.get("jobs", []):
        if not isinstance(job, dict):
            continue
        status = str(job.get("status", "") or "")
        if status not in ACTIVE_JOB_STATUSES and status != "done":
            continue

        if status == "done":
            age = recent_minutes(str(job.get("finished_at", "") or ""))
            if age is None or age > RECENT_DONE_REUSE_MINUTES:
                continue

        same_command = command_key and normalize_text(str(job.get("command", "") or "")) == command_key
        same_task = task_key and normalize_text(str(job.get("task_description", "") or "")) == task_key
        if same_command or same_task:
            return job
    return None


def resolve_runner_model() -> str:
    result = subprocess.run(
        [
            "python3",
            RESOLVE_MODEL_PY,
            "--selector-band",
            "quick",
            "--worker-pool",
            "octoclaw-runner",
            "--phase",
            "inspect",
            "--route",
            "runner",
            "--profile",
            "ops-fast",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode == 0:
        return result.stdout.strip()
    return ""


def runner_artifacts() -> dict:
    surface = runner_operator_surface()
    return {
        "execution_backend": "runner_queue",
        "operator_surface": surface,
        "operator_hint": str(surface.get("operator_hint", "") or ""),
    }


def main():
    parser = argparse.ArgumentParser(description="Dispatch a lightweight job to the persistent Octopus runner")
    parser.add_argument("--id", default="")
    parser.add_argument("--command", required=True)
    parser.add_argument("--summary", default="")
    parser.add_argument("--cwd", default="/workspace")
    parser.add_argument("--timeout-seconds", dest="timeout_seconds", type=int, default=120)
    parser.add_argument("--model-band", dest="model_band", default="fast")
    parser.add_argument("--task-description", dest="task_description", default="")
    args = parser.parse_args()

    job_id = args.id or f"runner-{now_compact()}"
    reusable = find_reusable_job(args.command, args.task_description or args.command)
    if reusable:
        print(json.dumps(reusable, ensure_ascii=False))
        return
    model = resolve_runner_model()

    subprocess.run(
        [
            "python3",
            TASK_STATE_PY,
            "upsert",
            "--id",
            job_id,
            "--model",
            model,
            "--status",
            "queued",
            "--summary",
            args.summary or job_id,
            "--model-band",
            args.model_band,
            "--expected-done",
            expected_done_offset(args.timeout_seconds),
            "--task-description",
            args.task_description or args.command,
            "--title",
            args.summary or args.task_description or args.command,
            "--executor",
            "runner",
            "--route",
            "runner",
            "--runtime",
            "runner",
            "--worker-pool",
            "octoclaw-runner",
            "--work-type",
            "ops",
            "--phase",
            "inspect",
            "--protocol",
            "normal",
            "--profile",
            "ops-fast",
            "--review-required",
            "false",
            "--artifacts-json",
            json.dumps(runner_artifacts(), ensure_ascii=False),
        ],
        stdout=subprocess.DEVNULL,
        check=True,
    )

    payload = run_json(
        [
            "python3",
            QUEUE_PY,
            "enqueue",
            "--id",
            job_id,
            "--command",
            args.command,
            "--summary",
            args.summary or job_id,
            "--cwd",
            args.cwd,
            "--timeout-seconds",
            str(args.timeout_seconds),
            "--model-band",
            args.model_band,
            "--model",
            model,
            "--task-description",
            args.task_description or args.command,
        ]
    )
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
