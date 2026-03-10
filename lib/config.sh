#!/bin/bash
# 八爪鱼 (Octopus) 功能开关配置
# 修改此文件后需重新 source 或重新安装才能生效

# ── 模型延迟探测 cron ─────────────────────────────────────────────────────────
# 默认关闭：铁甲虾（IronClaw）已提供模型探测能力，octopus-probe cron 默认不启用
# 若未安装铁甲虾且希望八爪鱼自动探测模型延迟，可将此开关改为 true 后重新运行 install.sh
FEATURE_MODEL_PROBE=false
