#!/usr/bin/env python3
"""State machine eval runner for OctoClaw task lifecycle transitions."""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from collections import Counter, defaultdict
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

try:
    import runtime_coordination as runtime_coordination_module
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib import runtime_coordination as runtime_coordination_module


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
DEFAULT_CASES_FILE = PROJECT_DIR / "eval" / "tasks-state-machine.json"


class EvalClock:
    def __init__(self, current: datetime | None = None):
        self._current = current or datetime.now(timezone.utc)

    @classmethod
    def from_value(cls, value: str = "") -> "EvalClock":
        text = str(value or "").strip()
        if not text:
            return cls()
        raw = text[:-1] + "+00:00" if text.endswith("Z") else text
        parsed = datetime.fromisoformat(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return cls(parsed.astimezone(timezone.utc))

    def now(self) -> datetime:
        return self._current

    def iso(self) -> str:
        return self._current.isoformat()

    def advance(self, seconds: int = 0) -> None:
        self._current = self._current + timedelta(seconds=max(0, int(seconds or 0)))


def _frozen_datetime_class(current: datetime) -> type[datetime]:
    frozen = current.astimezone(timezone.utc)

    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            if tz is None:
                return frozen.replace(tzinfo=None)
            return frozen.astimezone(tz)

    return FrozenDateTime


def _atomic_write_json(path: Path, payload: dict[str, Any] | list[Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp_path.replace(path)


def _load_cases(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, list):
        raise ValueError("state machine task file must be a JSON array")
    return [item for item in payload if isinstance(item, dict)]


def _subset_mismatches(actual: Any, expected: Any, prefix: str = "") -> list[str]:
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return [f"{prefix or 'root'} expected object, got {type(actual).__name__}"]
        mismatches: list[str] = []
        for key, value in expected.items():
            next_prefix = f"{prefix}.{key}" if prefix else str(key)
            mismatches.extend(_subset_mismatches(actual.get(key), value, next_prefix))
        return mismatches
    if isinstance(expected, list):
        if not isinstance(actual, list):
            return [f"{prefix or 'root'} expected list, got {type(actual).__name__}"]
        if len(actual) < len(expected):
            return [f"{prefix or 'root'} expected list length >= {len(expected)}, got {len(actual)}"]
        mismatches: list[str] = []
        for idx, value in enumerate(expected):
            next_prefix = f"{prefix}[{idx}]"
            mismatches.extend(_subset_mismatches(actual[idx], value, next_prefix))
        return mismatches
    if actual != expected:
        return [f"{prefix or 'value'} expected {expected!r}, got {actual!r}"]
    return []


def _state_file(workspace: Path) -> Path:
    return workspace / "tmp" / "octopus" / "task-state.json"


def _write_initial_task(workspace: Path, task: dict[str, Any], clock: EvalClock) -> dict[str, Any]:
    record = deepcopy(task)
    record.setdefault("id", "eval-task")
    record.setdefault("source", "octoclaw")
    record.setdefault("updated_at", clock.iso())
    state = {
      "tasks": [record],
      "updated_at": clock.iso(),
    }
    _atomic_write_json(_state_file(workspace), state)
    return record


def _persist_task(workspace: Path, task: dict[str, Any], clock: EvalClock) -> None:
    snapshot = deepcopy(task)
    snapshot["updated_at"] = snapshot.get("updated_at") or clock.iso()
    _atomic_write_json(
        _state_file(workspace),
        {
            "tasks": [snapshot],
            "updated_at": clock.iso(),
        },
    )


def _apply_claim(task: dict[str, Any], action: dict[str, Any], clock: EvalClock) -> str:
    owner_id = str(action.get("owner_id", "") or "eval-worker").strip()
    task["owner"] = owner_id
    task["agent_id"] = owner_id
    task["session_id"] = str(action.get("session_id", "") or "eval-session").strip()
    task["run_id"] = str(action.get("run_id", "") or "eval-run").strip()
    task["status"] = str(action.get("status", "") or task.get("status", "") or "running")
    task["lifecycle_state"] = str(action.get("lifecycle_state", "") or task.get("lifecycle_state", "") or "running")
    task["session_status"] = str(action.get("session_status", "") or "active")
    task["started_at"] = task.get("started_at") or clock.iso()
    task["spawned_at"] = task.get("spawned_at") or clock.iso()
    task["last_observed_at"] = clock.iso()
    task["updated_at"] = clock.iso()
    return str(action.get("expect_state", "") or "claimed")


def _apply_mark_stale(task: dict[str, Any], action: dict[str, Any], clock: EvalClock) -> str:
    task["session_status"] = str(action.get("session_status", "") or "stale")
    task["updated_at"] = clock.iso()
    return str(action.get("expect_state", "") or "stale")


def _apply_recover_stale(task: dict[str, Any], action: dict[str, Any], _clock: EvalClock) -> tuple[dict[str, Any], str]:
    stale_after_seconds = int(action.get("stale_after_seconds", 900) or 900)
    with patch.object(runtime_coordination_module, "datetime", _frozen_datetime_class(_clock.now())):
        recovered = runtime_coordination_module.recover_stale_ownership([deepcopy(task)], stale_after_seconds=stale_after_seconds)
    if recovered:
        return recovered[0], str(action.get("expect_state", "") or "recovered")
    return task, str(action.get("expect_state", "") or "stale")


def _apply_block(task: dict[str, Any], action: dict[str, Any], clock: EvalClock) -> str:
    task["status"] = "blocked"
    task["lifecycle_state"] = str(task.get("lifecycle_state", "") or "queued")
    task["outcome_state"] = "blocked"
    task["blocked_reason"] = str(action.get("reason", "") or "blocked by eval")
    task["updated_at"] = clock.iso()
    return str(action.get("expect_state", "") or "blocked")


def _apply_unblock(task: dict[str, Any], action: dict[str, Any], clock: EvalClock) -> str:
    task["status"] = "queued"
    task["lifecycle_state"] = "queued"
    task["outcome_state"] = "pending"
    task["blocked_reason"] = ""
    task["updated_at"] = clock.iso()
    return str(action.get("expect_state", "") or "unblocked")


def _apply_start(task: dict[str, Any], action: dict[str, Any], clock: EvalClock) -> str:
    task["status"] = "running"
    task["lifecycle_state"] = "running"
    task["outcome_state"] = "pending"
    task["started_at"] = task.get("started_at") or clock.iso()
    task["updated_at"] = clock.iso()
    return str(action.get("expect_state", "") or "running")


def _apply_complete(task: dict[str, Any], action: dict[str, Any], clock: EvalClock) -> str:
    task["status"] = "done"
    task["lifecycle_state"] = "finished"
    task["outcome_state"] = "done"
    task["completed_at"] = clock.iso()
    task["updated_at"] = clock.iso()
    return str(action.get("expect_state", "") or "done")


def _apply_error(task: dict[str, Any], action: dict[str, Any], case: dict[str, Any], clock: EvalClock) -> str:
    max_retries = int(case.get("max_retries", 3) or 3)
    retry_count = int(task.get("retry_count", 0) or 0)
    task["last_error"] = str(action.get("error_message", "") or "eval error")
    task["last_error_at"] = clock.iso()
    task["updated_at"] = clock.iso()
    if retry_count >= max_retries:
        task["status"] = "failed"
        task["lifecycle_state"] = "finished"
        task["outcome_state"] = "failed"
        task["final_failure"] = True
        task["completed_at"] = clock.iso()
        return str(action.get("expect_state", "") or "final_failure")
    task["status"] = "failed"
    task["lifecycle_state"] = "running"
    task["outcome_state"] = "failed"
    return str(action.get("expect_state", "") or "error")


def _apply_retry(task: dict[str, Any], action: dict[str, Any], case: dict[str, Any], clock: EvalClock) -> str:
    max_retries = int(case.get("max_retries", 3) or 3)
    retry_count = min(max_retries, int(task.get("retry_count", 0) or 0) + 1)
    task["retry_count"] = retry_count
    task["status"] = "queued" if retry_count <= max_retries else "failed"
    task["lifecycle_state"] = "queued" if retry_count <= max_retries else "finished"
    task["outcome_state"] = "pending" if retry_count <= max_retries else "failed"
    task["updated_at"] = clock.iso()
    return str(action.get("expect_state", "") or ("retry" if retry_count <= max_retries else "final_failure"))


def _apply_action(task: dict[str, Any], action: dict[str, Any], case: dict[str, Any], clock: EvalClock) -> tuple[dict[str, Any], str]:
    action_type = str(action.get("type", "") or "").strip()
    if int(action.get("advance_seconds", 0) or 0) > 0:
        clock.advance(int(action.get("advance_seconds", 0) or 0))

    if action_type == "claim":
        return task, _apply_claim(task, action, clock)
    if action_type == "mark_stale":
        return task, _apply_mark_stale(task, action, clock)
    if action_type == "recover_stale_ownership":
        return _apply_recover_stale(task, action, clock)
    if action_type == "block":
        return task, _apply_block(task, action, clock)
    if action_type == "unblock":
        return task, _apply_unblock(task, action, clock)
    if action_type == "start":
        return task, _apply_start(task, action, clock)
    if action_type == "complete":
        return task, _apply_complete(task, action, clock)
    if action_type == "error":
        return task, _apply_error(task, action, case, clock)
    if action_type == "retry":
        return task, _apply_retry(task, action, case, clock)
    raise ValueError(f"unsupported state machine action: {action_type}")


def _transition_matrix_rows(matrix: dict[str, Counter]) -> dict[str, dict[str, int]]:
    return {state: dict(sorted(counter.items())) for state, counter in sorted(matrix.items()) if counter}


def _declared_coverage(cases: list[dict[str, Any]]) -> tuple[set[str], set[tuple[str, str]]]:
    states: set[str] = set()
    transitions: set[tuple[str, str]] = set()
    for case in cases:
        current_state = str(case.get("initial_state", "") or "").strip()
        if current_state:
            states.add(current_state)
        actions = case.get("actions", []) if isinstance(case.get("actions"), list) else []
        for action in actions:
            if not isinstance(action, dict):
                continue
            next_state = str(action.get("expect_state", "") or "").strip()
            if current_state and next_state:
                transitions.add((current_state, next_state))
            if next_state:
                states.add(next_state)
                current_state = next_state
        expected = case.get("expect_final", {}) if isinstance(case.get("expect_final"), dict) else {}
        final_state = str(expected.get("state", "") or "").strip()
        if final_state:
            states.add(final_state)
            if current_state and current_state != final_state:
                transitions.add((current_state, final_state))
    return states, transitions


def run_state_machine_eval(
    *,
    tasks_file: Path = DEFAULT_CASES_FILE,
    workspace: str = "",
    freeze_time: str = "",
) -> dict[str, Any]:
    cases = _load_cases(tasks_file.resolve())
    if not workspace:
        workspace = tempfile.mkdtemp(prefix="octoclaw-state-machine-eval-")
    workspace_path = Path(workspace).resolve()
    base_clock = EvalClock.from_value(freeze_time)
    declared_states, declared_transitions = _declared_coverage(cases)

    results: list[dict[str, Any]] = []
    observed_states: set[str] = set()
    observed_transitions: set[tuple[str, str]] = set()
    transition_matrix: dict[str, Counter] = defaultdict(Counter)

    for case in cases:
        clock = EvalClock(base_clock.now())
        task = _write_initial_task(workspace_path, case.get("initial_task", {}), clock)
        current_state = str(case.get("initial_state", "") or "pending")
        observed_states.add(current_state)
        transitions: list[dict[str, str]] = []
        errors: list[str] = []

        for action in case.get("actions", []):
            if not isinstance(action, dict):
                continue
            previous_state = current_state
            try:
                task, next_state = _apply_action(task, action, case, clock)
            except Exception as exc:
                errors.append(f"action {action.get('type')}: {exc}")
                break
            current_state = next_state
            transitions.append(
                {
                    "action": str(action.get("type", "") or ""),
                    "from": previous_state,
                    "to": current_state,
                }
            )
            transition_matrix[previous_state][current_state] += 1
            observed_transitions.add((previous_state, current_state))
            observed_states.add(current_state)
            _persist_task(workspace_path, task, clock)

        expected = case.get("expect_final", {}) if isinstance(case.get("expect_final"), dict) else {}
        expected_state = str(expected.get("state", "") or "")
        if expected_state and current_state != expected_state:
            errors.append(f"final state expected {expected_state!r}, got {current_state!r}")
        expected_task = expected.get("task", {}) if isinstance(expected.get("task"), dict) else {}
        errors.extend(_subset_mismatches(task, expected_task))

        results.append(
            {
                "id": str(case.get("id", "") or ""),
                "description": str(case.get("description", "") or ""),
                "pass": not errors,
                "final_state": current_state,
                "transitions": transitions,
                "errors": errors,
                "final_task": task,
            }
        )

    transition_total = sum(len(result.get("transitions", [])) for result in results)
    passed = len([item for item in results if item.get("pass")])
    covered_states = observed_states & declared_states if declared_states else set(observed_states)
    covered_transitions = observed_transitions & declared_transitions if declared_transitions else set(observed_transitions)
    report = {
        "generated_at": datetime.now(timezone.utc).astimezone().isoformat(),
        "mode": "state_machine",
        "tasks_file": str(tasks_file),
        "workspace": str(workspace_path),
        "summary": {
            "total_cases": len(results),
            "passed_cases": passed,
            "failed_cases": len(results) - passed,
            "pass_rate": round(passed / len(results), 4) if results else 0.0,
            "coverage": {
                "declared_states": sorted(declared_states),
                "covered_states": sorted(covered_states),
                "state_coverage_rate": round(len(covered_states) / len(declared_states), 4) if declared_states else 1.0,
                "declared_transitions": [
                    {"from": source, "to": target}
                    for source, target in sorted(declared_transitions)
                ],
                "covered_transitions": [
                    {"from": source, "to": target}
                    for source, target in sorted(covered_transitions)
                ],
                "transition_coverage_rate": round(len(covered_transitions) / len(declared_transitions), 4) if declared_transitions else 1.0,
            },
            "observed_state_count": len(observed_states),
            "observed_transition_count": transition_total,
            "unique_observed_transition_count": len(observed_transitions),
        },
        "state_transition_matrix": _transition_matrix_rows(transition_matrix),
        "results": results,
    }
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run OctoClaw state machine eval cases")
    parser.add_argument("--tasks", default=str(DEFAULT_CASES_FILE))
    parser.add_argument("--workspace", default="")
    parser.add_argument("--freeze-time", default="")
    args = parser.parse_args(argv)

    tasks_file = Path(args.tasks).resolve()
    try:
        report = run_state_machine_eval(
            tasks_file=tasks_file,
            workspace=args.workspace,
            freeze_time=args.freeze_time,
        )
    except Exception as exc:
        print(f"state machine eval failed: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
