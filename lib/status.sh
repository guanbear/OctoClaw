#!/bin/bash
# 八爪鱼状态查询脚本
# 用法：bash /workspace/openclaw/skills/octopus/lib/status.sh

python3 - <<'PYEOF'
import json
import os
from datetime import datetime, timedelta, timezone

TASK_FILE = "/workspace/tmp/octopus/task-state.json"

# Emoji 映射
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

def get_emoji(label):
    return LABEL_EMOJI.get(label, "🤖")

def parse_time(tstr):
    if not tstr:
        return None
    try:
        if tstr.endswith('Z'):
            tstr = tstr[:-1] + '+00:00'
        return datetime.fromisoformat(tstr)
    except:
        return None

def format_duration(started_at, now):
    start = parse_time(started_at)
    if not start:
        return "?"
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    secs = int((now - start).total_seconds())
    if secs < 60:
        return f"{secs}s"
    mins = secs // 60
    secs = secs % 60
    return f"{mins}m{secs}s"

# 当前时间（东八区）
now = datetime.now(timezone(timedelta(hours=8)))
one_hour_ago = now - timedelta(minutes=30)

# 读取任务
if not os.path.exists(TASK_FILE):
    tasks = []
else:
    with open(TASK_FILE) as f:
        data = json.load(f)
    tasks = data.get("tasks", [])

# 只显示八爪鱼任务（严格匹配 source=octopus）
tasks = [t for t in tasks if t.get("source") == "octopus"]

# 分类
running = [t for t in tasks if t.get("status") in ("running", "dispatched")]
queued = [t for t in tasks if t.get("status") == "queued"]
deferred = [t for t in tasks if t.get("status") == "deferred"]
recent_done = []
recent_failed = []

for t in tasks:
    if t.get("status") == "done":
        ct = parse_time(t.get("completed_at"))
        if ct:
            if ct.tzinfo:
                ct = ct.astimezone(timezone(timedelta(hours=8))).replace(tzinfo=None)
            if ct >= one_hour_ago.replace(tzinfo=None):
                recent_done.append(t)
    elif t.get("status") == "failed":
        ct = parse_time(t.get("completed_at"))
        if ct:
            if ct.tzinfo:
                ct = ct.astimezone(timezone(timedelta(hours=8))).replace(tzinfo=None)
            if ct >= one_hour_ago.replace(tzinfo=None):
                recent_failed.append(t)

# 输出
ts = now.strftime("%Y-%m-%d %H:%M")
print(f"🐙 八爪鱼状态 [{ts}]")
print("━━━━━━━━━━━━━━━━━━━━")

# 运行中
print(f"🔵 运行中（{len(running)}个）")
for t in running:
    emoji = get_emoji(t.get("label"))
    tid = t.get("id", "?")
    tier = t.get("tier", "?")
    dur = format_duration(t.get("started_at") or t.get("spawned_at"), now)
    summary = t.get("summary", "")
    # summary 为空时用 id 末段作为任务描述
    display = summary[:30] if summary else tid.split("-", 3)[-1] if "-" in tid else tid
    print(f"  {emoji} {display} · {tier} · {dur}")

# 排队中
print(f"⏸️ 排队中（{len(queued)}个）")
for t in queued:
    emoji = get_emoji(t.get("label"))
    tid = t.get("id", "?")
    deps = t.get("deps", [])
    waiting = deps[0] if deps else "?"
    print(f"  {emoji} {tid} · 等待 {waiting}")

# 待定
print(f"⏳ 待定（{len(deferred)}个）")
for t in deferred:
    emoji = get_emoji(t.get("label"))
    tid = t.get("id", "?")
    summary = t.get("summary", "")[:40] if t.get("summary") else ""
    print(f"  {emoji} {tid} · {summary}")

# 近30min完成
print(f"✅ 近30min完成（{len(recent_done)}个）")
for t in recent_done[:10]:
    tid = t.get("id", "?")
    summary = t.get("summary", "")[:30] if t.get("summary") else ""
    print(f"  {tid} | {summary}")

# 近1h失败
print(f"❌ 近30min失败（{len(recent_failed)}个）")
if recent_failed:
    for t in recent_failed[:10]:
        tid = t.get("id", "?")
        summary = t.get("summary", "")[:30] if t.get("summary") else ""
        print(f"  {tid} | {summary}")

print("━━━━━━━━━━━━━━━━━━━━")
PYEOF