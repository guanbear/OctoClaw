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

# ── 模型延迟探测 cron ─────────────────────────────────────────────────────────
# 默认关闭：铁甲虾（IronClaw）已提供模型探测能力，octopus-probe cron 默认不启用
# 若未安装铁甲虾且希望八爪鱼自动探测模型延迟，可将此开关改为 true 后重新运行 install.sh
FEATURE_MODEL_PROBE=false
