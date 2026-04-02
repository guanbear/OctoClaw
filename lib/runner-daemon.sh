#!/bin/bash
# runner-daemon.sh — 常驻飞鱼腿管理器
# 启动: setsid bash runner-daemon.sh &
# 停止: kill $(cat /workspace/tmp/octopus/runner-daemon.pid)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/workspace.sh"
WORKSPACE="$(resolve_octoclaw_workspace "$SCRIPT_DIR")"
RUNNER_SCRIPT="$SCRIPT_DIR/runner_loop.sh"
PID_FILE="$WORKSPACE/tmp/octopus/runner-daemon.pid"
LOG_FILE="$WORKSPACE/tmp/octopus/runner.log"
RESTART_DELAY="${RUNNER_RESTART_DELAY_SECONDS:-3}"
HEALTH_FILE="$WORKSPACE/tmp/octopus/runner-health.json"

mkdir -p "$WORKSPACE/tmp/octopus"

cleanup() {
    rm -f "$PID_FILE"
}

trap cleanup EXIT INT TERM

if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] runner-daemon 已在运行 (PID=$OLD_PID)，退出" >> "$LOG_FILE"
        exit 0
    fi
    rm -f "$PID_FILE"
fi

echo $$ > "$PID_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] runner-daemon 启动 (PID=$$)" >> "$LOG_FILE"

while true; do
    START=$(date +%s)
    set +e
    WORKSPACE="$WORKSPACE" bash "$RUNNER_SCRIPT" >> "$LOG_FILE" 2>&1
    EXIT_CODE=$?
    set -e
    END=$(date +%s)
    ELAPSED=$((END - START))
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] runner_loop 退出 code=$EXIT_CODE elapsed=${ELAPSED}s" >> "$LOG_FILE"
    if [[ $EXIT_CODE -ne 0 ]]; then
        rm -f "$HEALTH_FILE"
    fi
    sleep "$RESTART_DELAY"
done
