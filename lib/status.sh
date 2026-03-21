#!/bin/bash
# 八爪鱼状态查询脚本
# 用法：
#   bash /workspace/openclaw/skills/octopus/lib/status.sh
#   bash /workspace/openclaw/skills/octopus/lib/status.sh --format table
#   bash /workspace/openclaw/skills/octopus/lib/status.sh --format lanes

FORMAT="compact"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --format)
            FORMAT="${2:-compact}"
            shift 2
            ;;
        --table)
            FORMAT="table"
            shift
            ;;
        --lanes)
            FORMAT="lanes"
            shift
            ;;
        *)
            shift
            ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

python3 - "$FORMAT" "$SCRIPT_DIR" <<'PYEOF'
import json
import os
import sys
from datetime import datetime, timedelta, timezone

fmt = sys.argv[1] if len(sys.argv) > 1 else "compact"
script_dir = sys.argv[2] if len(sys.argv) > 2 else os.getcwd()
sys.path.insert(0, script_dir)

from octopus_config import CONFIG_FILE, MODE_FILE, MODEL_POLICY_FILE, RUNNER_HEALTH_FILE, load_json
from status_render import (
    build_status_snapshot,
    render_status_lanes,
    render_status_table,
    render_status_text_compact,
    short_model,
)

TASK_FILE = "/workspace/tmp/octopus/task-state.json"
ALIASES_FILE = "/workspace/tmp/octopus-model-aliases.json"

now = datetime.now(timezone(timedelta(hours=8)))

mode_data = load_json(MODE_FILE) or {}
aliases = load_json(ALIASES_FILE) or {}
policy_data = load_json(MODEL_POLICY_FILE) or {}
config_data = load_json(CONFIG_FILE) or {}
runner_health = load_json(RUNNER_HEALTH_FILE) or {}

mode = mode_data.get("mode", "balanced")
MODE_LABELS = {
    "balanced": "平衡模式",
    "quality": "效果优先",
    "cost": "成本优先",
    "speed": "速度优先",
    "private": "保密模式",
    "custom": "自定义模式",
    "auto": "自动选模",
}
mode_label = MODE_LABELS.get(mode, mode)

rules = mode_data.get("modes", {}).get(mode, {})


def tier_model(tier):
    if mode == "auto":
        auto_tier = policy_data.get("tiers", {}).get(tier, "")
        if auto_tier:
            return short_model(auto_tier)
    short = rules.get(tier)
    if short and isinstance(short, str) and "/" in short:
        return short_model(short)
    if short:
        model_short = {
            "glm": "GLM",
            "kimi": "Kimi",
            "sonnet": "Sonnet",
            "claudeopus": "Opus",
            "dynamic_fastest": "最快可用",
        }
        return model_short.get(short, short)
    full = aliases.get(tier, "")
    if full:
        return short_model(full)
    return "?"


def load_tasks():
    if not os.path.exists(TASK_FILE):
        return []
    try:
        with open(TASK_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        tasks = data.get("tasks", [])
        return [task for task in tasks if task.get("source") == "octopus"]
    except Exception:
        return []


ts = now.strftime("%Y-%m-%d %H:%M")
print(f"🐙 八爪鱼状态 [{ts}]")
print("━━━━━━━━━━━━━━━━━━━━")
print(f"⚙️  模式：{mode_label}")
backend = config_data.get("notification", {}).get("backend", "auto")
print(f"🔔 通知：{backend}")
if isinstance(runner_health, dict) and runner_health.get("worker_id"):
    runner_job = runner_health.get("job_id", "")
    runner_note = f" · 当前任务 {runner_job}" if runner_job else ""
    print(f"🏃 Runner：{runner_health.get('worker_id')}{runner_note}")
print("📊 模型配置：")
print(
    "   trivial/simple → "
    f"{tier_model('trivial')}  |  normal/hard → {tier_model('normal')}  |  deep → {tier_model('deep')}"
)
main_model = policy_data.get("main_model", "")
if mode == "auto" and main_model:
    print(f"🤖 主模型：{short_model(main_model)}")
print(f"🖥️  视图：{fmt}")
print("━━━━━━━━━━━━━━━━━━━━")

tasks = load_tasks()
snapshot = build_status_snapshot(tasks, now=now)

if fmt == "table":
    print(render_status_table(snapshot))
elif fmt == "lanes":
    print(render_status_lanes(snapshot))
else:
    print(render_status_text_compact(snapshot))

print("━━━━━━━━━━━━━━━━━━━━")
PYEOF
