#!/usr/bin/env python3
"""Generic Octopus status renderers for text-only environments."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

LABEL_EMOJI = {
    "octopus-power": "💪",
    "octopus-scout": "🔍",
    "octopus-writer": "✍️",
    "octopus-fix": "🔧",
    "octopus-test": "🧪",
    "octopus-analyze": "📊",
    "octopus-runner": "🏃",
    "octopus-feishu": "🐦",
}

LABEL_NAME = {
    "octopus-power": "鲸力手",
    "octopus-scout": "梭鱼眼",
    "octopus-writer": "墨鱼手",
    "octopus-fix": "螃蟹手",
    "octopus-test": "海胆手",
    "octopus-analyze": "章鱼脑",
    "octopus-runner": "飞鱼腿",
    "octopus-feishu": "鸽手",
}


def task_executor(task: dict) -> str:
    explicit = str(task.get("executor", "") or "").strip().lower()
    if explicit in ("runner", "subagent"):
        return explicit
    if task.get("label") == "octopus-runner":
        return "runner"
    return "subagent"


def get_emoji(label: str) -> str:
    return LABEL_EMOJI.get(label, "🤖")


def get_label_name(label: str) -> str:
    return LABEL_NAME.get(label, label.replace("octopus-", "") if label else "任务")


def parse_time(value: str):
    if not value:
        return None
    try:
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        return datetime.fromisoformat(value)
    except Exception:
        return None


def short_model(path: str) -> str:
    if not path:
        return "?"
    lower = path.lower()
    if "opus" in lower:
        return "Opus"
    if "sonnet" in lower:
        return "Sonnet"
    if "gpt-5.4" in lower or "gpt_5_4" in lower:
        return "GPT-5.4"
    if "glm" in lower:
        return "GLM"
    if "kimi" in lower:
        return "Kimi"
    if "gemini" in lower:
        return "Gemini"
    if "minimax" in lower or "m2_5" in lower or "m2.5" in lower:
        return "MiniMax"
    return path.split("/")[-1][:12]


def model_cost_badge(path: str) -> str:
    lower = (path or "").lower()
    if "gpt-5.4" in lower or "gpt_5_4" in lower or "opus" in lower:
        return "¥¥¥"
    if "sonnet" in lower:
        return "¥¥"
    if "glm" in lower or "minimax" in lower or "m2_5" in lower or "m2.5" in lower or "kimi" in lower:
        return "¥"
    return "?"


GENERIC_SUMMARY_PREFIXES = (
    "runner完成",
    "runner失败",
    "已通过常驻 runner 完成检查",
    "当前任务适合主 agent 直接处理",
)


def preferred_task_title(task: dict, limit: int = 48) -> str:
    summary = str(task.get("summary") or "").strip()
    task_desc = str(task.get("task_description") or "").strip()
    task_id = str(task.get("id") or "?").strip()
    if task_desc and (not summary or summary.startswith(GENERIC_SUMMARY_PREFIXES)):
        return task_desc[:limit]
    if summary:
        return summary[:limit]
    return task_id[:limit]


def format_duration(started_at: str, now: datetime) -> str:
    started = parse_time(started_at)
    if not started:
        return "?"
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    seconds = max(0, int((now - started).total_seconds()))
    if seconds < 60:
        return f"{seconds}s"
    minutes, seconds = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes}m{seconds}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h{minutes}m"


def format_duration_between(started_at: str, completed_at: str, now: datetime) -> str:
    started = parse_time(started_at)
    completed = parse_time(completed_at)
    if not completed:
        return format_duration(started_at, now)
    if not started:
        return "?"
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    if completed.tzinfo is None:
        completed = completed.replace(tzinfo=timezone.utc)
    seconds = max(0, int((completed - started).total_seconds()))
    if seconds < 60:
        return "<1m"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes}m"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h{minutes}m"


def format_clock(value: str, now: datetime) -> str:
    dt = parse_time(value)
    if not dt:
        return "?"
    if dt.tzinfo:
        dt = dt.astimezone(now.tzinfo)
    return dt.strftime("%H:%M")


def build_status_snapshot(tasks: list[dict], now: datetime | None = None, recent_minutes: int = 30) -> dict:
    now = now or datetime.now(timezone(timedelta(hours=8)))
    recent_window = now - timedelta(minutes=recent_minutes)
    running = [t for t in tasks if t.get("status") in ("running", "dispatched")]
    queued = [t for t in tasks if t.get("status") == "queued"]
    deferred = [t for t in tasks if t.get("status") == "deferred"]
    pending = [t for t in tasks if t.get("status") == "pending_confirm"]
    failed_recent = []
    done_recent = []
    steer_needed = []

    for task in tasks:
        if task.get("recovery_action") in ("needs_steer", "steered"):
            steer_needed.append(task)
        completed = parse_time(task.get("completed_at", ""))
        if not completed:
            continue
        if completed.tzinfo:
            completed = completed.astimezone(now.tzinfo).replace(tzinfo=None)
        if completed >= recent_window.replace(tzinfo=None):
            if task.get("status") == "done":
                done_recent.append(task)
            elif task.get("status") == "failed":
                failed_recent.append(task)

    return {
        "now": now,
        "running": running,
        "queued": queued,
        "deferred": deferred,
        "pending": pending,
        "done_recent": done_recent,
        "failed_recent": failed_recent,
        "steer_needed": steer_needed,
    }


def _compact_task_line(task: dict, now: datetime) -> str:
    emoji = get_emoji(task.get("label", ""))
    role = get_label_name(task.get("label", ""))
    name = preferred_task_title(task, limit=52)
    model = short_model(task.get("model", ""))
    cost = model_cost_badge(task.get("model", ""))
    tier = str(task.get("tier", "?"))[:8]
    duration = format_duration(task.get("started_at") or task.get("spawned_at") or "", now)
    eta = task.get("expected_done_at")
    eta_text = f" · 预计 {format_clock(eta, now)}" if eta else ""
    return f"  {emoji} {role} · {model} · {cost} · {tier} · ⏱️ {duration}{eta_text}\n    └ {name}"


def render_status_text_compact(snapshot: dict) -> str:
    now = snapshot["now"]
    recent_done_count = len(snapshot["done_recent"])
    recent_failed_count = len(snapshot["failed_recent"])
    lines = [
        "🐙 八爪鱼（OctoClaw）任务面板",
        (
            f"运行中 {len(snapshot['running'])} | 排队 {len(snapshot['queued'])} | "
            f"待确认 {len(snapshot['pending'])} | 异常 {len(snapshot['failed_recent']) + len(snapshot['steer_needed'])}"
        ),
        "",
    ]
    if snapshot["running"]:
        lines.append(f"🔵 运行中（{len(snapshot['running'])}个）")
        lines.extend(_compact_task_line(task, now) for task in snapshot["running"][:8])
        lines.append("")
    if snapshot["queued"]:
        lines.append(f"⏸️ 排队中（{len(snapshot['queued'])}个）")
        for task in snapshot["queued"][:6]:
            deps = ",".join(task.get("deps", [])[:2]) or "?"
            lines.append(
                f"  {get_emoji(task.get('label', ''))} {get_label_name(task.get('label', ''))} · {short_model(task.get('model', ''))} · "
                f"{model_cost_badge(task.get('model', ''))} · {str(task.get('tier', '?'))[:8]} · wait {deps}"
            )
            lines.append(f"    └ {preferred_task_title(task, limit=52)}")
        lines.append("")
    if snapshot["steer_needed"]:
        lines.append(f"🩹 恢复中（{len(snapshot['steer_needed'])}个）")
        for task in snapshot["steer_needed"][:6]:
            reason = task.get("session_status") or task.get("recovery_action") or "needs attention"
            lines.append(
                f"  {get_emoji(task.get('label', ''))} {get_label_name(task.get('label', ''))} · {short_model(task.get('model', ''))} · "
                f"{str(task.get('tier', '?'))[:8]} · {str(reason)[:24]}"
            )
            lines.append(f"    └ {preferred_task_title(task, limit=52)}")
        lines.append("")
    if recent_done_count or recent_failed_count:
        lines.append(f"📋 近期结束（最近30分钟）：✅完成{recent_done_count} ❌失败{recent_failed_count}")
    if snapshot["done_recent"]:
        for task in snapshot["done_recent"][:5]:
            duration = format_duration_between(
                task.get("started_at") or task.get("spawned_at") or "",
                task.get("completed_at") or "",
                now,
            )
            completed = format_clock(task.get("completed_at") or "", now)
            lines.append(
                f"  ✅ {get_emoji(task.get('label', ''))} {get_label_name(task.get('label', ''))} · "
                f"{short_model(task.get('model', ''))} · {model_cost_badge(task.get('model', ''))} · "
                f"{str(task.get('tier', '?'))[:8]} · {duration} · {completed}"
            )
            lines.append(f"    └ {preferred_task_title(task, limit=60)}")
    if snapshot["failed_recent"]:
        for task in snapshot["failed_recent"][:5]:
            duration = format_duration_between(
                task.get("started_at") or task.get("spawned_at") or "",
                task.get("completed_at") or "",
                now,
            )
            completed = format_clock(task.get("completed_at") or "", now)
            lines.append(
                f"  ❌ {get_emoji(task.get('label', ''))} {get_label_name(task.get('label', ''))} · "
                f"{short_model(task.get('model', ''))} · {model_cost_badge(task.get('model', ''))} · "
                f"{str(task.get('tier', '?'))[:8]} · {duration} · {completed}"
            )
            lines.append(f"    └ {preferred_task_title(task, limit=60)}")
    if recent_done_count or recent_failed_count:
        lines.append("")
    return "\n".join(lines).rstrip()


def _table_row(columns: list[str], widths: list[int]) -> str:
    cells = []
    for idx, value in enumerate(columns):
        width = widths[idx]
        cells.append(f" {value[:width].ljust(width)} ")
    return "|" + "|".join(cells) + "|"


def render_status_table(snapshot: dict) -> str:
    now = snapshot["now"]
    rows = []
    for group_name, tasks, status_text in (
        ("run", snapshot["running"], "run"),
        ("queued", snapshot["queued"], "queued"),
        ("pending", snapshot["pending"], "pending"),
        ("recover", snapshot["steer_needed"], "steer"),
    ):
        for task in tasks[:16]:
            note = ""
            if group_name == "queued":
                note = "deps:" + ",".join(task.get("deps", [])[:2])
            elif group_name == "recover":
                note = str(task.get("session_status") or task.get("recovery_action") or "")[:16]
            else:
                note = format_duration(task.get("started_at") or task.get("spawned_at") or "", now)
            rows.append(
                [
                    preferred_task_title(task, limit=22),
                    get_label_name(task.get("label", ""))[:8],
                    short_model(task.get("model", ""))[:8],
                    status_text,
                    note,
                ]
            )

    widths = [22, 8, 8, 8, 18]
    border = "+" + "+".join("-" * (w + 2) for w in widths) + "+"
    lines = [
        "🐙 八爪鱼（OctoClaw）状态",
        border,
        _table_row(["Task", "Role", "Model", "Status", "Note"], widths),
        border,
    ]
    if rows:
        lines.extend(_table_row(row, widths) for row in rows)
    else:
        lines.append(_table_row(["(no active tasks)", "", "", "", ""], widths))
    lines.append(border)
    return "\n".join(lines)


def render_status_lanes(snapshot: dict) -> str:
    now = snapshot["now"]
    lane_map = [
        ("Main", []),
        ("Runner lane", [t for t in snapshot["running"] + snapshot["queued"] if task_executor(t) == "runner"]),
        (
            "Build lane",
            [
                t
                for t in snapshot["running"] + snapshot["queued"]
                if task_executor(t) != "runner" and t.get("label") in ("octopus-fix", "octopus-test", "octopus-power")
            ],
        ),
        (
            "Research lane",
            [
                t
                for t in snapshot["running"] + snapshot["queued"]
                if task_executor(t) != "runner" and t.get("label") in ("octopus-scout", "octopus-writer", "octopus-analyze")
            ],
        ),
        ("Recovery", snapshot["steer_needed"]),
    ]

    def lane_line(task: dict) -> str:
        name = preferred_task_title(task, limit=26)
        status = task.get("status", "?")
        if task in snapshot["steer_needed"]:
            status = "needs-steer"
        if task.get("status") == "queued":
            note = "deps"
        else:
            note = format_duration(task.get("started_at") or task.get("spawned_at") or "", now)
        return f"  └─ {name:<26} [{status:<11}] {note}"

    lines = [
        "🐙 八爪鱼（OctoClaw）",
        "",
        "Main",
        "  └─ orchestration active",
    ]
    for title, tasks in lane_map[1:]:
        lines.extend(["", title])
        if tasks:
            lines.extend(lane_line(task) for task in tasks[:6])
        else:
            lines.append("  └─ idle")
    return "\n".join(lines)
