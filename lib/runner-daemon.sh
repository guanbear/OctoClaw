#!/bin/bash
# DEPRECATED (2026-04-12, R9): runner-daemon.sh is legacy compat.
# Runner uses on-demand bootstrap or runner_loop.sh. This daemon wrapper
# will be removed in a future release. Do not add new dependencies.
# runner-daemon.sh — legacy wrapper
# 默认架构下 runner 常驻只作为显式 opt-in 加速层；如需继续使用旧 daemon，
# 必须显式设置 OCTOCLAW_ENABLE_LEGACY_LOOPS=1。

if [[ "${OCTOCLAW_ENABLE_LEGACY_LOOPS:-}" != "1" ]]; then
    echo "runner-daemon.sh is legacy-only. Use the gateway-managed runner pool or on-demand runner mode instead."
    exit 0
fi

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/workspace.sh"
WORKSPACE="$(resolve_octoclaw_workspace "$SCRIPT_DIR")"
PYTHON_BIN="$(resolve_octoclaw_python)"
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
    WORKSPACE="$WORKSPACE" OCTOCLAW_PYTHON_BIN="$PYTHON_BIN" bash "$RUNNER_SCRIPT" >> "$LOG_FILE" 2>&1
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
