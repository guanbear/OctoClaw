#!/usr/bin/env python3
"""Build minimal authoritative state grounding packets for protected lanes."""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from typing import Any

try:
    from main_model_drift import assess_main_model_drift
    from patrol import observe_runtime_read_model
except ModuleNotFoundError:  # pragma: no cover
    from lib.main_model_drift import assess_main_model_drift
    from lib.patrol import observe_runtime_read_model


TASK_ID_RE = re.compile(r"\b(?:review|research|code|runner)-\d+\b", re.IGNORECASE)
TASK_STATUS_QUERY_RE = re.compile(
    r"(queued|running|done|complete|completed|finish|finished|status|dispatch|subtask|delegate|谁做的|谁查的|谁回的|谁执行的|跑起来了吗|跑了没|完成了吗|还在排队|还在queued|有没有走dispatch|是不是子任务)",
    re.IGNORECASE,
)
SESSION_MODEL_QUERY_RE = re.compile(
    r"(你是啥模型|你是什么模型|你现在是啥模型|你现在是什么模型|现在啥模型|当前啥模型|现在是啥模型|现在是什么模型|what model are you|current model|主会话模型|策略主链|漂移)",
    re.IGNORECASE,
)


def _text(value: Any) -> str:
    return str(value or "").strip()


def _parse_iso(value: str) -> datetime | None:
    raw = _text(value)
    if not raw:
        return None
    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        parsed = datetime.fromisoformat(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def _task_sort_key(task: dict[str, Any]) -> tuple[int, float]:
    status = _text(task.get("status")).lower()
    active_rank = 1 if status in {"running", "queued", "dispatched", "pending_confirm"} else 0
    for field in ("latest_event_at", "updated_at", "completed_at", "started_at", "spawned_at"):
        parsed = _parse_iso(_text(task.get(field)))
        if parsed is not None:
            return (active_rank, parsed.timestamp())
    return (active_rank, 0.0)


def _select_task(tasks: list[dict[str, Any]], prompt: str, preferred_task_id: str = "") -> dict[str, Any] | None:
    explicit = TASK_ID_RE.findall(prompt or "")
    if explicit:
        wanted = explicit[-1].lower()
        for task in tasks:
            if _text(task.get("id")).lower() == wanted:
                return task
    preferred = _text(preferred_task_id).lower()
    if preferred:
        for task in tasks:
            if _text(task.get("id")).lower() == preferred:
                return task
    ranked = sorted(tasks, key=_task_sort_key, reverse=True)
    return ranked[0] if ranked else None


def _derive_handled_by(task: dict[str, Any]) -> str:
    route = _text(task.get("route")).lower()
    worker_pool = _text(task.get("worker_pool"))
    runtime = _text(task.get("runtime"))
    model = _text(task.get("model"))
    if route == "direct":
        return "main_agent_direct"
    parts = [part for part in [worker_pool, runtime or route, model] if part]
    return " / ".join(parts) if parts else "delegated"


def _task_prompt_context(task: dict[str, Any]) -> str:
    lines = [
        "[OctoClaw state grounding]",
        "Use these authoritative task facts for status/provenance answers. Do not guess or reuse stale wording.",
        f"task_id={_text(task.get('id'))}",
        f"display_status={_text(task.get('status'))}",
        f"projection_status={_text(task.get('projection_status'))}",
        f"read_model_status={_text(task.get('read_model_status'))}",
        f"latest_event_kind={_text(task.get('latest_event_kind'))}",
        f"latest_event_at={_text(task.get('latest_event_at'))}",
        f"route={_text(task.get('route'))}",
        f"worker_pool={_text(task.get('worker_pool'))}",
        f"handled_by={_derive_handled_by(task)}",
        f"model={_text(task.get('model'))}",
        f"summary={_text(task.get('summary'))}",
        f"report_path={_text(task.get('report_path'))}",
    ]
    return "\n".join(lines)


def _session_model_context() -> dict[str, Any]:
    drift = assess_main_model_drift()
    packet = {
        "current_model": _text(drift.get("actual_model")) or _text(drift.get("compared_model")),
        "expected_model": _text(drift.get("expected_model")),
        "drift_reason": _text(drift.get("reason")),
        "current_override": _text(drift.get("current_override")),
        "drift": bool(drift.get("drift")),
    }
    lines = [
        "[OctoClaw session model grounding]",
        "Use these authoritative session-model facts. Do not infer the current model from memory.",
        f"current_model={packet['current_model']}",
        f"expected_model={packet['expected_model']}",
        f"drift_reason={packet['drift_reason']}",
        f"current_override={packet['current_override']}",
        f"drift={'true' if packet['drift'] else 'false'}",
    ]
    return {"packet_type": "session_model", "packet": packet, "prompt_context": "\n".join(lines)}


def build_state_grounding(
    prompt: str,
    *,
    protected_lane: str = "",
    scope: str = "",
    workspace: str = "",
    preferred_task_id: str = "",
) -> dict[str, Any]:
    if _text(protected_lane) != "control_observer":
        return {"required": False, "found": False, "reason": "not_protected_lane"}
    prompt_text = _text(prompt)
    if SESSION_MODEL_QUERY_RE.search(prompt_text):
        session_payload = _session_model_context()
        session_payload.update({"required": True, "found": bool(_text(session_payload["packet"].get("current_model"))), "scope": "session_model"})
        if not session_payload["found"]:
            session_payload["reason"] = "session_model_missing"
        return session_payload
    if not TASK_STATUS_QUERY_RE.search(prompt_text) and not TASK_ID_RE.search(prompt_text):
        return {"required": True, "found": False, "scope": scope or "task_status_or_provenance", "reason": "no_status_or_provenance_intent"}
    payload = observe_runtime_read_model(workspace=workspace) if workspace else observe_runtime_read_model()
    tasks = [dict(task) for task in (payload.get("tasks", []) if isinstance(payload, dict) else []) if isinstance(task, dict)]
    task = _select_task(tasks, prompt_text, preferred_task_id=preferred_task_id)
    if not task:
        return {"required": True, "found": False, "scope": scope or "task_status_or_provenance", "reason": "task_not_found"}
    return {
        "required": True,
        "found": True,
        "scope": scope or "task_status_or_provenance",
        "packet_type": "task_status",
        "packet": {
            "task_id": _text(task.get("id")),
            "display_status": _text(task.get("status")),
            "projection_status": _text(task.get("projection_status")),
            "read_model_status": _text(task.get("read_model_status")),
            "latest_event_kind": _text(task.get("latest_event_kind")),
            "latest_event_at": _text(task.get("latest_event_at")),
            "route": _text(task.get("route")),
            "worker_pool": _text(task.get("worker_pool")),
            "handled_by": _derive_handled_by(task),
            "model": _text(task.get("model")),
            "summary": _text(task.get("summary")),
            "report_path": _text(task.get("report_path")),
        },
        "prompt_context": _task_prompt_context(task),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Build protected-lane state grounding context")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--protected-lane", default="")
    parser.add_argument("--scope", default="")
    parser.add_argument("--workspace", default="")
    parser.add_argument("--preferred-task-id", default="")
    args = parser.parse_args()
    payload = build_state_grounding(
        args.prompt,
        protected_lane=args.protected_lane,
        scope=args.scope,
        workspace=args.workspace,
        preferred_task_id=args.preferred_task_id,
    )
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
