#!/usr/bin/env python3
"""
八爪鱼巡逻脚本 patrol.py
每5分钟由 octopus-patrol cron 触发，检查任务状态，有异常则发飞书告警。

⚠️ 巡逻铁律：只读不写（task-state.json 超时标记除外）
  - 禁止修改任何代码文件（patrol.py、AGENTS.md 等）
  - 禁止"顺手修复"发现的 bug，应通过 task-state.json 记录或飞书告警通知用户
  - 所有修改必须走正式派遣流程（主 Agent spawn 子 Agent），保持派遣状态可见

检查内容：
  1. 运行中：status=running/dispatched，且 spawned_at 未超过15分钟
  2. 排队中：status=queued
  3. 待确认：status=pending_confirm（主 Agent 等待用户确认）
  4. 可能卡死：status=running/dispatched 且 spawned_at 超过15分钟没更新
  5. ⏱️ 超时检测：根据任务 tier 判断运行时长是否超阈值，超时则自动终止并告警

触发逻辑：
  - 有状态变化（running变化/新排队/新完成/新失败/新卡死）→ 发飞书面板
  - 无状态变化 → 静默，不发通知
  - 每次运行后保存快照到 /tmp/octopus-patrol-last-state.json

卡片格式：
  🔵 运行中（N个）  — 正常状态
  ⏸️ 排队中（N个）  — 等待执行
  ❓ 待确认（N个）  — 等待用户确认
  ⚠️ 可能卡死（N个）— 超15分钟无更新

超时阈值：
  trivial  → 3 min
  simple   → 5 min
  normal   → 8 min（默认）
  hard     → 15 min
  deep     → 20 min
"""

import sys
import json
import os
import fcntl
import subprocess
import time
import argparse
from datetime import datetime, timezone, timedelta
from collections import deque

from notifier import backend_supports_cards, send_text
from octopus_config import (
    MAIN_AGENT_SESSIONS_FILE,
    RUNNER_HEALTH_FILE,
    get_notification_backend,
    load_json,
    notification_enabled,
    resolve_main_session_key,
)
from session_ops import send_agent_message

# ⚠️ 注意：巡逻任务本身通过 cron 运行，不写入 task-state.json
# 因此不会在巡逻报告中出现自己。
SYSTEM_LABELS = {'octopus-patrol', 'octopus-probe', 'ironclaw-heartbeat', 'ironclaw-probe'}
# 内部查询任务 ID 前缀，过滤出面板和通知
INTERNAL_ID_PREFIXES = ('status-query-',)

# label → 触手显示名称
LABEL_NAMES = {
    "octopus-power": "💪 鲸力手",
    "octopus-scout": "🔍 梭鱼眼",
    "octopus-writer": "✍️ 墨鱼手",
    "octopus-fix": "🔧 螃蟹手",
    "octopus-test": "🧪 海胆手",
    "octopus-analyze": "📊 章鱼脑",
    "octopus-runner": "🏃 飞鱼腿",
    "octopus-feishu": "🐦 鸽手",
}

# 模型名简化映射（完整路径 → 短名）
MODEL_SHORT = {
    # Sonnet 系列
    "vendor-claude-sonnet-4-6/aws-claude-sonnet-4-6": "Sonnet",
    "aws-claude-sonnet-4-6": "Sonnet",
    "vendor-claude-google/google-claude-sonnet-4-6": "Sonnet(Google)",
    # Opus 系列
    "vendor-claude-opus-4-6/aws-claude-opus-4-6": "Opus",
    "aws-claude-opus-4-6": "Opus",
    "vendor-claude-opus-4-5/aws-claude-opus-4-5": "Opus4.5",
    "vendor-claude-google/google-claude-opus-4-6": "Opus(Google)",
    # GLM 系列
    "lixiang-glm-5/kivy-glm-5": "GLM",
    # Kimi 系列
    "lixiang-kimi-2-5/kivy-kimi-k2_5": "Kimi",
}


def _cards_enabled() -> bool:
    return backend_supports_cards() and notification_enabled("panel")


def _event_cards_enabled() -> bool:
    return backend_supports_cards() and notification_enabled("event")


def _text_notify_enabled() -> bool:
    return notification_enabled("text")

# 序号字符（同 label 多于1个时使用）
ORDINAL_CHARS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"]


def get_label_name(label: str) -> str:
    """返回触手显示名称，未知 label 直接返回原值"""
    return LABEL_NAMES.get(label, label)


def get_model_short(model: str) -> str:
    """返回模型简称，未知模型取/后面部分截断到15字"""
    if not model:
        return ""
    if model in MODEL_SHORT:
        return MODEL_SHORT[model]
    # 取/后面部分，截断到15字
    short = model.split("/")[-1] if "/" in model else model
    return short[:15] if len(short) > 15 else short


def task_executor(task: dict) -> str:
    explicit = str(task.get("executor", "") or "").strip().lower()
    if explicit in ("runner", "subagent"):
        return explicit
    if str(task.get("label", "") or "") == "octopus-runner":
        return "runner"
    return "subagent"


def is_runner_task(task: dict) -> bool:
    """Persistent runner jobs are queue/file-driven, not child-session-driven."""
    return task_executor(task) == "runner"


def assign_ordinals(task_list: list) -> dict:
    """
    统计 task_list 中每个 label 出现次数。
    多于1个时，返回 {task_id: "①"/"②"/...} 映射；只有1个则不加序号。
    """
    from collections import Counter
    label_counts = Counter(t.get("label", "") for t in task_list)
    label_index = {}  # label → 当前序号下标
    ordinal_map = {}  # task id → 序号字符（单个 label 则为 ""）

    for t in task_list:
        label = t.get("label", "")
        tid = t.get("id", id(t))
        if label_counts[label] > 1:
            idx = label_index.get(label, 0)
            ordinal_map[tid] = ORDINAL_CHARS[idx] if idx < len(ORDINAL_CHARS) else f"({idx+1})"
            label_index[label] = idx + 1
        else:
            ordinal_map[tid] = ""

    return ordinal_map

TASK_STATE_FILE = "/workspace/tmp/octopus/task-state.json"
FEISHU_CARD_SCRIPT = os.path.join(os.path.dirname(__file__), "feishu-card.py")
SESSION_HISTORY_TAIL_LINES = 30
STEER_MIN_AGE_MINUTES = 2
STEER_COOLDOWN_SECONDS = 300

# 卡死阈值：超过15分钟未更新视为可能卡死
STUCK_THRESHOLD_MINUTES = 15
RUNNER_STALE_SECONDS = 120
RUNNER_RESTART_COOLDOWN_SECONDS = 600
RUNNER_DAEMON_PID_FILE = "/workspace/tmp/octopus/runner-daemon.pid"
RUNNER_RESTART_COOLDOWN_FILE = "/workspace/tmp/octopus/runner-restart-cooldown.json"
FAILED_NOTIFY_RETRY_SECONDS = 900

# ── 超时阈值（分钟）：软超时基准（只告警不 kill）──
# 硬超时 = 软超时 × 2（才自动 kill）
# tier 字段未定义时默认 normal（15分钟软超时）
TIER_TIMEOUT_MINUTES = {
    "trivial": 3,
    "simple": 5,
    "normal": 8,
    "hard": 15,
    "deep": 20,
}
DEFAULT_TIER = "normal"  # 无 tier 字段时的默认级别

# 特定 label 的默认 tier（当 task 没有 tier 字段时使用）
LABEL_DEFAULT_TIER = {
    "octopus-analyze": "deep",   # 章鱼脑默认 deep（20min 阈值）
    "octopus-power": "deep",     # 鲸力手默认 deep
}


def load_task_state(path: str) -> dict:
    """读取 task-state.json，带共享文件锁（避免并发冲突）"""
    if not os.path.exists(path):
        return {"tasks": [], "updated_at": ""}
    with open(path, 'r', encoding='utf-8') as f:
        fcntl.flock(f, fcntl.LOCK_SH)  # 共享锁（读）
        try:
            data = json.load(f)
            # 格式容错：防止裸 list 格式导致任务丢失
            if isinstance(data, list):
                data = {"tasks": data, "updated_at": ""}
                # 顺手修复文件格式（用临时文件+replace避免竞态）
                fcntl.flock(f, fcntl.LOCK_UN)
                tmp = path + ".tmp"
                with open(tmp, 'w', encoding='utf-8') as fw:
                    json.dump(data, fw, indent=2, ensure_ascii=False)
                os.replace(tmp, path)
            return data
        except json.JSONDecodeError:
            return {"tasks": [], "updated_at": ""}
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def save_task_state(path: str, data: dict):
    """写入 task-state.json，带排他文件锁（避免并发冲突）
    
    注意：用 open('r+') 或先创建再 open('r+') 避免 'w' 模式在加锁前就截断文件。
    流程：打开文件 → 加锁 → 截断 → 写入 → 释放锁
    """
    # 确保文件存在（如果不存在则创建空文件）
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            f.write('{}')
    with open(path, 'r+', encoding='utf-8') as f:
        fcntl.flock(f, fcntl.LOCK_EX)  # 排他锁（写）
        try:
            f.seek(0)
            f.truncate()  # 加锁后再截断，避免竞态
            json.dump(data, f, indent=2, ensure_ascii=False)
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def load_tasks() -> list:
    """读取 task-state.json，返回 tasks 列表（文件不存在时返回空列表）"""
    try:
        data = load_task_state(TASK_STATE_FILE)
        tasks = data.get("tasks", [])
        if not isinstance(tasks, list):
            print(f"⚠️  task-state.json 中 tasks 字段不是列表（类型: {type(tasks).__name__}），返回空列表", file=sys.stderr)
            return []
        # 只处理八爪鱼任务（严格匹配 source=octopus）
        tasks = [t for t in tasks if t.get("source") == "octopus"]
        return tasks
    except Exception as e:
        print(f"⚠️  读取 task-state.json 失败: {e}", file=sys.stderr)
        return []


def parse_iso(ts: str):
    """解析 ISO 8601 时间字符串，返回 datetime（UTC aware）"""
    if not ts:
        return None
    try:
        ts = ts.replace("Z", "+00:00")
        return datetime.fromisoformat(ts)
    except Exception:
        return None


def check_runner_health() -> dict:
    """读取 runner 心跳并判断是否 stale。"""
    health = load_json(RUNNER_HEALTH_FILE)
    if not isinstance(health, dict) or not health.get("worker_id"):
        return {"present": False, "healthy": False, "reason": "missing"}

    last = parse_iso(str(health.get("last_heartbeat_at", "")))
    if not last:
        return {"present": True, "healthy": False, "reason": "invalid_heartbeat", "health": health}
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    age_seconds = max(0, int((datetime.now(timezone.utc) - last.astimezone(timezone.utc)).total_seconds()))
    healthy = age_seconds <= RUNNER_STALE_SECONDS
    return {
        "present": True,
        "healthy": healthy,
        "reason": "ok" if healthy else "stale",
        "age_seconds": age_seconds,
        "health": health,
    }


def maybe_restart_runner() -> bool:
    daemon_script = os.path.join(os.path.dirname(__file__), "runner-daemon.sh")
    if not os.path.exists(daemon_script):
        return False
    now = int(time.time())
    cooldown = load_json(RUNNER_RESTART_COOLDOWN_FILE)
    if isinstance(cooldown, dict):
        last_ts = int(cooldown.get("ts", 0) or 0)
        if now - last_ts < RUNNER_RESTART_COOLDOWN_SECONDS:
            return False
    try:
        if os.path.exists(RUNNER_DAEMON_PID_FILE):
            with open(RUNNER_DAEMON_PID_FILE, "r", encoding="utf-8") as f:
                old_pid = int((f.read() or "0").strip() or "0")
            if old_pid > 0:
                try:
                    os.kill(old_pid, 15)
                except OSError:
                    pass
        subprocess.Popen(
            ["bash", daemon_script],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            env=dict(os.environ),
        )
        os.makedirs(os.path.dirname(RUNNER_RESTART_COOLDOWN_FILE), exist_ok=True)
        with open(RUNNER_RESTART_COOLDOWN_FILE, "w", encoding="utf-8") as f:
            json.dump({"ts": now}, f, ensure_ascii=False)
        return True
    except Exception as e:
        print(f"  ⚠️  runner 自动重启失败: {e}", file=sys.stderr)
        return False


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def is_old_enough(task: dict, threshold_seconds: int = 60) -> bool:
    """
    检查 running/dispatched 任务是否已运行超过阈值秒数。
    - running 任务读 started_at；dispatched 任务读 spawned_at
    - 没有时间戳则默认显示（返回 True）
    """
    ts_str = task.get("started_at") or task.get("spawned_at", "")
    if not ts_str:
        return True  # 没有时间戳则显示
    try:
        ts = parse_iso(ts_str)
        if ts is None:
            return True
        now = now_utc()
        return (now - ts).total_seconds() >= threshold_seconds
    except Exception:
        return True


# 新任务显示阈值：running/dispatched 不足此秒数则忽略（过滤刚派遣的任务）
RUNNING_MIN_AGE_SECONDS = 60


def classify_tasks(tasks: list) -> tuple:
    """
    将任务分类，返回 (running, queued, pending_confirm, deferred, stuck)
    - running: status=running/dispatched 且运行超过60秒、且未超过15分钟
    - queued: status=queued（始终展示，不受60秒限制）
    - pending_confirm: status=pending_confirm（始终展示）
    - deferred: status=deferred（待定状态，不算失败）
    - stuck: status=running/dispatched 且 spawned_at 超过15分钟（可能卡死）
    注意：running/dispatched 不足60秒的任务直接忽略，不展示也不计数。
    """
    running = []
    queued = []
    pending_confirm = []
    deferred = []
    stuck = []

    now = now_utc()
    fresh_status_by_id = {}
    try:
        fresh_data = load_task_state(TASK_STATE_FILE)
        fresh_status_by_id = {
            ft.get("id"): ft.get("status")
            for ft in fresh_data.get("tasks", [])
            if isinstance(ft, dict) and ft.get("id")
        }
    except Exception:
        fresh_status_by_id = {}

    for t in tasks:
        status = t.get("status", "")

        # 跳过系统 label 和内部查询任务
        if t.get("label", "") in SYSTEM_LABELS:
            continue
        if any(t.get("id", "").startswith(p) for p in INTERNAL_ID_PREFIXES):
            continue

        if status == "deferred":
            # deferred_report_count >= 1 时不再展示（已过期）
            if t.get("deferred_report_count", 0) >= 1:
                continue
            deferred.append(t)
            continue

        if status == "pending_confirm":
            # panel_shown_count >= 1 时静默，不展示
            if t.get("panel_shown_count", 0) >= 3:
                continue
            pending_confirm.append(t)
            continue

        if status in ("running", "dispatched"):
            runner_task = is_runner_task(t)
            # running 任务用 started_at 计算年龄（更准确）；dispatched 用 spawned_at
            if status == "running":
                ref_ts_str = t.get("started_at") or t.get("spawned_at") or t.get("updated_at") or ""
            else:
                ref_ts_str = t.get("spawned_at") or t.get("updated_at") or ""
            ref_ts = parse_iso(ref_ts_str)
            age_minutes = (now - ref_ts).total_seconds() / 60 if ref_ts else 0
            t["_age_minutes"] = round(age_minutes, 1)

            # 不足60秒的任务直接忽略（过滤刚派遣/刚启动的任务，避免面板闪烁）
            if not is_old_enough(t, threshold_seconds=RUNNING_MIN_AGE_SECONDS):
                continue

            # ── 新增：session 已结束但 task 仍为 running → 自动标 failed ──
            # 仅对运行超过2分钟的任务检查（避免刚启动的任务被误判）
            if age_minutes >= 2 and not runner_task:
                task_label = t.get("label", "")
                session_status = t.get("session_status", "")
                # "missing" 更像观测缺失，不应直接等同于 session 已结束。
                # 老版本对缺失 session 走保守路径，这里也保持同样策略，
                # 让 orphan/timeout 逻辑继续兜底，避免误把活任务判死。
                ended = session_status in ("completed", "stale") or (task_label and is_session_ended(task_label))
                if ended:
                    task_id = t.get("id", "")
                    session_event = t.get("session_last_event", "")
                    print(f"🔴 检测到 session 已结束但 task 仍为 running: {task_id}，自动标 failed")
                    mark_task_failed(task_id)
                    t["status"] = "failed"  # 同步更新内存中的状态
                    if session_event:
                        t["_stuck_reason"] = f"session 已结束（最后事件: {session_event}）"
                    else:
                        t["_stuck_reason"] = "session 已结束（无活跃 runId 或 updatedAt 超30分钟）"
                    # 注意：failed 状态的任务不加入 stuck 列表，由近期失败区块显示
                    continue

            # ── 修复：超时判断前重新读取最新状态，避免误判已完成的任务 ──
            task_id = t.get("id", "")
            fresh_status = fresh_status_by_id.get(task_id)

            # 如果最新状态已完成，跳过超时检查
            if fresh_status in ("done", "failed", "expired", "completed_no_result"):
                continue

            # ── 卡死判断：优先用 expected_done_at，兜底用 age_minutes ──
            expected_done_at_str = t.get("expected_done_at", "")
            is_stuck = False
            if expected_done_at_str:
                expected_done_at = parse_iso(expected_done_at_str)
                if expected_done_at and now > expected_done_at:
                    is_stuck = True
                    # 格式化时间戳为 HH:MM（用户易读）
                    time_str = expected_done_at.strftime("%H:%M")
                    t["_stuck_reason"] = t.get("_stuck_reason") or f"超过预期完成时间 {time_str}"
            elif age_minutes > STUCK_THRESHOLD_MINUTES:
                is_stuck = True
                t["_stuck_reason"] = t.get("_stuck_reason") or f"超过 {STUCK_THRESHOLD_MINUTES}min 默认上限"

            if is_stuck:
                # ── 改进：区分"卡死/真实失败"和"完成但无RESULT" ──
                task_id = t.get("id", "")
                task_label = t.get("label", "")
                if runner_task:
                    task_label = ""
                # 检查 session 是否已结束 + 是否幽灵完成
                if is_session_ended(task_label) and check_ghost_completion(task_id, task_label):
                    # 完成但无RESULT，不重派
                    t["status"] = "completed_no_result"
                    t["summary"] = "任务已完成但未输出RESULT格式，可能是GLM格式问题或上下文截断"
                    t["_stuck_reason"] = "幽灵完成：session已退出但无RESULT标记"
                    # 写入 task-state.json
                    try:
                        ts_file = "/workspace/tmp/octopus/task-state.json"
                        if os.path.exists(ts_file):
                            with open(ts_file, 'r', encoding='utf-8') as f:
                                ts_data = json.load(f)
                            updated = False
                            for task_obj in ts_data.get("tasks", []):
                                if task_obj.get("id") == task_id:
                                    task_obj["status"] = "completed_no_result"
                                    task_obj["summary"] = t["summary"]
                                    task_obj["completed_at"] = now.isoformat()
                                    updated = True
                                    break
                            if updated:
                                tmp_file = ts_file + ".tmp"
                                with open(tmp_file, 'w', encoding='utf-8') as f:
                                    json.dump(ts_data, f, ensure_ascii=False, indent=2)
                                os.replace(tmp_file, ts_file)
                                print(f"🟡 幽灵完成标记: {task_id}")
                    except Exception as e:
                        print(f"⚠️  标记 completed_no_result 失败: {e}", file=sys.stderr)
                    # 不加入 stuck 列表，不重派
                    continue
                # 卡死或真实失败，正常重派
                stuck.append(t)
            elif age_minutes > 5:
                # 运行超过5分钟：检查 transcript 是否有 token 超限/卡死迹象
                transcript_error = check_task_transcript_errors(t)
                if transcript_error:
                    # token_overflow 是正常的输出超限，Agent 会自动续写，不计为卡死
                    if "输出超限截断" in transcript_error or "token_overflow" in transcript_error:
                        t["_stuck_reason"] = transcript_error
                        running.append(t)  # 继续等待续写完成
                    else:
                        # 有错误信号 → 视为卡死，注明错误原因
                        t["_stuck_reason"] = transcript_error
                        stuck.append(t)
                else:
                    # 无错误 → 继续等待（可能还在正常运行）
                    running.append(t)
            else:
                running.append(t)

        elif status == "queued":
            # queued 始终展示，不受60秒限制
            spawned_at_str = t.get("spawned_at") or t.get("updated_at") or ""
            spawned_at = parse_iso(spawned_at_str)
            age_minutes = (now - spawned_at).total_seconds() / 60 if spawned_at else 0
            t["_age_minutes"] = round(age_minutes, 1)
            queued.append(t)

    return running, queued, pending_confirm, deferred, stuck


def get_active_subagent_sessions() -> list:
    """
    获取当前活跃的子 Agent session 列表。
    返回 [{'key': sessionKey, 'label': label, 'updatedAt': ts}, ...]
    只返回最近 30 分钟内活跃的 subagent sessions。
    """
    sessions_file = os.path.expanduser("~/.openclaw/agents/main/sessions/sessions.json")
    if not os.path.exists(sessions_file):
        return []

    try:
        with open(sessions_file, 'r', encoding='utf-8') as f:
            sessions_data = json.load(f)
    except Exception:
        return []

    if not isinstance(sessions_data, dict):
        return []

    now_ms = time.time() * 1000
    result = []
    for key, val in sessions_data.items():
        if not isinstance(val, dict):
            continue
        if 'subagent' not in key:
            continue
        updated_at = val.get('updatedAt')
        if updated_at:
            # updatedAt 可能是毫秒时间戳或 ISO 字符串
            if isinstance(updated_at, (int, float)):
                age_ms = now_ms - updated_at
            elif isinstance(updated_at, str):
                ts = parse_iso(updated_at)
                if ts:
                    age_ms = now_ms - ts.timestamp() * 1000
                else:
                    continue
            else:
                continue
            # 只保留 30 分钟内活跃的
            if age_ms < 30 * 60 * 1000:
                result.append({
                    'key': key,
                    'label': val.get('label', ''),
                    'updatedAt': updated_at
                })
    return result


def load_main_agent_sessions() -> dict:
    """读取 main agent sessions.json，失败返回空 dict。"""
    sessions_file = MAIN_AGENT_SESSIONS_FILE
    if not os.path.exists(sessions_file):
        return {}
    try:
        with open(sessions_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def session_updated_at_iso(session: dict) -> str:
    updated_at = session.get("updatedAt")
    if isinstance(updated_at, str):
        return updated_at
    if isinstance(updated_at, (int, float)):
        try:
            return datetime.fromtimestamp(float(updated_at) / 1000.0, timezone.utc).isoformat()
        except Exception:
            return ""
    return ""


def session_updated_at_dt(session: dict):
    return parse_iso(session_updated_at_iso(session))


def build_session_candidates(task: dict, sessions_data: dict) -> list[dict]:
    """按 task label 选出可能匹配的 session，并按更新时间倒序排序。"""
    label = task.get("label", "")
    if not label:
        return []

    task_spawned = parse_iso(task.get("spawned_at") or task.get("started_at") or task.get("updated_at") or "")
    candidates = []
    for key, value in sessions_data.items():
        if not isinstance(value, dict):
            continue
        if value.get("label") != label:
            continue
        session = dict(value)
        session["_session_key"] = key
        updated_dt = session_updated_at_dt(session)
        if task_spawned and updated_dt:
            # 太早结束的历史 session 不参与当前任务匹配。
            if updated_dt < task_spawned - timedelta(minutes=10):
                continue
        candidates.append(session)

    candidates.sort(key=lambda item: session_updated_at_iso(item) or "", reverse=True)
    return candidates


def summarize_session_history(session_id: str, tail_lines: int = SESSION_HISTORY_TAIL_LINES) -> dict:
    """
    读取 session transcript 尾部，给出轻量摘要：
    - last_event: success / error / length / tool / assistant / unknown
    - last_text: 最后一句可读文本
    """
    result = {"last_event": "unknown", "last_text": "", "has_result": False, "has_success": False}
    if not session_id:
        return result
    transcript_path = os.path.expanduser(f"~/.openclaw/agents/main/sessions/{session_id}.jsonl")
    if not os.path.exists(transcript_path):
        return result

    try:
        with open(transcript_path, "rb") as f:
            lines = list(deque(f, tail_lines))
    except Exception:
        return result

    joined = b"".join(lines).decode("utf-8", errors="ignore")
    joined_lower = joined.lower()
    result["has_result"] = "---result---" in joined_lower
    result["has_success"] = (
        "状态: 成功" in joined
        or '"status":"success"' in joined_lower
        or '"status": "success"' in joined_lower
        or "status: success" in joined_lower
    )

    for raw in reversed(lines):
        try:
            obj = json.loads(raw.decode("utf-8", errors="ignore"))
        except Exception:
            continue
        if not isinstance(obj, dict):
            continue
        if obj.get("error") or obj.get("errorMessage") or obj.get("error_message"):
            result["last_event"] = "error"
            result["last_text"] = str(obj.get("error") or obj.get("errorMessage") or obj.get("error_message"))[:160]
            return result
        stop_reason = str(obj.get("stopReason") or obj.get("stop_reason") or "")
        if stop_reason == "length":
            result["last_event"] = "length"
            result["last_text"] = "stopReason=length"
            return result
        if result["has_result"] and result["has_success"]:
            result["last_event"] = "success"
        role = str(obj.get("role") or "")
        if role == "assistant":
            text = ""
            content = obj.get("content")
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                pieces = []
                for item in content:
                    if isinstance(item, dict) and isinstance(item.get("text"), str):
                        pieces.append(item["text"])
                text = " ".join(pieces)
            if text.strip():
                if result["last_event"] == "unknown":
                    result["last_event"] = "assistant"
                result["last_text"] = text.strip().replace("\n", " ")[:160]
                return result
        tool_calls = obj.get("toolCalls") or obj.get("tool_calls")
        if isinstance(tool_calls, list) and tool_calls:
            result["last_event"] = "tool"
            result["last_text"] = "toolCalls"
            return result
    return result


def annotate_tasks_with_session_state(tasks: list) -> list:
    """
    为 running/dispatched/queued 任务补充 session 观测字段，并回写 task-state.json。
    这一步让 patrol 不再只靠文件状态猜任务状态。
    """
    sessions_data = load_main_agent_sessions()
    if not tasks:
        return tasks

    state = load_task_state(TASK_STATE_FILE)
    state_tasks = state.get("tasks", [])
    state_by_id = {t.get("id"): t for t in state_tasks if isinstance(t, dict) and t.get("id")}
    changed = False
    observed_at = datetime.now(timezone.utc).isoformat()

    for task in tasks:
        status = task.get("status", "")
        if status not in ("running", "dispatched", "queued"):
            continue
        task_id = task.get("id", "")
        if not task_id:
            continue
        state_task = state_by_id.get(task_id)
        if not state_task:
            continue

        if is_runner_task(task):
            updates = {
                "session_status": "runner_local",
                "last_observed_at": observed_at,
                "session_key": "",
                "session_id": "",
                "run_id": "",
            }
            for key, value in updates.items():
                if state_task.get(key) != value:
                    state_task[key] = value
                    changed = True
                task[key] = value
            continue

        if not sessions_data:
            continue

        candidates = build_session_candidates(task, sessions_data)
        if not candidates:
            if state_task.get("session_status") != "missing":
                state_task["session_status"] = "missing"
                state_task["last_observed_at"] = observed_at
                changed = True
            task["session_status"] = state_task.get("session_status", "missing")
            task["last_observed_at"] = state_task.get("last_observed_at", observed_at)
            continue

        session = candidates[0]
        session_id = session.get("sessionId") or session.get("id") or ""
        run_id = session.get("runId") or session.get("activeRunId") or session_id
        history = summarize_session_history(session_id)
        updated_iso = session_updated_at_iso(session)
        session_status = "active"
        last_dt = session_updated_at_dt(session)
        if last_dt:
            age_minutes = (now_utc() - last_dt).total_seconds() / 60.0
            if age_minutes > 30:
                session_status = "stale"
        if history.get("last_event") == "success":
            session_status = "completed"
        elif history.get("last_event") in ("error", "length"):
            session_status = f"history_{history.get('last_event')}"

        updates = {
            "session_key": session.get("_session_key", ""),
            "session_id": session_id,
            "run_id": run_id,
            "session_status": session_status,
            "last_observed_at": observed_at,
            "session_updated_at": updated_iso,
            "session_last_event": history.get("last_event", "unknown"),
            "session_last_text": history.get("last_text", ""),
            "session_has_result": bool(history.get("has_result")),
        }
        for key, value in updates.items():
            if state_task.get(key) != value:
                state_task[key] = value
                changed = True
            task[key] = value

    if changed:
        save_task_state(TASK_STATE_FILE, state)
    return tasks


def build_steer_message(task: dict) -> str:
    """
    为活跃但异常迹象明显的任务生成一条简短纠偏消息。
    目标不是重新描述整个任务，而是尽量少 token 地把任务拉回正轨。
    """
    base = [
        "继续当前任务，但请立刻收束。",
        "不要重新读太多文件，不要重复前面的步骤。",
    ]
    last_event = str(task.get("session_last_event", "") or "")
    last_text = str(task.get("session_last_text", "") or "")

    if last_event == "length":
        base.extend(
            [
                "你刚才很可能输出过长被截断了。",
                "详细内容写到 /workspace/tmp/octopus/shared/{TASK_ID}.md，再输出 ---RESULT---。",
                "summary 保持 2-5 句短句。",
            ]
        )
    elif last_event == "error":
        base.extend(
            [
                "如果已被阻塞，请立刻执行 failed 状态写入，然后输出 failure RESULT。",
                "不要继续硬撑，也不要无限重试同一步。",
            ]
        )
    else:
        base.extend(
            [
                "如果已完成，请立即输出 ---RESULT---。",
                "如果未完成，请只做最后必要的一步并收尾。",
            ]
        )

    if last_text:
        base.append(f"最近迹象：{last_text[:120]}")
    return "\n".join(base)


def should_steer_task(task: dict) -> bool:
    status = task.get("status", "")
    if status not in ("running", "dispatched"):
        return False
    age_minutes = float(task.get("_age_minutes", 0) or 0)
    if age_minutes < STEER_MIN_AGE_MINUTES:
        return False
    session_key = task.get("session_key", "")
    if not session_key:
        return False
    session_status = task.get("session_status", "")
    if session_status in ("missing", "stale", "completed"):
        return False
    last_steered_at = parse_iso(task.get("last_steered_at", "") or "")
    if last_steered_at:
        elapsed = (now_utc() - last_steered_at).total_seconds()
        if elapsed < STEER_COOLDOWN_SECONDS:
            return False
    # transcript 有 length/error/无 RESULT 等迹象时才 steer
    last_event = task.get("session_last_event", "")
    return last_event in ("length", "error", "assistant", "tool", "unknown")


def attempt_task_steers(tasks: list) -> int:
    """
    对仍然活着、但已有异常迹象的任务先发一条纠偏消息。
    失败时不报错中断，后续逻辑仍可继续重试或重派。
    """
    steer_count = 0
    state = load_task_state(TASK_STATE_FILE)
    state_tasks = state.get("tasks", [])
    changed = False

    for task in tasks:
        if not should_steer_task(task):
            continue
        task_id = task.get("id", "")
        session_key = task.get("session_key", "")
        message = build_steer_message(task).replace("{TASK_ID}", task_id)
        result = send_agent_message(session_key, message, timeout_seconds=0)
        ok = isinstance(result, dict) and (result.get("runId") or result.get("status") in ("accepted", "running", "ok"))

        for state_task in state_tasks:
            if state_task.get("id") != task_id:
                continue
            state_task["recovery_action"] = "steered" if ok else "needs_steer"
            state_task["last_steered_at"] = datetime.now(timezone.utc).isoformat()
            state_task["steer_message"] = message[:240]
            state_task["steer_count"] = int(state_task.get("steer_count", 0) or 0) + 1
            if ok and state_task.get("status") == "dispatched":
                state_task["status"] = "running"
            changed = True
            break

        task["recovery_action"] = "steered" if ok else "needs_steer"
        task["last_steered_at"] = datetime.now(timezone.utc).isoformat()
        task["steer_count"] = int(task.get("steer_count", 0) or 0) + 1
        if ok:
            steer_count += 1

    if changed:
        save_task_state(TASK_STATE_FILE, state)
    return steer_count


def check_orphan_tasks(tasks: list, active_sessions: list) -> list:
    """
    检测孤儿任务：status=running/dispatched 但无活跃子 Agent，且超过 3 分钟。
    这是 B 类错误（GLM ghost_completion）的典型特征：
    - 子 Agent 只跑 ~34 秒就"正常结束"（无 error）
    - 但没有输出 RESULT，task-state.json 状态停在 running
    - 没有活跃子 Agent 进程
    - patrol 当前要等 18 分钟才超时发现（太慢）

    返回孤儿任务列表，每个元素含 task 和 elapsed_min。
    """
    orphans = []
    now = now_utc()
    ORPHAN_THRESHOLD_MIN = 3  # 3分钟无活跃子Agent即视为孤儿

    for task in tasks:
        if task.get('status') not in ('running', 'dispatched'):
            continue
        if is_runner_task(task):
            continue
        spawned_at_str = task.get('spawned_at') or task.get('started_at')
        if not spawned_at_str:
            continue
        # 解析时间
        spawned_at = parse_iso(spawned_at_str)
        if not spawned_at:
            continue
        elapsed_min = (now - spawned_at).total_seconds() / 60

        if elapsed_min < ORPHAN_THRESHOLD_MIN:
            continue

        # 检查是否有活跃子 Agent
        task_id = task.get('id', '')
        label = task.get('label', '')
        # 跳过内部查询任务（不产生孤儿告警）
        if any(task_id.startswith(p) for p in INTERNAL_ID_PREFIXES):
            continue
        if label in SYSTEM_LABELS:
            continue
        # 在 active_sessions 里找匹配的子 Agent（key 或 label 精确匹配，防止子串误判）
        has_active = any(
            (label and (label == s.get('label', '') or f':{label}:' in s.get('key', '') or s.get('key', '').endswith(f':{label}')))
            or (task_id and task_id in s.get('key', ''))
            for s in active_sessions
        )

        if not has_active:
            orphans.append({
                'task': task,
                'elapsed_min': round(elapsed_min, 1)
            })

    return orphans


LAST_DONE_IDS_FILE = "/workspace/tmp/octopus/.patrol-last-done-ids"
RECENT_DONE_MINUTES = 60
MAX_RECENT_DONE = 10

# 临时存储本次 get_recent_done_tasks() 筛出的新 id → completed_at（供 main() 写入）
_recent_done_new_entries: dict = {}


def format_age(age_minutes: float) -> str:
    """格式化运行时长"""
    if age_minutes < 1:
        return "< 1min"
    elif age_minutes < 60:
        return f"{int(age_minutes)}min"
    else:
        h = int(age_minutes // 60)
        m = int(age_minutes % 60)
        return f"{h}h{m}m"


def should_retry_failed_notification(task: dict, now: datetime) -> bool:
    if task.get("notified_failed"):
        return False
    last_attempt = parse_iso(str(task.get("failed_notify_last_attempt_at", "") or ""))
    if not last_attempt:
        return True
    if last_attempt.tzinfo is None:
        last_attempt = last_attempt.replace(tzinfo=timezone.utc)
    return (now - last_attempt.astimezone(timezone.utc)).total_seconds() >= FAILED_NOTIFY_RETRY_SECONDS


def record_failed_notification_attempt(task_id: str, success: bool) -> None:
    try:
        state_data = load_task_state(TASK_STATE_FILE)
        now_iso_str = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        for task_item in state_data.get("tasks", []):
            if task_item.get("id") != task_id:
                continue
            task_item["failed_notify_last_attempt_at"] = now_iso_str
            task_item["failed_notify_attempts"] = int(task_item.get("failed_notify_attempts", 0) or 0) + 1
            if success:
                task_item["notified_failed"] = True
            task_item["updated_at"] = now_iso_str
            break
        save_task_state(TASK_STATE_FILE, state_data)
    except Exception as mark_err:
        print(f"  ⚠️ 更新失败通知状态失败: {mark_err}", file=sys.stderr)


def format_running_table(task_list: list, ordinals: dict) -> str:
    """格式化运行中任务为结构化文本（飞书 lark_md 不支持 markdown 表格语法）"""
    rows = []
    for t in task_list:
        label = t.get("label", t.get("id", "未知"))
        ordinal = ordinals.get(t.get("id", id(t)), "")
        display_name = get_label_name(label) + ordinal
        # 优先显示summary，为空则显示id前30字
        summary = t.get("summary", "")
        if not summary:
            task_id = t.get("id", "")
            summary = task_id[:30] if len(task_id) > 30 else task_id
        model_short = get_model_short(t.get("model", ""))
        age = t.get("_age_minutes", 0)
        duration = format_age(age)
        # 预期完成时间
        expected_done_str = t.get("expected_done_at", "")
        eta_part = ""
        if expected_done_str:
            try:
                eta_dt = parse_iso(expected_done_str)
                if eta_dt:
                    eta_local = eta_dt.astimezone()
                    eta_part = f" · 预计 {eta_local.strftime('%H:%M')}"
            except Exception:
                pass
        # 格式：触手名 · 模型 · 已运行时长 · 预计完成时间
        #       └ 任务摘要
        line = f"  {display_name} · {model_short} · ⏱️ {duration}{eta_part}"
        line += f"\n    └ {summary}"
        rows.append(line)
    return "\n".join(rows)


def format_queued_table(task_list: list, ordinals: dict) -> str:
    """格式化排队中任务为结构化文本（飞书 lark_md 不支持 markdown 表格语法）"""
    rows = []
    for t in task_list:
        label = t.get("label", t.get("id", "未知"))
        ordinal = ordinals.get(t.get("id", id(t)), "")
        display_name = get_label_name(label) + ordinal
        # 优先显示summary，为空则显示id前30字
        summary = t.get("summary", "")
        if not summary:
            task_id = t.get("id", "")
            summary = task_id[:30] if len(task_id) > 30 else task_id
        model_short = get_model_short(t.get("model", ""))
        line = f"  {display_name} · {model_short} · ⏸️ 等待中"
        line += f"\n    └ {summary}"
        rows.append(line)
    return "\n".join(rows)


def format_pending_line(t: dict) -> str:
    """格式化待确认任务行：优先显示summary，为空则显示id前30字"""
    summary = t.get("summary", "")
    if summary:
        return f"  · {summary}"
    # summary为空则显示id前30字
    task_id = t.get("id", "待确认")
    display_id = task_id[:30] if len(task_id) > 30 else task_id
    return f"  · {display_id}"


def format_stuck_table(task_list: list, ordinals: dict) -> str:
    """格式化可能卡死任务为结构化文本（飞书 lark_md 不支持 markdown 表格语法）"""
    rows = []
    for t in task_list:
        label = t.get("label", t.get("id", "未知"))
        ordinal = ordinals.get(t.get("id", id(t)), "")
        display_name = get_label_name(label) + ordinal
        # 优先显示summary，为空则显示id前30字
        summary = t.get("summary", "")
        if not summary:
            task_id = t.get("id", "")
            summary = task_id[:30] if len(task_id) > 30 else task_id
        model_short = get_model_short(t.get("model", ""))
        age = t.get("_age_minutes", 0)
        duration = format_age(age)
        stuck_reason = t.get("_stuck_reason", "")
        line = f"  {display_name} · {model_short} · ⚠️ 已运行 {duration}"
        if stuck_reason:
            line += f"\n    └ ❗ {stuck_reason}"
        else:
            line += f"\n    └ {summary}"
        rows.append(line)
    return "\n".join(rows)


def get_recent_done_tasks(tasks: list, force: bool = False) -> list:
    """
    返回最近 RECENT_DONE_MINUTES 分钟内完成的任务（status=done/failed），最多 MAX_RECENT_DONE 条。
    双重过滤：时间过滤 + ID去重（已推送过的 ID 不再推送）。
    - 时间过滤：优先用 completed_at，为空或解析失败则用 spawned_at 兜底
    - ID过滤：已在 last-done-ids 文件中的 ID 不再推送
    - 状态区分：done → 近期完成；failed → 近期失败（timeout_reason 非空则为近期超时）
    按 completed_at 降序排列（最新在前）。
    """
    now = now_utc()
    cutoff_seconds = RECENT_DONE_MINUTES * 60
    # last_done 不再用于面板去重（面板始终显示近30分钟）
    recent = []
    new_done_entries = {}  # 本次新完成的任务 id → completed_at（用于状态变化通知去重）
    for t in tasks:
        status = t.get("status", "")
        if status not in ("done", "failed"):
            continue
        if t.get("label", "") in SYSTEM_LABELS:
            continue
        task_id = t.get("id", "")
        if any(task_id.startswith(p) for p in INTERNAL_ID_PREFIXES):
            continue
        # 面板不做 ID 去重，始终展示近30分钟的所有完成任务

        # 时间过滤：优先用 completed_at，兜底用 spawned_at
        ref_str = t.get("completed_at", "")
        ref_dt = parse_iso(ref_str) if ref_str else None
        if ref_dt is None:
            # completed_at 为空或解析失败，用 spawned_at 兜底
            fallback_str = t.get("spawned_at", "")
            ref_dt = parse_iso(fallback_str) if fallback_str else None
        if ref_dt is None:
            # 两个时间戳都没有 → 无法判断，跳过
            continue

        age_seconds = (now - ref_dt).total_seconds()
        if 0 <= age_seconds <= cutoff_seconds:
            t["_completed_age_seconds"] = age_seconds
            # 标记任务类型：done/failed/timeout
            if status == "failed" and t.get("timeout_reason"):
                t["_finish_type"] = "timeout"
            elif status == "failed":
                t["_finish_type"] = "failed"
            else:
                t["_finish_type"] = "done"
            recent.append(t)
            # 记录本次将要推送的 id → completed_at
            if task_id:
                completed_at_val = t.get("completed_at", "") or (datetime.utcnow().isoformat() + "Z")
                new_done_entries[task_id] = completed_at_val

    # 按完成时间降序（最新在前）
    recent.sort(key=lambda x: x.get("completed_at", ""), reverse=True)
    recent = recent[:MAX_RECENT_DONE]

    # 将本次筛选出的（截断后的）任务 id 存回，供 main() 调用 save_last_done_ids
    _recent_done_new_entries.clear()
    _recent_done_new_entries.update(new_done_entries)

    return recent


def format_recent_done_table(task_list: list) -> str:
    """格式化近期完成任务为结构化文本（飞书 lark_md 不支持 markdown 表格语法）
    根据 _finish_type 显示不同前缀：
    - done → ✅ 近期完成
    - failed → ❌ 近期失败
    - timeout → ⏰ 近期超时
    """
    rows = []
    for t in task_list:
        label = t.get("label", t.get("id", "未知"))
        display_name = get_label_name(label)
        # 优先显示summary，为空则显示id前30字
        summary = t.get("summary", "")
        if not summary:
            task_id = t.get("id", "")
            summary = task_id[:30] if len(task_id) > 30 else task_id
        model_short = get_model_short(t.get("model", ""))

        # 耗时 = completed_at - started_at（优先），否则 completed_at - spawned_at
        completed_at = parse_iso(t.get("completed_at", ""))
        start_str = t.get("started_at") or t.get("spawned_at", "")
        start_at = parse_iso(start_str)
        if completed_at and start_at:
            elapsed_minutes = (completed_at - start_at).total_seconds() / 60
            elapsed_str = format_age(elapsed_minutes)
        else:
            elapsed_str = "-"

        # 根据 _finish_type 选择前缀
        finish_type = t.get("_finish_type", "done")
        if finish_type == "timeout":
            prefix = "⏰"
        elif finish_type == "failed":
            prefix = "❌"
        else:
            prefix = "✅"

        # 完成时间（本地时间 HH:MM）
        if completed_at:
            done_time = completed_at.astimezone().strftime("%H:%M")
            time_part = f" · {done_time}"
        else:
            time_part = ""
        line = f"  {prefix} {display_name} · {model_short} · {elapsed_str}{time_part}"
        line += f"\n    └ {summary}"
        rows.append(line)
    return "\n".join(rows)


def load_last_done_ids() -> dict:
    """
    读取上次已推送的 done 任务 id 字典（id → completed_at ISO字符串）。
    兼容旧格式：如果读到列表，转为 {id: ""} 字典。
    """
    if not os.path.exists(LAST_DONE_IDS_FILE):
        return {}
    try:
        with open(LAST_DONE_IDS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            # 旧格式兼容：列表 → 字典（时间戳留空）
            return {id_: "" for id_ in data if id_}
        elif isinstance(data, dict):
            return data
        return {}
    except Exception:
        return {}


def save_last_done_ids(ids_dict: dict):
    """
    保存已推送的 done 任务 id 字典（id → completed_at ISO字符串）。
    写入前清理超过24小时的条目，防止文件无限增长。
    没有时间戳的条目（旧格式兼容）保留。
    """
    os.makedirs(os.path.dirname(LAST_DONE_IDS_FILE), exist_ok=True)
    try:
        now = datetime.now(timezone.utc)
        # 清理超过24小时的条目
        cleaned = {}
        for k, v in ids_dict.items():
            if not k:
                continue
            if v:
                try:
                    ts = datetime.fromisoformat(v.rstrip('Z'))
                    if ts.tzinfo is None:
                        ts = ts.replace(tzinfo=timezone.utc)
                    if (now - ts).total_seconds() < 86400:
                        cleaned[k] = v  # 未超24小时，保留
                    # 超过24小时，丢弃
                except Exception:
                    cleaned[k] = v  # 解析失败，保留（保守处理）
            else:
                cleaned[k] = v  # 没有时间戳的保留（旧格式兼容）
        with open(LAST_DONE_IDS_FILE, "w", encoding="utf-8") as f:
            json.dump(cleaned, f, ensure_ascii=False)
    except Exception as e:
        print(f"⚠️  保存 last-done-ids 失败: {e}", file=sys.stderr)


def tail_file(path: str, n: int = 200) -> str:
    """只读文件最后 N 行（用 deque 避免大文件时读全量）"""
    with open(path, 'rb') as f:
        return b''.join(deque(f, n)).decode('utf-8', errors='ignore')


def mark_task_failed(task_id: str):
    """
    将 task-state.json 中指定 task 的 status 改为 failed，completed_at 设为当前时间。
    线程安全（使用排他锁写入）。
    """
    try:
        data = load_task_state(TASK_STATE_FILE)
        tasks = data.get("tasks", [])
        changed = False
        for t in tasks:
            if t.get("id") == task_id and t.get("status") in ("running", "dispatched"):
                t["status"] = "failed"
                t["completed_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                changed = True
                print(f"🔴 自动标 failed: {task_id}（session 已结束但 task 仍为 running）")
                break
        if changed:
            data["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            save_task_state(TASK_STATE_FILE, data)
    except Exception as e:
        print(f"⚠️  mark_task_failed({task_id}) 失败: {e}", file=sys.stderr)


def is_session_ended(label: str) -> bool:
    """
    检查 label 对应的最新 session 是否已结束。
    判断条件：
    1. 在 sessions.json 中找到 label 匹配的最新 session
    2. 若 session 不存在 → 无法判断，保守返回 False
    3. 若 session 的 updatedAt 超过30分钟 → 视为已结束（True）
    4. 其他情况 → 未结束（False）
    sessions.json 为 dict，key 为 session key，value 含 label/updatedAt/sessionId 字段。
    """
    sessions_file = os.path.expanduser("~/.openclaw/agents/main/sessions/sessions.json")
    if not os.path.exists(sessions_file):
        return False  # 无法判断，保守处理

    try:
        with open(sessions_file, 'r', encoding='utf-8') as f:
            sessions_data = json.load(f)
    except Exception:
        return False

    if not isinstance(sessions_data, dict):
        return False

    # sessions_data 是 {sessionKey: {label, updatedAt, ...}}
    matched = [
        v for k, v in sessions_data.items()
        if isinstance(v, dict) and v.get("label") == label
    ]
    if not matched:
        # sessions.json 里没有该 label 的记录 → 无法判断，保守处理
        return False

    # 取 updatedAt 最新的 session
    matched.sort(key=lambda s: s.get("updatedAt") or "", reverse=True)
    session = matched[0]

    # 检查 updatedAt 是否超过30分钟（毫秒级时间戳）
    updated_at_ms = session.get("updatedAt")
    if updated_at_ms and isinstance(updated_at_ms, (int, float)):
        age_minutes = (time.time() * 1000 - updated_at_ms) / 60000.0
        if age_minutes > 30:
            return True  # 超过30分钟未更新 → 视为已结束
        else:
            return False  # 近期有更新 → 未结束

    # updatedAt 为 ISO 字符串兜底
    updated_at_str = session.get("updatedAt") or ""
    if updated_at_str and isinstance(updated_at_str, str):
        updated_at = parse_iso(updated_at_str)
        if updated_at:
            age_minutes = (now_utc() - updated_at).total_seconds() / 60
            if age_minutes > 30:
                return True
            else:
                return False

    # 没有 updatedAt → 无法判断，保守处理
    return False


def check_task_transcript_errors(task: dict) -> str | None:
    """
    检测 running 任务的 transcript 是否有 output token 超限迹象。
    
    检测模式：
    - stopReason=length 或 stop_reason: length → output token 超限
    - Validation failed 连续出现3次+ → 工具参数被截断
    - 任意 error 字段含 token → token 相关错误
    
    返回：错误描述字符串，或 None（无异常）
    """
    label = task.get("label", "")
    if not label:
        return None

    # 从 sessions.json 中查找 label 匹配的 sessionId
    # sessions.json 是 dict，key 为 session key，value 含 label/updatedAt/sessionId
    sessions_file = os.path.expanduser("~/.openclaw/agents/main/sessions/sessions.json")
    if not os.path.exists(sessions_file):
        return None

    try:
        with open(sessions_file, 'r', encoding='utf-8') as f:
            sessions_data = json.load(f)
    except Exception:
        return None

    if not isinstance(sessions_data, dict):
        return None

    # 找到 label 匹配的所有 session（dict 格式）
    matched = [
        v for k, v in sessions_data.items()
        if isinstance(v, dict) and v.get("label") == label
    ]
    if not matched:
        return None

    # 取 updatedAt 最新的 session
    matched.sort(key=lambda s: s.get("updatedAt") or "", reverse=True)
    session = matched[0]
    session_id = session.get("sessionId") or session.get("id")
    if not session_id:
        return None

    # 读取 transcript 文件最后100行
    transcript_path = os.path.expanduser(f"~/.openclaw/agents/main/sessions/{session_id}.jsonl")
    if not os.path.exists(transcript_path):
        # transcript 不存在：如果任务已启动超过 2 分钟，视为启动失败
        started_str = task.get("started_at") or task.get("spawned_at", "")
        started_ts = parse_iso(started_str) if started_str else None
        if started_ts:
            age_min = (datetime.now(timezone.utc) - started_ts).total_seconds() / 60
            if age_min >= 2:
                return f"transcript 文件不存在（任务已启动 {age_min:.1f} 分钟，疑似启动失败）"
        return None

    try:
        with open(transcript_path, 'rb') as f:
            lines = list(deque(f, 100))
        content = b''.join(lines).decode('utf-8', errors='ignore')
    except Exception:
        return None

    # ── 检测模式 1：stopReason=length 或 stop_reason: length ──
    if 'stopReason=length' in content or '"stopReason":"length"' in content or '"stop_reason":"length"' in content or 'stop_reason: length' in content:
        return "输出超限截断（stopReason=length），Agent 已分步续写，非失败"

    # ── 检测模式 2：Validation failed 连续出现3次+ ──
    validation_count = content.count('Validation failed')
    if validation_count >= 1:
        return f"工具参数被截断（Validation failed 出现 {validation_count} 次，疑似 token 超限导致）"

    # ── 检测模式 3：顶层 error 字段含 token（精确匹配，避免误报）──
    # 只检查顶层 error/errorMessage/errorCode 字段，不递归扫描内容字段
    for line in lines:
        try:
            obj = json.loads(line.decode('utf-8', errors='ignore'))
            if not isinstance(obj, dict):
                continue
            # 只检查明确的错误字段
            for error_key in ('error', 'errorMessage', 'errorCode', 'error_message'):
                val = obj.get(error_key, '')
                if isinstance(val, str) and 'token' in val.lower() and ('limit' in val.lower() or 'exceeded' in val.lower() or 'quota' in val.lower()):
                    return "token 相关错误（error 字段含 token 关键词）"
        except Exception:
            continue

    return None


def check_ghost_completion(task_id: str, label: str) -> bool:
    """
    查 transcript 最后若干条消息，判断任务是否"幽灵完成"：
    任务实际做完了但没写 ---RESULT--- 标记。

    判断逻辑：
    1. 找到 sessions.json 中 label 匹配的最新 session → 读取对应 .jsonl transcript
    2. 检查最后 15 条消息：
       - 有 stopReason=stop 的 assistant 消息 → 可能幽灵完成
       - 有 edit/write 工具调用成功 → 说明有实际操作
    3. 同时检查最后 200 行文本内容中没有 ---RESULT--- → 确认幽灵完成

    返回：True=幽灵完成（实际做完了），False=真正卡死 / 无法判断
    """
    if not label:
        return False

    sessions_file = os.path.expanduser("~/.openclaw/agents/main/sessions/sessions.json")
    if not os.path.exists(sessions_file):
        return False

    try:
        with open(sessions_file, 'r', encoding='utf-8') as f:
            sessions_data = json.load(f)
    except Exception:
        return False

    if not isinstance(sessions_data, dict):
        return False

    matched = [
        v for k, v in sessions_data.items()
        if isinstance(v, dict) and v.get("label") == label
    ]
    if not matched:
        return False

    matched.sort(key=lambda s: s.get("updatedAt") or "", reverse=True)
    session = matched[0]
    session_id = session.get("sessionId") or session.get("id")
    if not session_id:
        return False

    transcript_path = os.path.expanduser(
        f"~/.openclaw/agents/main/sessions/{session_id}.jsonl"
    )
    if not os.path.exists(transcript_path):
        return False

    try:
        with open(transcript_path, 'rb') as f:
            all_lines = list(deque(f, 200))
        content = b''.join(all_lines).decode('utf-8', errors='ignore')
    except Exception:
        return False

    # 检查是否包含 RESULT 标记（含则不是幽灵完成）
    if '---RESULT---' in content:
        return False

    # 解析最后 15 条 JSONL 消息
    last_15_lines = all_lines[-15:]
    has_stop_reason_stop = False
    has_edit_write_success = False

    for line in last_15_lines:
        try:
            obj = json.loads(line.decode('utf-8', errors='ignore'))
        except Exception:
            continue

        # 检查 stopReason=stop 的 assistant 消息
        role = obj.get("role", "")
        stop_reason = obj.get("stopReason") or obj.get("stop_reason") or ""
        if role == "assistant" and stop_reason == "stop":
            has_stop_reason_stop = True

        # 检查 edit/write 工具调用成功
        # tool_calls 里含 edit/write 工具名，且没有 error
        tool_calls = obj.get("toolCalls") or obj.get("tool_calls") or []
        if isinstance(tool_calls, list):
            for tc in tool_calls:
                if not isinstance(tc, dict):
                    continue
                tool_name = (
                    tc.get("name") or tc.get("function", {}).get("name") or ""
                ).lower()
                if tool_name in ("edit", "write"):
                    # 检查无 error 字段（成功执行）
                    if not tc.get("error"):
                        has_edit_write_success = True

        # 也检查 tool result 消息（type=tool_result）
        msg_type = obj.get("type", "")
        if msg_type == "tool_result":
            tool_name_in_result = (obj.get("toolName") or "").lower()
            if tool_name_in_result in ("edit", "write") and not obj.get("error"):
                has_edit_write_success = True

    # 幽灵完成：有正常结束迹象 + 有实际操作 + 没有 RESULT 标记
    if has_stop_reason_stop and has_edit_write_success:
        return True

    # 宽松判断：只要有 stopReason=stop 且无 RESULT，也视为可能幽灵完成
    if has_stop_reason_stop:
        return True

    return False


def check_result_success(task_id: str, label: str, spawned_at: str = None) -> bool:
    """
    检查 transcript 是否包含成功的 RESULT 标记。
    用于孤儿任务判断：有 RESULT+成功 则自动标 done，不报警。
    """
    if not label:
        return False
    sessions_file = os.path.expanduser("~/.openclaw/agents/main/sessions/sessions.json")
    if not os.path.exists(sessions_file):
        return False
    try:
        with open(sessions_file, 'r', encoding='utf-8') as f:
            sessions_data = json.load(f)
    except Exception:
        return False
    if not isinstance(sessions_data, dict):
        return False
    matched = [v for k, v in sessions_data.items()
               if isinstance(v, dict) and v.get("label") == label]
    if not matched:
        return False
    matched.sort(key=lambda s: s.get("updatedAt") or "", reverse=True)
    session = matched[0]
    session_id = session.get("sessionId") or session.get("id")
    if not session_id:
        return False
    transcript_path = os.path.expanduser(
        f"~/.openclaw/agents/main/sessions/{session_id}.jsonl"
    )
    if not os.path.exists(transcript_path):
        return False
    try:
        with open(transcript_path, 'rb') as f:
            all_lines = list(deque(f, 50))
        content = b''.join(all_lines).decode('utf-8', errors='ignore')
    except Exception:
        return False
    # 有 RESULT 且含「状态: 成功」或 JSON 格式 {"status":"success"} （只看最后50行，避免误判历史RESULT）
    if '---RESULT---' not in content:
        return False
    # 兼容三种格式:
    #   1. 文本格式: 状态: 成功
    #   2. HTTP/英文格式: status: success
    #   3. JSON格式: "status":"success" 或 "status": "success"
    content_lower = content.lower()
    has_success = (
        '状态: 成功' in content
        or 'status: success' in content_lower
        or '"status":"success"' in content_lower
        or '"status": "success"' in content_lower
    )
    if not has_success:
        return False
    # 时间戳校验：RESULT 附近需有 spawned_at 之后的时间戳
    # 从 content 中提取所有 ISO 时间戳，判断是否有 >= spawned_at 的
    if spawned_at:
        import re as _re
        ts_pattern = _re.compile(r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})')
        timestamps = ts_pattern.findall(content)
        if timestamps:
            # 取最新时间戳（transcript 里的时间戳为 UTC naive，统一转为 UTC aware 再比较）
            latest_ts_str = sorted(timestamps)[-1]
            try:
                latest_ts_utc = datetime.fromisoformat(latest_ts_str).replace(tzinfo=timezone.utc)
                spawned_ts = parse_iso(spawned_at)
                if spawned_ts and latest_ts_utc < spawned_ts.astimezone(timezone.utc):
                    return False  # 最新时间戳早于任务派遣时间，说明是历史 RESULT
            except Exception:
                pass  # 解析失败则不做时间校验，保守通过
    return True


def get_last_compact_time():
    """返回最近30分钟内最后一次 compact 的时间（HH:MM格式），没有则返回None"""
    import glob
    import time
    import datetime as _datetime
    log_dir = os.path.expanduser("~/.openclaw/agents/main/sessions/")
    if not os.path.exists(log_dir):
        return None

    cutoff = time.time() - 1800  # 30分钟前
    last_compact_time = None

    for f in sorted(glob.glob(log_dir + "*.jsonl"), key=os.path.getmtime, reverse=True)[:5]:
        if os.path.getmtime(f) < cutoff:
            break
        try:
            # 只读最后200行
            with open(f, 'rb') as fp:
                lines = list(deque(fp, 200))
            content = b''.join(lines).decode('utf-8', errors='ignore')

            if any(kw in content.lower() for kw in ['compacted', 'pre-compaction', 'summarize']):
                # 尝试提取时间戳（JSONL里通常有 timestamp 字段）
                for line in reversed(lines):
                    try:
                        obj = json.loads(line.decode('utf-8', errors='ignore'))
                        ts = obj.get('timestamp') or obj.get('ts') or obj.get('created_at')
                        if ts:
                            # 转为本地时间 HH:MM
                            dt = _datetime.datetime.fromisoformat(str(ts).replace('Z', '+00:00'))
                            local_dt = dt.astimezone()
                            last_compact_time = local_dt.strftime('%H:%M')
                            break
                    except Exception:
                        continue
                if not last_compact_time:
                    # 用文件修改时间作为fallback
                    mtime = os.path.getmtime(f)
                    dt = _datetime.datetime.fromtimestamp(mtime)
                    last_compact_time = dt.strftime('%H:%M')
                break
        except Exception:
            pass

    return last_compact_time


def should_report_compact(compact_time: str) -> bool:
    """检查是否需要报告这个 compact 时间点（已报过则不再报）"""
    if not compact_time:
        return False

    import datetime as _datetime
    reported_file = os.path.expanduser("~/.openclaw/") + "patrol-compact-reported.txt"

    try:
        if os.path.exists(reported_file):
            with open(reported_file) as f:
                reported = f.read().strip().splitlines()
            # 记录格式：日期+时间，如 "2026-03-05 12:35"
            today = _datetime.datetime.now().strftime("%Y-%m-%d")
            key = f"{today} {compact_time}"
            if key in reported:
                return False  # 已报过，跳过
    except Exception:
        pass

    return True


def mark_compact_reported(compact_time: str):
    """标记这个 compact 时间点已经报告过"""
    import datetime as _datetime
    reported_file = os.path.expanduser("~/.openclaw/") + "patrol-compact-reported.txt"
    today = _datetime.datetime.now().strftime("%Y-%m-%d")
    key = f"{today} {compact_time}"
    try:
        # 追加记录，保留最近 20 条
        lines = []
        if os.path.exists(reported_file):
            with open(reported_file) as f:
                lines = f.read().strip().splitlines()
        lines.append(key)
        lines = lines[-20:]  # 只保留最近20条
        with open(reported_file, 'w') as f:
            f.write('\n'.join(lines))
    except Exception:
        pass


# ── 执行成本统计（借鉴 agent-swarm statistics-template）──
_EXEC_STATS_PRICING: dict = {
    "glm":     (0.10,  0.30),
    "kimi":    (0.15,  0.45),
    "sonnet":  (3.00, 15.00),
    "opus":    (15.0, 75.00),
    "haiku":   (0.25,  1.25),
    "default": (3.00, 15.00),
}
_EXEC_STATS_TIER_TOKENS: dict = {
    "trivial": 800, "simple": 2000, "normal": 5000, "hard": 10000, "deep": 20000,
}


def _calc_task_cost(model: str, tier: str) -> float:
    """快速估算单个任务成本（USD），不依赖 budget.py"""
    m = model.lower()
    key = "default"
    for k in ("opus", "sonnet", "haiku", "glm", "kimi"):
        if k in m:
            key = k
            break
    p_in, p_out = _EXEC_STATS_PRICING[key]
    tokens = _EXEC_STATS_TIER_TOKENS.get(tier, 5000)
    return round((tokens * 0.75 * p_in + tokens * 0.25 * p_out) / 1_000_000, 5)


def build_exec_stats_text(recent_done: list):
    """
    构建执行成本统计文本（借鉴 agent-swarm statistics-template）。
    仅统计 _finish_type=done 的成功任务。
    返回格式化多行字符串，或 None（无可统计数据时）。
    """
    try:
        rows = []
        total_actual = 0.0
        total_baseline = 0.0
        for t in recent_done:
            if t.get("_finish_type") != "done":
                continue
            model = t.get("model", "")
            tier = t.get("tier", "normal")
            label = t.get("label", "")
            actual = _calc_task_cost(model, tier)
            baseline = _calc_task_cost("sonnet", tier)
            total_actual += actual
            total_baseline += baseline
            label_name = get_label_name(label)
            model_short = get_model_short(model)
            completed_at = parse_iso(t.get("completed_at", ""))
            start_str = t.get("started_at") or t.get("spawned_at", "")
            start_at = parse_iso(start_str)
            if completed_at and start_at:
                elapsed_str = format_age((completed_at - start_at).total_seconds() / 60)
            else:
                elapsed_str = "-"
            rows.append(f"  {label_name} · {model_short} · {tier} · {elapsed_str} · ${actual:.4f}")
        if not rows:
            return None
        saved = total_baseline - total_actual
        saved_pct = (saved / total_baseline * 100) if total_baseline > 0 else 0.0
        summary_line = f"  合计：实际 ${total_actual:.4f} | Sonnet基线 ${total_baseline:.4f} | 节省 ${saved:.4f} ({saved_pct:.0f}%)"
        return "\n".join(rows) + "\n" + summary_line
    except Exception:
        return None


def build_panel_card(running: list, queued: list, pending_confirm: list, deferred: list, stuck: list, recent_done: list, force_mode: bool = False, sent_at: int = 0) -> dict:
    """构建任务状态面板飞书卡片 JSON
    
    force_mode=True 时：
    - 无论有无活跃任务都发卡片
    - 额外展示「⏳ 待确认」区块（pending_confirm 任务）
    
    sent_at: 卡片首次发送时间戳，用于计算有效期显示
    """
    now_local = datetime.now().astimezone()  # 明确使用本地时区
    now_str = now_local.strftime("%H:%M")

    elements = []

    # 跨所有分组（running/queued/stuck）统一计算序号，保证同 label 全局编号一致
    ordinals = assign_ordinals(running + queued + stuck)

    # ── 🔵 运行中 ──
    if running:
        text_md = format_running_table(running, ordinals)
        elements.append({
            "tag": "div",
            "text": {
                "tag": "lark_md",
                "content": f"**🔵 运行中（{len(running)}个）**\n{text_md}"
            }
        })

    # ── ⏸️ 排队中 ──
    if queued:
        text_md = format_queued_table(queued, ordinals)
        elements.append({
            "tag": "div",
            "text": {
                "tag": "lark_md",
                "content": f"**⏸️ 排队中（{len(queued)}个）**\n{text_md}"
            }
        })

    # ── ⏳ 待确认（仅 --force 模式展示）──
    if force_mode and pending_confirm:
        pending_lines = []
        for t in pending_confirm:
            task_id = t.get("id", "未知")
            summary = t.get("summary", "") or ""
            # 格式：· id - summary（如果 summary 太长则截断）
            if summary:
                line = f"  · {task_id} - {summary[:50]}"
            else:
                line = f"  · {task_id}"
            pending_lines.append(line)
        pending_text = "\n".join(pending_lines)
        elements.append({
            "tag": "div",
            "text": {
                "tag": "lark_md",
                "content": f"**⏳ 待确认（{len(pending_confirm)}个）**\n{pending_text}"
            }
        })

    # ── ⏳ 待定（deferred 状态，不算失败）──
    if deferred:
        deferred_lines = []
        for t in deferred:
            task_id = t.get("id", "未知")
            summary = t.get("summary", "") or ""
            # 格式：· id - summary（如果 summary 太长则截断）
            if summary:
                line = f"  · {summary[:50]}"
            else:
                line = f"  · {task_id}"
            deferred_lines.append(line)
        deferred_text = "\n".join(deferred_lines)
        elements.append({
            "tag": "div",
            "text": {
                "tag": "lark_md",
                "content": f"**⏳ 待定（{len(deferred)}个）**\n{deferred_text}"
            }
        })

    # ── ⚠️ 超时未完成 ──
    if stuck:
        text_md = format_stuck_table(stuck, ordinals)
        elements.append({
            "tag": "div",
            "text": {
                "tag": "lark_md",
                "content": f"**⚠️ 超时未完成（{len(stuck)}个）**\n{text_md}"
            }
        })

    # ── ✅ 近期完成 / ❌ 近期失败 / ⏰ 近期超时 ──
    if recent_done:
        text_md = format_recent_done_table(recent_done)
        # 根据 finish_type 统计各类数量
        done_count = sum(1 for t in recent_done if t.get("_finish_type") == "done")
        failed_count = sum(1 for t in recent_done if t.get("_finish_type") == "failed")
        timeout_count = sum(1 for t in recent_done if t.get("_finish_type") == "timeout")
        title_parts = []
        if done_count:
            title_parts.append(f"✅完成{done_count}")
        if failed_count:
            title_parts.append(f"❌失败{failed_count}")
        if timeout_count:
            title_parts.append(f"⏰超时{timeout_count}")
        title = f"**📋 近期结束（最近{RECENT_DONE_MINUTES}分钟）：{' '.join(title_parts)}**"
        elements.append({
            "tag": "div",
            "text": {
                "tag": "lark_md",
                "content": f"{title}\n{text_md}"
            }
        })

    # ── 💰 执行成本统计（近期成功任务）──
    if recent_done:
        _stats_text = build_exec_stats_text(recent_done)
        if _stats_text:
            elements.append({
                "tag": "div",
                "text": {
                    "tag": "lark_md",
                    "content": f"**💰 执行成本估算**\n{_stats_text}"
                }
            })

    # 分隔线
    elements.append({"tag": "hr"})

    # compact 提示：最近30分钟内发生过上下文压缩，显示具体时间点（同一时间点只报一次）
    compact_time = get_last_compact_time()
    if compact_time and should_report_compact(compact_time):
        elements.append({
            "tag": "note",
            "elements": [{"tag": "plain_text", "content": f"⚡ 上次上下文压缩：{compact_time}，如有短暂响应延迟属正常现象"}]
        })
        mark_compact_reported(compact_time)

    # 最后更新时间 + 有效期显示
    # 底部提示：告诉用户怎么主动查状态
    elements.append({"tag": "hr"})
    # 计算有效期（基于首次发卡时间 sent_at，而非当前更新时间）
    from datetime import timedelta
    if sent_at and sent_at > 0:
        expire_date = (datetime.fromtimestamp(sent_at) + timedelta(days=30)).strftime("%m月%d日")
        footer_text = f"💡 发送「八爪鱼状态」可随时查看最新面板 | ⚡ 快捷动作：在当前会话继续下发任务即可复用调度上下文 | 🕐 最后更新：{now_str} · 📅 有效至 {expire_date}"
    else:
        footer_text = f"💡 发送「八爪鱼状态」可随时查看最新面板 | ⚡ 快捷动作：在当前会话继续下发任务即可复用调度上下文 | 🕐 最后更新：{now_str}"
    elements.append({
        "tag": "note",
        "elements": [
            {
                "tag": "plain_text",
                "content": footer_text
            }
        ]
    })

    # 标题颜色：有卡死用红色，有待确认/待定用橙色，只有活跃任务用蓝色
    if stuck:
        header_color = "red"
    elif pending_confirm or deferred:
        header_color = "orange"
    else:
        header_color = "blue"

    card = {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {
                "tag": "plain_text",
                "content": "🐙 八爪鱼（OctoClaw）任务面板"
            },
            "template": header_color
        },
        "elements": elements
    }
    return card


def build_idle_card(recent_done: list = None) -> dict:
    """构建空闲状态卡片（无任务时的固定面板）"""
    import time
    now_str = time.strftime("%H:%M", time.localtime())
    recent_done = recent_done or []

    if recent_done:
        recent_lines = "\n".join(
            f"✅ {t.get('label','')[:6]} · {(t.get('summary') or t.get('id',''))[:30]}"
            for t in recent_done[:5]
        )
        recent_text = f"**📋 近期完成（最近{RECENT_DONE_MINUTES}分钟）：**\n{recent_lines}"
    else:
        recent_text = f"📭 最近 {RECENT_DONE_MINUTES} 分钟内无完成任务"

    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": "🐙 八爪鱼（OctoClaw）· 空闲中"},
            "template": "green"
        },
        "elements": [
            {
                "tag": "div",
                "text": {
                    "tag": "lark_md",
                    "content": f"⚙️ 模式：平衡模式　　🏃 进行中：无　　⏳ 排队中：无"
                }
            },
            {"tag": "hr"},
            {
                "tag": "div",
                "text": {
                    "tag": "lark_md",
                    "content": recent_text
                }
            },
            {"tag": "hr"},
            {
                "tag": "div",
                "text": {
                    "tag": "lark_md",
                    "content": f"🕐 最后更新：{now_str}"
                }
            }
        ]
    }


PATROL_CARD_STATE_FILE = "/workspace/tmp/octopus/patrol-card-state.json"
PATROL_CARD_EXPIRE_SECONDS = 24 * 60 * 60  # 24小时：超过24小时的旧卡片直接发新卡
PATROL_CARD_MAX_AGE_SECONDS = 25 * 24 * 60 * 60  # 25天：超25天自动撤回旧卡 + 发新卡（飞书卡片有效期约30天）


def load_patrol_card_state() -> dict | None:
    """读取 patrol 卡片状态（message_id + 发送时间），过期或不存在返回 None
    
    两级过期检查：
    1. 24小时 → 超过24小时的旧卡片直接发新卡（不尝试 update）
    2. 25天卡片寿命 → 撤回旧卡 + 强制发新卡（飞书卡片有效期约30天，提前5天刷新）
    
    sent_at 记录卡片首次发送时间戳，update 成功不会刷新 sent_at，
    确保卡片满24小时后自动发新卡。
    """
    try:
        with open(PATROL_CARD_STATE_FILE, "r", encoding="utf-8") as f:
            state = json.load(f)
        sent_at = state.get("sent_at", 0)
        # 25天寿命检查（优先，自动撤回旧卡 + 发新卡 + 提示用户重新置顶）
        if time.time() - sent_at > PATROL_CARD_MAX_AGE_SECONDS:
            print(f"📅 卡片已超过25天，将撤回旧卡 + 发新卡 + 提示重新置顶")
            return None
        # 24小时过期检查：超过24小时的旧卡片直接发新卡
        if time.time() - sent_at > PATROL_CARD_EXPIRE_SECONDS:
            print(f"📅 卡片已超过24小时，直接发新卡（不尝试 update）")
            return None
        return state
    except Exception:
        return None


def save_patrol_card_state(message_id: str, force_new: bool = False):
    """保存 patrol 卡片 message_id 和发送时间（保留首次发送时间，不刷新）
    
    sent_at 始终保存首次发送时间戳，update 成功时不刷新。
    这样卡片满 24 小时后自动发新卡（load_patrol_card_state 返回 None）。
    update 失败时调用方负责 clear_patrol_card_state() + 发新卡，新卡会写入新的 sent_at。
    
    force_new=True：忽略旧 sent_at，强制写入新的（用于撤回旧卡 + 发新卡的场景）
    
    state 格式：
    {
        "message_id": "om_xxx",
        "sent_at": 1234567890,        # Unix 时间戳（首次发送，不刷新）
        "sent_at_iso": "2026-03-11T21:35:00+08:00",  # ISO 格式（便于人读）
        "chat_id": "<TARGET_OPEN_ID>" # 发送目标（便于跨环境调试）
    }
    """
    # 直接从文件读取原始 state（绕过 load_patrol_card_state 的过期检查，确保首次发送时间不丢失）
    existing_raw = None
    try:
        with open(PATROL_CARD_STATE_FILE, "r", encoding="utf-8") as _f:
            existing_raw = json.load(_f)
    except Exception:
        pass
    # 保留首次发送时间，避免 sent_at 每次刷新导致24小时/25天过期检查失效
    now_ts = int(time.time())
    if force_new or existing_raw is None:
        first_sent = now_ts
    else:
        first_sent = existing_raw.get("sent_at", now_ts)
    
    # 从 feishu-card.py 读取 TARGET_OPEN_ID
    chat_id = ""
    try:
        import importlib.util as _ilu_s
        _spec_s = _ilu_s.spec_from_file_location("feishu_card", FEISHU_CARD_SCRIPT)
        if _spec_s and _spec_s.loader:
            _fc_s = _ilu_s.module_from_spec(_spec_s)
            _spec_s.loader.exec_module(_fc_s)
            chat_id = _fc_s.TARGET_OPEN_ID
    except Exception:
        pass
    
    sent_at_iso = datetime.fromtimestamp(first_sent).astimezone().isoformat()
    state = {
        "message_id": message_id,
        "sent_at": first_sent,
        "sent_at_iso": sent_at_iso,
        "chat_id": chat_id,
    }
    try:
        with open(PATROL_CARD_STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)
    except Exception as e:
        print(f"⚠️  保存 patrol card state 失败: {e}", file=sys.stderr)


def clear_patrol_card_state():
    """清除 patrol 卡片状态（任务全部完成或过期后调用）"""
    try:
        if os.path.exists(PATROL_CARD_STATE_FILE):
            os.remove(PATROL_CARD_STATE_FILE)
    except Exception:
        pass


def update_panel_card(message_id: str, card: dict) -> bool:
    """
    通过飞书 API 原地更新已有面板卡片。
    返回 True 表示成功，False 表示失败（调用方应降级为 send）。
    """
    if not _cards_enabled():
        return False
    if not os.path.exists(FEISHU_CARD_SCRIPT):
        return False

    import importlib.util
    spec = importlib.util.spec_from_file_location("feishu_card", FEISHU_CARD_SCRIPT)
    if spec is None or spec.loader is None:
        return False
    fc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fc)

    token = fc.get_tenant_access_token()
    import requests as _requests

    payload = {
        "msg_type": "interactive",
        "content": json.dumps(card, ensure_ascii=False)
    }

    try:
        resp = _requests.patch(
            f"{fc.FEISHU_API_BASE}/im/v1/messages/{message_id}",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8"
            },
            json=payload,
            timeout=15
        )
        data = resp.json()
        if data.get("code") != 0:
            print(f"⚠️  更新卡片失败 (code={data.get('code')}): {data.get('msg')}", file=sys.stderr)
            return False
        return True
    except Exception as e:
        print(f"⚠️  更新卡片异常: {e}", file=sys.stderr)
        return False


def send_panel_card(card: dict) -> str:
    """
    通过 feishu-card.py 的内部 API 发送面板卡片。
    直接 import 并调用，避免 subprocess 序列化问题。
    返回 message_id。
    """
    if not _cards_enabled():
        print("ℹ️  当前通知后端不支持卡片，跳过面板发送")
        return ""
    if not os.path.exists(FEISHU_CARD_SCRIPT):
        raise FileNotFoundError(f"feishu-card.py 不存在: {FEISHU_CARD_SCRIPT}")

    import importlib.util
    spec = importlib.util.spec_from_file_location("feishu_card", FEISHU_CARD_SCRIPT)
    if spec is None or spec.loader is None:
        raise ImportError(f"无法加载 feishu-card.py: {FEISHU_CARD_SCRIPT}")
    fc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fc)

    token = fc.get_tenant_access_token()
    import requests as _requests

    payload = {
        "receive_id": fc.TARGET_OPEN_ID,
        "msg_type": "interactive",
        "content": json.dumps(card, ensure_ascii=False)
    }

    resp = _requests.post(
        f"{fc.FEISHU_API_BASE}/im/v1/messages?receive_id_type=open_id",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8"
        },
        json=payload,
        timeout=15
    )
    data = resp.json()
    if data.get("code") != 0:
        raise RuntimeError(
            f"发送失败 (code={data.get('code')}): {data.get('msg')}\n"
            f"完整响应: {json.dumps(data, ensure_ascii=False)}"
        )
    return data["data"]["message_id"]


def send_dm_alert(stuck_tasks: list) -> str | None:
    """
    向主 Agent 发送 DM 文本告警，通知卡死/超时任务。
    
    Args:
        stuck_tasks: 卡死任务列表，每个任务含 id, label, _stuck_reason 等字段
        
    Returns:
        message_id 或 None（发送失败时）
    """
    if not stuck_tasks:
        return None
    if not _text_notify_enabled():
        return None
    
    if not os.path.exists(FEISHU_CARD_SCRIPT):
        print("⚠️  feishu-card.py 不存在，跳过 DM 告警", file=sys.stderr)
        return None
    
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("feishu_card", FEISHU_CARD_SCRIPT)
        if spec is None or spec.loader is None:
            print("⚠️  无法加载 feishu-card.py，跳过 DM 告警", file=sys.stderr)
            return None
        fc = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fc)
        
        token = fc.get_tenant_access_token()
        import requests as _requests
        
        # 构建结构化卡死任务信息（JSON 格式，方便主 Agent 解析）
        import json as _json_mod
        stuck_info = []
        for t in stuck_tasks:
            task_id = t.get("id", "未知ID")
            label = t.get("label", "未知")
            model = t.get("model", "未知")
            reason = t.get("_stuck_reason", "超时无响应")
            # 计算卡死时长（分钟）
            spawned_at_str = t.get("spawned_at") or t.get("started_at") or ""
            elapsed_min = 0
            if spawned_at_str:
                t_spawned = parse_iso(spawned_at_str)
                if t_spawned:
                    elapsed_min = int((datetime.now(timezone.utc) - t_spawned).total_seconds() / 60)
            stuck_info.append({
                "id": task_id,
                "label": label,
                "model": model,
                "tier": t.get("tier", "normal"),
                "reason": reason,
                "elapsed": f"{elapsed_min}min"
            })
        
        stuck_json = _json_mod.dumps(stuck_info, ensure_ascii=False)
        content = f"""---RESULT---
状态: 成功
摘要: 检测到 {len(stuck_tasks)} 个卡死/失败任务，已通过 announce 通知主 Agent
🚨 卡死任务：{stuck_json}
STUCK_TASKS: {stuck_json}
详情: 无需写详情报告
---END---"""
        
        payload = {
            "receive_id": fc.TARGET_OPEN_ID,
            "msg_type": "text",
            "content": json.dumps({"text": content}, ensure_ascii=False)
        }
        
        resp = _requests.post(
            f"{fc.FEISHU_API_BASE}/im/v1/messages?receive_id_type=open_id",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8"
            },
            json=payload,
            timeout=15
        )
        data = resp.json()
        if data.get("code") != 0:
            print(f"⚠️  DM 告警发送失败 (code={data.get('code')}): {data.get('msg')}", file=sys.stderr)
            return None
        
        print(f"📨 DM 告警已发送: {len(stuck_tasks)} 个卡死任务")
        return data["data"]["message_id"]
    except Exception as e:
        print(f"⚠️  DM 告警发送异常: {e}", file=sys.stderr)
        return None


def recall_card_a(message_id: str) -> bool:
    """
    撤回置顶常驻卡 A（调用 feishu-card.py 的 recall_message）。
    撤回失败时静默降级（返回 False），不中断流程。
    25天后调用，撤回后会发新卡 + 提示用户重新置顶。
    """
    if not _cards_enabled():
        return False
    if not os.path.exists(FEISHU_CARD_SCRIPT):
        return False
    try:
        import importlib.util as _ilu_r
        _spec_r = _ilu_r.spec_from_file_location("feishu_card", FEISHU_CARD_SCRIPT)
        if _spec_r is None or _spec_r.loader is None:
            return False
        _fc_r = _ilu_r.module_from_spec(_spec_r)
        _spec_r.loader.exec_module(_fc_r)
        ok = _fc_r.recall_message(message_id)
        if ok:
            print(f"🗑️  旧置顶卡 A 已撤回: {message_id}")
        else:
            print(f"⚠️  旧置顶卡 A 撤回失败（可能超过飞书限制）: {message_id}", file=sys.stderr)
        return ok
    except Exception as e:
        print(f"⚠️  recall_card_a 异常: {e}", file=sys.stderr)
        return False


def send_expire_dm_alert() -> str | None:
    """
    发送卡片过期提醒 DM，提示用户重新置顶新卡片（25天自动撤回刷新场景）。
    """
    if not _text_notify_enabled():
        return None
    if not os.path.exists(FEISHU_CARD_SCRIPT):
        print("⚠️  feishu-card.py 不存在，跳过期 DM 提示", file=sys.stderr)
        return None
    
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("feishu_card", FEISHU_CARD_SCRIPT)
        if spec is None or spec.loader is None:
            return None
        fc = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fc)
        
        token = fc.get_tenant_access_token()
        import requests as _requests
        
        content = "📌 状态面板已自动刷新（原置顶卡已满25天），请重新置顶最新卡片"
        
        payload = {
            "receive_id": fc.TARGET_OPEN_ID,
            "msg_type": "text",
            "content": json.dumps({"text": content}, ensure_ascii=False)
        }
        
        resp = _requests.post(
            f"{fc.FEISHU_API_BASE}/im/v1/messages?receive_id_type=open_id",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8"
            },
            json=payload,
            timeout=15
        )
        data = resp.json()
        if data.get("code") != 0:
            print(f"⚠️  过期 DM 提示发送失败 (code={data.get('code')}): {data.get('msg')}", file=sys.stderr)
            return None
        
        print(f"📨 过期 DM 提示已发送")
        return data["data"]["message_id"]
    except Exception as e:
        print(f"⚠️  过期 DM 提示发送异常: {e}", file=sys.stderr)
        return None


def build_event_card_b(event_type: str, task: dict) -> dict:
    """
    构建事件通知卡片 B（精简版，仅显示变化的那一条）。
    
    event_type: "done" | "failed" | "stuck"
    task: 触发事件的任务 dict
    
    返回飞书卡片 JSON。
    """
    label = task.get("label", task.get("id", "未知"))
    display_name = get_label_name(label)
    summary = (task.get("summary") or task.get("id", ""))[:50]
    model_short = get_model_short(task.get("model", ""))
    
    if event_type == "done":
        header_color = "green"
        icon = "✅"
        title_text = f"触手完成：{display_name}"
    elif event_type == "failed":
        header_color = "red"
        icon = "❌"
        title_text = f"触手失败：{display_name}"
    elif event_type == "stuck":
        header_color = "orange"
        icon = "⚠️"
        title_text = f"触手超时：{display_name}"
    else:
        header_color = "blue"
        icon = "ℹ️"
        title_text = f"触手通知：{display_name}"
    
    # 耗时
    elapsed_str = ""
    completed_at = parse_iso(task.get("completed_at", ""))
    start_str = task.get("started_at") or task.get("spawned_at", "")
    start_at = parse_iso(start_str)
    if completed_at and start_at:
        elapsed_str = f" · 耗时 {format_age((completed_at - start_at).total_seconds() / 60)}"
    
    now_str = datetime.now().astimezone().strftime("%H:%M")
    
    stuck_reason = task.get("_stuck_reason", "")
    detail_line = summary
    if event_type == "stuck" and stuck_reason:
        detail_line = f"{stuck_reason}\n  └ {summary}"
    
    card = {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": title_text},
            "template": header_color
        },
        "elements": [
            {
                "tag": "div",
                "text": {
                    "tag": "lark_md",
                    "content": f"{icon} **{display_name}** · {model_short}{elapsed_str}\n└ {detail_line}"
                }
            },
            {"tag": "hr"},
            {
                "tag": "note",
                "elements": [
                    {"tag": "plain_text", "content": f"🕐 {now_str}  ·  此卡片为事件通知，不置顶"}
                ]
            }
        ]
    }
    return card


def send_event_card_b(event_type: str, task: dict) -> str | None:
    """
    发送事件通知卡片 B（精简卡片，不 update，不保存 state）。
    
    event_type: "done" | "failed" | "stuck"
    task: 触发事件的任务 dict
    
    Returns: message_id 或 None（发送失败）
    """
    if not _event_cards_enabled():
        return None
    if not os.path.exists(FEISHU_CARD_SCRIPT):
        return None
    try:
        card = build_event_card_b(event_type, task)
        import importlib.util as _ilu_b
        _spec_b = _ilu_b.spec_from_file_location("feishu_card", FEISHU_CARD_SCRIPT)
        if _spec_b is None or _spec_b.loader is None:
            return None
        _fc_b = _ilu_b.module_from_spec(_spec_b)
        _spec_b.loader.exec_module(_fc_b)
        token = _fc_b.get_tenant_access_token()
        import requests as _requests_b
        payload = {
            "receive_id": _fc_b.TARGET_OPEN_ID,
            "msg_type": "interactive",
            "content": json.dumps(card, ensure_ascii=False)
        }
        resp = _requests_b.post(
            f"{_fc_b.FEISHU_API_BASE}/im/v1/messages?receive_id_type=open_id",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8"
            },
            json=payload,
            timeout=15
        )
        data = resp.json()
        if data.get("code") == 0:
            mid = data["data"]["message_id"]
            print(f"📨 事件卡片 B 已发送（{event_type}）: {mid}")
            return mid
        else:
            print(f"⚠️  事件卡片 B 发送失败: {data.get('msg')}", file=sys.stderr)
            return None
    except Exception as e:
        print(f"⚠️  send_event_card_b 异常: {e}", file=sys.stderr)
        return None


# ── 状态变化通知相关 ──
PATROL_NOTIFY_STATE_FILE = "/workspace/tmp/octopus/patrol-notify-state.json"


def load_notify_state() -> dict:
    """读取上次通知状态快照"""
    try:
        with open(PATROL_NOTIFY_STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"task_ids": {}, "updated_at": ""}


def save_notify_state(state: dict):
    """保存通知状态快照"""
    try:
        os.makedirs(os.path.dirname(PATROL_NOTIFY_STATE_FILE), exist_ok=True)
        with open(PATROL_NOTIFY_STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)
    except Exception as e:
        print(f"⚠️  保存通知状态失败: {e}", file=sys.stderr)


def send_state_change_dm(msg: str, reply_to_message_id: str | None = None) -> str | None:
    """
    发送状态变化通知 DM（复用飞书发送逻辑）。
    可选 reply_to_message_id 用于引用面板卡片消息。
    """
    mid = send_text(msg, reply_to=reply_to_message_id)
    if mid:
        print(f"📨 状态变化 DM 已发送: {msg[:30]}...")
    return mid


def _increment_panel_shown_count(pending_list: list):
    """
    对本次展示在面板上的 pending_confirm 任务，在 task-state.json 中将
    panel_shown_count +1（初始为0）。达到3次后下次 classify_tasks 将静默过滤。
    """
    try:
        data = load_task_state(TASK_STATE_FILE)
        tasks = data.get("tasks", [])
        shown_ids = {t.get("id") for t in pending_list}
        changed = False
        for task in tasks:
            if task.get("id") in shown_ids and task.get("status") == "pending_confirm":
                task["panel_shown_count"] = task.get("panel_shown_count", 0) + 1
                print(f"📊 pending_confirm [{task['id']}] panel_shown_count → {task['panel_shown_count']}")
                changed = True
        if changed:
            data["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            save_task_state(TASK_STATE_FILE, data)
    except Exception as e:
        print(f"⚠️  更新 panel_shown_count 失败: {e}", file=sys.stderr)


def _update_deferred_report_count(deferred_list: list):
    """
    对 deferred 任务更新上报计数，达到 1 次后自动标记为 expired。
    """
    try:
        data = load_task_state(TASK_STATE_FILE)
        tasks = data.get("tasks", [])
        deferred_ids = {t.get("id") for t in deferred_list}
        changed = False
        for task in tasks:
            if task.get("id") in deferred_ids and task.get("status") == "deferred":
                count = task.get("deferred_report_count", 0)
                if count >= 1:
                    # 达到 1 次，标记为 expired
                    task["status"] = "expired"
                    task["expired_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                    task["expired_reason"] = "deferred_report_count >= 1"
                    print(f"⏰ deferred [{task['id']}] → expired (report_count={count})")
                    changed = True
                else:
                    # 计数 +1
                    task["deferred_report_count"] = count + 1
                    print(f"📊 deferred [{task['id']}] report_count → {count + 1}")
                    changed = True
        if changed:
            data["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            save_task_state(TASK_STATE_FILE, data)
    except Exception as e:
        print(f"⚠️  更新 deferred_report_count 失败: {e}", file=sys.stderr)


def get_timeout_minutes(task: dict) -> int:
    """兼容旧调用：返回 tier 最低保障（分钟），等同于 TIER_MIN[tier]。"""
    label = task.get("label", "")
    label_default = LABEL_DEFAULT_TIER.get(label, DEFAULT_TIER)
    tier = task.get("tier", label_default).lower()
    return TIER_TIMEOUT_MINUTES.get(tier, TIER_TIMEOUT_MINUTES[DEFAULT_TIER])


def calculate_timeout(task: dict) -> float:
    """动态超时公式：max(expected_duration × 1.5, TIER_MIN[tier])（分钟）

    expected_duration = expected_done_at - spawned_at（分钟）
    若 expected_done_at 为空，fallback 到 TIER_MIN[tier] × 2
    """
    label = task.get("label", "")
    label_default = LABEL_DEFAULT_TIER.get(label, DEFAULT_TIER)
    tier = task.get("tier", label_default).lower()
    tier_min = float(TIER_TIMEOUT_MINUTES.get(tier, TIER_TIMEOUT_MINUTES[DEFAULT_TIER]))

    expected_done_at_str = task.get("expected_done_at") or ""
    spawned_at_str = task.get("spawned_at") or task.get("started_at") or ""

    expected_duration: float | None = None
    if expected_done_at_str and spawned_at_str:
        t_expected = parse_iso(expected_done_at_str)
        t_spawned = parse_iso(spawned_at_str)
        if t_expected and t_spawned:
            expected_duration = (t_expected - t_spawned).total_seconds() / 60.0

    if expected_duration is not None and expected_duration > 0:
        dynamic = expected_duration * 1.5
    else:
        dynamic = tier_min * 2  # fallback

    return max(dynamic, tier_min)


def get_subagent_run_id(label: str) -> str | None:
    """
    从 sessions.json 中找到 label 匹配的最新 session 的 sessionId。
    sessions.json 是 dict，key 为 session key（如 agent:main:subagent:xxx），
    value 有 label/updatedAt/sessionId 等字段。
    返回 sessionId（用于 kill 操作）。
    """
    sessions_file = os.path.expanduser("~/.openclaw/agents/main/sessions/sessions.json")
    if not os.path.exists(sessions_file):
        return None
    try:
        with open(sessions_file, 'r', encoding='utf-8') as f:
            sessions_data = json.load(f)
        if not isinstance(sessions_data, dict):
            return None

        # sessions_data 是 {sessionKey: {label, updatedAt, sessionId, ...}}
        matched = [
            (k, v) for k, v in sessions_data.items()
            if isinstance(v, dict) and v.get("label") == label
        ]
        if not matched:
            return None
        # 取 updatedAt 最新的
        matched.sort(
            key=lambda kv: kv[1].get("updatedAt") or "",
            reverse=True
        )
        _key, session = matched[0]
        return session.get("sessionId") or session.get("runId") or session.get("activeRunId")
    except Exception as e:
        print(f"⚠️  get_subagent_run_id({label}) 失败: {e}", file=sys.stderr)
        return None


def get_session_last_activity(label: str) -> float | None:
    """
    从 sessions.json 中找到 label 匹配的最新 session 的 updatedAt，
    返回距今多少分钟（float）。找不到则返回 None。
    """
    sessions_file = os.path.expanduser("~/.openclaw/agents/main/sessions/sessions.json")
    if not os.path.exists(sessions_file):
        return None
    try:
        with open(sessions_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return None
        # sessions.json is a dict keyed by session key, values have label + updatedAt
        now_ms = time.time() * 1000
        best_updated = None
        for key, val in data.items():
            if not isinstance(val, dict):
                continue
            if val.get("label") == label:
                updated = val.get("updatedAt")
                if updated and (best_updated is None or updated > best_updated):
                    best_updated = updated
        if best_updated is None:
            return None
        age_minutes = (now_ms - best_updated) / 60000.0
        return age_minutes
    except Exception as e:
        print(f"⚠️  get_session_last_activity({label}) 失败: {e}", file=sys.stderr)
        return None


def analyze_timeout_reason(task: dict) -> str:
    """纯 Python 分析 transcript 最后 20 条消息，判断超时原因。

    返回值：ghost_completion / token_overflow / tool_error / stuck / unknown
    """
    label = task.get("label", "")
    if not label:
        return "unknown"

    sessions_file = os.path.expanduser("~/.openclaw/agents/main/sessions/sessions.json")
    if not os.path.exists(sessions_file):
        return "unknown"

    try:
        with open(sessions_file, 'r', encoding='utf-8') as f:
            sessions_data = json.load(f)
    except Exception:
        return "unknown"

    if not isinstance(sessions_data, dict):
        return "unknown"

    matched = [
        v for v in sessions_data.values()
        if isinstance(v, dict) and v.get("label") == label
    ]
    if not matched:
        return "unknown"

    matched.sort(key=lambda s: s.get("updatedAt") or "", reverse=True)
    session = matched[0]
    session_id = session.get("sessionId") or session.get("id")
    if not session_id:
        return "unknown"

    transcript_path = os.path.expanduser(
        f"~/.openclaw/agents/main/sessions/{session_id}.jsonl"
    )
    if not os.path.exists(transcript_path):
        return "unknown"

    try:
        with open(transcript_path, 'rb') as f:
            all_lines = list(deque(f, 200))
    except Exception:
        return "unknown"

    # 解析最后 20 条消息
    last_20_lines = all_lines[-20:]
    has_stop_reason_stop = False
    has_stop_reason_length = False
    has_edit_write_success = False
    has_tool_error = False
    has_result_marker = False
    last_tool_time: float | None = None

    full_text = b''.join(all_lines).decode('utf-8', errors='ignore')
    if '---RESULT---' in full_text:
        has_result_marker = True

    for line in last_20_lines:
        try:
            obj = json.loads(line.decode('utf-8', errors='ignore'))
        except Exception:
            continue

        role = obj.get("role", "")
        stop_reason = obj.get("stopReason") or obj.get("stop_reason") or ""

        if role == "assistant":
            if stop_reason == "stop":
                has_stop_reason_stop = True
            elif stop_reason == "length":
                has_stop_reason_length = True

        # 检查工具调用：edit/write 成功 & isError
        tool_calls = obj.get("toolCalls") or obj.get("tool_calls") or []
        if isinstance(tool_calls, list):
            for tc in tool_calls:
                if not isinstance(tc, dict):
                    continue
                tool_name = (
                    tc.get("name") or
                    (tc.get("function") or {}).get("name") or ""
                ).lower()
                is_error = tc.get("isError") or tc.get("is_error") or False
                if is_error:
                    has_tool_error = True
                if tool_name in ("edit", "write") and not is_error:
                    has_edit_write_success = True
                # 记录工具调用时间戳
                ts = obj.get("timestamp") or obj.get("ts")
                if ts:
                    try:
                        last_tool_time = float(ts)
                    except Exception:
                        pass

        # tool_results 格式（assistant 消息里的结果）
        tool_results = obj.get("toolResults") or obj.get("tool_results") or []
        if isinstance(tool_results, list):
            for tr in tool_results:
                if not isinstance(tr, dict):
                    continue
                if tr.get("isError") or tr.get("is_error"):
                    has_tool_error = True

    # 判断 stuck：最后工具活动 > 5 分钟前
    if last_tool_time is not None:
        now_ms = time.time() * 1000
        # timestamp 可能是秒或毫秒
        if last_tool_time < 1e12:
            last_tool_time *= 1000  # 转毫秒
        idle_minutes = (now_ms - last_tool_time) / 60000.0
        is_stuck = idle_minutes > 5
    else:
        is_stuck = False

    # 判断逻辑（按优先级）
    if has_stop_reason_length:
        return "token_overflow"
    if has_edit_write_success and has_stop_reason_stop and not has_result_marker:
        return "ghost_completion"
    if has_tool_error:
        return "tool_error"
    if is_stuck:
        return "stuck"
    return "unknown"


def kill_subagent(run_id: str) -> bool:
    """
    尝试通过 Gateway HTTP API 终止子 Agent。
    注意：subagents kill 只能在 agent turn 内通过工具调用实现；
    patrol.py 作为独立脚本运行，无法直接 kill subagent session，
    此函数会返回 False 并记录告警，由飞书告警通知用户手动处理。
    """
    gateway_url = os.environ.get("OPENCLAW_GATEWAY_URL", "http://localhost:3000")
    gateway_token = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")
    headers = {"Content-Type": "application/json"}
    if gateway_token:
        headers["Authorization"] = f"Bearer {gateway_token}"

    # 尝试通过 Gateway REST API kill（若版本支持）
    try:
        import requests as _req
        resp = _req.post(
            f"{gateway_url}/api/subagents/kill",
            headers=headers,
            json={"runId": run_id, "sessionId": run_id},
            timeout=10
        )
        if resp.status_code in (200, 204):
            data = resp.json() if resp.content else {}
            if data.get("success") or data.get("killed") or resp.status_code == 204:
                print(f"🔴 已终止 subagent: {run_id}")
                return True
    except Exception:
        pass

    # fallback：尝试 openclaw gateway kill（若 CLI 版本支持）
    try:
        result = subprocess.run(
            ["openclaw", "gateway", "kill", run_id],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            print(f"🔴 已终止 subagent via CLI: {run_id}")
            return True
    except Exception:
        pass

    # kill 不可用：告警后由用户手动处理
    print(f"⚠️  无法自动终止 subagent {run_id}：patrol 作为独立脚本无 kill 权限，请主 Agent 手动处理", file=sys.stderr)
    return False


def mark_task_timed_out(task_id: str, elapsed_minutes: float, summary_prefix: str = "超时自动终止"):
    """
    将 task-state.json 中指定 task 标记为 failed，summary 写入运行时长。
    """
    try:
        data = load_task_state(TASK_STATE_FILE)
        tasks = data.get("tasks", [])
        changed = False
        total_seconds = int(elapsed_minutes * 60)
        m = total_seconds // 60
        s = total_seconds % 60
        for t in tasks:
            if t.get("id") == task_id and t.get("status") in ("running", "dispatched"):
                t["status"] = "failed"
                t["summary"] = f"{summary_prefix}（运行 {m}m {s}s）"
                t["completed_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                changed = True
                print(f"🔴 任务 {task_id} 已标记为 failed：运行 {m}m {s}s，超时终止")
                break
        if changed:
            data["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            save_task_state(TASK_STATE_FILE, data)
    except Exception as e:
        print(f"⚠️  mark_task_timed_out({task_id}) 失败: {e}", file=sys.stderr)


def send_timeout_alert(task: dict, elapsed_minutes: float, run_id: str | None, killed: bool,
                        soft: bool = False, last_activity_minutes: float | None = None,
                        ghost_completion: bool = False,
                        timeout_reason: str = "unknown"):
    """
    发送超时告警到飞书（简单文本消息）。
    timeout_reason: analyze_timeout_reason() 返回的分析结果
    """
    label = task.get("label", task.get("id", "未知"))
    display_name = get_label_name(label)
    tier = task.get("tier", DEFAULT_TIER)
    timeout_minutes = calculate_timeout(task)
    total_seconds = int(elapsed_minutes * 60)
    m = total_seconds // 60
    s = total_seconds % 60
    task_summary = task.get("summary", "无摘要")

    # 超时原因→建议操作
    reason_labels = {
        "ghost_completion": "🔮 幽灵完成（任务实际完成但未写 RESULT）",
        "token_overflow":   "📄 输出超限（已分步续写，非失败）",
        "tool_error":       "🔧 工具失败（isError=true）",
        "stuck":            "🧊 卡死（超 5 分钟无工具调用）",
        "unknown":          "❓ 原因未知",
    }
    advice_map = {
        "ghost_completion": "建议主 Agent 检查文件后手动标记 done",
        "token_overflow":   "建议重派，task 注明「分段写文件，每次不超过 60 行」",
        "tool_error":       "建议主 Agent 查看 transcript 后决策是否重派",
        "stuck":            "建议主 Agent 终止并重派",
        "unknown":          "建议主 Agent 查看 transcript 后决策",
    }
    reason_str = reason_labels.get(timeout_reason, timeout_reason)
    advice_str = advice_map.get(timeout_reason, "建议主 Agent 检查")

    msg = (
        f"⏰ 八爪鱼超时告警\n\n"
        f"触手：{display_name}（{label}）\n"
        f"任务：{task.get('summary', '（无标题）')[:20]} | {task.get('id', '未知')}\n"
        f"级别：{tier}（动态超时 {timeout_minutes:.0f}min）\n"
        f"运行时长：{m}m {s}s\n"
        f"超时原因：{reason_str}\n"
        f"建议操作：{advice_str}\n"
        f"摘要：{task_summary}\n"
        f"状态：未自动终止，等待主 Agent 决策\n"
        f"如需处理：告诉 Agent「终止任务 {task.get('id', '未知')}」或「重派任务」"
    )

    mid = send_text(msg)
    if mid:
        print(f"✅ 超时告警已发送: {task.get('id')}")


def check_and_handle_timeout(tasks: list) -> list:
    """
    检查所有 status=running/dispatched 的任务，使用动态超时公式。
    超时后：
      1. 分析 transcript 判断原因（纯 Python，不依赖 AI）
      2. 写入 task-state.json 的 timeout_reason 字段
      3. 发送飞书告警（含任务名、运行时长、超时原因、建议操作）
      4. 不自动 kill，由用户/主 Agent 决策
    返回超时任务列表（供日志记录）。
    """
    now = now_utc()
    timed_out_tasks = []

    for task in tasks:
        status = task.get("status", "")
        if status not in ("running", "dispatched"):
            continue

        # 跳过系统任务
        if task.get("label", "") in SYSTEM_LABELS:
            continue

        # 计算运行时长
        if status == "running":
            ref_ts_str = task.get("started_at") or task.get("spawned_at") or ""
        else:
            ref_ts_str = task.get("spawned_at") or ""

        if not ref_ts_str:
            continue

        ref_ts = parse_iso(ref_ts_str)
        if ref_ts is None:
            continue

        elapsed_minutes = (now - ref_ts).total_seconds() / 60

        # ── 动态超时公式 ──
        timeout_minutes = calculate_timeout(task)

        if elapsed_minutes < timeout_minutes:
            continue

        task_id = task.get("id", "")
        label = task.get("label", "")
        label_default = LABEL_DEFAULT_TIER.get(label, DEFAULT_TIER)
        tier = task.get("tier", label_default)

        # ── 发告警前再次从文件确认状态，防止已完成时误告警 ──
        try:
            _fresh_data = load_task_state(TASK_STATE_FILE)
            _fresh_task = next(
                (t for t in _fresh_data.get("tasks", []) if t.get("id") == task_id),
                None
            )
            _fresh_status = _fresh_task.get("status", "") if _fresh_task else ""
        except Exception:
            _fresh_status = status

        if _fresh_status not in ("running", "dispatched"):
            print(f"ℹ️  超时跳过：{task_id} 在告警前已变为 {_fresh_status!r}，无需告警")
            continue

        # ── 分析 transcript 超时原因 ──
        timeout_reason = analyze_timeout_reason(task)
        print(f"⏰ 超时：{task_id} ({label}) 运行 {elapsed_minutes:.1f}min，"
              f"超出动态阈值 {timeout_minutes:.0f}min，原因={timeout_reason}")

        # ── 写入 task-state.json 的 timeout_reason 字段 ──
        try:
            ts_data = load_task_state(TASK_STATE_FILE)
            for t in ts_data.get("tasks", []):
                if t.get("id") == task_id:
                    t["timeout_reason"] = timeout_reason
                    break
            ts_data["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            save_task_state(TASK_STATE_FILE, ts_data)
        except Exception as e:
            print(f"⚠️  写入 timeout_reason 失败: {e}", file=sys.stderr)

        # ── 发飞书告警（只发一次，防重复）──
        if not task.get("timeout_alerted"):
            send_timeout_alert(task, elapsed_minutes, run_id=None, killed=False,
                               timeout_reason=timeout_reason)
            # 打标：已告警，下次巡逻跳过
            try:
                ts_data2 = load_task_state(TASK_STATE_FILE)
                for t2 in ts_data2.get("tasks", []):
                    if t2.get("id") == task_id:
                        t2["timeout_alerted"] = True
                        break
                ts_data2["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                save_task_state(TASK_STATE_FILE, ts_data2)
            except Exception as e:
                print(f"⚠️  写入 timeout_alerted 失败: {e}", file=sys.stderr)
        else:
            print(f"⏭️  超时告警已发过，跳过重复告警: {task_id}")

        timed_out_tasks.append(task)

    return timed_out_tasks


def check_and_kill_timed_out_tasks(tasks: list) -> list:
    """兼容旧调用：委托给 check_and_handle_timeout。"""
    return check_and_handle_timeout(tasks)


_ALIAS_CHECK_LAST_TS: float = 0.0  # 上次检查时间戳（秒）
_ALIAS_CHECK_INTERVAL = 900  # 15 分钟缓存


def parse_openclaw_json_output(raw: str):
    raw = (raw or "").strip()
    if not raw:
        raise ValueError("empty output")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    for idx, ch in enumerate(raw):
        if ch not in "[{":
            continue
        try:
            return json.loads(raw[idx:])
        except json.JSONDecodeError:
            continue
    raise ValueError("no JSON payload found in output")


def check_model_aliases():
    """
    检查别名文件里的模型是否可用，失败时自动重新匹配并更新。
    带 10 分钟缓存，避免每次巡逻都触发 openclaw models list。
    逻辑：
    1. 读取 /workspace/tmp/octopus-model-aliases.json
    2. 用 subprocess 运行 openclaw models list --json，获取可用模型列表
    3. 对比别名文件里的模型是否在可用列表中
    4. 发现不可用的模型：
       - trivial/simple/normal：从可用列表找名字含 glm 的替代
       - normal_fallback/deep/deep_fallback：从可用列表找名字含 sonnet 的替代
    5. 有变化则更新别名文件 + 飞书通知
    """
    global _ALIAS_CHECK_LAST_TS
    now_ts = time.time()
    if now_ts - _ALIAS_CHECK_LAST_TS < _ALIAS_CHECK_INTERVAL:
        remaining = int(_ALIAS_CHECK_INTERVAL - (now_ts - _ALIAS_CHECK_LAST_TS))
        print(f"⏭️  check_model_aliases: 缓存有效，跳过检测（{remaining}s 后到期）")
        return
    _ALIAS_CHECK_LAST_TS = now_ts

    alias_path = "/workspace/tmp/octopus-model-aliases.json"
    try:
        with open(alias_path) as f:
            aliases = json.load(f)
    except Exception as e:
        print(f"⚠️  check_model_aliases: 读取别名文件失败: {e}")
        return

    # 获取可用模型列表
    try:
        result = subprocess.run(
            ["openclaw", "models", "list", "--json"],
            capture_output=True, text=True, timeout=15
        )
        if result.returncode != 0:
            print(f"⚠️  check_model_aliases: openclaw models list 失败: {result.stderr[:200]}")
            return
        models_data = parse_openclaw_json_output(result.stdout)
        # 支持列表或字典格式（新格式: {"count": N, "models": [{"key": "...", ...}]}）
        if isinstance(models_data, list):
            # 旧格式：直接是模型 ID 列表
            available_ids = set(models_data)
        elif isinstance(models_data, dict):
            if "models" in models_data:
                # 新格式：从 models 数组提取 key 字段
                available_ids = {m["key"] for m in models_data["models"] if "key" in m}
            else:
                # 兜底：直接取 keys
                available_ids = set(models_data.keys())
        else:
            print(f"⚠️  check_model_aliases: 未知模型列表格式")
            return
    except subprocess.TimeoutExpired:
        print("⚠️  check_model_aliases: openclaw models list 超时")
        return
    except Exception as e:
        print(f"⚠️  check_model_aliases: 获取模型列表异常: {e}")
        return

    if not available_ids:
        print("⚠️  check_model_aliases: 可用模型列表为空，跳过检测")
        return

    # 按类别选替代模型
    glm_candidates = [m for m in available_ids if "glm" in m.lower()]
    sonnet_candidates = [m for m in available_ids if "sonnet" in m.lower()]
    # lixiang 私有模型优先，bailian 公有模型排后（私有 < 公有）
    def _glm_sort_key(m):
        if "bailian" in m.lower():
            return (1, m)  # 公有，排后
        return (0, m)  # 私有/其他，排前
    glm_candidates.sort(key=_glm_sort_key)
    sonnet_candidates.sort()

    glm_keys = ["trivial", "simple", "normal"]
    sonnet_keys = ["normal_fallback", "deep", "deep_fallback"]
    changed = {}

    for key in glm_keys:
        model = aliases.get(key, "")
        if model and model not in available_ids:
            if glm_candidates:
                new_model = glm_candidates[0]
                print(f"🔄  check_model_aliases: {key} 模型 {model} 不可用，替换为 {new_model}")
                changed[key] = (model, new_model)
                aliases[key] = new_model
            else:
                print(f"⚠️  check_model_aliases: {key} 模型 {model} 不可用，且无 GLM 候选")

    for key in sonnet_keys:
        model = aliases.get(key, "")
        if model and model not in available_ids:
            if sonnet_candidates:
                new_model = sonnet_candidates[0]
                print(f"🔄  check_model_aliases: {key} 模型 {model} 不可用，替换为 {new_model}")
                changed[key] = (model, new_model)
                aliases[key] = new_model
            else:
                print(f"⚠️  check_model_aliases: {key} 模型 {model} 不可用，且无 Sonnet 候选")

    if changed:
        aliases["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        try:
            with open(alias_path, "w") as f:
                json.dump(aliases, f, indent=2)
            print(f"✅ check_model_aliases: 别名文件已更新，变更 {len(changed)} 项")
        except Exception as e:
            print(f"❌ check_model_aliases: 写入别名文件失败: {e}")
            return

        change_lines = "\n".join(
            f"  {k}: {old} → {new}" for k, (old, new) in changed.items()
        )
        if send_text(f"🔄 模型别名自动更新\n{change_lines}"):
            print("✅ check_model_aliases: 文本通知已发送")
    else:
        print(f"✅ check_model_aliases: 所有别名模型均可用（共检查 {len(glm_keys + sonnet_keys)} 项）")


def update_task_status(task_id: str, new_status: str, extra: dict = None):
    """更新 task-state.json 中指定任务的状态字段。"""
    try:
        data = load_task_state(TASK_STATE_FILE)
        tasks = data.get("tasks", [])
        for t in tasks:
            if t.get("id") == task_id:
                t["status"] = new_status
                if extra:
                    t.update(extra)
                break
        data["updated_at"] = datetime.now(timezone.utc).isoformat()
        save_task_state(TASK_STATE_FILE, data)
        print(f"  ✅ 已更新任务 {task_id} 状态 → {new_status}")
    except Exception as e:
        print(f"  ⚠️  update_task_status 失败: {e}", file=sys.stderr)


def check_model_violations():
    """
    静默检测模型违规：读取 task-state.json 里最近20个 done/failed 任务的 model 字段。
    如果 model 包含完整路径字符串（如 vendor-claude/ 或 aws-claude）而不是短名，
    视为可能的违规，写入 /workspace/.learnings/ERRORS.md。
    
    合规模型名：短名白名单 + lixiang-*/kivy-* 前缀
    短名白名单：glm, sonnet, opus, claudeopus, kimi, gemini
    """
    import datetime as _dt
    
    ERRORS_FILE = "/workspace/.learnings/ERRORS.md"
    TASK_STATE_FILE = "/workspace/tmp/octopus/task-state.json"
    
    # 短名白名单（这些是合规的 resolve-model 输出）
    SHORT_NAME_WHITELIST = {"glm", "sonnet", "opus", "claudeopus", "kimi", "gemini"}
    
    # 合规前缀（lixiang-*/kivy-* 是正常的 resolved model）
    ALLOWED_PREFIXES = ("lixiang-", "kivy-")
    
    if not os.path.exists(TASK_STATE_FILE):
        return
    
    try:
        with open(TASK_STATE_FILE, "r", encoding="utf-8") as f:
            tasks = json.load(f).get("tasks", [])
    except Exception as e:
        print(f"⚠️ 读取 task-state.json 失败: {e}", file=sys.stderr)
        return
    
    # 筛选最近20个 done/failed 任务
    done_failed = [t for t in tasks if t.get("status") in ("done", "failed")]
    done_failed = done_failed[:20]  # 只取最近20个
    
    if not done_failed:
        return
    
    violations = []
    for task in done_failed:
        model = task.get("model", "")
        task_id = task.get("id", "unknown")
        
        if not model:
            continue
        
        # 检查是否合规：白名单短名 或 合规前缀
        model_lower = model.lower()
        is_compliant = (
            model_lower in SHORT_NAME_WHITELIST or
            any(model_lower.startswith(p) for p in ALLOWED_PREFIXES)
        )
        
        if not is_compliant:
            # 可能是写死的完整路径
            violations.append({
                "task_id": task_id,
                "model": model
            })
    
    if not violations:
        print(f"  ✅ 模型名检查：无违规（检查 {len(done_failed)} 条 done/failed 任务）")
        return
    
    # 写入 ~/self-improving/domains/octopus-errors.md，目录不存在则自动创建
    SELF_IMPROVING_ERRORS = os.path.join(os.path.expanduser("~"), "self-improving/domains/octopus-errors.md")
    today_str = datetime.now().strftime("%Y-%m-%d")
    os.makedirs(os.path.dirname(SELF_IMPROVING_ERRORS), exist_ok=True)

    new_entries = []
    for v in violations:
        desc = f"任务 {v['task_id']} 使用了非标准模型名 {v['model']}，疑似写死路径"
        new_entries.append(f"- [{today_str}] 模型违规: {desc} → 使用 resolve-model.py 获取模型名\n")
    try:
        with open(SELF_IMPROVING_ERRORS, "a", encoding="utf-8") as f:
            f.writelines(new_entries)
        print(f"  🔍 模型名检查：发现 {len(violations)} 条疑似违规，已写入 octopus-errors.md")
    except Exception as e:
        print(f"⚠️ 写入 octopus-errors.md 失败: {e}", file=sys.stderr)


def check_model_violation(tasks: list):
    """
    检查近期任务的 model 字段是否符合 resolve-model.py 的预期结果。
    发现违规则静默写入 /workspace/.learnings/ERRORS.md。
    不发飞书告警。
    
    违规判定条件：
    1. 任务状态为 running/dispatched/done/failed（排除 queued/pending_confirm）
    2. 任务有 tier 字段
    3. 任务的 model 与 resolve-model.py 应返回的结果不一致
    
    ERRORS.md 格式：
    ERR-YYYYMMDD-XXX | medium | open | [描述] | 重现N次
    """
    import datetime as _dt
    from collections import defaultdict
    
    ERRORS_FILE = "/workspace/.learnings/ERRORS.md"
    RECENT_HOURS = 24  # 只检查最近24小时的任务
    
    now = now_utc()
    cutoff = _dt.datetime(now.year, now.month, now.day, now.hour, 0, 0, tzinfo=timezone.utc) - _dt.timedelta(hours=RECENT_HOURS)
    
    # 读取 ERRORS.md 中的现有记录，用于去重和更新重现次数
    existing_errors = {}  # key: (task_id, expected_model, actual_model) → {date, seq, count, status}
    if os.path.exists(ERRORS_FILE):
        try:
            with open(ERRORS_FILE, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    # 格式: ERR-YYYYMMDD-XXX | severity | status | description | count
                    parts = [p.strip() for p in line.split("|")]
                    if len(parts) >= 5 and parts[0].startswith("ERR-"):
                        err_id = parts[0]
                        desc = parts[3]
                        count_str = parts[4].replace("重现", "").replace("次", "").strip()
                        try:
                            count = int(count_str)
                        except ValueError:
                            count = 1
                        # 从描述中提取 task_id
                        if "任务id:" in desc:
                            task_id_part = desc.split("任务id:")[-1].strip().split()[0]
                            key = (task_id_part, desc.split("应该是")[1].split(",")[0].strip() if "应该是" in desc else "", desc.split("用了")[1].split(",")[0].strip() if "用了" in desc else "")
                            existing_errors[key] = {
                                "err_id": err_id,
                                "count": count,
                                "status": parts[2],
                                "line": line
                            }
        except Exception as e:
            print(f"⚠️  读取 ERRORS.md 失败: {e}", file=sys.stderr)
    
    violations = []
    
    for task in tasks:
        status = task.get("status", "")
        if status not in ("running", "dispatched", "done", "failed"):
            continue
        
        # 检查任务时间（spawned_at 或 completed_at）
        ts_str = task.get("spawned_at") or task.get("started_at") or task.get("completed_at", "")
        if ts_str:
            ts = parse_iso(ts_str)
            if ts and ts < cutoff:
                continue  # 超过24小时，跳过
        
        tier = task.get("tier", "")
        label = task.get("label", "")
        actual_model = task.get("model", "")
        
        if not tier or not actual_model:
            continue  # 缺少必要字段，跳过
        
        # 推断 tier（如果任务没有显式 tier，从 label 推断）
        if not tier:
            tier = LABEL_DEFAULT_TIER.get(label, DEFAULT_TIER)
        
        # 模拟 resolve-model.py 的逻辑，计算应该使用的模型
        try:
            result = subprocess.run(
                ["python3", "/workspace/openclaw/skills/octopus/lib/resolve-model.py", "--tier", tier, "--label", label],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0:
                expected_model = result.stdout.strip()
            else:
                print(f"⚠️  resolve-model.py 失败 (tier={tier}, label={label}): {result.stderr[:100]}", file=sys.stderr)
                continue
        except Exception as e:
            print(f"⚠️  resolve-model.py 异常: {e}", file=sys.stderr)
            continue
        
        # 对比实际 model 和预期 model
        if actual_model != expected_model:
            task_id = task.get("id", "unknown")
            violations.append({
                "task_id": task_id,
                "tier": tier,
                "label": label,
                "expected_model": expected_model,
                "actual_model": actual_model,
                "status": status
            })
    
    if not violations:
        print(f"  ✅ 模型违规检测：无违规（检查 {len(tasks)} 条任务）")
        return
    
    # 写入 ERRORS.md
    today_str = now.strftime("%Y%m%d")
    os.makedirs(os.path.dirname(ERRORS_FILE), exist_ok=True)
    
    # 读取现有文件内容
    existing_lines = []
    if os.path.exists(ERRORS_FILE):
        try:
            with open(ERRORS_FILE, "r", encoding="utf-8") as f:
                existing_lines = f.readlines()
        except Exception:
            existing_lines = []
    
    # 写入 ~/self-improving/domains/octopus-errors.md，目录不存在则自动创建
    SELF_IMPROVING_ERRORS = os.path.join(os.path.expanduser("~"), "self-improving/domains/octopus-errors.md")
    today_date = now.strftime("%Y-%m-%d")
    os.makedirs(os.path.dirname(SELF_IMPROVING_ERRORS), exist_ok=True)

    added_count = 0
    updated_count = 0
    new_entries = []
    for v in violations:
        key = (v["task_id"], v["expected_model"], v["actual_model"])
        desc = f"主Agent spawn时未执行resolve-model.py，用了{v['actual_model']}，应该是{v['expected_model']}，任务id: {v['task_id']}"
        if key in existing_errors:
            updated_count += 1
            suffix = "(重现)"
        else:
            added_count += 1
            suffix = ""
        new_entries.append(f"- [{today_date}] 模型违规{suffix}: {desc} → 使用 resolve-model.py 获取模型名\n")

    try:
        with open(SELF_IMPROVING_ERRORS, "a", encoding="utf-8") as f:
            f.writelines(new_entries)
        print(f"  🔍 模型违规检测：发现 {len(violations)} 条违规（新增 {added_count} 条，重现 {updated_count} 条），已写入 octopus-errors.md")
    except Exception as e:
        print(f"⚠️  写入 octopus-errors.md 失败: {e}", file=sys.stderr)


def check_queued_tasks(tasks: list) -> int:
    """
    检查 status=queued 的任务，当所有 deps 均已 done 时，
    通过 openclaw cron add 自动 spawn，并将状态更新为 dispatched。
    返回成功 spawn 的任务数量。
    """
    queued = [t for t in tasks if t.get("status") == "queued"]
    if not queued:
        return 0

    # 建立全量 id→status 索引
    id_to_status = {t["id"]: t["status"] for t in tasks if "id" in t}
    resolved_model_cache: dict[tuple[str, str], str | None] = {}

    spawned_count = 0
    for task in queued:
        task_id = task.get("id", "")
        if is_runner_task(task):
            print(f"  ℹ️  跳过 runner 队列任务 {task_id}：由 runner_queue 处理，不走 openclaw spawn")
            continue
        deps = task.get("deps", [])
        task_desc = task.get("task_description", "").strip()
        label = task.get("label", "octopus-fix")
        model = task.get("model", "lixiang-glm-5/kivy-glm-5")

        if not task_desc:
            summary = task.get("summary", "").strip()
            if summary:
                task_desc = f"[queued兜底] {summary}"
                print(f"  ⚠️  queued 任务 {task_id} 缺少 task_description，用 summary 兜底")
            else:
                print(f"  ⚠️  queued 任务 {task_id} 缺少 task_description 且无 summary，跳过")
                continue

        # 检查所有依赖是否均已 done
        if deps:
            dep_statuses = {dep_id: id_to_status.get(dep_id, "unknown") for dep_id in deps}
            not_done = [dep_id for dep_id, s in dep_statuses.items() if s != "done"]
            if not_done:
                print(f"  ⏸️  queued 任务 {task_id} 等待依赖: {not_done}")
                continue

        # 所有依赖已完成（或无依赖），执行 spawn
        # ── BUG-3 修复：spawn 前重新解析 model，使用 ironclaw 降级保护 ──
        # 从 task 推断 tier（优先 task.tier，再从 label 查表，最后默认 normal）
        tier = task.get("tier", "")
        if not tier:
            tier = LABEL_DEFAULT_TIER.get(label, DEFAULT_TIER)
        cache_key = (tier, label)
        cached_model = resolved_model_cache.get(cache_key, "__missing__")
        if cached_model == "__missing__":
            # 调用 resolve-model.py 获取最新 model（感知全局降级和模型守卫）
            try:
                resolve_result = subprocess.run(
                    ["python3", "/workspace/openclaw/skills/octopus/lib/resolve-model.py", "--tier", tier, "--label", label],
                    capture_output=True, text=True, timeout=5
                )
                if resolve_result.returncode == 0:
                    resolved_model = resolve_result.stdout.strip()
                    if resolved_model:
                        resolved_model_cache[cache_key] = resolved_model
                        model = resolved_model
                        print(f"  🔄 resolved model: {model} (tier={tier})")
                    else:
                        resolved_model_cache[cache_key] = None
                        print(f"  ⚠️  resolve-model.py 返回空，使用原 model: {model}")
                else:
                    resolved_model_cache[cache_key] = None
                    print(f"  ⚠️  resolve-model.py 失败，使用原 model: {model}")
            except Exception as e:
                resolved_model_cache[cache_key] = None
                print(f"  ⚠️  resolve-model.py 异常: {e}，使用原 model: {model}")
        elif cached_model:
            model = cached_model
            print(f"  ♻️  复用 resolved model: {model} (tier={tier})")

        print(f"  🚀 queued 任务 {task_id} 依赖全部完成，正在 spawn...")
        try:
            cron_name = f"queued-{task_id}"[:64]  # cron name 长度限制
            result = subprocess.run(
                [
                    "openclaw", "cron", "add",
                    "--name", cron_name,
                    "--session", "isolated",
                    "--at", "1m",
                    "--model", model,
                    "--announce",
                    "--channel", "last",
                    "--delete-after-run",
                    "--message", task_desc,
                ],
                capture_output=True, text=True, timeout=20
            )
            if result.returncode == 0:
                print(f"  ✅ 已 spawn queued 任务 {task_id} (label={label}, model={model})")
                update_task_status(task_id, "dispatched", {
                    "model": model,  # 同步更新为 resolve-model 实际返回的 model
                    "dispatched_at": datetime.now(timezone.utc).isoformat()
                })
                spawned_count += 1
            else:
                err_msg = result.stderr[:200] if result.stderr else result.stdout[:200]
                print(f"  ❌ spawn queued 任务 {task_id} 失败: {err_msg}", file=sys.stderr)
        except subprocess.TimeoutExpired:
            print(f"  ❌ spawn queued 任务 {task_id} 超时", file=sys.stderr)
        except Exception as e:
            print(f"  ❌ spawn queued 任务 {task_id} 异常: {e}", file=sys.stderr)

    return spawned_count


def check_main_model_drift():
    """检测主 Agent 模型是否因重启而漂移（modelOverride 丢失），自动恢复"""
    import subprocess as sp_inner

    DRIFT_COOLDOWN_FILE = "/tmp/octopus-drift-recovered.json"
    MODE_FILE = "/workspace/tmp/octopus-mode.json"
    POLICY_FILE = "/workspace/tmp/octopus/model-policy.json"
    MODES_NEED_CHECK = {"cost", "quality", "private", "auto"}

    try:
        mode_data = json.load(open(MODE_FILE))
        current_mode = mode_data.get("mode", "balanced")
    except:
        return

    if current_mode not in MODES_NEED_CHECK:
        return

    main_session = resolve_main_session_key()
    if not main_session:
        return

    # 读当前主 session 的 modelOverride
    try:
        sessions = json.load(open(os.path.expanduser("~/.openclaw/agents/main/sessions/sessions.json")))
        current_override = None
        for key, val in sessions.items():
            channel_session_key = key
            if isinstance(val, dict) and val.get("channelSessionKey"):
                channel_session_key = val.get("channelSessionKey")
            if channel_session_key == main_session:
                current_override = val.get("modelOverride")
                break
    except:
        return

    # 期望的模型
    if current_mode in ("cost", "private"):
        expected_model = "lixiang-glm-5/kivy-glm-5"
    elif current_mode == "auto":
        try:
            expected_model = json.load(open(POLICY_FILE)).get("main_model", "")
        except Exception:
            expected_model = ""
        if not expected_model:
            return
    else:  # quality
        expected_model = None
        return

    if current_override == expected_model:
        # 一致，清除 drift 标记
        if os.path.exists(DRIFT_COOLDOWN_FILE):
            os.remove(DRIFT_COOLDOWN_FILE)
        return

    # 不一致，检查冷却
    now = time.time()
    if os.path.exists(DRIFT_COOLDOWN_FILE):
        try:
            d = json.load(open(DRIFT_COOLDOWN_FILE))
            if now - d.get("ts", 0) < 3600 and d.get("mode") == current_mode:
                return  # 1小时内已恢复过，不重复
        except:
            pass

    # 自动恢复
    script = os.path.join(os.path.dirname(__file__), "set-main-model.py")
    result = sp_inner.run(["python3", script, "--mode", current_mode],
                          capture_output=True, text=True, timeout=15)

    # 记录冷却
    with open(DRIFT_COOLDOWN_FILE, "w") as f:
        json.dump({"ts": now, "mode": current_mode, "recovered_model": expected_model}, f)

    model_name = "GLM" if "glm" in expected_model else expected_model
    msg = (
        f"🔄 八爪鱼：主模型已自动恢复\n"
        f"当前模式：{current_mode}\n"
        f"已重新设置主模型为 {model_name}（因重启后 modelOverride 丢失）"
    )
    if send_text(msg):
        print("✅ check_main_model_drift: 文本通知已发送")

    print(f"[drift-check] 主模型漂移已自动恢复：{current_override} → {expected_model}")


def main():
    # 解析命令行参数
    parser = argparse.ArgumentParser(description="八爪鱼巡逻脚本")
    parser.add_argument("--force", action="store_true", 
                        help="强制发送飞书卡片，无论状态是否变化，并展示待确认任务")
    args = parser.parse_args()
    force_mode = args.force
    
    if force_mode:
        print("🐙 八爪鱼巡逻开始（强制模式）...")
    else:
        print("🐙 八爪鱼巡逻开始...")
    runner_health = check_runner_health()
    if runner_health.get("present"):
        if runner_health.get("healthy"):
            print(
                f"  🏃 Runner 心跳正常：{runner_health.get('health', {}).get('worker_id', '')} "
                f"({runner_health.get('age_seconds', 0)}s)"
            )
        else:
            age_seconds = runner_health.get("age_seconds", "?")
            print(f"  ⚠️  Runner 心跳异常：{runner_health.get('reason')} age={age_seconds}s")
            restarted = maybe_restart_runner()
            if restarted:
                print("  🔄 已触发 runner-daemon 自动重启")
            if _text_notify_enabled():
                health = runner_health.get("health", {})
                worker_id = health.get("worker_id", "unknown-runner")
                job_id = health.get("job_id", "")
                msg = f"⚠️ 八爪鱼 Runner 心跳异常\nworker={worker_id}\nage={age_seconds}s"
                if restarted:
                    msg += "\n已尝试自动重启 runner-daemon"
                if job_id:
                    msg += f"\njob={job_id}"
                send_text(msg)
    else:
        print("  ℹ️  Runner 未启动或无心跳文件")
    tasks = load_tasks()

    if not tasks:
        print("✅ task-state.json 为空或不存在，无需巡逻")
        return

    # ── v1.3: 先补充 session 观测字段，让后续判断不只依赖 task-state 本身 ──
    tasks = annotate_tasks_with_session_state(tasks)

    # ── v1.4: 对仍然活着但有异常迹象的任务，先尝试 steer，再决定是否重派 ──
    steered = attempt_task_steers(tasks)
    if steered > 0:
        print(f"  🧭 本轮已 steer 任务 {steered} 个")
        tasks = load_tasks()
        tasks = annotate_tasks_with_session_state(tasks)

    # ── 超时检测：先于分类，自动终止超时任务 ──
    killed_tasks = check_and_kill_timed_out_tasks(tasks)
    if killed_tasks:
        print(f"⏱️  本轮终止超时任务 {len(killed_tasks)} 个：{[t.get('id') for t in killed_tasks]}")
        # 重新加载任务（kill+标记 failed 后状态已更新）
        tasks = load_tasks()

    # ── 排队任务检测：依赖全部 done → 自动 spawn ──
    spawned = check_queued_tasks(tasks)
    if spawned > 0:
        print(f"  🚀 本轮自动 spawn 排队任务 {spawned} 个，重新加载状态")
        tasks = load_tasks()
    
    # ── 模型违规检测：检查近期任务的 model 是否符合预期 ──
    check_model_violation(tasks)
    
    # ── 模型名静态检查：检测写死模型路径的违规行为 ──
    check_model_violations()

    # ── 主模型漂移检测：重启后 modelOverride 丢失自动恢复 ──
    check_main_model_drift()

    running, queued, pending_confirm, deferred, stuck = classify_tasks(tasks)
    recent_done = get_recent_done_tasks(tasks, force=force_mode)

    # ── 孤儿任务检测：running 但无活跃 session ──
    active_sessions = get_active_subagent_sessions()
    orphans = check_orphan_tasks(tasks, active_sessions)
    if orphans:
        print(f"🔴 检测到 {len(orphans)} 个孤儿任务（running 但无活跃 session）：")
        for o in orphans:
            t = o.get("task", {})
            print(f"  - {t.get('id', '未知')} ({t.get('label', '')}) 已运行 {o.get('elapsed_min', 0)}min")
        # 将孤儿任务加入 stuck 列表（如果不在的话）
        orphan_ids = {o.get("task", {}).get("id") for o in orphans}
        for t in orphans:
            task = t.get("task", {})
            task_id = task.get("id", "")
            task_label = task.get("label", "")
            if task_id not in {s.get("id") for s in stuck}:
                # 先检查 transcript 是否有成功 RESULT → 自动标 done，不报警
                if check_result_success(task_id, task_label, task.get("spawned_at") or task.get("started_at")):
                    print(f"  ✅ 孤儿任务 {task_id} transcript 含成功RESULT，自动标记 done（不报警）")
                    task["_auto_done"] = True  # 标记已自动完成，防止GLM升级循环重复处理
                    try:
                        _state_data = load_task_state(TASK_STATE_FILE)
                        for _t in _state_data.get("tasks", []):
                            if _t.get("id") == task_id:
                                _t["status"] = "done"
                                _t["completed_at"] = datetime.now(timezone.utc).isoformat()
                                if not _t.get("summary"):
                                    _t["summary"] = "孤儿任务自动标记：transcript含成功RESULT"
                                break
                        save_task_state(TASK_STATE_FILE, _state_data)
                    except Exception as _e:
                        print(f"  ⚠️  自动标done异常: {_e}", file=sys.stderr)
                    continue  # 不加入 stuck
                task["_stuck_reason"] = "孤儿任务：session 已结束但 task 仍为 running"
                task["_orphan"] = True
                stuck.append(task)

    # ── GLM 孤儿任务自动升级 Sonnet 重派 ──
    # 若孤儿任务原模型含 "glm"，且未曾升级过（无 _glm_upgraded 标记），自动升级到 Sonnet
    # 记录自动重派成功的任务 ID，后续 send_dm_alert 时排除（成功重派静默）
    _auto_redispatched_ids = set()
    # 过滤掉已被 check_result_success 自动标为 done 的任务，避免双重派遣
    already_done_ids = {o.get("task", {}).get("id") for o in orphans if o.get("task", {}).get("_auto_done")}
    glm_orphans_to_upgrade = []
    for o in orphans:
        task = o.get("task", {})
        task_model = task.get("model", "")
        task_id = task.get("id", "")
        task_desc = task.get("task_description", "").strip()
        already_upgraded = task.get("_glm_upgraded", False)
        if task_id in already_done_ids:
            continue  # 已自动标done，跳过GLM升级
        if "glm" in task_model.lower() and not already_upgraded and task_id:
            glm_orphans_to_upgrade.append(task)
    if glm_orphans_to_upgrade:
        print(f"🔼 检测到 {len(glm_orphans_to_upgrade)} 个 GLM 孤儿任务，自动升级 Sonnet 重派：")
        # 解析 Sonnet 模型路径
        try:
            _resolve_result = subprocess.run(
                ["python3", "/workspace/openclaw/skills/octopus/lib/resolve-model.py", "--tier", "hard"],
                capture_output=True, text=True, timeout=5
            )
            _sonnet_model = _resolve_result.stdout.strip() if _resolve_result.returncode == 0 and _resolve_result.stdout.strip() else "vendor-claude-sonnet-4-6/aws-claude-sonnet-4-6"
        except Exception:
            _sonnet_model = "vendor-claude-sonnet-4-6/aws-claude-sonnet-4-6"
        print(f"  🤖 升级目标模型: {_sonnet_model}")
        for task in glm_orphans_to_upgrade:
            task_id = task.get("id", "")
            task_desc = task.get("task_description", "").strip()
            label = task.get("label", "octopus-fix")
            if not task_desc:
                summary = task.get("summary", "").strip()
                task_desc = f"[GLM升级重派兜底] {summary}" if summary else ""
            if not task_desc:
                # 无 task_description 的孤儿任务：静默标记 failed + 写 ERRORS.md，不发飞书通知
                # 常见原因：task 描述太长导致 session 启动即失败，或 session 未正确写入描述
                print(f"  ⚠️  GLM孤儿任务 {task_id} 无 task_description，静默标记 failed（不通知用户）")
                try:
                    _state_data = load_task_state(TASK_STATE_FILE)
                    for _t in _state_data.get("tasks", []):
                        if _t.get("id") == task_id:
                            _t["status"] = "failed"
                            _t["summary"] = "孤儿任务：无task_description，可能因task描述过长导致session启动即失败，静默标记"
                            _t["notified_failed"] = True  # 标记已处理，不再告警
                            _t["completed_at"] = datetime.now(timezone.utc).isoformat()
                            break
                    save_task_state(TASK_STATE_FILE, _state_data)
                    # 写 ERRORS.md 静默记录
                    _errors_md = "/workspace/.learnings/ERRORS.md"
                    _err_line = f"\n| ERR-{datetime.now().strftime('%Y%m%d')}-ORPHAN | low | open | 重现1次 | 孤儿任务{task_id}无task_description，session启动即失败，可能task描述过长 |"
                    try:
                        with open(_errors_md, "a") as _ef:
                            _ef.write(_err_line + "\n")
                    except:
                        pass
                except Exception as _e:
                    print(f"  ⚠️  标记failed异常: {_e}", file=sys.stderr)
                continue
            # 在 task 描述开头加升级说明
            upgrade_prefix = "上次 GLM 因 token 超限截断，本次升级 Sonnet，必须分段读文件每步立即写结果\n\n"
            new_task_desc = upgrade_prefix + task_desc
            # 更新 task-state.json：状态改为 dispatched，标记已升级
            try:
                _state_data = load_task_state(TASK_STATE_FILE)
                for _t in _state_data.get("tasks", []):
                    if _t.get("id") == task_id:
                        _t["status"] = "dispatched"
                        _t["model"] = _sonnet_model
                        _t["_glm_upgraded"] = True
                        _t["_upgrade_from"] = task.get("model", "")
                        _t["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                        _t["task_description"] = new_task_desc
                        break
                save_task_state(TASK_STATE_FILE, _state_data)
            except Exception as _e:
                print(f"  ⚠️  更新升级状态异常: {_e}", file=sys.stderr)
            # 重派
            try:
                cron_name = f"glm-upgrade-{task_id}"[:64]
                _spawn_result = subprocess.run(
                    [
                        "openclaw", "cron", "add",
                        "--name", cron_name,
                        "--session", "isolated",
                        "--at", "1m",
                        "--model", _sonnet_model,
                        "--announce",
                        "--channel", "last",
                        "--delete-after-run",
                        "--message", new_task_desc,
                    ],
                    capture_output=True, text=True, timeout=20
                )
                if _spawn_result.returncode == 0:
                    print(f"  ✅ GLM孤儿任务 {task_id} 已升级 Sonnet 重派（model={_sonnet_model}），静默不告警")
                    _auto_redispatched_ids.add(task_id)
                else:
                    print(f"  ⚠️  GLM孤儿任务 {task_id} 重派失败: {_spawn_result.stderr[:100]}", file=sys.stderr)
            except Exception as _e:
                print(f"  ⚠️  GLM孤儿任务 {task_id} 重派异常: {_e}", file=sys.stderr)

    # ── 新失败任务检测：对 failed 任务发飞书通知 ──
    # 使用 task-state.json 中的 notified_failed 字段，而非外部文件
    failed_tasks = [t for t in tasks if t.get("status") == "failed"]
    notify_now = now_utc()
    new_failed = [t for t in failed_tasks if should_retry_failed_notification(t, notify_now)]
    if new_failed:
        print(f"❌ 检测到 {len(new_failed)} 个新失败任务，发送通知")
        for t in new_failed:
            task_id = t.get("id", "未知")
            summary = t.get("summary", "无摘要")[:80]
            msg = f"❌ 任务 {task_id} 失败：{summary}\n如需重派请回复'重派 {task_id}'"
            try:
                if send_text(msg):
                    print(f"  ✅ 已发送失败通知: {task_id}")
                    record_failed_notification_attempt(task_id, success=True)
                else:
                    print(f"  ⚠️ 发送失败通知失败: {task_id}", file=sys.stderr)
                    record_failed_notification_attempt(task_id, success=False)
            except Exception as e:
                print(f"  ⚠️ 发送失败通知异常: {e}", file=sys.stderr)
                record_failed_notification_attempt(task_id, success=False)

    total_active = len(running) + len(queued) + len(pending_confirm) + len(deferred) + len(stuck)
    print(f"  📋 扫描 {len(tasks)} 条任务：运行中={len(running)} 排队={len(queued)} 待确认={len(pending_confirm)} 待定={len(deferred)} 卡死={len(stuck)} 近期完成={len(recent_done)}")

    # ── 状态变化检测（v4：只要有变化就发面板，无变化静默）──────────────────
    # 快照字段：running_ids + queued_count + failed_count + stuck_count
    # 有变化（新完成/新失败/新超时/新排队/running数量变化）→ 发飞书面板
    # 无变化 → 静默退出，不发任何通知
    _PATROL_STATE_FILE = "/workspace/tmp/octopus/patrol-last-state.json"
    import time as _time_mod

    current_running_ids = sorted([t.get("id", "") for t in running])
    current_queued_count = len(queued)
    current_failed_count = len([t for t in tasks if t.get("status") == "failed"])
    current_stuck_count = len(stuck)
    current_state = {
        "running_ids": current_running_ids,
        "queued_count": current_queued_count,
        "failed_count": current_failed_count,
        "stuck_count": current_stuck_count,
        "ts": int(_time_mod.time()),
    }

    _state_changed = True
    _prev_stuck_count = 0  # 上一轮 stuck 数量，用于判断是否需要强制发新卡片
    try:
        with open(_PATROL_STATE_FILE, "r", encoding="utf-8") as _f:
            _last_state = json.load(_f)
        _last_running_ids = _last_state.get("running_ids", [])
        _last_queued = _last_state.get("queued_count", 0)
        _last_failed = _last_state.get("failed_count", 0)
        _last_stuck = _last_state.get("stuck_count", 0)
        _prev_stuck_count = _last_stuck
        if (
            current_running_ids == _last_running_ids
            and current_queued_count == _last_queued
            and current_failed_count <= _last_failed
            and current_stuck_count <= _last_stuck
        ):
            _state_changed = False
    except (FileNotFoundError, json.JSONDecodeError):
        _state_changed = True  # 首次或文件损坏，视为有变化

    # 保存当前快照（无论是否发面板）
    try:
        with open(_PATROL_STATE_FILE, "w", encoding="utf-8") as _f:
            json.dump(current_state, _f)
    except Exception as _e:
        print(f"  ⚠️ 保存巡逻状态快照失败: {_e}")

    # 触发条件（v4：状态变化检测，--force 模式跳过检测）：
    # ✅ 状态无变化 → 静默，不发任何消息
    # 🔴/🟡 有任何变化（running变化/新排队/新完成/新失败/新卡死）→ 发面板
    # 🚀 --force 模式 → 跳过状态变化检测，始终发面板
    # 注意：近期完成任务由主 Agent 子任务汇报，不重复通知
    
    # --force 模式：跳过状态变化检测，直接发面板
    if force_mode:
        print(f"  🚀 强制模式：跳过状态变化检测，直接发送面板")
        # 不保存快照，不比较状态
    elif not _state_changed:
        print(f"✅ 状态无变化（running_ids/queued/failed/stuck 均未变），静默退出")
        check_model_aliases()
        return

    if not force_mode:
        if stuck:
            print(f"  🔴 检测到 {len(stuck)} 个卡死/超时任务，触发告警面板（状态有变化）")
        elif running or queued or pending_confirm:
            _existing = load_patrol_card_state()
            if pending_confirm:
                print(f"  🟡 有待确认任务，触发面板（待确认={len(pending_confirm)}）")
            elif _existing:
                print(f"  🔵 任务运行中，原地更新已有面板（运行中={len(running)} 排队={len(queued)}）")
            else:
                # 无已有卡片且只是普通运行中，静默
                print(f"  🔵 任务运行中但无已有面板，静默跳过")
                check_model_aliases()
                check_main_model_drift()
                return
        else:
            print(f"✅ 状态有变化但无活跃任务，静默退出")
            check_model_aliases()
            return
    current_done_ids = _recent_done_new_entries.copy()

    # 模型健康检测（每轮巡逻均执行）
    check_model_aliases()

    # 构建并发送任务面板卡片（force_mode 控制是否展示待确认任务）
    # 获取已有卡片状态（用于传递 sent_at 计算有效期）
    _pre_existing_state = load_patrol_card_state()
    _sent_at_for_card = _pre_existing_state.get("sent_at", 0) if _pre_existing_state else 0
    card = build_panel_card(running, queued, pending_confirm, deferred, stuck, recent_done, force_mode=force_mode, sent_at=_sent_at_for_card)

    # ── 「发一次，持续更新」双卡片模式 ──
    # 卡片 A（置顶常驻卡）：始终只有一张，原地 update；超25天自动 recall 旧卡 + 发新卡
    # 卡片 B（事件通知卡）：任务完成/失败/卡死时额外 send 一张精简卡，不 update，不保存 state
    # --force 模式：update 卡 A + 额外 send 一条卡 A 内容到最新位置（不更新 state 中 message_id）
    all_done = not running and not queued and not pending_confirm and not deferred and not stuck
    _stuck_increased = current_stuck_count > _prev_stuck_count

    # 检查是否因25天过期而返回 None（需要撤回旧卡 + 发 DM 提示）
    _card_expired_25d = False
    if _stuck_increased:
        clear_patrol_card_state()
        existing_state = None
        print(f"  🔴 新增卡死告警（{_prev_stuck_count} → {current_stuck_count}），清除旧卡片状态，强制发新卡片")
    else:
        existing_state = load_patrol_card_state()
        # 判断是否刚过期（之前有 state 但现在返回 None）
        # 可能原因：24小时过期（正常轮换）或 25天飞书卡片寿命到期（自动撤回刷新）
        if existing_state is None and _pre_existing_state is not None:
            sent_at_age_h = (time.time() - _pre_existing_state.get("sent_at", 0)) / 3600
            if sent_at_age_h > 25 * 24:
                _card_expired_25d = True
                print(f"  📅 检测到卡片已超过25天（{sent_at_age_h:.1f}h），将撤回旧卡 + 发新卡 + 提示重新置顶")
            else:
                print(f"  📅 检测到卡片已超过24小时（{sent_at_age_h:.1f}h），将发新卡")

    # 25天过期：撤回旧卡 A
    if _card_expired_25d and _pre_existing_state:
        old_mid = _pre_existing_state.get("message_id", "")
        if old_mid:
            recall_card_a(old_mid)  # 撤回失败静默降级，不中断流程

    # 标记是否因过期发新卡（用于后续发 DM 提示）
    _sent_new_card_for_expire = False

    try:
        if force_mode:
            # ── force 模式（八爪鱼面板）──
            # 1. update 卡 A（置顶卡原地刷新）
            # 2. 额外 send 一条卡 A 内容的新消息到最新位置（让用户在消息流里看到）
            #    注意：这条额外发送的不是置顶卡，不更新 state 里的 message_id
            existing_state_for_force = _pre_existing_state
            if existing_state_for_force and existing_state_for_force.get("message_id"):
                existing_mid = existing_state_for_force["message_id"]
                ok = update_panel_card(existing_mid, card)
                if ok:
                    message_id = existing_mid
                    print(f"✅ 卡片 A 已更新（force模式）: {message_id}")
                    save_patrol_card_state(message_id)  # 保留 sent_at 不变
                else:
                    # update 失败，发新卡 A（顶替旧卡）
                    message_id = send_panel_card(card)
                    print(f"✅ 卡片 A 已发新（force模式，旧卡失效）: {message_id}")
                    save_patrol_card_state(message_id)
            else:
                # 无旧卡 A，直接发新
                message_id = send_panel_card(card)
                print(f"✅ 卡片 A 已发新（force模式，无旧卡）: {message_id}")
                save_patrol_card_state(message_id)
            # 额外发一条卡 A 内容到最新位置（消息流可见，不更新 state 的 message_id）
            try:
                _extra_mid = send_panel_card(card)
                print(f"📢 卡片 A 内容已额外推送到消息流（force模式）: {_extra_mid}")
            except Exception as _extra_e:
                print(f"⚠️  额外推送失败（不影响卡 A）: {_extra_e}", file=sys.stderr)
        elif existing_state:
            # 有 existing card A → 原地 update
            existing_mid = existing_state["message_id"]
            ok = update_panel_card(existing_mid, card)
            if ok:
                print(f"✅ 卡片 A 已原地更新: {existing_mid}")
                message_id = existing_mid
                # 任务全部完成 → 把卡片更新为空闲状态（固定面板）
                if all_done:
                    idle_card = build_idle_card(recent_done=get_recent_done_tasks(all_tasks))
                    update_ok = update_panel_card(existing_mid, idle_card)
                    if update_ok:
                        print(f"  🏁 所有任务完成，卡片 A 已更新为空闲状态")
                    else:
                        clear_patrol_card_state()
                        print(f"  🏁 更新空闲卡片失败，清除 state")
            else:
                # update 失败，降级为 send 新卡 A
                print(f"⚠️  更新卡片 A 失败，降级为发新卡", file=sys.stderr)
                clear_patrol_card_state()
                message_id = send_panel_card(card)
                print(f"✅ 卡片 A 已发新（降级）: {message_id}")
                if not all_done:
                    save_patrol_card_state(message_id)
        else:
            # 无 existing state → 发新卡 A
            message_id = send_panel_card(card)
            if _card_expired_25d:
                print(f"✅ 卡片 A 已发新（25天过期刷新）: {message_id}")
                _sent_new_card_for_expire = True
            else:
                print(f"✅ 卡片 A 已发新: {message_id}")
            save_patrol_card_state(message_id, force_new=_card_expired_25d)

        # ── 卡片 B（事件通知卡）──
        # 仅在任务完成/失败/卡死时发送精简通知卡，不 update，不保存 state
        # 排除已自动重派成功的任务（成功重派静默）
        # ── 卡片 B · 卡死事件 ──
        stuck_need_alert = [t for t in stuck if t.get("id", "") not in _auto_redispatched_ids]
        if stuck_need_alert:
            send_dm_alert(stuck_need_alert)
            # 为每个卡死任务发精简事件卡 B
            for _stuck_task in stuck_need_alert[:3]:  # 最多3张，避免刷屏
                send_event_card_b("stuck", _stuck_task)
        
        # ── 过期发新卡 DM 提示 ──
        if _sent_new_card_for_expire:
            send_expire_dm_alert()

        # ── 状态变化 DM 通知 ──
        try:
            notify_state = load_notify_state()
            old_states = notify_state.get("task_ids", {})
            new_states = {t.get("id", ""): t.get("status", "") for t in tasks if t.get("id")}
            changes = []
            for tid, new_status in new_states.items():
                old_status = old_states.get(tid)
                if old_status == new_status:
                    continue
                # 跳过内部查询任务（不发通知）
                if any(tid.startswith(p) for p in INTERNAL_ID_PREFIXES):
                    continue
                task = next((t for t in tasks if t.get("id") == tid), {})
                if task.get("label", "") in SYSTEM_LABELS:
                    continue
                label_name = get_label_name(task.get("label", ""))
                summary = (task.get("summary") or tid)[:40]
                # 状态变化规则
                if new_status in ("running", "dispatched") and old_status not in ("running", "dispatched"):
                    # 包含首次 spawn（old_status is None）和状态从非运行变为运行
                    changes.append(f"🟡 {label_name} 开始：{summary}")
                elif new_status == "done" and old_status in ("running", "dispatched"):
                    changes.append(f"✅ {label_name} 完成：{summary}")
                    # ── 卡片 B：任务完成事件通知 ──
                    send_event_card_b("done", task)
                elif new_status == "failed" and old_status in ("running", "dispatched"):
                    # notified_failed=True 表示已通过独立失败通知发送过，跳过重发（无论是否 force 模式）
                    if not task.get("notified_failed"):
                        changes.append(f"❌ {label_name} 失败：{summary}")
                        # ── 卡片 B：任务失败事件通知 ──
                        send_event_card_b("failed", task)
            if changes:
                msg = "\n".join(changes)
                # 引用面板卡片消息
                card_state = load_patrol_card_state()
                panel_msg_id = card_state.get("message_id") if card_state else None
                send_state_change_dm(msg, reply_to_message_id=panel_msg_id)
            save_notify_state({"task_ids": new_states, "updated_at": datetime.now().isoformat()})
        except Exception as e:
            print(f"⚠️  状态变化通知异常: {e}", file=sys.stderr)

        # ── 预算追踪：同步已完成任务成本 + 超限告警 ──
        try:
            budget_script = os.path.join(os.path.dirname(__file__), "budget.py")
            if os.path.exists(budget_script):
                import importlib.util as _iutil
                _spec = _iutil.spec_from_file_location("budget", budget_script)
                _budget = _iutil.module_from_spec(_spec)
                _spec.loader.exec_module(_budget)
                _synced = _budget.sync_from_task_state()
                if _synced > 0:
                    print(f"💰 预算追踪：已同步 {_synced} 条任务成本", file=sys.stderr)
                _bcode, _bmsg = _budget.check_budget()
                if _bcode == 1:
                    print(f"⚠️  {_bmsg}", file=sys.stderr)
                    # 发送 DM 预算警告（每日最多提醒一次）
                    _alert_flag = "/tmp/octopus-budget-warn-today.flag"
                    _today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                    _flag_content = ""
                    try:
                        with open(_alert_flag, "r") as _ff:
                            _flag_content = _ff.read().strip()
                    except FileNotFoundError:
                        pass
                    if _flag_content != _today_str:
                        send_state_change_dm(f"💰 八爪鱼预算警告\n{_bmsg}", reply_to_message_id=None)
                        with open(_alert_flag, "w") as _ff:
                            _ff.write(_today_str)
                elif _bcode == 2:
                    print(f"🚨 {_bmsg}", file=sys.stderr)
                    send_state_change_dm(f"🚨 八爪鱼预算超限！\n{_bmsg}\n请检查任务调度策略。", reply_to_message_id=None)
        except Exception as _be:
            print(f"⚠️  预算追踪异常（不影响巡逻）: {_be}", file=sys.stderr)

        # ── 输出结构化卡死任务信息（供主 Agent 解析并自动重派）──
        import json as _json_out
        stuck_summary = []
        for t in stuck:
            spawned_at_str = t.get("spawned_at") or t.get("started_at") or ""
            elapsed_min = 0
            if spawned_at_str:
                t_spawned = parse_iso(spawned_at_str)
                if t_spawned:
                    elapsed_min = int((datetime.now(timezone.utc) - t_spawned).total_seconds() / 60)
            stuck_summary.append({
                "id": t.get("id", ""),
                "label": t.get("label", ""),
                "model": t.get("model", ""),
                "tier": t.get("tier", "normal"),
                "reason": t.get("_stuck_reason", "超时无响应"),
                "elapsed": f"{elapsed_min}min"
            })
        print(f"STUCK_TASKS: {_json_out.dumps(stuck_summary, ensure_ascii=False)}")

        # 发送成功后保存本次展示的 done ids（force 模式不写，保持幂等）
        if recent_done and current_done_ids and not force_mode:
            # 合并到现有字典后写入（追加语义，带24小时淘汰）
            existing = load_last_done_ids()
            existing.update(current_done_ids)
            save_last_done_ids(existing)
        # 增加 pending_confirm 任务的 panel_shown_count
        if pending_confirm:
            _increment_panel_shown_count(pending_confirm)
        # 更新 deferred 任务的上报计数（达到3次自动expired）
        if deferred:
            _update_deferred_report_count(deferred)
    except Exception as e:
        print(f"❌ 发送飞书卡片失败: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
