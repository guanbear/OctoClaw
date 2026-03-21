#!/usr/bin/env python3
"""Minimal replay/eval harness for OctoClaw."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from model_pricing import estimate_task_cost_usd


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
DISPATCH_PY = SCRIPT_DIR / "dispatch_task.py"
RUNNER_QUEUE_PY = SCRIPT_DIR / "runner_queue.py"
RUNNER_LOOP_SH = SCRIPT_DIR / "runner_loop.sh"


def now_compact() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def run_cmd(cmd: list[str], env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, check=False, env=env)


def load_tasks(path: Path) -> list[dict]:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError("task file must be a JSON array")
    return data


def summarize_markdown(report: dict) -> str:
    lines = [
        "# OctoClaw Eval Report",
        "",
        f"- Generated at: `{report['generated_at']}`",
        f"- Task file: `{report['task_file']}`",
        f"- Workspace: `{report['workspace']}`",
        "",
        "## Summary",
        "",
        f"- Total tasks: `{report['summary']['total']}`",
        f"- Expected route matches: `{report['summary']['route_matches']}/{report['summary']['total']}`",
        f"- Runner tasks: `{report['summary']['runner_tasks']}`",
        f"- Spawn tasks: `{report['summary']['spawn_tasks']}`",
        f"- Total estimated cost USD: `{report['summary']['total_estimated_cost_usd']}`",
        "",
        "## Results",
        "",
        "| ID | Route | Expected | Match | Elapsed ms | Model | Tier | Cost USD |",
        "| --- | --- | --- | --- | ---: | --- | --- | ---: |",
    ]
    for item in report["results"]:
        lines.append(
            f"| {item['id']} | {item['route']} | {item.get('expect_route','')} | "
            f"{'yes' if item.get('route_match') else 'no'} | {item['elapsed_ms']} | "
            f"{item.get('model','')} | {item.get('tier','')} | {item.get('estimated_cost_usd', 0)} |"
        )
    lines.append("")
    return "\n".join(lines)


def execute_runner_job(workspace: str) -> None:
    env = dict(os.environ)
    env["WORKSPACE"] = workspace
    env["RUNNER_MAX_JOBS_PER_WORKER"] = "1"
    result = run_cmd(["bash", str(RUNNER_LOOP_SH)], env=env)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "runner loop failed")


def main():
    parser = argparse.ArgumentParser(description="Minimal replay/eval for OctoClaw")
    parser.add_argument("--tasks", default=str(PROJECT_DIR / "eval" / "tasks-minimal.json"))
    parser.add_argument("--workspace", default="")
    parser.add_argument("--output-dir", default=str(PROJECT_DIR / "eval" / "reports"))
    args = parser.parse_args()

    task_file = Path(args.tasks).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    workspace = args.workspace
    if not workspace:
        workspace = tempfile.mkdtemp(prefix="octoclaw-eval-")

    env = dict(os.environ)
    env["WORKSPACE"] = workspace

    ensure = run_cmd(["python3", str(RUNNER_QUEUE_PY), "ensure"], env=env)
    if ensure.returncode != 0:
        raise SystemExit(ensure.stderr.strip() or ensure.stdout.strip() or "runner queue ensure failed")

    tasks = load_tasks(task_file)
    results = []

    for task in tasks:
        start = time.time()
        cmd = [
            "python3",
            str(DISPATCH_PY),
            "--task",
            task["task"],
            "--cwd",
            workspace,
        ]
        if task.get("command"):
            cmd.extend(["--command", task["command"]])
        if task.get("summary"):
            cmd.extend(["--summary", task["summary"]])

        dispatch = run_cmd(cmd, env=env)
        elapsed_ms = int((time.time() - start) * 1000)
        if dispatch.returncode != 0:
            payload = {
                "id": task["id"],
                "task": task["task"],
                "route": "error",
                "expect_route": task.get("expect_route", ""),
                "route_match": False,
                "elapsed_ms": elapsed_ms,
                "error": dispatch.stderr.strip() or dispatch.stdout.strip(),
            }
            results.append(payload)
            continue

        payload = json.loads(dispatch.stdout.strip())
        route = payload.get("route", "")

        if route == "runner" and payload.get("executed"):
            exec_start = time.time()
            execute_runner_job(workspace)
            elapsed_ms += int((time.time() - exec_start) * 1000)
            job = payload.get("job", {})
            model = job.get("model", "")
            tier = job.get("tier", "trivial")
        else:
            model = payload.get("model", "")
            tier = payload.get("tier", "")

        est_cost = estimate_task_cost_usd(model, {"trivial": 800, "simple": 2000, "normal": 5000, "hard": 10000, "deep": 20000}.get(tier, 5000)) or 0.0

        results.append(
            {
                "id": task["id"],
                "task": task["task"],
                "route": route,
                "expect_route": task.get("expect_route", ""),
                "route_match": route == task.get("expect_route", ""),
                "elapsed_ms": elapsed_ms,
                "model": model,
                "tier": tier,
                "estimated_cost_usd": round(est_cost, 6),
            }
        )

    summary = {
        "total": len(results),
        "route_matches": len([r for r in results if r.get("route_match")]),
        "runner_tasks": len([r for r in results if r.get("route") == "runner"]),
        "spawn_tasks": len([r for r in results if r.get("route") == "spawn"]),
        "total_estimated_cost_usd": round(sum(float(r.get("estimated_cost_usd", 0.0)) for r in results), 6),
    }

    report = {
        "generated_at": datetime.now(timezone.utc).astimezone().isoformat(),
        "task_file": str(task_file),
        "workspace": workspace,
        "summary": summary,
        "results": results,
    }

    stamp = now_compact()
    json_path = output_dir / f"eval-report-{stamp}.json"
    md_path = output_dir / f"eval-report-{stamp}.md"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(summarize_markdown(report))

    print(json.dumps({"json": str(json_path), "markdown": str(md_path), "summary": summary}, ensure_ascii=False))


if __name__ == "__main__":
    main()
