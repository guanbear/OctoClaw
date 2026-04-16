#!/usr/bin/env python3
"""Unified local harness gate for OctoClaw router/runtime changes."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent

PRESETS: dict[str, list[str]] = {
    "quick": [
        "tests.test_router_policy_v2_goldens",
        "tests.test_route_goldens",
        "tests.test_runtime_policy",
        "tests.test_harness_synthetics",
        "tests.test_policy_judge_shadow_report",
        "tests.test_replay_validation",
        "tests.test_acceptance_runtime",
        "tests.test_runtime_policy_replay_schema",
        "tests.test_dispatch_task",
        "tests.test_runner_runtime",
        "tests.test_octoclaw_runtime_extension",
    ],
    "full": [
        "tests.test_router_policy_v2_goldens",
        "tests.test_route_goldens",
        "tests.test_runtime_policy",
        "tests.test_harness_synthetics",
        "tests.test_policy_judge_shadow_report",
        "tests.test_runtime_policy_replay_schema",
        "tests.test_dispatch_task",
        "tests.test_runner_runtime",
        "tests.test_task_anchor_commands",
        "tests.test_task_state_anchor_seed",
        "tests.test_delivery_relay_reconcile",
        "tests.test_replay_validation",
        "tests.test_acceptance_runtime",
        "tests.test_octoclaw_runtime_extension",
        "tests.test_runtime_task_record",
        "tests.test_runtime_snapshot",
        "tests.test_replay_summary",
        "tests.test_replay_review",
        "tests.test_runtime_policy_rollout",
        "tests.test_replay_automation",
    ],
}


def _unique_modules(names: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for name in names:
        module = str(name or "").strip()
        if not module or module in seen:
            continue
        seen.add(module)
        ordered.append(module)
    return ordered


def build_gate_modules(preset: str, extra: list[str] | None = None) -> list[str]:
    modules = list(PRESETS.get(preset, PRESETS["quick"]))
    if extra:
        modules.extend(extra)
    return _unique_modules(modules)


def run_gate(modules: list[str], *, cwd: Path = PROJECT_DIR) -> dict[str, object]:
    started = time.time()
    env = dict(os.environ)
    env.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    cmd = ["python3", "-B", "-m", "unittest", *modules]
    result = subprocess.run(
        cmd,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )
    duration_ms = int((time.time() - started) * 1000)
    return {
        "ok": result.returncode == 0,
        "preset": "",
        "modules": modules,
        "command": cmd,
        "duration_ms": duration_ms,
        "returncode": int(result.returncode),
        "stdout": result.stdout,
        "stderr": result.stderr,
    }


def _text_report(payload: dict[str, object]) -> str:
    lines = [
        "OctoClaw harness gate",
        f"- ok: {'yes' if payload.get('ok') else 'no'}",
        f"- preset: {payload.get('preset') or 'custom'}",
        f"- modules: {len(payload.get('modules', []))}",
        f"- duration_ms: {payload.get('duration_ms', 0)}",
        "",
        "Modules:",
    ]
    for module in payload.get("modules", []):
        lines.append(f"- {module}")
    stdout = str(payload.get("stdout", "") or "").strip()
    stderr = str(payload.get("stderr", "") or "").strip()
    if stdout:
        lines.extend(["", "stdout:", stdout])
    if stderr:
        lines.extend(["", "stderr:", stderr])
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the OctoClaw local harness gate")
    parser.add_argument("--preset", choices=sorted(PRESETS.keys()), default="quick")
    parser.add_argument("--module", action="append", default=[], help="Extra unittest module to include")
    parser.add_argument("--format", choices=["text", "json"], default="text")
    parser.add_argument("--list", action="store_true", help="Only print the selected module list")
    args = parser.parse_args()

    modules = build_gate_modules(args.preset, args.module)
    if args.list:
        payload = {"preset": args.preset, "modules": modules}
        if args.format == "json":
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        else:
            print("\n".join(modules))
        return 0

    payload = run_gate(modules)
    payload["preset"] = args.preset
    if args.format == "json":
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(_text_report(payload))
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
