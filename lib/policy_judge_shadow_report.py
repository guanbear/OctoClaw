#!/usr/bin/env python3
"""Compare main router decisions against shadow judge outputs."""

from __future__ import annotations

import argparse
import json
import subprocess
from collections import Counter
from pathlib import Path
from typing import Any

from node_runtime import ensure_node_environment, resolve_node_bin


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
EXTENSION_PATH = PROJECT_DIR / "extensions" / "octoclaw-runtime" / "index.js"
DEFAULT_CASES = PROJECT_DIR / "tests" / "fixtures" / "router-policy-goldens-v2.json"

COMPARE_FIELDS = (
    "route",
    "request_kind",
    "scope",
    "target",
)


def _normalize_text(value: Any) -> str:
    return str(value or "").strip()


def _normalize_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [_normalize_text(item) for item in value if _normalize_text(item)]
    return []


def load_cases(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("cases file must be a JSON array")
    return [item for item in data if isinstance(item, dict)]


def load_shadow_fixture(path: Path) -> dict[str, dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("shadow fixture file must be a JSON array")
    indexed: dict[str, dict[str, Any]] = {}
    for item in data:
        if not isinstance(item, dict):
            continue
        task = _normalize_text(item.get("task"))
        if not task:
            continue
        indexed[task] = item
    return indexed


def run_main_decisions(tasks: list[str]) -> list[dict[str, Any]]:
    script = f"""
import {{ __octoclawTest }} from {json.dumps(str(EXTENSION_PATH))};
const tasks = {json.dumps(tasks, ensure_ascii=False)};
const payload = tasks.map((task) => {{
  const decision = __octoclawTest.buildDecision(task);
  return {{
    task,
    route: decision.route_decision.route,
    request_kind: decision.router_decision_v2.request_kind,
    scope: decision.router_decision_v2.scope,
    target: decision.router_decision_v2.target,
    evidence_required: decision.router_decision_v2.evidence_required || [],
    decision_source: decision.policy_router.decision_source || "",
  }};
}});
console.log(JSON.stringify(payload));
"""
    result = subprocess.run(
        [resolve_node_bin(), "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        cwd=str(PROJECT_DIR),
        env=ensure_node_environment(),
        check=True,
    )
    data = json.loads(result.stdout)
    if not isinstance(data, list):
        raise ValueError("main decision payload must be a list")
    return [item for item in data if isinstance(item, dict)]


def compare_record(case: dict[str, Any], main: dict[str, Any], shadow: dict[str, Any]) -> dict[str, Any]:
    expected = case.get("expected", {}) if isinstance(case.get("expected"), dict) else {}
    shadow_result = shadow.get("shadow_result", {}) if isinstance(shadow.get("shadow_result"), dict) else {}
    diffs: list[str] = []
    for field in COMPARE_FIELDS:
        if _normalize_text(main.get(field)) != _normalize_text(shadow_result.get(field)):
            diffs.append(field)
    if _normalize_list(main.get("evidence_required")) != _normalize_list(shadow_result.get("evidence_required")):
        diffs.append("evidence_required")
    return {
        "task": _normalize_text(case.get("task")),
        "expected": {
            "route": _normalize_text(expected.get("route")),
            "request_kind": _normalize_text(expected.get("request_kind")),
            "scope": _normalize_text(expected.get("scope")),
            "target": _normalize_text(expected.get("target")),
            "evidence_required": _normalize_list(expected.get("evidence_required")),
        },
        "main": {
            "route": _normalize_text(main.get("route")),
            "request_kind": _normalize_text(main.get("request_kind")),
            "scope": _normalize_text(main.get("scope")),
            "target": _normalize_text(main.get("target")),
            "evidence_required": _normalize_list(main.get("evidence_required")),
            "decision_source": _normalize_text(main.get("decision_source")),
        },
        "shadow": {
            "judge": _normalize_text(shadow.get("judge")),
            "route": _normalize_text(shadow_result.get("route")),
            "request_kind": _normalize_text(shadow_result.get("request_kind")),
            "scope": _normalize_text(shadow_result.get("scope")),
            "target": _normalize_text(shadow_result.get("target")),
            "evidence_required": _normalize_list(shadow_result.get("evidence_required")),
            "confidence": float(shadow_result.get("confidence", 0.0) or 0.0),
        },
        "matches_main": not diffs,
        "drift_fields": diffs,
    }


def build_report(cases: list[dict[str, Any]], shadow_fixture: dict[str, dict[str, Any]]) -> dict[str, Any]:
    tasks = [_normalize_text(case.get("task")) for case in cases]
    main_decisions = run_main_decisions(tasks)
    indexed_main = {_normalize_text(item.get("task")): item for item in main_decisions}
    records: list[dict[str, Any]] = []
    drift_counter: Counter[str] = Counter()
    missing_shadow = 0
    matched = 0
    for case in cases:
        task = _normalize_text(case.get("task"))
        if not task or task not in indexed_main:
            continue
        shadow = shadow_fixture.get(task)
        if not shadow:
            missing_shadow += 1
            continue
        record = compare_record(case, indexed_main[task], shadow)
        if record["matches_main"]:
            matched += 1
        for field in record["drift_fields"]:
            drift_counter[field] += 1
        records.append(record)
    return {
        "schema_version": "octoclaw.policy_judge.shadow_report/v1",
        "summary": {
            "total_cases": len(cases),
            "shadow_compared": len(records),
            "shadow_matched": matched,
            "shadow_drifted": len(records) - matched,
            "missing_shadow_cases": missing_shadow,
            "drift_fields": dict(sorted(drift_counter.items())),
        },
        "records": records,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a shadow judge comparison report")
    parser.add_argument("--cases", default=str(DEFAULT_CASES))
    parser.add_argument("--shadow-fixture", required=True)
    parser.add_argument("--format", choices=["json", "text"], default="text")
    args = parser.parse_args()

    cases = load_cases(Path(args.cases).expanduser().resolve())
    shadow_fixture = load_shadow_fixture(Path(args.shadow_fixture).expanduser().resolve())
    report = build_report(cases, shadow_fixture)
    if args.format == "json":
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        summary = report["summary"]
        print("OctoClaw policy judge shadow report")
        print(f"- total_cases: {summary['total_cases']}")
        print(f"- shadow_compared: {summary['shadow_compared']}")
        print(f"- shadow_matched: {summary['shadow_matched']}")
        print(f"- shadow_drifted: {summary['shadow_drifted']}")
        print(f"- missing_shadow_cases: {summary['missing_shadow_cases']}")
        print(f"- drift_fields: {json.dumps(summary['drift_fields'], ensure_ascii=False)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
