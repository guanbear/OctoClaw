#!/usr/bin/env python3
"""Replay valuable real-user prompts against the latest local OctoClaw build."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Replay valuable prompts against latest OctoClaw")
    parser.add_argument("--sessions-index", default="")
    parser.add_argument("--packet", default="")
    parser.add_argument("--day", required=True)
    parser.add_argument("--timezone", default=DEFAULT_TIMEZONE)
    parser.add_argument("--limit", type=int, default=3)
    parser.add_argument("--output", required=True)
    parser.add_argument("--cases-output", default="")
    parser.add_argument("--workspace", default="")
    parser.add_argument("--openclaw-home", default="")
    parser.add_argument("--agent-model", default="zai/glm-4.7")
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
            stdout=exc.stdout or "",
            stderr=(exc.stderr or "") + "\n[replay_validation] timeout after 240s",
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


def render_report(day: str, cases: list[CaseResult]) -> str:
    lines = [
        f"# Nightly Replay Validation - {day}",
        "",
        "## Summary",
        "",
        f"- Cases replayed: {len(cases)}",
    ]
    total_findings = sum(len(case.findings) for case in cases)
    lines.append(f"- Finding signals: {total_findings}")
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
    else:
        sessions_index = load_sessions_index(Path(args.sessions_index))
        turns = collect_turns_all(sessions_index=sessions_index, review_day=review_day, tz=tz)
    selected = select_turns(turns, args.limit)

    workspace = args.workspace or os.environ.get("WORKSPACE") or str(Path.home() / ".openclaw" / "workspace")
    openclaw_home = args.openclaw_home or os.environ.get("OPENCLAW_HOME") or str(Path.home() / ".openclaw")
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

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(render_report(args.day, case_results), encoding="utf-8")
    if args.cases_output:
        cases_path = Path(args.cases_output)
        cases_path.parent.mkdir(parents=True, exist_ok=True)
        cases_path.write_text(
            json.dumps([asdict(case) for case in case_results], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    print(str(output_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
