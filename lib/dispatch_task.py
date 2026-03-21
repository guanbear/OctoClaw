#!/usr/bin/env python3
"""Unified Octopus task dispatcher.

- Fast lightweight tasks -> persistent runner
- Other tasks -> return spawn recommendation (label/tier/model)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

from runner_routing import route_task


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RUNNER_DISPATCH_PY = os.path.join(SCRIPT_DIR, "runner_dispatch.py")
RESOLVE_MODEL_PY = os.path.join(SCRIPT_DIR, "resolve-model.py")


def now_compact() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")


def infer_label(task: str) -> str:
    text = (task or "").lower()
    rules = [
        ("octopus-test", [r"\b(test|pytest|unit test|regression|验证|测试)\b"]),
        ("octopus-writer", [r"\b(write|draft|doc|readme|总结|文档|说明|报告|翻译)\b"]),
        ("octopus-scout", [r"\b(research|compare|investigate|调研|对比|查资料)\b"]),
        ("octopus-analyze", [r"\b(analy|root cause|日志分析|根因|分析)\b"]),
        ("octopus-fix", [r"\b(fix|bug|修复|排障|hotfix)\b"]),
    ]
    for label, patterns in rules:
        if any(re.search(pattern, text, re.IGNORECASE) for pattern in patterns):
            return label
    return "octopus-power"


def infer_tier(task: str, label: str) -> str:
    text = (task or "").lower()
    if any(token in text for token in ["架构", "重构", "多文件", "根因", "系统设计", "microservice", "refactor"]):
        return "hard"
    if label in ("octopus-power", "octopus-analyze"):
        return "hard"
    if label in ("octopus-fix", "octopus-test", "octopus-scout", "octopus-writer"):
        return "normal"
    return "normal"


def resolve_model(tier: str, label: str, description: str) -> str:
    result = subprocess.run(
        ["python3", RESOLVE_MODEL_PY, "--tier", tier, "--label", label, "--description", description],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode == 0:
        return result.stdout.strip()
    return ""


def dispatch_runner(args) -> dict:
    dispatch_cmd = [
        "python3",
        RUNNER_DISPATCH_PY,
        "--id",
        args.id or f"runner-{now_compact()}",
        "--command",
        args.command,
        "--cwd",
        args.cwd,
        "--summary",
        args.summary or args.task[:40],
        "--timeout-seconds",
        str(args.timeout_seconds),
        "--tier",
        args.tier or "trivial",
        "--task-description",
        args.task,
    ]
    result = subprocess.run(dispatch_cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "runner dispatch failed")
    payload = json.loads(result.stdout.strip() or "{}")
    return {
        "route": "runner",
        "executed": True,
        "job": payload,
        "reason": "lightweight_task",
    }


def recommend_spawn(args, task: str) -> dict:
    label = args.label or infer_label(task)
    tier = args.tier or infer_tier(task, label)
    model = resolve_model(tier, label, task)
    return {
        "route": "spawn",
        "executed": False,
        "label": label,
        "tier": tier,
        "model": model,
        "reason": "needs_subagent",
        "task": task,
    }


def main():
    parser = argparse.ArgumentParser(description="Unified Octopus dispatcher")
    parser.add_argument("--task", required=True)
    parser.add_argument("--command", default="")
    parser.add_argument("--cwd", default="/workspace")
    parser.add_argument("--summary", default="")
    parser.add_argument("--timeout-seconds", dest="timeout_seconds", type=int, default=120)
    parser.add_argument("--id", default="")
    parser.add_argument("--label", default="")
    parser.add_argument("--tier", default="")
    parser.add_argument("--force-route", choices=["auto", "runner", "spawn"], default="auto")
    args = parser.parse_args()

    task = args.task.strip()
    route = route_task(task)
    final_route = route["route"]
    if args.force_route != "auto":
        final_route = args.force_route
    if args.label == "octopus-runner":
        final_route = "runner"

    if final_route == "runner":
        if not args.command:
            print(
                json.dumps(
                    {
                        "route": "runner",
                        "executed": False,
                        "reason": "runner_command_required",
                        "task": task,
                    },
                    ensure_ascii=False,
                )
            )
            return
        print(json.dumps(dispatch_runner(args), ensure_ascii=False))
        return

    print(json.dumps(recommend_spawn(args, task), ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
