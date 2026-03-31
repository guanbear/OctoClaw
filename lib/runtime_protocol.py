#!/usr/bin/env python3
"""Shared brief/result protocol helpers for OctoClaw workers."""

from __future__ import annotations

from typing import Any


BRIEF_SCHEMA_VERSION = "octoclaw.brief/v1"
WORKER_RESULT_SCHEMA_VERSION = "octoclaw.worker_result/v1"


def _compact_text(text: str, limit: int) -> str:
    collapsed = " ".join(str(text or "").strip().split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 1].rstrip() + "…"


def _string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        text = str(value).strip()
        return [text] if text else []
    return []


def normalize_result_status(value: str, default: str = "failed") -> str:
    text = str(value or "").strip().lower()
    if text in {"done", "success", "completed"}:
        return "done"
    if text in {"blocked", "pending", "needs_input"}:
        return "blocked"
    if text in {"failed", "failure", "error"}:
        return "failed"
    return default


def build_result_contract(summary_hint: str, *, artifact_first: bool = True) -> dict[str, Any]:
    artifacts_hint = ["path-or-id"] if artifact_first else []
    return {
        "schema_version": WORKER_RESULT_SCHEMA_VERSION,
        "status": "done",
        "summary": summary_hint,
        "artifacts": artifacts_hint,
        "files": [],
        "report": "共享文件路径或null" if artifact_first else "null",
        "risks": [],
        "next_step": "若无需后续动作则写 none",
    }


def build_task_brief(
    *,
    task_id: str,
    goal: str,
    route: str,
    worker_pool: str,
    work_type: str,
    phase: str,
    profile: str,
    protocol: str,
    review_required: bool,
    report_path: str,
    context_summary: str = "",
    context_path: str = "",
    context_pack: dict[str, Any] | None = None,
    context_budget: dict[str, Any] | None = None,
    skill_bundle: list[str] | None = None,
    expected_done: str = "",
    summary_hint: str = "",
) -> dict[str, Any]:
    constraints = [
        "开始前先写 running 状态",
        "默认只读必要上下文，避免长 transcript 回灌主脑",
        "长输出或长 diff 优先写共享文件，不要直接塞回 RESULT",
    ]
    if report_path:
        constraints.append(f"详细报告默认写到 {report_path}")
    if review_required:
        constraints.append("交付前需要显式说明风险点，必要时建议 review next_step")
    if protocol == "heavy":
        constraints.append("需要 checkpoint summary，中间结果优先 artifact 化")
    if context_path:
        constraints.append(f"如需详细背景，优先读取 {context_path}")
    if isinstance(context_pack, dict) and int(context_pack.get("related_task_count", 0) or 0) > 0:
        constraints.append("follow-up 优先使用 context_pack，而不是回灌长 transcript")

    brief = {
        "schema_version": BRIEF_SCHEMA_VERSION,
        "task_id": str(task_id or "").strip(),
        "goal": _compact_text(goal, 400),
        "route": str(route or "").strip(),
        "worker_pool": str(worker_pool or "").strip(),
        "work_type": str(work_type or "").strip(),
        "phase": str(phase or "").strip(),
        "profile": str(profile or "").strip(),
        "protocol": str(protocol or "").strip() or "normal",
        "review_required": bool(review_required),
        "expected_done": str(expected_done or "").strip(),
        "constraints": constraints,
        "context_summary": _compact_text(context_summary, 400),
        "context_path": str(context_path or "").strip(),
        "context_pack": dict(context_pack) if isinstance(context_pack, dict) else {},
        "context_budget": dict(context_budget) if isinstance(context_budget, dict) else {},
        "skill_bundle": [str(item).strip() for item in (skill_bundle or []) if str(item).strip()],
        "expected_output": build_result_contract(summary_hint, artifact_first=True),
    }
    return brief


def normalize_worker_result(
    payload: dict[str, Any] | None,
    *,
    task_id: str = "",
    default_report: str = "",
) -> dict[str, Any]:
    data = payload if isinstance(payload, dict) else {}
    report = str(data.get("report", "") or default_report or "").strip()
    artifacts = _string_list(data.get("artifacts"))
    if report and report not in artifacts:
        artifacts.append(report)
    return {
        "schema_version": WORKER_RESULT_SCHEMA_VERSION,
        "task_id": str(data.get("task_id", "") or task_id or "").strip(),
        "status": normalize_result_status(str(data.get("status", "") or "")),
        "summary": _compact_text(str(data.get("summary", "") or ""), 500),
        "artifacts": artifacts,
        "files": _string_list(data.get("files")),
        "report": report,
        "risks": _string_list(data.get("risks")),
        "next_step": _compact_text(str(data.get("next_step", "") or ""), 240),
    }
