#!/usr/bin/env python3
"""Minimal replay/eval harness for OctoClaw."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

try:
    from model_pricing import estimate_task_cost_usd
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.model_pricing import estimate_task_cost_usd

try:
    from eval_state_machine import DEFAULT_CASES_FILE as DEFAULT_STATE_MACHINE_TASKS_FILE, run_state_machine_eval
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.eval_state_machine import DEFAULT_CASES_FILE as DEFAULT_STATE_MACHINE_TASKS_FILE, run_state_machine_eval


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
DISPATCH_PY = SCRIPT_DIR / "dispatch_task.py"
RUNNER_QUEUE_PY = SCRIPT_DIR / "runner_queue.py"
RUNNER_LOOP_SH = SCRIPT_DIR / "runner_loop.sh"
DEFAULT_ROUTE_TASKS_FILE = PROJECT_DIR / "eval" / "tasks-minimal.json"
DEFAULT_OUTPUT_DIR = PROJECT_DIR / "eval" / "reports"


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
        f"- Expected work-contract matches: `{report['summary']['work_contract_matches']}/{report['summary']['total']}`",
        f"- Direct tasks: `{report['summary']['direct_tasks']}`",
        f"- Runner tasks: `{report['summary']['runner_tasks']}`",
        f"- Spawn single tasks: `{report['summary']['spawn_single_tasks']}`",
        f"- Spawn multi tasks: `{report['summary']['spawn_multi_tasks']}`",
        f"- Delegated tasks: `{report['summary']['delegated_tasks']}`",
        f"- Average elapsed ms: `{report['summary']['avg_elapsed_ms']}`",
        f"- Average spawn count: `{report['summary']['avg_spawn_count']}`",
        f"- Invalid delegation count: `{report['summary']['invalid_delegation_count']}`",
        f"- Total estimated cost USD: `{report['summary']['total_estimated_cost_usd']}`",
        f"- Avg estimated cost USD: `{report['summary']['avg_estimated_cost_usd']}`",
        f"- Budget caps: `{json.dumps(report['summary']['budget_cap_counts'], ensure_ascii=False)}`",
        "",
        "## Results",
        "",
        "| ID | Route | Contract | Expected | Match | Elapsed ms | Spawn | Model | Band | Budget | Cost USD |",
        "| --- | --- | --- | --- | --- | ---: | ---: | --- | --- | --- | ---: |",
    ]
    for item in report["results"]:
        lines.append(
            f"| {item['id']} | {item['route']} | {item.get('work_contract','')} | {item.get('expect_route','')} | "
            f"{'yes' if item.get('route_match') and item.get('work_contract_match', True) else 'no'} | {item['elapsed_ms']} | {item.get('spawn_count', 0)} | "
            f"{item.get('model','')} | {item.get('model_band','')} | {item.get('budget_cap','')} | {item.get('estimated_cost_usd', 0)} |"
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


def normalize_expected_route(value: str) -> str:
    route = str(value or "").strip()
    if route == "spawn":
        return "delegated"
    return route


def route_matches_expected(actual_route: str, expected_route: str) -> bool:
    expected = normalize_expected_route(expected_route)
    actual = str(actual_route or "").strip()
    if not expected:
        return True
    if expected == "delegated":
        return actual in {"spawn_single", "spawn_multi"}
    return actual == expected


def estimate_eval_token_budget(route: str, budget_policy: dict[str, object] | None = None) -> int:
    budget_policy = budget_policy if isinstance(budget_policy, dict) else {}
    budget_cap = str(budget_policy.get("budget_cap", "") or "").strip()
    max_workers = int(budget_policy.get("max_workers", 0) or 0)
    defaults = {
        "direct": 1200,
        "runner": 1800,
        "spawn_single": 7000,
        "spawn_multi": 14000,
    }
    budget_cap_defaults = {
        "tiny": 1000,
        "low": 2500,
        "medium": 7000,
        "high": 14000,
    }
    tokens = budget_cap_defaults.get(budget_cap, defaults.get(route, 5000))
    if route == "spawn_multi" and max_workers > 1:
        tokens = max(tokens, 5000 * max_workers)
    return tokens


def summarize_results(results: list[dict]) -> dict[str, object]:
    budget_cap_counts = Counter(str(item.get("budget_cap", "") or "").strip() for item in results if str(item.get("budget_cap", "") or "").strip())
    total = len(results)
    total_cost = round(sum(float(item.get("estimated_cost_usd", 0.0) or 0.0) for item in results), 6)
    total_elapsed = sum(int(item.get("elapsed_ms", 0) or 0) for item in results)
    total_spawn = sum(int(item.get("spawn_count", 0) or 0) for item in results)
    return {
        "total": total,
        "route_matches": len([item for item in results if item.get("route_match")]),
        "work_contract_matches": len([item for item in results if item.get("work_contract_match", True)]),
        "direct_tasks": len([item for item in results if item.get("route") == "direct"]),
        "runner_tasks": len([item for item in results if item.get("route") == "runner"]),
        "spawn_single_tasks": len([item for item in results if item.get("route") == "spawn_single"]),
        "spawn_multi_tasks": len([item for item in results if item.get("route") == "spawn_multi"]),
        "delegated_tasks": len([item for item in results if item.get("route") in {"spawn_single", "spawn_multi"}]),
        "avg_elapsed_ms": int(total_elapsed / total) if total else 0,
        "avg_spawn_count": round(total_spawn / total, 3) if total else 0.0,
        "invalid_delegation_count": len(
            [
                item
                for item in results
                if item.get("route") in {"spawn_single", "spawn_multi"} and normalize_expected_route(str(item.get("expect_route", "") or "")) in {"direct", "runner"}
            ]
        ),
        "total_estimated_cost_usd": total_cost,
        "avg_estimated_cost_usd": round(total_cost / total, 6) if total else 0.0,
        "budget_cap_counts": dict(sorted(budget_cap_counts.items())),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Minimal replay/eval for OctoClaw")
    parser.add_argument("--mode", choices=("route", "state_machine"), default="route")
    parser.add_argument("--tasks", default="")
    parser.add_argument("--workspace", default="")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--freeze-time", default="")
    return parser


def resolve_tasks_path(mode: str, tasks: str = "") -> Path:
    if str(tasks or "").strip():
        return Path(tasks).resolve()
    if str(mode or "").strip() == "state_machine":
        return Path(DEFAULT_STATE_MACHINE_TASKS_FILE).resolve()
    return DEFAULT_ROUTE_TASKS_FILE.resolve()


def run_route_eval(*, task_file: Path, workspace: str = "", output_dir: Path = DEFAULT_OUTPUT_DIR) -> dict[str, object]:
    output_dir = Path(output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

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
        policy_decision = payload.get("policy_decision", {}) if isinstance(payload.get("policy_decision"), dict) else {}
        route_decision = policy_decision.get("route_decision", {}) if isinstance(policy_decision.get("route_decision"), dict) else {}
        budget_policy = policy_decision.get("budget_policy", {}) if isinstance(policy_decision.get("budget_policy"), dict) else {}
        model_policy = policy_decision.get("model_policy", {}) if isinstance(policy_decision.get("model_policy"), dict) else {}
        prompt_contract = policy_decision.get("prompt_contract", {}) if isinstance(policy_decision.get("prompt_contract"), dict) else {}
        work_contract = str(route_decision.get("work_contract", "") or prompt_contract.get("work_contract", "") or "")

        if route == "runner" and payload.get("executed"):
            exec_start = time.time()
            execute_runner_job(workspace)
            elapsed_ms += int((time.time() - exec_start) * 1000)
            job = payload.get("job", {})
            model = job.get("model", "") or model_policy.get("selected_model", "")
            model_band = job.get("model_band", "") or payload.get("model_band", "") or model_policy.get("model_band", "")
            spawn_count = 0
        else:
            model = payload.get("model", "") or model_policy.get("selected_model", "")
            model_band = payload.get("model_band", "") or model_policy.get("model_band", "")
            if route == "spawn_multi":
                steps = payload.get("steps", []) if isinstance(payload.get("steps"), list) else []
                spawn_count = max(1, len(steps))
            elif route == "spawn_single":
                spawn_count = 1
            else:
                spawn_count = 0

        est_cost = estimate_task_cost_usd(model, estimate_eval_token_budget(route, budget_policy)) or 0.0

        results.append(
            {
                "id": task["id"],
                "task": task["task"],
                "route": route,
                "work_contract": work_contract,
                "expect_route": task.get("expect_route", ""),
                "expect_work_contract": task.get("expect_work_contract", ""),
                "route_match": route_matches_expected(route, str(task.get("expect_route", "") or "")),
                "work_contract_match": not task.get("expect_work_contract") or work_contract == str(task.get("expect_work_contract", "") or ""),
                "elapsed_ms": elapsed_ms,
                "model": model,
                "model_band": model_band,
                "worker_pool": payload.get("worker_pool", "") or route_decision.get("worker_pool", ""),
                "budget_cap": str(budget_policy.get("budget_cap", "") or ""),
                "retry_cap": int(budget_policy.get("retry_cap", 0) or 0),
                "max_workers": int(budget_policy.get("max_workers", 0) or 0),
                "review_required": bool(payload.get("review_required", False)),
                "spawn_count": spawn_count,
                "estimated_cost_usd": round(est_cost, 6),
            }
        )

    summary = summarize_results(results)

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

    return {"json": str(json_path), "markdown": str(md_path), "summary": summary}


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    task_file = resolve_tasks_path(args.mode, args.tasks)
    try:
        if args.mode == "state_machine":
            payload = run_state_machine_eval(
                tasks_file=task_file,
                workspace=args.workspace,
                freeze_time=args.freeze_time,
            )
        else:
            payload = run_route_eval(
                task_file=task_file,
                workspace=args.workspace,
                output_dir=Path(args.output_dir),
            )
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
