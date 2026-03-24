#!/usr/bin/env python3
"""High-level dispatcher for Octopus runner jobs."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
QUEUE_PY = os.path.join(SCRIPT_DIR, "runner_queue.py")
TASK_STATE_PY = os.path.join(SCRIPT_DIR, "task-state-update.py")
RESOLVE_MODEL_PY = os.path.join(SCRIPT_DIR, "resolve-model.py")


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


def resolve_runner_model() -> str:
    result = subprocess.run(
        ["python3", RESOLVE_MODEL_PY, "--tier", "trivial", "--label", "octopus-runner"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode == 0:
        return result.stdout.strip()
    return ""


def main():
    parser = argparse.ArgumentParser(description="Dispatch a lightweight job to the persistent Octopus runner")
    parser.add_argument("--id", default="")
    parser.add_argument("--command", required=True)
    parser.add_argument("--summary", default="")
    parser.add_argument("--cwd", default="/workspace")
    parser.add_argument("--timeout-seconds", dest="timeout_seconds", type=int, default=120)
    parser.add_argument("--tier", default="trivial")
    parser.add_argument("--task-description", dest="task_description", default="")
    args = parser.parse_args()

    job_id = args.id or f"runner-{now_compact()}"
    model = resolve_runner_model()

    subprocess.run(
        [
            "python3",
            TASK_STATE_PY,
            "upsert",
            "--id",
            job_id,
            "--label",
            "octopus-runner",
            "--model",
            model,
            "--status",
            "queued",
            "--summary",
            args.summary or job_id,
            "--tier",
            args.tier,
            "--expected-done",
            expected_done_offset(args.timeout_seconds),
            "--task-description",
            args.task_description or args.command,
            "--executor",
            "runner",
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
            "--tier",
            args.tier,
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
