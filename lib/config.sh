#!/bin/bash
# 八爪鱼 (Octopus) 功能开关配置
# 修改此文件后需重新 source 或重新安装才能生效

# ── 巡逻模式 ──────────────────────────────────────────────────────────────────
# loop: 零 token，常驻 bash 进程直接执行 patrol.py（默认，推荐）
#        启动后与 openclaw 无关，patrol.py 直接调飞书 API 发通知
# cron: openclaw cron，每次触发启动 Claude 隔离会话，消耗 ~500-1000 token/次
PATROL_MODE="${PATROL_MODE:-loop}"

# 巡逻间隔（秒），仅 loop 模式生效；cron 模式间隔在注册时固定为 1min
PATROL_INTERVAL="${PATROL_INTERVAL:-60}"

# ── 通知后端 ──────────────────────────────────────────────────────────────────
# auto: 自动探测（当前优先 Feishu DM，有则启用；否则 none）
# feishu: 使用飞书卡片/文本通知
# none: 关闭主动通知，仅保留本地状态文件
NOTIFICATION_BACKEND="${NOTIFICATION_BACKEND:-auto}"
NOTIFICATION_PANEL_ENABLED="${NOTIFICATION_PANEL_ENABLED:-true}"
NOTIFICATION_EVENT_ENABLED="${NOTIFICATION_EVENT_ENABLED:-true}"
NOTIFICATION_TEXT_ENABLED="${NOTIFICATION_TEXT_ENABLED:-true}"

# ── 主会话定位 ────────────────────────────────────────────────────────────────
# auto: 自动选择当前主会话
# feishu/discord/telegram/slack: 按 channel 前缀匹配
MAIN_SESSION_CHANNEL="${MAIN_SESSION_CHANNEL:-auto}"
MAIN_SESSION_TARGET="${MAIN_SESSION_TARGET:-}"

# ── 自动选模 ──────────────────────────────────────────────────────────────────
MODEL_AUTO_ENABLED="${MODEL_AUTO_ENABLED:-true}"
MODEL_AUTO_PREFER_PRIVATE="${MODEL_AUTO_PREFER_PRIVATE:-false}"
MODEL_AUTO_PREFER_LOW_COST="${MODEL_AUTO_PREFER_LOW_COST:-false}"

# ── 模型延迟探测 cron ─────────────────────────────────────────────────────────
# 默认关闭：铁甲虾（IronClaw）已提供模型探测能力，octopus-probe cron 默认不启用
# 若未安装铁甲虾且希望八爪鱼自动探测模型延迟，可将此开关改为 true 后重新运行 install.sh
FEATURE_MODEL_PROBE=false

# ── 常驻 Runner（飞鱼腿）──────────────────────────────────────────────────────
RUNNER_ENABLED="${RUNNER_ENABLED:-true}"
RUNNER_POLL_INTERVAL_SECONDS="${RUNNER_POLL_INTERVAL_SECONDS:-3}"
RUNNER_HEARTBEAT_INTERVAL_SECONDS="${RUNNER_HEARTBEAT_INTERVAL_SECONDS:-10}"
RUNNER_DEFAULT_TIMEOUT_SECONDS="${RUNNER_DEFAULT_TIMEOUT_SECONDS:-120}"
RUNNER_MAX_AGE_MINUTES="${RUNNER_MAX_AGE_MINUTES:-120}"
RUNNER_MAX_JOBS_PER_WORKER="${RUNNER_MAX_JOBS_PER_WORKER:-50}"
