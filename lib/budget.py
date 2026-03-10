#!/usr/bin/env python3
"""
budget.py — 八爪鱼成本追踪模块（NadirClaw 启发）

功能:
  1. 累计当日/当月任务成本估算（基于 model + tier）
  2. 支持可配置的日/月预算上限
  3. 超过阈值时返回警告/超限状态
  4. 可被 patrol.py 调用，也可独立运行

用法:
  python3 budget.py status          # 显示当前预算状态（JSON）
  python3 budget.py check           # 检查预算 (exit 0=正常, 1=警告, 2=超限)
  python3 budget.py record --task-id xxx --model yyy --tier zzz [--tokens N]
  python3 budget.py reset           # 重置当日预算记录（测试用）
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

# ── 路径常量 ────────────────────────────────────────────────────────────────
TASK_STATE_FILE = "/workspace/tmp/octopus/task-state.json"
BUDGET_LOG_FILE = "/workspace/tmp/octopus-budget.json"
BUDGET_CONFIG_FILE = "/workspace/tmp/octopus-budget-config.json"

# ── 模型定价（每百万 token，美元）──────────────────────────────────────────
# 格式: {短名关键字: (input_per_1m, output_per_1m)}
_MODEL_PRICING: dict[str, tuple[float, float]] = {
    "glm":     (0.10,  0.30),   # GLM-5 估算
    "kimi":    (0.15,  0.45),   # Kimi K2 估算
    "sonnet":  (3.00, 15.00),   # Claude Sonnet 3.5/4.6
    "opus":    (15.0, 75.00),   # Claude Opus 4.x
    "haiku":   (0.25,  1.25),   # Claude Haiku 3.5
    "gpt4o":   (5.00, 15.00),   # GPT-4o
    "default": (3.00, 15.00),   # 未知模型 fallback → 按 Sonnet 计
}

# ── 每个 tier 的 token 估算（input + output，单位 tokens）──────────────────
_TIER_TOKENS: dict[str, int] = {
    "trivial": 800,
    "simple":  2000,
    "normal":  5000,
    "hard":    10000,
    "deep":    20000,
}

# ── 默认预算配置 ──────────────────────────────────────────────────────────
_DEFAULT_CONFIG = {
    "daily_limit_usd": 5.0,       # 日预算上限（美元）
    "monthly_limit_usd": 50.0,    # 月预算上限（美元）
    "warn_threshold": 0.80,       # 警告阈值（占上限百分比）
    "enabled": True,
}


def _load_json(path: str) -> dict | list | None:
    """安全读取 JSON 文件，不存在或解析失败返回 None。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _save_json(path: str, data: dict | list) -> bool:
    """安全写入 JSON 文件，返回是否成功。"""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp_path = path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, path)
        return True
    except OSError as e:
        print(f"WARNING: budget.py 写入失败 {path}: {e}", file=sys.stderr)
        return False


def _get_config() -> dict:
    """读取预算配置，不存在则返回默认值。"""
    cfg = _load_json(BUDGET_CONFIG_FILE)
    if isinstance(cfg, dict):
        merged = dict(_DEFAULT_CONFIG)
        merged.update(cfg)
        return merged
    return dict(_DEFAULT_CONFIG)


def _get_model_short_name(model_path: str) -> str:
    """从完整模型路径中提取短名关键字，用于查定价。"""
    lower = model_path.lower()
    for key in ("opus", "sonnet", "haiku", "glm", "kimi", "gpt4o"):
        if key in lower:
            return key
    return "default"


def estimate_cost(model: str, tier: str, tokens: int | None = None) -> float:
    """
    估算单次任务成本（美元）。
    如果提供了 tokens，使用实际 tokens；否则按 tier 估算。
    假设 input:output = 3:1。
    """
    short = _get_model_short_name(model)
    price_in, price_out = _MODEL_PRICING.get(short, _MODEL_PRICING["default"])

    total_tokens = tokens if tokens and tokens > 0 else _TIER_TOKENS.get(tier, 5000)
    # 估算 input 占 75%，output 占 25%
    input_tokens = total_tokens * 0.75
    output_tokens = total_tokens * 0.25

    cost = (input_tokens * price_in + output_tokens * price_out) / 1_000_000
    return round(cost, 6)


def _load_budget_log() -> dict:
    """读取预算日志，返回结构化对象。"""
    log = _load_json(BUDGET_LOG_FILE)
    if not isinstance(log, dict):
        log = {}
    if "daily" not in log or not isinstance(log["daily"], dict):
        log["daily"] = {}
    if "monthly" not in log or not isinstance(log["monthly"], dict):
        log["monthly"] = {}
    if "tasks" not in log or not isinstance(log["tasks"], list):
        log["tasks"] = []
    return log


def record_task(task_id: str, model: str, tier: str, tokens: int | None = None) -> float:
    """
    记录一次已完成任务的成本。
    返回本次估算成本（美元）。
    避免重复记录同一 task_id。
    """
    log = _load_budget_log()

    # 防止重复记录
    existing_ids = {t.get("id") for t in log["tasks"]}
    if task_id in existing_ids:
        return 0.0

    cost = estimate_cost(model, tier, tokens)
    now = datetime.now(timezone.utc)
    day_key = now.strftime("%Y-%m-%d")
    month_key = now.strftime("%Y-%m")

    log["daily"][day_key] = round(log["daily"].get(day_key, 0.0) + cost, 6)
    log["monthly"][month_key] = round(log["monthly"].get(month_key, 0.0) + cost, 6)
    log["tasks"].append({
        "id": task_id,
        "model": model,
        "tier": tier,
        "tokens": tokens,
        "cost_usd": cost,
        "recorded_at": now.isoformat(),
    })

    # 只保留最近 500 条任务记录，防止文件膨胀
    if len(log["tasks"]) > 500:
        log["tasks"] = log["tasks"][-500:]

    _save_json(BUDGET_LOG_FILE, log)
    return cost


def get_status() -> dict:
    """
    返回当前预算状态字典。
    包含：today_usd, month_usd, daily_limit, monthly_limit,
          daily_pct, monthly_pct, alert_level (ok/warn/over)
    """
    cfg = _get_config()
    log = _load_budget_log()
    now = datetime.now(timezone.utc)
    day_key = now.strftime("%Y-%m-%d")
    month_key = now.strftime("%Y-%m")

    today_usd = log["daily"].get(day_key, 0.0)
    month_usd = log["monthly"].get(month_key, 0.0)
    daily_limit = cfg["daily_limit_usd"]
    monthly_limit = cfg["monthly_limit_usd"]
    warn_pct = cfg["warn_threshold"]

    daily_pct = today_usd / daily_limit if daily_limit > 0 else 0.0
    monthly_pct = month_usd / monthly_limit if monthly_limit > 0 else 0.0
    max_pct = max(daily_pct, monthly_pct)

    if not cfg.get("enabled", True):
        alert_level = "disabled"
    elif max_pct >= 1.0:
        alert_level = "over"
    elif max_pct >= warn_pct:
        alert_level = "warn"
    else:
        alert_level = "ok"

    return {
        "today_usd": round(today_usd, 4),
        "month_usd": round(month_usd, 4),
        "daily_limit_usd": daily_limit,
        "monthly_limit_usd": monthly_limit,
        "daily_pct": round(daily_pct * 100, 1),
        "monthly_pct": round(monthly_pct * 100, 1),
        "alert_level": alert_level,
        "warn_threshold_pct": round(warn_pct * 100, 1),
        "enabled": cfg.get("enabled", True),
    }


def check_budget() -> tuple[int, str]:
    """
    检查预算状态，返回 (exit_code, message)。
    exit_code: 0=正常, 1=警告, 2=超限, 3=已禁用
    """
    status = get_status()
    level = status["alert_level"]
    today = status["today_usd"]
    dlimit = status["daily_limit_usd"]
    month = status["month_usd"]
    mlimit = status["monthly_limit_usd"]

    if level == "disabled":
        return 3, "预算追踪已禁用"
    elif level == "over":
        return 2, (
            f"⚠️ 预算超限！今日: ${today:.3f}/${dlimit} ({status['daily_pct']}%), "
            f"本月: ${month:.3f}/${mlimit} ({status['monthly_pct']}%)"
        )
    elif level == "warn":
        return 1, (
            f"💰 预算警告！今日: ${today:.3f}/${dlimit} ({status['daily_pct']}%), "
            f"本月: ${month:.3f}/${mlimit} ({status['monthly_pct']}%)"
        )
    else:
        return 0, (
            f"✅ 预算正常：今日 ${today:.3f}/${dlimit} ({status['daily_pct']}%), "
            f"本月 ${month:.3f}/${mlimit} ({status['monthly_pct']}%)"
        )


def sync_from_task_state() -> int:
    """
    从 task-state.json 批量同步已完成任务的成本记录。
    返回新增记录数。
    """
    task_data = _load_json(TASK_STATE_FILE)
    if not task_data:
        return 0

    # task-state.json 可能是 dict（单任务）或 dict-of-dicts（多任务keyed by id）
    tasks: list[dict] = []
    if isinstance(task_data, dict):
        # 判断是单任务还是多任务字典
        if "id" in task_data:
            # 单任务
            tasks = [task_data]
        else:
            # 多任务字典（keyed by task_id）
            tasks = list(task_data.values())
    elif isinstance(task_data, list):
        tasks = task_data

    count = 0
    for task in tasks:
        if not isinstance(task, dict):
            continue
        status = task.get("status", "")
        if status not in ("done", "failed"):
            continue  # 只记录已完成任务
        task_id = task.get("id", "")
        model = task.get("model", "unknown")
        tier = task.get("tier", "normal")
        if not task_id or not model:
            continue
        cost = record_task(task_id, model, tier)
        if cost > 0:
            count += 1

    return count


def main():
    parser = argparse.ArgumentParser(description="八爪鱼成本追踪模块")
    subparsers = parser.add_subparsers(dest="cmd")

    subparsers.add_parser("status", help="显示当前预算状态")
    subparsers.add_parser("check", help="检查预算（exit 0=正常, 1=警告, 2=超限）")
    subparsers.add_parser("sync", help="从 task-state.json 同步任务成本")
    subparsers.add_parser("reset", help="重置当日预算记录（测试用）")

    rec_parser = subparsers.add_parser("record", help="记录单次任务成本")
    rec_parser.add_argument("--task-id", required=True, help="任务ID")
    rec_parser.add_argument("--model", required=True, help="模型路径")
    rec_parser.add_argument("--tier", default="normal",
                            choices=["trivial", "simple", "normal", "hard", "deep"])
    rec_parser.add_argument("--tokens", type=int, default=0, help="实际 token 数（可选）")

    args = parser.parse_args()

    if args.cmd == "status":
        status = get_status()
        print(json.dumps(status, ensure_ascii=False, indent=2))

    elif args.cmd == "check":
        code, msg = check_budget()
        print(msg)
        sys.exit(code)

    elif args.cmd == "sync":
        n = sync_from_task_state()
        print(f"✅ 已同步 {n} 条新任务成本记录")

    elif args.cmd == "record":
        tokens = args.tokens if args.tokens > 0 else None
        cost = record_task(args.task_id, args.model, args.tier, tokens)
        if cost > 0:
            print(f"✅ 已记录 task={args.task_id} cost=${cost:.6f}")
        else:
            print(f"ℹ️  task={args.task_id} 已存在，跳过重复记录")

    elif args.cmd == "reset":
        log = _load_budget_log()
        now = datetime.now(timezone.utc)
        day_key = now.strftime("%Y-%m-%d")
        if day_key in log["daily"]:
            del log["daily"][day_key]
        _save_json(BUDGET_LOG_FILE, log)
        print(f"✅ 已重置 {day_key} 的预算记录")

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
