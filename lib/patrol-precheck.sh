#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/workspace.sh"
WORKSPACE="$(resolve_octoclaw_workspace "$SCRIPT_DIR")"
STATE_FILE="$WORKSPACE/tmp/octopus/task-state.json"
if [ ! -f "$STATE_FILE" ]; then
  echo "PATROL_SKIP: no state file"
  exit 0
fi
# 检查是否有 running 或 queued 任务
ACTIVE=$(jq '[.tasks[] | select(.status == "running" or .status == "queued")] | length' "$STATE_FILE" 2>/dev/null || echo "0")
# 检查是否有超时任务（expected_done 已过期且 status=running）
NOW=$(date +%s)
OVERDUE=$(jq --argjson now "$NOW" '[.tasks[] | select(.status == "running" and .expected_done_at != null and (.expected_done_at | gsub("[^0-9]"; "") | tonumber? // 0) < $now)] | length' "$STATE_FILE" 2>/dev/null || echo "0")
if [ "$ACTIVE" -eq 0 ] && [ "$OVERDUE" -eq 0 ]; then
  echo "PATROL_SKIP: no active tasks"
  exit 0
fi
echo "PATROL_NEEDED: active=$ACTIVE overdue=$OVERDUE"

# 检查模型缓存是否过期（超过 30 分钟则清除，下次 spawn 时重建）
CACHE_FILE="/tmp/octopus-model-cache.json"
if [ -f "$CACHE_FILE" ]; then
  CACHE_AGE=$(( NOW - $(jq '.generated_at' "$CACHE_FILE" 2>/dev/null || echo 0) ))
  if [ "$CACHE_AGE" -gt 1800 ]; then
    rm -f "$CACHE_FILE"
  fi
fi

exit 1
