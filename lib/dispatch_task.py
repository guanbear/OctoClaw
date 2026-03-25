#!/usr/bin/env python3
"""Unified Octopus task dispatcher.

- Ask octoclaw_route first
- Fast lightweight tasks -> persistent runner
- Other tasks -> return structured spawn recommendation
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone

from octoclaw_route import infer_route
from octoclaw_spawn import build_spawn_spec
from octopus_config import RUNNER_QUEUE_FILE, RUNNER_RESULTS_DIR, SHARED_DIR, load_json
from runner_playbooks import infer_runner_playbook


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RUNNER_DISPATCH_PY = os.path.join(SCRIPT_DIR, "runner_dispatch.py")
RESOLVE_MODEL_PY = os.path.join(SCRIPT_DIR, "resolve-model.py")


def now_compact() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")


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
    if any(token in text for token in ["并行", "同时", "分别", "一边", "parallel"]):
        return "hard"
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


def _tail_text(path: str, limit: int = 1600) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read().strip()
        if len(text) <= limit:
            return text
        return text[-limit:]
    except OSError:
        return ""


def _read_text(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def _clean_output_lines(text: str) -> list[str]:
    lines = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if re.fullmatch(r"[-=]{3,}[A-Z_-]*[-=]{0,}", line):
            continue
        lines.append(line)
    return lines


def _summarize_output(text: str, max_lines: int = 5, max_chars: int = 420) -> str:
    lines = _clean_output_lines(text)
    if not lines:
        return ""
    result: list[str] = []
    total = 0
    for line in lines[:max_lines]:
        if total + len(line) > max_chars and result:
            break
        result.append(line)
        total += len(line)
    summary = "\n".join(result).strip()
    if len(summary) > max_chars:
        summary = summary[: max_chars - 1].rstrip() + "…"
    return summary


def _write_shared_report(job_id: str, content: str) -> str:
    if not content.strip():
        return ""
    os.makedirs(SHARED_DIR, exist_ok=True)
    path = os.path.join(SHARED_DIR, f"{job_id}.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(content.rstrip() + "\n")
    return path


def build_runner_handoff(task: str, payload: dict, wait: dict | None) -> dict:
    job = payload.get("job", {}) if isinstance(payload, dict) else {}
    job_id = str(job.get("id", "") or "")
    wait = wait or {}
    if wait.get("completed"):
        status = str(wait.get("status", "done") or "done")
        stdout_text = _read_text(str(wait.get("stdout_file", "") or "")) or str(wait.get("stdout_excerpt", "") or "")
        stderr_text = _read_text(str(wait.get("stderr_file", "") or "")) or str(wait.get("stderr_excerpt", "") or "")
        merged = stdout_text.strip()
        if stderr_text.strip():
            merged = f"{merged}\n\n[stderr]\n{stderr_text.strip()}".strip()
        reply_text = _summarize_output(stdout_text or merged)
        report_path = ""
        if len(merged) > 500 or len(_clean_output_lines(merged)) > 6:
            report_path = _write_shared_report(job_id or f"runner-{now_compact()}", merged)
        if not reply_text:
            reply_text = "已通过常驻 runner 完成检查。"
        if report_path:
            summary = "已通过常驻 runner 完成检查，详细输出已写入共享文件。"
        else:
            summary = "已通过常驻 runner 完成检查。"
        return {
            "kind": "final",
            "status": "success" if status == "done" else status,
            "summary": summary,
            "reply_text": reply_text,
            "report_path": report_path,
            "job_id": job_id,
            "user_safe": True,
        }
    timeout_seconds = int(wait.get("timeout_seconds", 0) or 0)
    return {
        "kind": "background",
        "status": "pending",
        "summary": "runner 已转后台继续执行。",
        "reply_text": f"OctoClaw 已转后台执行，可用 /octostatus 查看进度。任务ID：{job_id or 'unknown'}",
        "report_path": "",
        "job_id": job_id,
        "timeout_seconds": timeout_seconds,
        "user_safe": True,
    }


def build_spawn_handoff(route: str, label: str, task: str) -> dict:
    reply = "我会交给一个子任务继续处理，稍后给你结论。"
    if route == "spawn_multi":
        reply = "我会拆成分阶段子任务处理，先做调研/分析，再回给你结论。"
    elif label == "octopus-fix":
        reply = "我会先交给修复子任务分析并整理修复建议。"
    elif label == "octopus-scout":
        reply = "我会先交给调研子任务收集信息，再回来汇总结论。"
    elif label == "octopus-analyze":
        reply = "我会先交给分析子任务处理，再回来给你结论。"
    return {
        "kind": "plan",
        "status": "planned",
        "summary": f"{route} 已规划完成。",
        "reply_text": reply,
        "report_path": "",
        "task": task,
        "user_safe": True,
    }


def wait_for_runner_result(job_id: str, timeout_seconds: int) -> dict:
    deadline = time.time() + max(0, timeout_seconds)
    meta_path = os.path.join(RUNNER_RESULTS_DIR, f"{job_id}.json")
    while time.time() <= deadline:
        if os.path.exists(meta_path):
            meta = load_json(meta_path)
            if isinstance(meta, dict):
                stdout_file = str(meta.get("stdout_file", "") or "")
                stderr_file = str(meta.get("stderr_file", "") or "")
                return {
                    "completed": True,
                    "status": meta.get("status", "done"),
                    "exit_code": int(meta.get("exit_code", 0) or 0),
                    "result_path": meta_path,
                    "stdout_file": stdout_file,
                    "stderr_file": stderr_file,
                    "stdout_excerpt": _tail_text(stdout_file),
                    "stderr_excerpt": _tail_text(stderr_file),
                    "finished_at": meta.get("finished_at", ""),
                }
        queue = load_json(RUNNER_QUEUE_FILE)
        if isinstance(queue, dict):
            jobs = queue.get("jobs", [])
            if isinstance(jobs, list):
                job = next((item for item in jobs if item.get("id") == job_id), None)
                if isinstance(job, dict) and job.get("status") == "failed":
                    result_path = str(job.get("result_path", "") or "")
                    meta = load_json(result_path) if result_path else None
                    stdout_file = str((meta or {}).get("stdout_file", "") or "")
                    stderr_file = str((meta or {}).get("stderr_file", "") or "")
                    return {
                        "completed": True,
                        "status": "failed",
                        "exit_code": int(job.get("exit_code", 1) or 1),
                        "result_path": result_path,
                        "stdout_file": stdout_file,
                        "stderr_file": stderr_file,
                        "stdout_excerpt": _tail_text(stdout_file),
                        "stderr_excerpt": _tail_text(stderr_file),
                        "finished_at": str(job.get("finished_at", "") or ""),
                    }
        time.sleep(0.5)
    return {"completed": False, "timeout_seconds": timeout_seconds}


def dispatch_runner(args) -> dict:
    playbook = None
    command = args.command
    summary = args.summary
    if not command:
        playbook = infer_runner_playbook(args.task)
        if playbook:
            command = playbook.get("command", "")
            if not summary:
                summary = playbook.get("summary", "")

    dispatch_cmd = [
        "python3",
        RUNNER_DISPATCH_PY,
        "--id",
        args.id or f"runner-{now_compact()}",
        "--command",
        command,
        "--cwd",
        args.cwd,
        "--summary",
        summary or args.task[:40],
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
    response = {
        "route": "runner",
        "executed": True,
        "job": payload,
        "reason": "lightweight_task",
    }
    if playbook:
        response["playbook"] = playbook
    if args.wait:
        response["wait"] = wait_for_runner_result(payload.get("id", ""), args.wait_timeout_seconds)
    response["handoff"] = build_runner_handoff(args.task, response, response.get("wait"))
    return response


def recommend_spawn(args, task: str) -> dict:
    route_meta = getattr(args, "_route_meta", {}) or {}
    label = args.label or route_meta.get("role_hint") or infer_label(task)
    if label == "main":
        label = infer_label(task)
    tier = args.tier or route_meta.get("tier_hint") or infer_tier(task, label)
    spawn_spec = build_spawn_spec(
        task,
        route="spawn_single",
        label=label,
        tier=tier,
        parent_id=args.id or "",
        register=False,
    )
    return {
        "route": "spawn_single",
        "executed": False,
        "label": spawn_spec["label"],
        "tier": spawn_spec["tier"],
        "model": spawn_spec["model"],
        "reason": "needs_subagent",
        "task": task,
        "handoff": spawn_spec["handoff"],
        "spawn_spec": spawn_spec,
    }


def recommend_multi_spawn(args, task: str) -> dict:
    route_meta = getattr(args, "_route_meta", {}) or {}
    primary_label = args.label or route_meta.get("role_hint") or infer_label(task)
    if primary_label == "main":
        primary_label = infer_label(task)
    primary_tier = args.tier or route_meta.get("tier_hint") or infer_tier(task, primary_label)
    primary_spawn = build_spawn_spec(
        task,
        route="spawn_multi",
        label=primary_label,
        tier=primary_tier,
        parent_id=args.id or "",
        register=False,
    )
    plan = {
        "planner": {
            "label": "octopus-analyze",
            "tier": "hard",
            "model": resolve_model("hard", "octopus-analyze", task),
        },
        "worker": {
            "label": primary_spawn["label"],
            "tier": primary_spawn["tier"],
            "model": primary_spawn["model"],
        },
    }
    if primary_label in ("octopus-fix", "octopus-power", "octopus-test"):
        plan["review"] = {
            "label": "octopus-test",
            "tier": "normal",
            "model": resolve_model("normal", "octopus-test", task),
        }
    return {
        "route": "spawn_multi",
        "executed": False,
        "label": primary_spawn["label"],
        "tier": primary_spawn["tier"],
        "model": primary_spawn["model"],
        "reason": "parallel_or_staged_workflow",
        "task": task,
        "plan": plan,
        "handoff": primary_spawn["handoff"],
        "spawn_spec": primary_spawn,
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
    parser.add_argument("--force-route", choices=["auto", "direct", "runner", "spawn_single", "spawn_multi"], default="auto")
    parser.add_argument("--wait", action="store_true")
    parser.add_argument("--wait-timeout-seconds", dest="wait_timeout_seconds", type=int, default=12)
    args = parser.parse_args()

    task = args.task.strip()
    route = infer_route(task, args.command)
    args._route_meta = route
    final_route = route["route"]
    if args.force_route != "auto":
        final_route = args.force_route
    if args.label == "octopus-runner":
        final_route = "runner"

    if final_route == "direct":
        print(
            json.dumps(
                {
                    "route": "direct",
                    "executed": False,
                    "reason": route["reason"],
                    "reasons": route.get("reasons", []),
                    "reason_codes": route.get("reason_codes", []),
                    "scores": route.get("scores", {}),
                    "task_class": route.get("task_class"),
                    "role_hint": route.get("role_hint"),
                    "tier_hint": route.get("tier_hint"),
                    "expected_latency_ms": route.get("expected_latency_ms"),
                    "expected_cost_band": route.get("expected_cost_band"),
                    "context_growth_band": route.get("context_growth_band"),
                    "execution_owner": route.get("execution_owner"),
                    "dispatch_required": route.get("dispatch_required"),
                    "handoff": {
                        "kind": "final",
                        "status": "success",
                        "summary": "当前任务适合主 agent 直接处理。",
                        "reply_text": "",
                        "report_path": "",
                        "user_safe": False,
                    },
                    "task": task,
                },
                ensure_ascii=False,
            )
        )
        return

    if final_route == "runner":
        playbook = infer_runner_playbook(task) if not args.command else None
        if not args.command and not playbook:
            print(
                json.dumps(
                    {
                        "route": "runner",
                        "executed": False,
                        "reason": "runner_command_required",
                        "task": task,
                        "reasons": route.get("reasons", []),
                        "reason_codes": route.get("reason_codes", []),
                        "scores": route.get("scores", {}),
                        "task_class": route.get("task_class"),
                        "role_hint": route.get("role_hint"),
                        "tier_hint": route.get("tier_hint"),
                        "expected_latency_ms": route.get("expected_latency_ms"),
                        "expected_cost_band": route.get("expected_cost_band"),
                        "context_growth_band": route.get("context_growth_band"),
                        "execution_owner": route.get("execution_owner"),
                        "dispatch_required": route.get("dispatch_required"),
                        "should_wait": route.get("should_wait", False),
                        "wait_timeout_seconds": route.get("wait_timeout_seconds", 0),
                        "handoff": {
                            "kind": "plan",
                            "status": "planned",
                            "summary": "当前任务更适合 runner，但缺少可执行命令。",
                            "reply_text": "当前任务适合交给常驻 runner，但还缺少具体命令或工具步骤。",
                            "report_path": "",
                            "user_safe": True,
                        },
                    },
                    ensure_ascii=False,
                )
            )
            return
        if playbook and not args.summary:
            args.summary = playbook.get("summary", "")
        if not args.wait and route.get("should_wait"):
            args.wait = True
            args.wait_timeout_seconds = route.get("wait_timeout_seconds", args.wait_timeout_seconds)
        payload = dispatch_runner(args)
        payload["reasons"] = route.get("reasons", [])
        payload["reason_codes"] = route.get("reason_codes", [])
        payload["scores"] = route.get("scores", {})
        payload["task_class"] = route.get("task_class")
        payload["role_hint"] = route.get("role_hint")
        payload["tier_hint"] = route.get("tier_hint")
        payload["expected_latency_ms"] = route.get("expected_latency_ms")
        payload["expected_cost_band"] = route.get("expected_cost_band")
        payload["context_growth_band"] = route.get("context_growth_band")
        payload["execution_owner"] = route.get("execution_owner")
        payload["dispatch_required"] = route.get("dispatch_required")
        print(json.dumps(payload, ensure_ascii=False))
        return

    if final_route == "spawn_multi":
        payload = recommend_multi_spawn(args, task)
    else:
        payload = recommend_spawn(args, task)
    payload["reasons"] = route.get("reasons", [])
    payload["reason_codes"] = route.get("reason_codes", [])
    payload["scores"] = route.get("scores", {})
    payload["task_class"] = route.get("task_class")
    payload["role_hint"] = route.get("role_hint")
    payload["tier_hint"] = route.get("tier_hint")
    payload["expected_latency_ms"] = route.get("expected_latency_ms")
    payload["expected_cost_band"] = route.get("expected_cost_band")
    payload["context_growth_band"] = route.get("context_growth_band")
    payload["execution_owner"] = route.get("execution_owner")
    payload["dispatch_required"] = route.get("dispatch_required")
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
