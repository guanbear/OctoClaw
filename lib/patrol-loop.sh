#!/bin/bash
# DEPRECATED (2026-04-12, R9): patrol-loop.sh is legacy compat.
# Patrol is now on-demand via `octoclawctl.sh restart patrol` or `patrol --force`.
# This script will be removed in a future release. Do not add new dependencies.
# patrol-loop.sh — legacy wrapper
# 默认架构下 patrol 不再常驻；如需继续使用旧 loop，必须显式设置
# OCTOCLAW_ENABLE_LEGACY_LOOPS=1。

if [[ "${OCTOCLAW_ENABLE_LEGACY_LOOPS:-}" != "1" ]]; then
    echo "patrol-loop.sh is legacy-only. Use bin/octoclawctl.sh reconcile-once or repair-once instead."
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/workspace.sh"
WORKSPACE="$(resolve_octoclaw_workspace "$SCRIPT_DIR")"
PYTHON_BIN="$(resolve_octoclaw_python)"
PATROL_SCRIPT="$SCRIPT_DIR/patrol.py"
LOG_FILE="$WORKSPACE/tmp/octopus/patrol.log"
PID_FILE="$WORKSPACE/tmp/octopus/patrol-loop.pid"
INTERVAL=${PATROL_INTERVAL:-60}  # 默认 60 秒，由 config.sh 的 PATROL_INTERVAL 控制

mkdir -p "$WORKSPACE/tmp/octopus"

cleanup() {
    rm -f "$PID_FILE"
}

trap cleanup EXIT INT TERM

# 防止重复启动
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] patrol-loop 已在运行 (PID=$OLD_PID)，退出" >> "$LOG_FILE"
        exit 0
    fi
    rm -f "$PID_FILE"
fi

echo $$ > "$PID_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] patrol-loop 启动 (PID=$$)，间隔 ${INTERVAL}s" >> "$LOG_FILE"

while true; do
    START=$(date +%s)
    "$PYTHON_BIN" "$PATROL_SCRIPT" >> "$LOG_FILE" 2>&1
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
