#!/usr/bin/env python3
"""Unified OctoClaw task dispatcher.

- Ask octoclaw_route first
- Fast lightweight tasks -> persistent runner
- Other tasks -> return structured spawn recommendation
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone

from octoclaw_policy import build_decision
from octoclaw_spawn import build_spawn_spec
from octopus_config import RUNNER_HEALTH_FILE, RUNNER_QUEUE_FILE, RUNNER_RESULTS_DIR, SHARED_DIR, WORKSPACE, load_json, load_octopus_config, spawn_operator_surface
from runtime_protocol import normalize_worker_result
from runner_playbooks import infer_runner_playbook
from worker_taxonomy import (
    infer_model_band as taxonomy_infer_model_band,
    resolve_phase as taxonomy_resolve_phase,
    resolve_work_type as taxonomy_resolve_work_type,
)


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RUNNER_DISPATCH_PY = os.path.join(SCRIPT_DIR, "runner_dispatch.py")
RUNNER_LOOP_SH = os.path.join(SCRIPT_DIR, "runner_loop.sh")
RESOLVE_MODEL_PY = os.path.join(SCRIPT_DIR, "resolve-model.py")
TASK_STATE_PY = os.path.join(SCRIPT_DIR, "task-state-update.py")
MAX_INLINE_CHARS = 1200
RUNNER_STALE_SECONDS = 60


def decision_route(decision: dict) -> dict:
    value = decision.get("route_decision", {})
    return value if isinstance(value, dict) else {}


def decision_model(decision: dict) -> dict:
    value = decision.get("model_policy", {})
    return value if isinstance(value, dict) else {}


def decision_skill(decision: dict) -> dict:
    value = decision.get("skill_policy", {})
    return value if isinstance(value, dict) else {}


def decision_review(decision: dict) -> dict:
    value = decision.get("review_policy", {})
    return value if isinstance(value, dict) else {}


def decision_request(decision: dict) -> dict:
    value = decision.get("request", {})
    return value if isinstance(value, dict) else {}


def decision_metadata(decision: dict) -> dict:
    request = decision_request(decision)
    value = request.get("metadata", {})
    return value if isinstance(value, dict) else {}


def octoclaw_identity_fields(decision: dict) -> dict:
    request = decision_request(decision)
    metadata = decision_metadata(decision)
    managed = metadata.get("managed_by_octoclaw")
    if managed is None or str(managed).strip() == "":
        managed = True
    return {
        "source": "octoclaw",
        "session_key": str(request.get("session_key", "") or metadata.get("session_key", "") or ""),
        "session_id": str(metadata.get("session_id", "") or ""),
        "agent_id": str(metadata.get("agent_id", "") or ""),
        "agent_namespace": str(metadata.get("agent_namespace", "") or "octoclaw"),
        "managed_by_octoclaw": "true" if str(managed).strip().lower() not in {"0", "false", "no", "off"} else "false",
    }


def apply_policy_fields(payload: dict, decision: dict) -> dict:
    route_meta = decision_route(decision)
    model_meta = decision_model(decision)
    skill_meta = decision_skill(decision)
    review_meta = decision_review(decision)

    payload["policy_summary"] = decision.get("summary", "")
    payload["policy_decision"] = decision
    payload["reason"] = route_meta.get("reason", payload.get("reason", ""))
    payload["reasons"] = route_meta.get("reason_codes", [])
    payload["reason_codes"] = route_meta.get("reason_codes", [])
    payload["scores"] = route_meta.get("scores", {})
    payload["system_preferred_route"] = route_meta.get("system_preferred_route", route_meta.get("route"))
    payload["task_class"] = route_meta.get("task_class")
    payload["expected_latency_ms"] = route_meta.get("expected_latency_ms")
    payload["expected_cost_band"] = route_meta.get("expected_cost_band")
    payload["context_growth_band"] = route_meta.get("context_growth_band")
    payload["execution_owner"] = route_meta.get("executor_type")
    payload["dispatch_required"] = route_meta.get("dispatch_required")
    payload["worker_pool"] = route_meta.get("worker_pool")
    payload["work_type"] = route_meta.get("work_type")
    payload["phase"] = route_meta.get("phase")
    payload["protocol"] = route_meta.get("protocol")
    payload["profile"] = payload.get("profile") or model_meta.get("profile", "")
    payload["model_band"] = payload.get("model_band") or model_meta.get("model_band", "")
    payload["selector_band"] = payload.get("selector_band") or model_meta.get("selector_band", "")
    payload["skill_bundle"] = skill_meta.get("default_skill_bundle", [])
    payload["review_required"] = review_meta.get("required", False)
    return payload


def clone_worker_step_decision(decision: dict) -> dict:
    cloned = copy.deepcopy(decision)
    route_meta = decision_route(cloned)
    route_meta["route"] = "spawn_single"
    route_meta["executor_type"] = "subagent"
    route_meta["dispatch_required"] = True
    route_meta["should_wait"] = False
    route_meta["wait_timeout_seconds"] = 0
    reason_codes = list(route_meta.get("reason_codes", []) or [])
    if "multi_worker_from_primary_decision" not in reason_codes:
        reason_codes.insert(0, "multi_worker_from_primary_decision")
    route_meta["reason_codes"] = reason_codes
    route_meta["reason"] = reason_codes[0] if reason_codes else "multi_worker_from_primary_decision"
    route_meta["worker_pool"] = route_meta.get("worker_pool", "octoclaw-research")
    cloned["summary"] = f"policy=spawn_single -> {route_meta.get('worker_pool', 'octoclaw-research')} / profile={decision_model(cloned).get('profile', '')}"
    return cloned


def compat_spawn_step_from_decision(decision: dict, fallback: dict | None = None) -> dict[str, str | dict]:
    fallback = fallback if isinstance(fallback, dict) else {}
    route_meta = decision_route(decision)
    model_meta = decision_model(decision)

    route = str(route_meta.get("route", fallback.get("route", "spawn_single")) or "spawn_single")
    worker_pool = str(route_meta.get("worker_pool", fallback.get("worker_pool", "")) or "")
    work_type = str(route_meta.get("work_type", fallback.get("work_type", "")) or "")
    phase = str(route_meta.get("phase", fallback.get("phase", "")) or "")
    profile = str(model_meta.get("profile", fallback.get("profile", "")) or "")
    model_band = str(model_meta.get("model_band", "") or fallback.get("model_band", "") or "")
    if not model_band:
        model_band = taxonomy_infer_model_band(route=route, worker_pool=worker_pool, work_type=work_type, protocol=str(route_meta.get("protocol", "") or "")) or "normal"
    return {
        "worker_pool": worker_pool,
        "work_type": work_type,
        "phase": phase,
        "profile": profile,
        "model_band": model_band,
        "selector_band": str(model_meta.get("selector_band", "") or fallback.get("selector_band", "") or ""),
        "model": str(model_meta.get("selected_model", "") or fallback.get("model", "") or ""),
        "policy_decision": decision,
    }


def now_compact() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")


def parse_iso(value: str):
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def task_title(task: str, limit: int = 72) -> str:
    text = re.sub(r"\s+", " ", (task or "").strip())
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def compact_text(text: str, limit: int = 120) -> str:
    value = re.sub(r"\s+", " ", str(text or "").strip())
    if len(value) <= limit:
        return value
    return value[: limit - 1].rstrip() + "…"


def upsert_runtime_task(**fields) -> None:
    cmd = ["python3", TASK_STATE_PY, "upsert"]
    for key, value in fields.items():
        text = str(value or "").strip()
        if not text:
            continue
        cmd.extend([f"--{key.replace('_', '-')}", text])
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def build_multi_parent_artifacts(plan: dict, steps: list[dict], backend: str) -> dict:
    ordered_steps = [name for name in ("planner", "worker", "review") if isinstance(plan.get(name), dict)]
    child_task_ids = [str(step.get("task_id", "") or "").strip() for step in steps if str(step.get("task_id", "") or "").strip()]
    operator_surface = spawn_operator_surface()
    operator_surface["backend"] = backend
    backend_name = str(operator_surface.get("backend_name", "tmux") or "tmux")
    if backend == "clawteam":
        team_name = str(operator_surface.get("team_name", "") or "").strip()
        operator_surface["operator_hint"] = f"clawteam/{backend_name}" + (f" {team_name}" if team_name else "")
    else:
        operator_surface["operator_hint"] = backend or str(operator_surface.get("operator_hint", "") or "")

    def step_taxonomy(entry: dict) -> dict[str, str]:
        if not isinstance(entry, dict):
            return {"worker_pool": "", "work_type": "", "phase": "", "profile": "", "model_band": "", "selector_band": ""}
        worker_pool = str(entry.get("worker_pool", "") or "")
        profile = str(entry.get("profile", "") or "")
        work_type = str(entry.get("work_type", "") or "") or str(
            taxonomy_resolve_work_type({"worker_pool": worker_pool, "profile": profile}) or ""
        )
        phase = str(entry.get("phase", "") or "") or str(
            taxonomy_resolve_phase(
                {
                    "worker_pool": worker_pool,
                    "work_type": work_type,
                    "profile": profile,
                }
            )
            or ""
        )
        return {
            "worker_pool": worker_pool,
            "work_type": work_type,
            "phase": phase,
            "profile": profile,
            "model_band": str(entry.get("model_band", "") or ""),
            "selector_band": str(entry.get("selector_band", "") or ""),
        }

    return {
        "step_order": ordered_steps,
        "child_task_ids": child_task_ids,
        "step_task_ids": {
            str(step.get("step", "") or ""): str(step.get("task_id", "") or "")
            for step in steps
            if str(step.get("step", "") or "").strip() and str(step.get("task_id", "") or "").strip()
        },
        "step_task_kinds": {
            str(step.get("step", "") or ""): str(step.get("task_kind", "") or "")
            for step in steps
            if str(step.get("step", "") or "").strip()
        },
        "step_models": {
            name: {
                "worker_pool": step_taxonomy(plan.get(name) or {}).get("worker_pool", ""),
                "work_type": step_taxonomy(plan.get(name) or {}).get("work_type", ""),
                "phase": step_taxonomy(plan.get(name) or {}).get("phase", ""),
                "profile": step_taxonomy(plan.get(name) or {}).get("profile", ""),
                "model_band": step_taxonomy(plan.get(name) or {}).get("model_band", ""),
                "selector_band": step_taxonomy(plan.get(name) or {}).get("selector_band", ""),
                "model": str((plan.get(name) or {}).get("model", "") or ""),
            }
            for name in ordered_steps
        },
        "step_reports": {
            str(step.get("step", "") or ""): str(step.get("report_path", "") or "")
            for step in steps
            if str(step.get("step", "") or "").strip()
        },
        "execution_backend": backend,
        "child_count": len(child_task_ids),
        "operator_surface": operator_surface,
        "operator_hint": str(operator_surface.get("operator_hint", "") or ""),
    }


def register_multi_parent_task(
    *,
    task: str,
    parent_spec: dict,
    decision: dict,
    plan: dict,
    execution: dict,
    backend: str,
    parent_parent_id: str = "",
) -> None:
    route_meta = decision_route(decision)
    model_meta = decision_model(decision)
    child_ids = [str(step.get("task_id", "") or "").strip() for step in execution.get("steps", []) if str(step.get("task_id", "") or "").strip()]
    step_names = " / ".join(name for name in ("planner", "worker", "review") if isinstance(plan.get(name), dict))
    executed = bool(execution.get("executed", False))
    handoff = execution.get("handoff", {}) if isinstance(execution.get("handoff", {}), dict) else {}
    status = "running" if executed else ("failed" if handoff.get("status") == "failed" else "dispatched")
    summary = (
        f"spawn_multi active: {step_names}" if executed
        else (f"spawn_multi failed: {step_names}" if status == "failed" else f"spawn_multi planned: {step_names}")
    )
    upsert_runtime_task(
        id=str(parent_spec.get("task_id", "") or ""),
        model=str(parent_spec.get("model", "") or ""),
        status=status,
        summary=summary,
        title=task_title(task),
        model_band=str(parent_spec.get("model_band", "") or ""),
        task_description=task,
        expected_done=str(parent_spec.get("expected_done", "") or ""),
        executor="team",
        route="spawn_multi",
        runtime=backend,
        parent_id=parent_parent_id,
        child_ids=",".join(child_ids),
        report_path=str(parent_spec.get("report_path", "") or ""),
        context_path=str(parent_spec.get("context_path", "") or ""),
        context_summary=str(parent_spec.get("context_summary", "") or ""),
        task_kind="team_parent",
        worker_pool=str(route_meta.get("worker_pool", "") or ""),
        work_type=str(route_meta.get("work_type", "") or ""),
        phase=str(route_meta.get("phase", "") or ""),
        protocol=str(route_meta.get("protocol", "") or "normal"),
        profile=str(model_meta.get("profile", "") or parent_spec.get("profile", "")),
        review_required="true" if bool(decision_review(decision).get("required", False)) else "false",
        artifacts_json=json.dumps(build_multi_parent_artifacts(plan, execution.get("steps", []), backend), ensure_ascii=False),
        **octoclaw_identity_fields(decision),
    )


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


def _runner_result_payload(
    *,
    status: str,
    meta: dict | None,
    result_path: str,
    fallback_exit_code: int = 0,
    fallback_finished_at: str = "",
    fallback_summary: str = "",
) -> dict:
    meta = meta if isinstance(meta, dict) else {}
    stdout_file = str(meta.get("stdout_file", "") or "")
    stderr_file = str(meta.get("stderr_file", "") or "")
    stdout_excerpt = str(meta.get("stdout_excerpt", "") or "").strip() or _tail_text(stdout_file)
    stderr_excerpt = str(meta.get("stderr_excerpt", "") or "").strip() or _tail_text(stderr_file)
    worker_result = normalize_worker_result(
        meta.get("worker_result") if isinstance(meta.get("worker_result"), dict) else {
            "status": str(meta.get("status", "") or status or "done"),
            "summary": str(meta.get("summary", "") or fallback_summary or ""),
            "report": str(meta.get("report_path", "") or ""),
            "next_step": "none" if str(meta.get("status", "") or status or "done").strip().lower() in {"done", "completed"} else "inspect report and retry or replan",
        },
        task_id=str(meta.get("id", "") or ""),
        default_report=str(meta.get("report_path", "") or ""),
    )
    return {
        "completed": True,
        "status": str(meta.get("status", "") or status or "done"),
        "exit_code": int(meta.get("exit_code", fallback_exit_code) or fallback_exit_code or 0),
        "result_path": result_path,
        "report_path": str(meta.get("report_path", "") or worker_result.get("report", "") or ""),
        "summary": str(meta.get("summary", "") or worker_result.get("summary", "") or fallback_summary or ""),
        "stdout_file": stdout_file,
        "stderr_file": stderr_file,
        "stdout_excerpt": stdout_excerpt,
        "stderr_excerpt": stderr_excerpt,
        "execution_backend": str(meta.get("execution_backend", "") or "runner_queue"),
        "command": str(meta.get("command", "") or ""),
        "cwd": str(meta.get("cwd", "") or ""),
        "timeout_seconds": int(meta.get("timeout_seconds", 0) or 0),
        "worker_id": str(meta.get("worker_id", "") or ""),
        "finished_at": str(meta.get("finished_at", "") or fallback_finished_at or ""),
        "worker_result": worker_result,
    }


def build_runner_handoff(task: str, payload: dict, wait: dict | None) -> dict:
    job = payload.get("job", {}) if isinstance(payload, dict) else {}
    job_id = str(job.get("id", "") or "")
    wait = wait or {}
    if wait.get("completed"):
        status = str(wait.get("status", "done") or "done")
        worker_result = wait.get("worker_result") if isinstance(wait.get("worker_result"), dict) else {}
        runner_summary = compact_text(str(wait.get("summary", "") or worker_result.get("summary", "") or ""), 180)
        report_path = str(wait.get("report_path", "") or worker_result.get("report", "") or "")
        stdout_text = _read_text(str(wait.get("stdout_file", "") or "")) or str(wait.get("stdout_excerpt", "") or "")
        stderr_text = _read_text(str(wait.get("stderr_file", "") or "")) or str(wait.get("stderr_excerpt", "") or "")
        merged = stdout_text.strip()
        if stderr_text.strip():
            merged = f"{merged}\n\n[stderr]\n{stderr_text.strip()}".strip()
        reply_text = _summarize_output(stdout_text or merged)
        if not report_path and (len(merged) > 500 or len(_clean_output_lines(merged)) > 6):
            report_path = _write_shared_report(job_id or f"runner-{now_compact()}", merged)
        if not reply_text:
            reply_text = compact_text(str(worker_result.get("summary", "") or ""), 220) or runner_summary or "已通过常驻 runner 完成检查。"
        if len(reply_text) > MAX_INLINE_CHARS:
            if not report_path:
                report_path = _write_shared_report(job_id or f"runner-{now_compact()}", merged or reply_text)
            reply_text = reply_text[:MAX_INLINE_CHARS] + f"\n\n[输出已截断，完整内容：{report_path}]"
        summary = runner_summary or compact_text(str(worker_result.get("summary", "") or ""), 180) or (
            "已通过常驻 runner 完成检查，详细输出已写入共享文件。" if report_path else "已通过常驻 runner 完成检查。"
        )
        return {
            "kind": "final",
            "status": "success" if status == "done" else status,
            "summary": summary,
            "reply_text": reply_text,
            "report_path": report_path,
            "job_id": job_id,
            "execution_backend": str(wait.get("execution_backend", "") or "runner_queue"),
            "worker_result": worker_result,
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


def build_spawn_handoff(route: str, worker_pool: str, task: str) -> dict:
    reply = "我会交给一个子任务继续处理，稍后给你结论。"
    if route == "spawn_multi":
        reply = "我会拆成分阶段子任务处理，先做调研/分析，再回给你结论。"
    elif worker_pool == "octoclaw-code":
        reply = "我会先交给修复子任务分析并整理修复建议。"
    elif worker_pool == "octoclaw-research":
        reply = "我会先交给调研子任务收集信息，再回来汇总结论。"
    elif worker_pool == "octoclaw-review":
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


def build_multi_step_task(base_task: str, step_name: str) -> str:
    if step_name == "planner":
        return (
            "你是多子任务流程里的规划/分析负责人。\n"
            "先拆解原始任务，明确关键检查点、依赖和交付结构；必要时先做快速调研，再给后续执行者一个清晰方案。\n\n"
            f"原始任务：\n{base_task}"
        )
    if step_name == "review":
        return (
            "你是多子任务流程里的审查/验证负责人。\n"
            "请站在 reviewer 视角检查主执行结果是否有遗漏、风险、回归点或表达不清的地方，并给出最终把关意见。\n\n"
            f"原始任务：\n{base_task}"
        )
    return (
        "你是多子任务流程里的主执行者。\n"
        "请基于原始任务完成主体分析/实现/整理工作，并把长结果写入共享报告。\n\n"
        f"原始任务：\n{base_task}"
    )


def execute_multi_spawn_plan(args, task: str, plan: dict, *, parent_task_id: str) -> dict:
    spawn_cfg = load_octopus_config().get("spawn_execution", {})
    if not isinstance(spawn_cfg, dict) or not spawn_cfg.get("enabled", False) or str(spawn_cfg.get("backend", "plan") or "plan").strip().lower() != "clawteam":
        return {"executed": False, "steps": [], "handoff": build_spawn_handoff("spawn_multi", "", task)}

    ordered_steps = [name for name in ("planner", "worker", "review") if isinstance(plan.get(name), dict)]
    if not ordered_steps:
        return {"executed": False, "steps": [], "handoff": build_spawn_handoff("spawn_multi", "", task)}

    parent_id = parent_task_id
    previous_task_id = ""
    steps: list[dict] = []

    for step_name in ordered_steps:
        step = plan.get(step_name, {}) or {}
        step_task = build_multi_step_task(task, step_name)
        spec = build_spawn_spec(
            step_task,
            route="spawn_single",
            model_band=str(step.get("model_band", "") or ""),
            selector_band=str(step.get("selector_band", "") or ""),
            model=str(step.get("model", "") or ""),
            worker_pool=str(step.get("worker_pool", "") or ""),
            work_type=str(step.get("work_type", "") or ""),
            phase=str(step.get("phase", "") or ""),
            profile=str(step.get("profile", "") or ""),
            parent_id=parent_id,
            task_kind="team_step",
            register=True,
            execute=True,
            deps=[previous_task_id] if previous_task_id else None,
            policy_decision=step.get("policy_decision") if isinstance(step.get("policy_decision"), dict) else None,
        )
        steps.append(
            {
                "step": step_name,
                "model": spec.get("model", ""),
                "model_band": spec.get("model_band", ""),
                "selector_band": spec.get("selector_band", ""),
                "worker_pool": spec.get("worker_pool", ""),
                "work_type": spec.get("work_type", ""),
                "phase": spec.get("phase", ""),
                "task_id": spec.get("task_id", ""),
                "executed": bool(spec.get("executed", False)),
                "execution_error": spec.get("execution_error", ""),
                "report_path": spec.get("report_path", ""),
                "task_kind": spec.get("task_kind", ""),
                "spawn_execution": spec.get("spawn_execution", {}),
            }
        )
        if not spec.get("executed", False):
            return {
                "executed": False,
                "steps": steps,
                "handoff": {
                    "kind": "plan",
                    "status": "failed",
                    "summary": f"多子任务流程在 {step_name} 阶段启动失败。",
                    "reply_text": "我开始拆多子任务了，但其中一个工位启动失败，已保留已创建的状态信息。",
                    "report_path": "",
                    "user_safe": True,
                },
            }
        previous_task_id = str(spec.get("task_id", "") or previous_task_id)

    step_names = " / ".join(ordered_steps)
    return {
        "executed": True,
        "steps": steps,
        "handoff": {
            "kind": "background",
            "status": "pending",
            "summary": f"多子任务流程已通过 ClawTeam/tmux 启动：{step_names}。",
            "reply_text": f"我已经把这个任务拆成 {step_names} 几个工位挂到 ClawTeam/tmux 里继续处理，稍后回来汇总结论。",
            "report_path": "",
            "user_safe": True,
        },
    }


def wait_for_runner_result(job_id: str, timeout_seconds: int) -> dict:
    deadline = time.time() + max(0, timeout_seconds)
    meta_path = os.path.join(RUNNER_RESULTS_DIR, f"{job_id}.json")
    while time.time() <= deadline:
        if os.path.exists(meta_path):
            meta = load_json(meta_path)
            if isinstance(meta, dict):
                return _runner_result_payload(status="done", meta=meta, result_path=meta_path)
        queue = load_json(RUNNER_QUEUE_FILE)
        if isinstance(queue, dict):
            jobs = queue.get("jobs", [])
            if isinstance(jobs, list):
                job = next((item for item in jobs if item.get("id") == job_id), None)
                if isinstance(job, dict) and job.get("status") == "failed":
                    result_path = str(job.get("result_path", "") or "")
                    meta = load_json(result_path) if result_path else None
                    return _runner_result_payload(
                        status="failed",
                        meta=meta,
                        result_path=result_path,
                        fallback_exit_code=int(job.get("exit_code", 1) or 1),
                        fallback_finished_at=str(job.get("finished_at", "") or ""),
                        fallback_summary=str(job.get("summary", "") or ""),
                    )
        time.sleep(0.5)
    return {"completed": False, "timeout_seconds": timeout_seconds}


def runner_health_is_healthy(stale_after_seconds: int = RUNNER_STALE_SECONDS) -> bool:
    health = load_json(RUNNER_HEALTH_FILE)
    if not isinstance(health, dict) or not health.get("worker_id"):
        return False
    last = parse_iso(str(health.get("last_heartbeat_at", "") or ""))
    if last is None:
        return False
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    age_seconds = max(0, int((datetime.now(timezone.utc) - last.astimezone(timezone.utc)).total_seconds()))
    return age_seconds <= stale_after_seconds


def run_runner_on_demand(job_id: str) -> dict:
    worker_id = f"runner-ondemand-{job_id or now_compact()}"
    env = {
        **os.environ,
        "WORKSPACE": WORKSPACE,
        "RUNNER_MAX_JOBS_PER_WORKER": "1",
        "RUNNER_MAX_IDLE_SECONDS": "1",
        "RUNNER_POLL_INTERVAL_SECONDS": "1",
        "RUNNER_HEARTBEAT_INTERVAL_SECONDS": "1",
        "RUNNER_WORKER_ID": worker_id,
    }
    result = subprocess.run(
        ["bash", RUNNER_LOOP_SH],
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )
    return {
        "triggered": True,
        "worker_id": worker_id,
        "returncode": int(result.returncode),
        "ok": result.returncode == 0,
    }


def dispatch_runner(args) -> dict:
    decision = getattr(args, "_policy_decision", {}) or {}
    identity = octoclaw_identity_fields(decision)
    playbook = getattr(args, "_runner_playbook", None)
    if not isinstance(playbook, dict) or not playbook:
        playbook = None
    command = args.command
    summary = args.summary
    if not command and not playbook:
        playbook = infer_runner_playbook(args.task)
    if playbook:
        command = command or str(playbook.get("command", "") or "")
        if not summary:
            summary = str(playbook.get("summary", "") or "")

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
        "--model-band",
        args.model_band or "fast",
        "--task-description",
        args.task,
    ]
    if playbook:
        dispatch_cmd.extend(["--playbook-json", json.dumps(playbook, ensure_ascii=False)])
    if str(identity.get("session_key", "") or "").strip():
        dispatch_cmd.extend(["--session-key", str(identity["session_key"])])
    if str(identity.get("session_id", "") or "").strip():
        dispatch_cmd.extend(["--session-id", str(identity["session_id"])])
    if str(identity.get("agent_id", "") or "").strip():
        dispatch_cmd.extend(["--agent-id", str(identity["agent_id"])])
    if str(identity.get("agent_namespace", "") or "").strip():
        dispatch_cmd.extend(["--agent-namespace", str(identity["agent_namespace"])])
    if str(identity.get("managed_by_octoclaw", "") or "").strip():
        dispatch_cmd.extend(["--managed-by-octoclaw", str(identity["managed_by_octoclaw"])])
    result = subprocess.run(dispatch_cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "runner dispatch failed")
    payload = json.loads(result.stdout.strip() or "{}")
    response = {
        "route": "runner",
        "executed": True,
        "job": payload,
        "reason": "lightweight_task",
        "runner_execution_mode": "daemon",
    }
    if playbook:
        response["runner_plan"] = playbook
        response["playbook"] = playbook
    if args.wait and not runner_health_is_healthy():
        response["runner_execution_mode"] = "on_demand"
        response["runner_execution"] = run_runner_on_demand(str(payload.get("id", "") or ""))
    if args.wait:
        wait_timeout = 1 if response.get("runner_execution_mode") == "on_demand" else args.wait_timeout_seconds
        response["wait"] = wait_for_runner_result(payload.get("id", ""), wait_timeout)
    response["handoff"] = build_runner_handoff(args.task, response, response.get("wait"))
    return response


def recommend_spawn(args, task: str) -> dict:
    decision = getattr(args, "_policy_decision", {}) or {}
    route_meta = decision_route(decision)
    model_meta = decision_model(decision)
    requested_model_band = getattr(args, "model_band", "") or ""
    spawn_spec = build_spawn_spec(
        task,
        route="spawn_single",
        model_band=requested_model_band or str(model_meta.get("model_band", "") or ""),
        selector_band=str(model_meta.get("selector_band", "") or ""),
        worker_pool=str(route_meta.get("worker_pool", "") or ""),
        work_type=str(route_meta.get("work_type", "") or ""),
        phase=str(route_meta.get("phase", "") or ""),
        profile=str(model_meta.get("profile", "") or ""),
        parent_id=args.id or "",
        register=True,
        execute=None,
        policy_decision=decision,
    )
    return apply_policy_fields({
        "route": "spawn_single",
        "executed": bool(spawn_spec.get("executed", False)),
        "model": spawn_spec["model"],
        "profile": spawn_spec.get("profile", ""),
        "model_band": spawn_spec.get("model_band", ""),
        "selector_band": spawn_spec.get("selector_band", ""),
        "reason": "needs_subagent" if not spawn_spec.get("execution_error") else "subagent_spawn_failed",
        "task": task,
        "handoff": spawn_spec["handoff"],
        "spawn_spec": spawn_spec,
    }, decision)


def recommend_multi_spawn(args, task: str) -> dict:
    decision = getattr(args, "_policy_decision", {}) or {}
    spawn_cfg = load_octopus_config().get("spawn_execution", {})
    multi_exec_enabled = isinstance(spawn_cfg, dict) and bool(spawn_cfg.get("enabled", False)) and str(spawn_cfg.get("backend", "plan") or "plan").strip().lower() == "clawteam"
    requested_model_band = getattr(args, "model_band", "") or ""
    primary_spawn = build_spawn_spec(
        task,
        route="spawn_multi",
        model_band=requested_model_band or str(decision_model(decision).get("model_band", "") or ""),
        selector_band=str(decision_model(decision).get("selector_band", "") or ""),
        worker_pool=str(decision_route(decision).get("worker_pool", "") or ""),
        work_type=str(decision_route(decision).get("work_type", "") or ""),
        phase=str(decision_route(decision).get("phase", "") or ""),
        profile=str(decision_model(decision).get("profile", "") or ""),
        parent_id=args.id or "",
        task_kind="team_parent",
        register=False,
        policy_decision=decision,
    )
    planner_task = build_multi_step_task(task, "planner")
    planner_decision = build_decision(planner_task, metadata=decision_metadata(decision), force_route="spawn_single")
    worker_decision = clone_worker_step_decision(decision)
    plan = {
        "planner": compat_spawn_step_from_decision(planner_decision),
        "worker": compat_spawn_step_from_decision(worker_decision, fallback=primary_spawn),
    }
    if decision_review(decision).get("required", False):
        review_task = build_multi_step_task(task, "review")
        review_decision = build_decision(review_task, metadata=decision_metadata(decision), force_route="spawn_single")
        plan["review"] = compat_spawn_step_from_decision(review_decision)
    execution = execute_multi_spawn_plan(args, task, plan, parent_task_id=str(primary_spawn.get("task_id", "") or f"octoclaw-team-{now_compact()}"))
    parent_runtime = "clawteam" if multi_exec_enabled else "plan"
    primary_spawn["runtime"] = parent_runtime
    primary_spawn["task_kind"] = "team_parent"
    primary_spawn["child_ids"] = [
        str(step.get("task_id", "") or "").strip()
        for step in execution.get("steps", [])
        if str(step.get("task_id", "") or "").strip()
    ]
    register_multi_parent_task(
        task=task,
        parent_spec=primary_spawn,
        decision=decision,
        plan=plan,
        execution=execution,
        backend=parent_runtime,
        parent_parent_id=args.id or "",
    )
    return apply_policy_fields({
        "route": "spawn_multi",
        "task_id": primary_spawn.get("task_id", ""),
        "executed": bool(execution.get("executed", False)),
        "model": primary_spawn["model"],
        "profile": primary_spawn.get("profile", ""),
        "model_band": primary_spawn.get("model_band", ""),
        "selector_band": primary_spawn.get("selector_band", ""),
        "runtime": parent_runtime,
        "task_kind": "team_parent",
        "reason": "parallel_or_staged_workflow",
        "task": task,
        "report_path": primary_spawn.get("report_path", ""),
        "plan": plan,
        "handoff": execution.get("handoff", primary_spawn["handoff"]),
        "steps": execution.get("steps", []),
        "spawn_spec": primary_spawn,
    }, decision)


def main():
    parser = argparse.ArgumentParser(description="Unified OctoClaw dispatcher")
    parser.add_argument("--task", required=True)
    parser.add_argument("--command", default="")
    parser.add_argument("--cwd", default=WORKSPACE)
    parser.add_argument("--summary", default="")
    parser.add_argument("--timeout-seconds", dest="timeout_seconds", type=int, default=120)
    parser.add_argument("--id", default="")
    parser.add_argument("--model-band", dest="model_band", default="")
    parser.add_argument("--force-route", choices=["auto", "direct", "runner", "spawn_single", "spawn_multi"], default="auto")
    parser.add_argument("--session-key", dest="session_key", default="")
    parser.add_argument("--metadata-json", dest="metadata_json", default="")
    parser.add_argument("--policy-json", default="")
    parser.add_argument("--wait", action="store_true")
    parser.add_argument("--wait-timeout-seconds", dest="wait_timeout_seconds", type=int, default=12)
    args = parser.parse_args()

    task = args.task.strip()
    decision = None
    if args.policy_json:
        try:
            parsed = json.loads(args.policy_json)
            if isinstance(parsed, dict):
                decision = parsed
        except json.JSONDecodeError:
            decision = None
    if not isinstance(decision, dict):
        forced_route = ""
        if args.force_route != "auto":
            forced_route = args.force_route
        metadata: dict[str, object] = {}
        if args.metadata_json:
            try:
                parsed = json.loads(args.metadata_json)
                if isinstance(parsed, dict):
                    metadata.update(parsed)
            except json.JSONDecodeError:
                metadata = metadata
        if args.session_key:
            metadata["session_key"] = args.session_key
        decision = build_decision(task, args.command, metadata, force_route=forced_route)
    args._policy_decision = decision
    route = decision_route(decision)
    model_meta = decision_model(decision)
    final_route = str(route.get("route", "direct") or "direct")

    if final_route == "direct":
        payload = apply_policy_fields(
            {
                "route": "direct",
                "executed": False,
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
            decision,
        )
        print(json.dumps(payload, ensure_ascii=False))
        return

    if final_route == "runner":
        playbook = infer_runner_playbook(task) if not args.command else None
        if not args.command and not playbook:
            payload = apply_policy_fields(
                {
                    "route": "runner",
                    "executed": False,
                    "task": task,
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
                decision,
            )
            print(json.dumps(payload, ensure_ascii=False))
            return
        if playbook and not args.summary:
            args.summary = playbook.get("summary", "")
        if playbook:
            args.command = args.command or str(playbook.get("command", "") or "")
            args._runner_playbook = playbook
        if not args.wait and route.get("should_wait"):
            args.wait = True
            args.wait_timeout_seconds = route.get("wait_timeout_seconds", args.wait_timeout_seconds)
        if not args.model_band:
            args.model_band = str(model_meta.get("model_band", "") or args.model_band or "fast")
        payload = dispatch_runner(args)
        payload = apply_policy_fields(payload, decision)
        print(json.dumps(payload, ensure_ascii=False))
        return

    if final_route == "spawn_multi":
        payload = recommend_multi_spawn(args, task)
    else:
        payload = recommend_spawn(args, task)
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
