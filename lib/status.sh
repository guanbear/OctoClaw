#!/bin/bash
# 八爪鱼状态查询脚本
# 用法：bash /workspace/openclaw/skills/octopus/lib/status.sh

python3 - <<'PYEOF'
import json
import os
from datetime import datetime, timedelta, timezone

TASK_FILE = "/workspace/tmp/octopus/task-state.json"
MODE_FILE = "/workspace/tmp/octopus-mode.json"
ALIASES_FILE = "/workspace/tmp/octopus-model-aliases.json"

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

def load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None

# 当前时间（东八区）
now = datetime.now(timezone(timedelta(hours=8)))
one_hour_ago = now - timedelta(minutes=30)

# ── 模式配置 ──────────────────────────────────────────────────
mode_data = load_json(MODE_FILE) or {}
aliases = load_json(ALIASES_FILE) or {}

mode = mode_data.get("mode", "balanced")
MODE_LABELS = {
    "balanced": "平衡模式", "quality": "效果优先",
    "cost": "成本优先", "speed": "速度优先",
    "private": "保密模式", "custom": "自定义模式",
}
mode_label = MODE_LABELS.get(mode, mode)

# 提取各 tier 的模型简称
def short_model(path):
    if not path:
        return "?"
    p = path.lower()
    if "opus" in p: return "Opus"
    if "sonnet" in p: return "Sonnet"
    if "haiku" in p: return "Haiku"
    if "glm" in p: return "GLM"
    if "kimi" in p: return "Kimi"
    return path.split("/")[-1][:12]

rules = mode_data.get("modes", {}).get(mode, {})

def tier_model(tier):
    # 先从 rules 查短名，再从 aliases 查完整路径
    short = rules.get(tier)
    if short and isinstance(short, str) and "/" in short:
        return short_model(short)
    if short:
        MODEL_SHORT = {"glm": "GLM", "kimi": "Kimi", "sonnet": "Sonnet",
                       "claudeopus": "Opus", "dynamic_fastest": "最快可用"}
        return MODEL_SHORT.get(short, short)
    full = aliases.get(tier, "")
    if full:
        return short_model(full)
    return "?"

t_trivial = tier_model("trivial")
t_normal  = tier_model("normal")
t_deep    = tier_model("deep")

# 输出 header
ts = now.strftime("%Y-%m-%d %H:%M")
print(f"🐙 八爪鱼状态 [{ts}]")
print("━━━━━━━━━━━━━━━━━━━━")
print(f"⚙️  模式：{mode_label}")
print(f"📊 模型配置：")
print(f"   trivial/simple → {t_trivial}  |  normal/hard → {t_normal}  |  deep → {t_deep}")
print("━━━━━━━━━━━━━━━━━━━━")

# ── 读取任务 ──────────────────────────────────────────────────
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

# 无活跃任务提示
if not running and not queued and not deferred:
    print("✅ 无活跃任务")
else:
    # 运行中
    if running:
        print(f"🔵 运行中（{len(running)}个）")
        for t in running:
            emoji = get_emoji(t.get("label"))
            tid = t.get("id", "?")
            tier = t.get("tier", "?")
            dur = format_duration(t.get("started_at") or t.get("spawned_at"), now)
            summary = t.get("summary", "")
            display = summary[:30] if summary else tid.split("-", 3)[-1] if "-" in tid else tid
            print(f"  {emoji} {display} · {tier} · {dur}")

    # 排队中
    if queued:
        print(f"⏸️  排队中（{len(queued)}个）")
        for t in queued:
            emoji = get_emoji(t.get("label"))
            tid = t.get("id", "?")
            deps = t.get("deps", [])
            waiting = deps[0] if deps else "?"
            print(f"  {emoji} {tid} · 等待 {waiting}")

    # 待定
    if deferred:
        print(f"⏳ 待定（{len(deferred)}个）")
        for t in deferred:
            emoji = get_emoji(t.get("label"))
            tid = t.get("id", "?")
            summary = t.get("summary", "")[:40] if t.get("summary") else ""
            print(f"  {emoji} {tid} · {summary}")

# 近30min完成/失败（不管有没有活跃任务都显示）
if recent_done:
    print(f"✅ 近30min完成（{len(recent_done)}个）")
    for t in recent_done[:10]:
        tid = t.get("id", "?")
        summary = t.get("summary", "")[:30] if t.get("summary") else ""
        print(f"  {tid} | {summary}")

if recent_failed:
    print(f"❌ 近30min失败（{len(recent_failed)}个）")
    for t in recent_failed[:10]:
        tid = t.get("id", "?")
        summary = t.get("summary", "")[:30] if t.get("summary") else ""
        print(f"  {tid} | {summary}")

print("━━━━━━━━━━━━━━━━━━━━")
PYEOF