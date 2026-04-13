#!/usr/bin/env python3
"""High-level dispatcher for OctoClaw runner jobs."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from typing import Any

from openclaw_taskflow_adapter import register_taskflow_binding
from octopus_config import RUNNER_QUEUE_FILE, WORKSPACE, load_json, runner_operator_surface
from runner_goal_contract import build_runner_goal_contract
from runtime_protocol import build_delegated_materialization
from task_events import append_task_event

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
    result = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=15)
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


def find_reusable_job(command: str) -> dict | None:
    queue = load_json(RUNNER_QUEUE_FILE)
    if not isinstance(queue, dict):
        return None

    command_key = normalize_text(command)
    if not command_key:
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

        same_command = normalize_text(str(job.get("command", "") or "")) == command_key
        if same_command:
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


def build_runner_materialization(job_id: str, *, session_key: str = "") -> dict[str, Any]:
    return build_delegated_materialization(
        lane="runner",
        kind="runner_playbook",
        status="materialized",
        execution_contract="inspect_report",
        runner_job_id=job_id,
        session_key=session_key,
        executed=True,
    )


def runner_artifacts(
    playbook: dict | None = None,
    taskflow_binding: dict | None = None,
    materialization: dict | None = None,
    goal_contract: dict | None = None,
) -> dict:
    surface = runner_operator_surface()
    payload = {
        "execution_backend": "runner_queue",
        "operator_surface": surface,
        "operator_hint": str(surface.get("operator_hint", "") or ""),
    }
    if isinstance(playbook, dict) and playbook:
        payload["runner_plan"] = dict(playbook)
    if isinstance(taskflow_binding, dict) and taskflow_binding:
        payload["openclaw_taskflow"] = dict(taskflow_binding)
    if isinstance(materialization, dict) and materialization:
        payload["delegated_materialization"] = dict(materialization)
    if isinstance(goal_contract, dict) and goal_contract:
        payload["goal_contract"] = dict(goal_contract)
    return payload


def build_runner_task_seed(
    job_id: str,
    args: argparse.Namespace,
    *,
    model: str,
    playbook: dict | None = None,
    materialization: dict | None = None,
    taskflow_binding: dict | None = None,
    goal_contract: dict | None = None,
) -> dict[str, Any]:
    return {
        "id": job_id,
        "model": model,
        "status": "queued",
        "summary": args.summary or job_id,
        "model_band": args.model_band or "fast",
        "task_description": args.task_description or args.command,
        "executor": "runner",
        "route": "runner",
        "runtime": "runner",
        "worker_pool": "octoclaw-runner",
        "work_type": "ops",
        "phase": "inspect",
        "protocol": "normal",
        "profile": "ops-fast",
        "review_required": False,
        "session_key": args.session_key or "",
        "session_id": args.session_id or "",
        "agent_id": args.agent_id or "",
        "agent_namespace": args.agent_namespace or "",
        "managed_by_octoclaw": args.managed_by_octoclaw or "",
        "artifacts": runner_artifacts(playbook, taskflow_binding, materialization, goal_contract),
    }


def main():
    parser = argparse.ArgumentParser(description="Dispatch a lightweight job to the persistent OctoClaw runner")
    parser.add_argument("--id", default="")
    parser.add_argument("--command", required=True)
    parser.add_argument("--summary", default="")
    parser.add_argument("--cwd", default=WORKSPACE)
    parser.add_argument("--timeout-seconds", dest="timeout_seconds", type=int, default=120)
    parser.add_argument("--model-band", dest="model_band", default="fast")
    parser.add_argument("--task-description", dest="task_description", default="")
    parser.add_argument("--session-key", dest="session_key", default="")
    parser.add_argument("--session-id", dest="session_id", default="")
    parser.add_argument("--agent-id", dest="agent_id", default="")
    parser.add_argument("--agent-namespace", dest="agent_namespace", default="")
    parser.add_argument("--managed-by-octoclaw", dest="managed_by_octoclaw", default="")
    parser.add_argument("--playbook-json", dest="playbook_json", default="")
    parser.add_argument("--goal-contract-json", dest="goal_contract_json", default="")
    args = parser.parse_args()

    job_id = args.id or f"runner-{now_compact()}"
    reusable = find_reusable_job(args.command)
    if reusable:
        print(json.dumps(reusable, ensure_ascii=False))
        return
    model = resolve_runner_model()
    playbook = {}
    if str(args.playbook_json or "").strip():
        try:
            parsed = json.loads(args.playbook_json)
            if isinstance(parsed, dict):
                playbook = parsed
        except json.JSONDecodeError:
            playbook = {}
    goal_contract = {}
    if str(args.goal_contract_json or "").strip():
        try:
            parsed = json.loads(args.goal_contract_json)
            if isinstance(parsed, dict):
                goal_contract = parsed
        except json.JSONDecodeError:
            goal_contract = {}
    materialization = build_runner_materialization(job_id, session_key=args.session_key or "")
    task_seed = build_runner_task_seed(
        job_id,
        args,
        model=model,
        playbook=playbook,
        materialization=materialization,
        goal_contract=goal_contract,
    )
    taskflow_binding = register_taskflow_binding(task_seed)
    goal_contract = build_runner_goal_contract(
        task=args.task_description or args.command,
        command=args.command,
        summary=args.summary or job_id,
        timeout_seconds=args.timeout_seconds,
        playbook=playbook,
        session_key=args.session_key or "",
        runner_job_id=job_id,
        task_id=job_id,
        taskflow_binding=taskflow_binding,
    ) if not goal_contract else build_runner_goal_contract(
        task=str(goal_contract.get("goal", "") or args.task_description or args.command),
        command=str(goal_contract.get("command", "") or args.command),
        summary=str(goal_contract.get("summary_hint", "") or args.summary or job_id),
        timeout_seconds=int(goal_contract.get("timeout_seconds", args.timeout_seconds) or args.timeout_seconds),
        playbook=playbook,
        session_key=str(goal_contract.get("session_key", "") or args.session_key or ""),
        runner_job_id=job_id,
        task_id=job_id,
        taskflow_binding=taskflow_binding,
    )
    artifacts = runner_artifacts(playbook, taskflow_binding, materialization, goal_contract)
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
            args.task_description or args.summary or job_id,
            "--model-band",
            args.model_band,
            "--expected-done",
            expected_done_offset(args.timeout_seconds),
            "--task-description",
            args.task_description or args.command,
            "--title",
            args.task_description or args.summary or args.command,
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
            json.dumps(artifacts, ensure_ascii=False),
            *(["--session-key", args.session_key] if args.session_key else []),
            *(["--session-id", args.session_id] if args.session_id else []),
            *(["--agent-id", args.agent_id] if args.agent_id else []),
            *(["--agent-namespace", args.agent_namespace] if args.agent_namespace else []),
            *(["--managed-by-octoclaw", args.managed_by_octoclaw] if args.managed_by_octoclaw else []),
        ],
        stdout=subprocess.DEVNULL,
        check=True,
        timeout=15,
    )
    append_task_event(
        {
            **task_seed,
            "artifacts": artifacts,
        },
        "task_bound",
        message="runner job bound to native taskflow",
        extra={
            "runner_job_id": job_id,
            "execution_backend": "runner_queue",
            "goal_contract": goal_contract,
            "taskflow_binding": taskflow_binding,
        },
    )
    append_task_event(
        {
            **task_seed,
            "artifacts": artifacts,
        },
        "dispatch_started",
        message="runner job queued for worker lease",
        extra={
            "runner_job_id": job_id,
            "execution_backend": "runner_queue",
            "progress_state": "queued",
        },
    )
    append_task_event(
        {
            **task_seed,
            "artifacts": artifacts,
        },
        "progress_note",
        message="runner queued and waiting for available worker",
        extra={
            "runner_job_id": job_id,
            "execution_backend": "runner_queue",
            "progress_state": "queued",
        },
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
            *(["--session-key", args.session_key] if args.session_key else []),
            *(["--session-id", args.session_id] if args.session_id else []),
            *(["--agent-id", args.agent_id] if args.agent_id else []),
            *(["--agent-namespace", args.agent_namespace] if args.agent_namespace else []),
            *(["--managed-by-octoclaw", args.managed_by_octoclaw] if args.managed_by_octoclaw else []),
            "--artifacts-json",
            json.dumps(artifacts, ensure_ascii=False),
        ]
    )
    if isinstance(payload, dict):
        payload.setdefault("artifacts", artifacts)
        payload.setdefault("goal_contract", goal_contract)
        if taskflow_binding:
            payload.setdefault("openclaw_taskflow", dict(taskflow_binding))
            payload.setdefault("openclaw_taskflow_backend", str(taskflow_binding.get("backend", "") or ""))
            payload.setdefault("openclaw_taskflow_state", str(taskflow_binding.get("binding_state", "") or ""))
            payload.setdefault("openclaw_task_runtime", str(taskflow_binding.get("task_runtime", "") or ""))
            payload.setdefault("openclaw_flow_runtime", str(taskflow_binding.get("flow_runtime", "") or ""))
            payload.setdefault("openclaw_task_id", str(taskflow_binding.get("task_id", "") or ""))
            payload.setdefault("openclaw_flow_id", str(taskflow_binding.get("flow_id", "") or ""))
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
