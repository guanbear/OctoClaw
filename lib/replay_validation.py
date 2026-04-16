#!/usr/bin/env python3
"""Replay valuable real-user prompts against the latest local OctoClaw build."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

try:
    from feedback_loop import build_validation_summary
except ModuleNotFoundError:
    from lib.feedback_loop import build_validation_summary
try:
    from octopus_config import load_json
except ModuleNotFoundError:
    from lib.octopus_config import load_json

try:
    from reply_review_packet import (
        DEFAULT_TIMEZONE,
        iter_jsonl,
        load_sessions_index,
        looks_internal_prompt,
        message_text,
        normalize_prompt,
        parse_iso,
    )
except ModuleNotFoundError:
    from lib.reply_review_packet import (
        DEFAULT_TIMEZONE,
        iter_jsonl,
        load_sessions_index,
        looks_internal_prompt,
        message_text,
        normalize_prompt,
        parse_iso,
    )


@dataclass
class Turn:
    session_key: str
    session_file: str
    user_timestamp: str
    user_prompt: str
    assistant_reply: str


@dataclass
class CaseResult:
    agent: str
    session_id: str
    prompt: str
    return_code: int
    reply_text: str
    stderr_tail: str
    new_tasks: list[dict]
    replay_events: list[dict]
    findings: list[str]


@dataclass
class RuntimeInfo:
    source_label: str
    workspace: str
    openclaw_home: str
    python_executable: str
    python_version: str
    openclaw_version: str


SAFE_REPLAY_BLOCKLIST = (
    "安装",
    "install",
    "卸载",
    "删除",
    "rm ",
    "sudo",
    "elevated",
    "allowfrom",
    "配置",
    "patch",
    "修改配置",
    "开 elevated",
)


def _event_dict(event: dict[str, object], *keys: str) -> dict[str, object]:
    for key in keys:
        value = event.get(key)
        if isinstance(value, dict):
            return value
    return {}


def _event_bool(event: dict[str, object], *keys: str) -> bool | None:
    for key in keys:
        value = event.get(key)
        if isinstance(value, bool):
            return value
    return None


def _first_non_empty(*values: object) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def summarize_route_outcomes(cases: list[CaseResult]) -> dict[str, object]:
    execution_contract_counts: dict[str, int] = {}
    route_class_counts: dict[str, int] = {}
    route_correct_cases = 0
    budget_correct_cases = 0
    delivery_correct_cases = 0
    delivery_failure_cases = 0
    cases_with_outcome = 0
    fallback_taken_count = 0
    unresolved_fallback_cases = 0
    stale_recovery_count = 0
    execution_contract_mismatch_cases = 0
    missing_outcome_cases: list[str] = []
    evidence: list[dict[str, object]] = []

    for case in cases:
        latest_event: dict[str, object] | None = None
        latest_outcome: dict[str, object] = {}
        for event in reversed(case.replay_events):
            if not isinstance(event, dict):
                continue
            payload = _event_dict(event, "routeOutcome", "route_outcome")
            if payload:
                latest_event = event
                latest_outcome = payload
                break

        budget_consistent: bool | None = None
        for event in reversed(case.replay_events):
            if not isinstance(event, dict):
                continue
            budget_consistent = _event_bool(event, "routeBudgetConsistent", "route_budget_consistent")
            if budget_consistent is None:
                auto_router = _event_dict(event, "autoRouter", "auto_router")
                planner = _event_dict(auto_router, "budgetPlanner", "budget_planner")
                consistency = _event_dict(planner, "consistency")
                budget_consistent = _event_bool(consistency, "route_budget_consistent")
            if budget_consistent is not None:
                break

        route_correct = False
        fallback_taken = False
        stale_recovery = False
        if latest_outcome:
            cases_with_outcome += 1
            execution_contract = _first_non_empty(
                latest_outcome.get("execution_contract"),
                latest_event.get("executionContract") if latest_event else "",
                latest_event.get("execution_contract") if latest_event else "",
            )
            resolved_execution_contract = _first_non_empty(
                latest_outcome.get("resolved_execution_contract"),
                latest_event.get("resolvedExecutionContract") if latest_event else "",
                latest_event.get("resolved_execution_contract") if latest_event else "",
                latest_event.get("route") if latest_event else "",
            )
            route_class = _first_non_empty(
                latest_outcome.get("route_class"),
                latest_event.get("routeClass") if latest_event else "",
                latest_event.get("route_class") if latest_event else "",
            )
            if execution_contract:
                execution_contract_counts[execution_contract] = execution_contract_counts.get(execution_contract, 0) + 1
            if route_class:
                route_class_counts[route_class] = route_class_counts.get(route_class, 0) + 1
            route_correct = bool(execution_contract and resolved_execution_contract and execution_contract == resolved_execution_contract)
            if route_correct:
                route_correct_cases += 1
            else:
                execution_contract_mismatch_cases += 1
            fallback_taken = bool(
                latest_outcome.get("fallback_taken")
                or (latest_event and latest_event.get("fallbackTaken"))
                or (latest_event and latest_event.get("fallback_taken"))
            )
            if fallback_taken:
                fallback_taken_count += 1
            stale_recovery = bool(
                latest_outcome.get("stale_recovery")
                or (latest_event and latest_event.get("staleRecovery"))
                or (latest_event and latest_event.get("stale_recovery"))
            )
            if stale_recovery:
                stale_recovery_count += 1
        else:
            missing_outcome_cases.append(case.prompt)
            execution_contract = ""
            resolved_execution_contract = ""
            route_class = ""

        delivery_correct = not case.findings
        if delivery_correct:
            delivery_correct_cases += 1
        else:
            delivery_failure_cases += 1
        if budget_consistent is True:
            budget_correct_cases += 1
        fallback_unresolved = bool(fallback_taken and (not delivery_correct or not route_correct or stale_recovery))
        if fallback_unresolved:
            unresolved_fallback_cases += 1

        evidence.append(
            {
                "prompt": case.prompt,
                "route_outcome_present": bool(latest_outcome),
                "execution_contract": execution_contract,
                "resolved_execution_contract": resolved_execution_contract,
                "route_class": route_class,
                "route_correct": route_correct,
                "budget_correct": budget_consistent,
                "delivery_correct": delivery_correct,
                "delivery_findings": list(case.findings),
                "fallback_taken": fallback_taken,
                "fallback_unresolved": fallback_unresolved,
                "stale_recovery": stale_recovery,
                "findings": list(case.findings),
            }
        )

    total = len(cases)
    return {
        "cases_total": total,
        "cases_with_outcome": cases_with_outcome,
        "coverage_complete": total > 0 and cases_with_outcome == total,
        "coverage_rate": round(cases_with_outcome / total, 6) if total else 0.0,
        "route_correct_cases": route_correct_cases,
        "route_correctness_rate": round(route_correct_cases / total, 6) if total else 0.0,
        "budget_correct_cases": budget_correct_cases,
        "budget_correctness_rate": round(budget_correct_cases / total, 6) if total else 0.0,
        "delivery_correct_cases": delivery_correct_cases,
        "delivery_correctness_rate": round(delivery_correct_cases / total, 6) if total else 0.0,
        "delivery_failure_cases": delivery_failure_cases,
        "fallback_taken_count": fallback_taken_count,
        "fallback_rate": round(fallback_taken_count / total, 6) if total else 0.0,
        "unresolved_fallback_cases": unresolved_fallback_cases,
        "stale_recovery_count": stale_recovery_count,
        "execution_contract_mismatch_cases": execution_contract_mismatch_cases,
        "execution_contract_counts": dict(sorted(execution_contract_counts.items())),
        "route_class_counts": dict(sorted(route_class_counts.items())),
        "missing_outcome_prompts": missing_outcome_cases,
        "evidence": evidence,
    }


def attach_validation_to_manifest(
    manifest_path: str,
    *,
    validation_summary_path: str,
    validation_cases_path: str,
    validation_summary: dict[str, object],
) -> None:
    if not manifest_path:
        return
    path = Path(manifest_path).expanduser().resolve()
    if not path.exists():
        return
    payload = load_json(str(path))
    if not isinstance(payload, dict):
        return
    if str(payload.get("schema_version", "") or "").strip() != "octoclaw.feedback_manifest/v1":
        return
    generated = payload.get("generated_artifacts")
    if not isinstance(generated, dict):
        generated = {}
    generated["validation_summary_json"] = validation_summary_path
    if validation_cases_path:
        generated["validation_cases_json"] = validation_cases_path
    payload["generated_artifacts"] = generated
    payload["validation_status"] = "passed" if bool(validation_summary.get("passed")) else "failed"
    payload["validation_artifacts"] = {
        "validation_summary_json": validation_summary_path,
        "validation_cases_json": validation_cases_path,
    }
    payload["route_outcome_metrics"] = dict(validation_summary.get("route_outcome_metrics") or {})
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Replay valuable prompts against latest OctoClaw")
    parser.add_argument("--sessions-index", default="")
    parser.add_argument("--packet", default="")
    parser.add_argument("--day", required=True)
    parser.add_argument("--timezone", default=DEFAULT_TIMEZONE)
    parser.add_argument("--limit", type=int, default=3)
    parser.add_argument("--output", required=True)
    parser.add_argument("--cases-output", default="")
    parser.add_argument("--summary-output", default="")
    parser.add_argument("--source-run-id", default="")
    parser.add_argument("--feedback-manifest", default="")
    parser.add_argument("--workspace", default="")
    parser.add_argument("--openclaw-home", default="")
    parser.add_argument("--agent-model", default="zai/glm-4.7")
    parser.add_argument("--source-label", default="")
    return parser.parse_args()


def collect_turns_all(
    *,
    sessions_index: dict[str, dict],
    review_day: datetime,
    tz: ZoneInfo,
) -> list[Turn]:
    turns: list[Turn] = []
    target_date = review_day.date()
    for session_key, meta in sessions_index.items():
        session_file_text = str((meta or {}).get("sessionFile") or "").strip()
        if not session_file_text:
            continue
        session_file = Path(session_file_text)
        if not session_file.exists():
            continue
        messages: list[tuple[datetime | None, str, str]] = []
        for entry in iter_jsonl(session_file):
            if entry.get("type") != "message":
                continue
            payload = entry.get("message") or {}
            role = str(payload.get("role") or "").strip()
            if role not in {"user", "assistant"}:
                continue
            text = message_text(payload.get("content"))
            if not text:
                continue
            stamp = parse_iso(entry.get("timestamp") or payload.get("timestamp"))
            messages.append((stamp, role, text))
        current_user: tuple[datetime | None, str] | None = None
        assistant_parts: list[str] = []
        for stamp, role, text in messages:
            if role == "user":
                if current_user and assistant_parts:
                    normalized = normalize_prompt(current_user[1])
                    if normalized and not looks_internal_prompt(normalized):
                        turns.append(
                            Turn(
                                session_key=session_key,
                                session_file=str(session_file),
                                user_timestamp=current_user[0].isoformat() if current_user[0] else "",
                                user_prompt=normalized,
                                assistant_reply="\n\n".join(part for part in assistant_parts if part.strip()).strip(),
                            )
                        )
                current_user = (stamp, text)
                assistant_parts = []
                continue
            if current_user:
                assistant_parts.append(str(text or "").strip())
        if current_user and assistant_parts:
            normalized = normalize_prompt(current_user[1])
            if normalized and not looks_internal_prompt(normalized):
                turns.append(
                    Turn(
                        session_key=session_key,
                        session_file=str(session_file),
                        user_timestamp=current_user[0].isoformat() if current_user[0] else "",
                        user_prompt=normalized,
                        assistant_reply="\n\n".join(part for part in assistant_parts if part.strip()).strip(),
                    )
                )
    filtered: list[Turn] = []
    for turn in turns:
        stamp = parse_iso(turn.user_timestamp)
        if not stamp or stamp.astimezone(tz).date() != target_date:
            continue
        filtered.append(turn)
    return filtered


def score_turn(turn: Turn) -> int:
    prompt = turn.user_prompt.strip()
    lowered = prompt.lower()
    if len(prompt) < 8:
        return -100
    if prompt in {"ping", "ok", "只回复 ok", "八爪鱼状态"}:
        return -100
    score = min(len(prompt), 120)
    keywords = (
        "调研",
        "研究",
        "修复",
        "安装",
        "配置",
        "更新",
        "总结",
        "判断",
        "分析",
        "排查",
        "验证",
        "why",
        "how",
        "fix",
        "research",
        "update",
        "summary",
    )
    if any(keyword in lowered or keyword in prompt for keyword in keywords):
        score += 60
    if "task flow" in lowered or "clawteam" in lowered or "octoclaw" in lowered:
        score += 40
    if len(turn.assistant_reply.strip()) < 20:
        score += 15
    return score


def is_safe_replay_prompt(prompt: str) -> bool:
    lowered = prompt.lower()
    return not any(token in lowered or token in prompt for token in SAFE_REPLAY_BLOCKLIST)


def select_turns(turns: list[Turn], limit: int) -> list[Turn]:
    deduped: dict[str, Turn] = {}
    for turn in turns:
        key = re.sub(r"\s+", " ", turn.user_prompt).strip().lower()
        existing = deduped.get(key)
        if not existing or score_turn(turn) > score_turn(existing):
            deduped[key] = turn
    ranked = sorted(deduped.values(), key=score_turn, reverse=True)
    return [turn for turn in ranked if score_turn(turn) > 0 and is_safe_replay_prompt(turn.user_prompt)][:limit]


def select_packet_turns(turns: list[Turn], limit: int) -> list[Turn]:
    selected: list[Turn] = []
    seen: set[str] = set()
    for turn in turns:
        key = re.sub(r"\s+", " ", turn.user_prompt).strip().lower()
        if not key or key in seen:
            continue
        if not is_safe_replay_prompt(turn.user_prompt):
            continue
        seen.add(key)
        selected.append(turn)
        if len(selected) >= limit:
            break
    return selected


def turns_from_packet(path: Path) -> list[Turn]:
    payload = json.loads(path.read_text())
    cases = payload.get("cases") or []
    turns: list[Turn] = []
    for case in cases:
        if not isinstance(case, dict):
            continue
        prompt = normalize_prompt(str(case.get("user_prompt") or case.get("prompt") or "").strip())
        if not prompt or looks_internal_prompt(prompt):
            continue
        turns.append(
            Turn(
                session_key=str(case.get("session_key") or ""),
                session_file=str(case.get("session_file") or ""),
                user_timestamp=str(case.get("user_timestamp") or ""),
                user_prompt=prompt,
                assistant_reply=str(case.get("assistant_reply") or "").strip(),
            )
        )
    return turns


def parse_agent_json(stdout_text: str) -> tuple[str, dict]:
    raw = (stdout_text or "").strip()
    if not raw:
        return "", {}
    payload = json.loads(raw)
    reply_parts: list[str] = []
    for item in payload.get("payloads", []):
        text = str((item or {}).get("text") or "").strip()
        if text:
            reply_parts.append(text)
    return "\n\n".join(reply_parts).strip(), payload


def load_tasks(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return json.loads(path.read_text()).get("tasks", [])


def load_replay_lines(path: Path) -> list[str]:
    if not path.exists():
        return []
    return path.read_text(errors="ignore").splitlines()


def ensure_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def run_case(
    *,
    index: int,
    prompt: str,
    workspace: str,
    openclaw_home: str,
    agent_model: str,
    task_path: Path,
    replay_path: Path,
) -> CaseResult:
    env = os.environ.copy()
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + env.get("PATH", "")
    env["OPENCLAW_HOME"] = openclaw_home
    env["WORKSPACE"] = workspace

    agent = f"octoclaw-replay-{datetime.now().strftime('%Y%m%d%H%M%S')}-{index}"
    session_id = f"{agent}-s1"
    subprocess.run(
        [
            "openclaw",
            "agents",
            "add",
            agent,
            "--workspace",
            workspace,
            "--model",
            agent_model,
            "--non-interactive",
            "--json",
        ],
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )

    before_ids = {task.get("id") for task in load_tasks(task_path)}
    before_replay = len(load_replay_lines(replay_path))

    try:
        proc = subprocess.run(
            [
                "openclaw",
                "agent",
                "--agent",
                agent,
                "--session-id",
                session_id,
                "--thinking",
                "low",
                "--json",
                "--message",
                prompt,
            ],
            env=env,
            check=False,
            capture_output=True,
            text=True,
            timeout=240,
        )
    except subprocess.TimeoutExpired as exc:
        proc = subprocess.CompletedProcess(
            args=exc.cmd,
            returncode=124,
            stdout=ensure_text(exc.stdout),
            stderr=ensure_text(exc.stderr) + "\n[replay_validation] timeout after 240s",
        )
    time.sleep(8)

    after_tasks = load_tasks(task_path)
    new_tasks = [task for task in after_tasks if task.get("id") not in before_ids]
    replay_lines = load_replay_lines(replay_path)[before_replay:]
    replay_events = []
    for line in replay_lines:
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            replay_events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    reply_text = ""
    try:
        reply_text, _ = parse_agent_json(proc.stdout)
    except Exception:
        reply_text = ""

    findings: list[str] = []
    if any((event.get("event") == "dispatch_called" and event.get("executed")) for event in replay_events):
        findings.append("dispatch_called=true")
    if any(task.get("status") == "failed" and "spawn启动失败" in str(task.get("summary") or "") for task in new_tasks):
        findings.append("spawn_failed")
    if len(new_tasks) > 1:
        findings.append("duplicate_tasks")
    if not reply_text.strip():
        findings.append("empty_reply")
    if any(event.get("event") == "policy_resolved" and not event.get("systemPreferredRoute") for event in replay_events):
        findings.append("missing_system_preferred_route_in_replay")
    if any(task.get("route") and task.get("system_preferred_route") in (None, "") for task in new_tasks):
        findings.append("missing_system_preferred_route_in_task_state")

    return CaseResult(
        agent=agent,
        session_id=session_id,
        prompt=prompt,
        return_code=proc.returncode,
        reply_text=reply_text,
        stderr_tail=(proc.stderr or "")[-2500:],
        new_tasks=new_tasks,
        replay_events=replay_events,
        findings=findings,
    )


def detect_openclaw_version(env: dict[str, str]) -> str:
    proc = subprocess.run(
        ["openclaw", "--version"],
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    return (proc.stdout or proc.stderr or "").strip() or "unknown"


def render_report(day: str, cases: list[CaseResult], runtime: RuntimeInfo) -> str:
    lines = [
        f"# Nightly Replay Validation - {day}",
        "",
        "## Summary",
        "",
        f"- Cases replayed: {len(cases)}",
    ]
    total_findings = sum(len(case.findings) for case in cases)
    lines.append(f"- Finding signals: {total_findings}")
    lines.append(f"- Source: {runtime.source_label}")
    lines.append(f"- Python: `{runtime.python_executable}` ({runtime.python_version})")
    lines.append(f"- OpenClaw: `{runtime.openclaw_version}`")
    lines.append(f"- Workspace: `{runtime.workspace}`")
    lines.append(f"- OpenClaw home: `{runtime.openclaw_home}`")
    lines.append("")
    lines.append("## Cases")
    lines.append("")
    for idx, case in enumerate(cases, start=1):
        lines.append(f"### Case {idx}")
        lines.append("")
        lines.append(f"- Prompt: `{case.prompt}`")
        lines.append(f"- Agent/session: `{case.agent}` / `{case.session_id}`")
        lines.append(f"- Return code: `{case.return_code}`")
        lines.append(f"- Findings: `{', '.join(case.findings) if case.findings else 'none'}`")
        if case.reply_text:
            lines.append("- Reply:")
            lines.append("")
            lines.append("```text")
            lines.append(case.reply_text[:1200])
            lines.append("```")
        if case.new_tasks:
            lines.append("- New tasks:")
            for task in case.new_tasks[:6]:
                lines.append(
                    f"  - `{task.get('id')}` route={task.get('route')} worker_pool={task.get('worker_pool')} "
                    f"status={task.get('status')} lifecycle={task.get('lifecycle_state')} "
                    f"system_preferred_route={task.get('system_preferred_route')!r}"
                )
        if case.stderr_tail.strip():
            lines.append("- STDERR tail:")
            lines.append("")
            lines.append("```text")
            lines.append(case.stderr_tail[-1200:])
            lines.append("```")
        lines.append("")
    lines.append("## Assessment")
    lines.append("")
    spawn_fail = [case for case in cases if "spawn_failed" in case.findings]
    missing_task_route = [case for case in cases if "missing_system_preferred_route_in_task_state" in case.findings]
    duplicate = [case for case in cases if "duplicate_tasks" in case.findings]
    if spawn_fail:
        lines.append(f"- Spawn remains broken in {len(spawn_fail)} replayed cases.")
    else:
        lines.append("- No spawn failure observed in the replayed cases.")
    if missing_task_route:
        lines.append(f"- `system_preferred_route` is still missing in task-state for {len(missing_task_route)} cases.")
    else:
        lines.append("- `system_preferred_route` persisted to task-state for all replayed delegated cases.")
    if duplicate:
        lines.append(f"- Duplicate task creation observed in {len(duplicate)} cases.")
    else:
        lines.append("- No duplicate task creation observed.")
    lines.append("")
    return "\n".join(lines).strip() + "\n"


def main() -> int:
    args = parse_args()
    tz = ZoneInfo(args.timezone)
    review_day = datetime.strptime(args.day, "%Y-%m-%d").replace(tzinfo=tz)
    turns: list[Turn]
    if args.packet:
        turns = turns_from_packet(Path(args.packet))
        selected = select_packet_turns(turns, args.limit)
    else:
        sessions_index = load_sessions_index(Path(args.sessions_index))
        turns = collect_turns_all(sessions_index=sessions_index, review_day=review_day, tz=tz)
        selected = select_turns(turns, args.limit)

    workspace = args.workspace or os.environ.get("WORKSPACE") or str(Path.home() / ".openclaw" / "workspace")
    openclaw_home = args.openclaw_home or os.environ.get("OPENCLAW_HOME") or str(Path.home() / ".openclaw")
    env = os.environ.copy()
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + env.get("PATH", "")
    env["OPENCLAW_HOME"] = openclaw_home
    task_path = Path(workspace) / "tmp" / "octopus" / "task-state.json"
    replay_path = Path(workspace) / "tmp" / "octopus" / "runtime-policy-replay.jsonl"

    case_results = [
        run_case(
            index=index,
            prompt=turn.user_prompt,
            workspace=workspace,
            openclaw_home=openclaw_home,
            agent_model=args.agent_model,
            task_path=task_path,
            replay_path=replay_path,
        )
        for index, turn in enumerate(selected, start=1)
    ]
    source_label = args.source_label or ("reply-review-packet(local real conversations)" if args.packet else "sessions-index(local)")
    runtime = RuntimeInfo(
        source_label=source_label,
        workspace=workspace,
        openclaw_home=openclaw_home,
        python_executable=sys.executable,
        python_version=sys.version.split()[0],
        openclaw_version=detect_openclaw_version(env),
    )

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(render_report(args.day, case_results, runtime), encoding="utf-8")
    passed_cases = [case for case in case_results if not case.findings]
    findings = sorted({finding for case in case_results for finding in case.findings})
    route_outcome_metrics = summarize_route_outcomes(case_results)
    validation_artifacts = {
        "validation_report_md": str(output_path),
    }
    summary_path = Path(args.summary_output) if args.summary_output else output_path.with_name(output_path.stem + "-summary.json")
    validation_artifacts["validation_summary_json"] = str(summary_path)
    validation_summary = build_validation_summary(
        source_run_id=str(args.source_run_id or ((load_json(args.feedback_manifest) or {}) if args.feedback_manifest else {}).get("run_id", "")).strip(),
        source_label=source_label,
        report_path=str(output_path),
        source_manifest_path=str(Path(args.feedback_manifest).expanduser().resolve()) if args.feedback_manifest else "",
        cases_total=len(case_results),
        cases_passed=len(passed_cases),
        cases_failed=len(case_results) - len(passed_cases),
        findings=findings,
        passed=len(case_results) > 0 and len(passed_cases) == len(case_results) and bool(route_outcome_metrics.get("coverage_complete")),
        route_outcome_metrics=route_outcome_metrics,
        generated_artifacts=validation_artifacts,
    )
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    validation_summary["generated_artifacts"] = dict(validation_artifacts)
    summary_path.write_text(json.dumps(validation_summary, ensure_ascii=False, indent=2), encoding="utf-8")
    cases_path: Path | None = None
    if args.cases_output:
        cases_path = Path(args.cases_output)
        cases_path.parent.mkdir(parents=True, exist_ok=True)
        cases_path.write_text(
            json.dumps([asdict(case) for case in case_results], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        validation_artifacts["validation_cases_json"] = str(cases_path)
    attach_validation_to_manifest(
        args.feedback_manifest,
        validation_summary_path=str(summary_path),
        validation_cases_path=str(cases_path) if cases_path else "",
        validation_summary=validation_summary,
    )
    print(str(output_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
