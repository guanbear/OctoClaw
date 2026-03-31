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


def _allowed_tools(worker_pool: str, work_type: str, phase: str, route: str) -> list[str]:
    current_pool = str(worker_pool or "").strip()
    current_work_type = str(work_type or "").strip()
    current_phase = str(phase or "").strip()
    current_route = str(route or "").strip()
    tools: list[str] = []
    if current_route == "runner" or current_pool == "octoclaw-runner":
        tools.extend(["shell", "logs", "status"])
    if current_work_type == "research" or current_pool == "octoclaw-research":
        tools.extend(["docs", "web", "report"])
    if current_work_type == "code" or current_pool == "octoclaw-code":
        tools.extend(["repo", "test", "review"])
    if current_work_type == "review" or current_pool == "octoclaw-review":
        tools.extend(["review", "risk", "regression"])
    if current_phase == "report":
        tools.append("writer")
    deduped: list[str] = []
    for item in tools:
        if item and item not in deduped:
            deduped.append(item)
    return deduped


def _done_definition(route: str, review_required: bool, report_path: str) -> str:
    pieces = [
        "交付必须包含结构化 RESULT",
        "summary 需要可直接转述",
    ]
    if report_path:
        pieces.append(f"长输出写到 {report_path}")
    if route == "runner":
        pieces.append("输出事实检查结果，不做多余推测")
    if review_required:
        pieces.append("显式说明风险与建议 review next_step")
    return "；".join(pieces)


def _expected_artifacts(report_path: str, context_path: str, context_pack: dict[str, Any] | None) -> list[str]:
    items: list[str] = []
    for value in (
        str(report_path or "").strip(),
        str(context_path or "").strip(),
        str(((context_pack or {}) if isinstance(context_pack, dict) else {}).get("context_pack_path", "") or "").strip(),
    ):
        if value and value not in items:
            items.append(value)
    return items


def _checklist_delta(context_pack: dict[str, Any] | None) -> list[str]:
    if not isinstance(context_pack, dict):
        return []
    related = context_pack.get("related_tasks", [])
    if not isinstance(related, list):
        return []
    deltas: list[str] = []
    for item in related[:3]:
        if not isinstance(item, dict):
            continue
        task_id = str(item.get("task_id", "") or "").strip()
        checklist = item.get("checklist", {}) if isinstance(item.get("checklist"), dict) else {}
        open_count = int(checklist.get("open_count", 0) or 0)
        completed_count = int(checklist.get("completed_count", 0) or 0)
        next_step = str(item.get("next_step", "") or "").strip()
        parts = []
        if completed_count or open_count:
            parts.append(f"{completed_count} done / {open_count} open")
        if next_step and next_step.lower() != "none":
            parts.append(f"next={next_step}")
        if task_id and parts:
            deltas.append(f"{task_id}: " + " ; ".join(parts))
    return deltas


def _retrieval_hints(
    *,
    task_id: str,
    report_path: str,
    context_path: str,
    context_pack: dict[str, Any] | None,
    context_budget: dict[str, Any] | None,
) -> dict[str, Any]:
    pack = dict(context_pack) if isinstance(context_pack, dict) else {}
    budget = dict(context_budget) if isinstance(context_budget, dict) else {}
    return {
        "prefer_context_pack": bool(budget.get("prefer_context_pack", False)),
        "report_path": str(report_path or "").strip(),
        "context_path": str(context_path or "").strip(),
        "context_pack_path": str(pack.get("context_pack_path", "") or "").strip(),
        "followup_command_hint": f"retrieve {str(task_id or '').strip()}".strip(),
    }


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
        "user_safe_summary": "若可直接转述给用户，写 1-3 句中文摘要；否则留空字符串",
        "deliverable_kind": "final_answer",
        "artifacts": artifacts_hint,
        "files": [],
        "report": "共享文件路径或null" if artifact_first else "null",
        "risks": [],
        "verification": [],
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
    work_contract: str = "",
    budget_policy: dict[str, Any] | None = None,
    merge_contract: str = "",
    handoff_contract: str = "",
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
        "objective": _compact_text(goal, 240),
        "work_contract": str(work_contract or "").strip(),
        "route": str(route or "").strip(),
        "worker_pool": str(worker_pool or "").strip(),
        "work_type": str(work_type or "").strip(),
        "phase": str(phase or "").strip(),
        "profile": str(profile or "").strip(),
        "protocol": str(protocol or "").strip() or "normal",
        "review_required": bool(review_required),
        "expected_done": str(expected_done or "").strip(),
        "boundary": {
            "artifact_first": True,
            "avoid_raw_transcript": True,
            "review_required": bool(review_required),
            "followup_uses_context_pack": isinstance(context_pack, dict) and int(context_pack.get("related_task_count", 0) or 0) > 0,
        },
        "allowed_tools": _allowed_tools(worker_pool, work_type, phase, route),
        "done_definition": _done_definition(route, review_required, report_path),
        "expected_artifacts": _expected_artifacts(report_path, context_path, context_pack),
        "constraints": constraints,
        "context_summary": _compact_text(context_summary, 400),
        "context_path": str(context_path or "").strip(),
        "context_pack": dict(context_pack) if isinstance(context_pack, dict) else {},
        "context_budget": dict(context_budget) if isinstance(context_budget, dict) else {},
        "checklist_delta": _checklist_delta(context_pack),
        "retrieval_hints": _retrieval_hints(
            task_id=task_id,
            report_path=report_path,
            context_path=context_path,
            context_pack=context_pack,
            context_budget=context_budget,
        ),
        "budget_policy": dict(budget_policy) if isinstance(budget_policy, dict) else {},
        "merge_contract": str(merge_contract or "").strip(),
        "handoff_contract": str(handoff_contract or "").strip(),
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
        "user_safe_summary": _compact_text(str(data.get("user_safe_summary", "") or ""), 320),
        "deliverable_kind": _compact_text(str(data.get("deliverable_kind", "") or ""), 80),
        "artifacts": artifacts,
        "files": _string_list(data.get("files")),
        "report": report,
        "risks": _string_list(data.get("risks")),
        "verification": _string_list(data.get("verification")),
        "next_step": _compact_text(str(data.get("next_step", "") or ""), 240),
    }
