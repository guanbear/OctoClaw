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

try:
    from runtime_task_record import normalize_task_record
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.runtime_task_record import normalize_task_record


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
        f"- Taskflow tracked/bound/active: `{report['summary']['taskflow_tracked_tasks']}/{report['summary']['taskflow_native_bound_tasks']}/{report['summary']['taskflow_native_active_tasks']}`",
        f"- Progress checkpoint/artifact: `{report['summary']['taskflow_checkpointed_tasks']}/{report['summary']['taskflow_artifact_ready_tasks']}`",
        f"- Handoff ready/delivered: `{report['summary']['taskflow_handoff_ready_tasks']}/{report['summary']['taskflow_delivered_tasks']}`",
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
    if not RUNNER_LOOP_SH.exists():
        raise RuntimeError("runner_loop.sh removed (R9): use gateway-managed runner pool")
    env = dict(os.environ)
    env["WORKSPACE"] = workspace
    env["RUNNER_MAX_JOBS_PER_WORKER"] = "1"
    env["OCTOCLAW_ENABLE_LEGACY_LOOPS"] = "1"
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
        "taskflow_tracked_tasks": len([item for item in results if str(item.get("taskflow_state", "") or "").strip()]),
        "taskflow_native_bound_tasks": len([item for item in results if str(item.get("taskflow_native_binding_state", "") or "").strip() == "bound"]),
        "taskflow_native_active_tasks": len(
            [
                item
                for item in results
                if str(item.get("taskflow_native_status", "") or "").strip().lower() in {"queued", "running", "blocked"}
            ]
        ),
        "taskflow_checkpointed_tasks": len([item for item in results if bool(item.get("taskflow_checkpointed"))]),
        "taskflow_artifact_ready_tasks": len([item for item in results if bool(item.get("taskflow_artifact_ready"))]),
        "taskflow_handoff_ready_tasks": len([item for item in results if str(item.get("taskflow_handoff_state", "") or "").strip() == "user_safe_ready"]),
        "taskflow_delivered_tasks": len([item for item in results if str(item.get("taskflow_handoff_state", "") or "").strip() == "delivered"]),
    }


def _task_state_path(workspace: str) -> Path:
    return Path(workspace).resolve() / "tmp" / "octopus" / "task-state.json"


def _load_task_state_index(workspace: str) -> dict[str, dict]:
    path = _task_state_path(workspace)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    tasks = payload.get("tasks", []) if isinstance(payload, dict) else []
    if not isinstance(tasks, list):
        return {}
    indexed: dict[str, dict] = {}
    for item in tasks:
        if not isinstance(item, dict):
            continue
        task_id = str(item.get("id", "") or "").strip()
        if not task_id:
            continue
        indexed[task_id] = normalize_task_record(item)
    return indexed


def _taskflow_fields_for_eval(task_record: dict | None) -> dict[str, object]:
    task = task_record if isinstance(task_record, dict) else {}
    task_event_summary = task.get("task_event_summary", {}) if isinstance(task.get("task_event_summary", {}), dict) else {}
    kind_counts = task_event_summary.get("kind_counts", {}) if isinstance(task_event_summary.get("kind_counts", {}), dict) else {}
    return {
        "taskflow_state": str(task.get("openclaw_taskflow_state", "") or "").strip(),
        "taskflow_task_runtime": str(task.get("openclaw_task_runtime", "") or "").strip(),
        "taskflow_flow_runtime": str(task.get("openclaw_flow_runtime", "") or "").strip(),
        "taskflow_native_binding_state": str(task.get("openclaw_native_binding_state", "") or "").strip(),
        "taskflow_native_status": str(task.get("openclaw_native_status", "") or "").strip(),
        "taskflow_native_runtime": str(task.get("openclaw_native_runtime", "") or "").strip(),
        "taskflow_task_id": str(task.get("openclaw_task_id", "") or "").strip(),
        "taskflow_flow_id": str(task.get("openclaw_flow_id", "") or "").strip(),
        "taskflow_checkpointed": int(kind_counts.get("checkpoint", 0) or 0) > 0,
        "taskflow_artifact_ready": int(kind_counts.get("artifact_ready", 0) or 0) > 0,
        "taskflow_handoff_state": str(task.get("handoff_state", "") or "").strip(),
    }


def _resolve_eval_task_record(workspace: str, route: str, payload: dict) -> dict[str, object]:
    state_index = _load_task_state_index(workspace)
    if not state_index:
        return {}
    candidates: list[str] = []
    if route == "runner":
        job = payload.get("job", {}) if isinstance(payload.get("job", {}), dict) else {}
        candidates.append(str(job.get("id", "") or "").strip())
    else:
        candidates.append(str(payload.get("task_id", "") or "").strip())
        spawn_spec = payload.get("spawn_spec", {}) if isinstance(payload.get("spawn_spec", {}), dict) else {}
        candidates.append(str(spawn_spec.get("task_id", "") or "").strip())
    for task_id in candidates:
        if task_id and task_id in state_index:
            return state_index[task_id]
    return {}


# ---------------------------------------------------------------------------
# Policy state snapshot — enables reproducible replay and regression detection
# ---------------------------------------------------------------------------

_POLICY_STATE_FILES: list[tuple[str, Path]] = [
    ("octopus-config.json", Path("tmp") / "octopus-config.json"),
    ("octoclaw-mode.json", Path("tmp") / "octoclaw-mode.json"),
    ("model-policy.json", Path("tmp") / "octopus" / "model-policy.json"),
    ("route-stickiness.json", Path("tmp") / "octopus" / "route-stickiness.json"),
]


def snapshot_policy_state(workspace: str) -> dict:
    """Capture policy config files to a serialisable dict for reproducible replay.

    The returned dict can be embedded in a report JSON, then later passed to
    restore_policy_state() to recreate identical conditions.
    """
    ws = Path(workspace)
    state: dict = {"snapshotted_at": datetime.now(timezone.utc).isoformat(), "files": {}}
    for key, rel in _POLICY_STATE_FILES:
        full = ws / rel
        if full.exists():
            try:
                state["files"][key] = json.loads(full.read_text("utf-8"))
            except (OSError, json.JSONDecodeError):
                pass
    return state


def restore_policy_state(state: dict, workspace: str) -> None:
    """Write snapshotted policy files back to workspace before a replay run.

    Only files captured in the snapshot are written; missing files are skipped
    so the workspace retains its own defaults for anything not in the snapshot.
    """
    ws = Path(workspace)
    key_to_rel = dict(_POLICY_STATE_FILES)
    files = state.get("files", {}) if isinstance(state.get("files"), dict) else {}
    for key, content in files.items():
        rel = key_to_rel.get(key)
        if rel is None:
            continue
        full = ws / rel
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(json.dumps(content, ensure_ascii=False, indent=2), "utf-8")


def compare_reports(baseline: dict, current: dict) -> list[dict]:
    """Return route regressions: tasks where route or work_contract changed.

    Only tasks present in both reports are compared.  New tasks in current
    or tasks removed from baseline are ignored.
    """
    baseline_by_id = {
        str(item.get("id", "")): item
        for item in baseline.get("results", [])
        if isinstance(item, dict)
    }
    regressions: list[dict] = []
    for item in current.get("results", []):
        if not isinstance(item, dict):
            continue
        task_id = str(item.get("id", "") or "")
        base = baseline_by_id.get(task_id)
        if base is None:
            continue
        route_changed = item.get("route") != base.get("route")
        contract_changed = item.get("work_contract") != base.get("work_contract")
        if route_changed or contract_changed:
            regressions.append({
                "id": task_id,
                "task": item.get("task", ""),
                "baseline_route": base.get("route", ""),
                "current_route": item.get("route", ""),
                "baseline_contract": base.get("work_contract", ""),
                "current_contract": item.get("work_contract", ""),
            })
    return regressions


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Minimal replay/eval for OctoClaw")
    parser.add_argument("--mode", choices=("route", "state_machine"), default="route")
    parser.add_argument("--tasks", default="")
    parser.add_argument("--workspace", default="")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument(
        "--replay-from", default="",
        help="Path to a previous report JSON; restores its policy snapshot before running",
    )
    parser.add_argument(
        "--save-policy-snapshot", action="store_true",
        help="Embed a policy state snapshot in the report for future replay",
    )
    parser.add_argument(
        "--assert-baseline", default="",
        help="Path to baseline report JSON; exit nonzero if any route regressions found",
    )
    parser.add_argument("--freeze-time", default="")
    return parser


def resolve_tasks_path(mode: str, tasks: str = "") -> Path:
    if str(tasks or "").strip():
        return Path(tasks).resolve()
    if str(mode or "").strip() == "state_machine":
        return Path(DEFAULT_STATE_MACHINE_TASKS_FILE).resolve()
    return DEFAULT_ROUTE_TASKS_FILE.resolve()


def run_route_eval(
    *,
    task_file: Path,
    workspace: str = "",
    output_dir: Path = DEFAULT_OUTPUT_DIR,
    replay_from: str = "",
    save_policy_snapshot: bool = False,
    assert_baseline: str = "",
) -> dict[str, object]:
    output_dir = Path(output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if not workspace:
        workspace = tempfile.mkdtemp(prefix="octoclaw-eval-")

    env = dict(os.environ)
    env["WORKSPACE"] = workspace

    # Restore policy state from a previous report so the run is comparable
    if replay_from:
        try:
            prior = json.loads(Path(replay_from).read_text("utf-8"))
            if "policy_snapshot" in prior:
                restore_policy_state(prior["policy_snapshot"], workspace)
        except (OSError, json.JSONDecodeError) as exc:
            print(f"warning: could not load replay-from report: {exc}", file=sys.stderr)

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
        task_record = _resolve_eval_task_record(workspace, route, payload)
        taskflow_fields = _taskflow_fields_for_eval(task_record)

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
                **taskflow_fields,
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

    # Embed policy snapshot when requested or when replay/assert flags are used
    if save_policy_snapshot or replay_from or assert_baseline:
        report["policy_snapshot"] = snapshot_policy_state(workspace)

    stamp = now_compact()
    json_path = output_dir / f"eval-report-{stamp}.json"
    md_path = output_dir / f"eval-report-{stamp}.md"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(summarize_markdown(report))

    result = {"json": str(json_path), "markdown": str(md_path), "summary": summary}

    # Regression check — report is always written first so artifacts are preserved
    if assert_baseline:
        try:
            baseline = json.loads(Path(assert_baseline).read_text("utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SystemExit(f"error: could not load baseline report: {exc}")
        regressions = compare_reports(baseline, report)
        if regressions:
            print(json.dumps({"regressions": regressions}, ensure_ascii=False), file=sys.stderr)
            raise SystemExit(f"{len(regressions)} route regression(s) found (see stderr)")

    return result


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
                replay_from=args.replay_from,
                save_policy_snapshot=args.save_policy_snapshot,
                assert_baseline=args.assert_baseline,
            )
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
