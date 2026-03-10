#!/bin/bash
# patrol-loop.sh — 八爪鱼巡逻后台循环（零 token 开销）
# 替代 openclaw cron 的 AI session 模式，直接执行 Python 脚本
# 正常状态: 0 token | 异常状态: patrol.py 直接调飞书 API
#
# 启动: PATROL_INTERVAL=60 setsid bash patrol-loop.sh &
# 停止: kill $(cat /workspace/tmp/octopus/patrol-loop.pid)
# 间隔: 通过 PATROL_INTERVAL 环境变量控制（默认 60 秒）

PATROL_SCRIPT="/workspace/openclaw/skills/octopus/lib/patrol.py"
LOG_FILE="/workspace/tmp/octopus/patrol.log"
PID_FILE="/workspace/tmp/octopus/patrol-loop.pid"
INTERVAL=${PATROL_INTERVAL:-60}  # 默认 60 秒，由 config.sh 的 PATROL_INTERVAL 控制

mkdir -p /workspace/tmp/octopus

# 防止重复启动
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] patrol-loop 已在运行 (PID=$OLD_PID)，退出" >> "$LOG_FILE"
        exit 0
    fi
fi

echo $$ > "$PID_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] patrol-loop 启动 (PID=$$)，间隔 ${INTERVAL}s" >> "$LOG_FILE"

while true; do
    START=$(date +%s)
    python3 "$PATROL_SCRIPT" >> "$LOG_FILE" 2>&1
    EXIT_CODE=$?
    END=$(date +%s)
    ELAPSED=$((END - START))

    if [ $EXIT_CODE -ne 0 ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️  patrol.py 退出码 $EXIT_CODE，耗时 ${ELAPSED}s" >> "$LOG_FILE"
    fi

    # 下次运行前等待（剩余时间）
    WAIT=$((INTERVAL - ELAPSED))
    if [ $WAIT -lt 10 ]; then
        WAIT=10
    fi
    sleep $WAIT
done
