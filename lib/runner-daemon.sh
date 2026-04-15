#!/bin/bash
# runner-daemon.sh — ensure the resident runner loop is alive inside tmux.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/workspace.sh"

WORKSPACE="$(resolve_octoclaw_workspace "$SCRIPT_DIR")"
TMUX_BIN="${TMUX_BIN:-$(command -v tmux || true)}"
SESSION_NAME="${TMUX_SESSION_NAME:-octoclaw-runtime}"
RUNNER_WINDOW="${TMUX_RUNNER_WINDOW_NAME:-runner}"
LOG_DIR="${WORKSPACE}/tmp/octopus"
LOG_FILE="${LOG_DIR}/runner-daemon.log"
RUNNER_WORKER_ID="${RUNNER_WORKER_ID:-runner-daemon}"
PYTHON_BIN="${OCTOCLAW_PYTHON_BIN:-$(resolve_octoclaw_python)}"

if [[ -z "$TMUX_BIN" ]]; then
  echo "tmux unavailable" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"

runner_cmd=$(
  cat <<EOF
cd "$WORKSPACE" && export WORKSPACE="$WORKSPACE" OCTOCLAW_WORKSPACE="$WORKSPACE" OCTOCLAW_ENABLE_LEGACY_LOOPS=1 OCTOCLAW_PYTHON_BIN="$PYTHON_BIN" RUNNER_WORKER_ID="$RUNNER_WORKER_ID" RUNNER_POLL_INTERVAL_SECONDS="${RUNNER_POLL_INTERVAL_SECONDS:-1}" RUNNER_HEARTBEAT_INTERVAL_SECONDS="${RUNNER_HEARTBEAT_INTERVAL_SECONDS:-5}" RUNNER_MAX_IDLE_SECONDS=0 RUNNER_MAX_JOBS_PER_WORKER=1000000 RUNNER_DEFAULT_TIMEOUT_SECONDS="${RUNNER_DEFAULT_TIMEOUT_SECONDS:-120}" && exec bash "$SCRIPT_DIR/runner_loop.sh" >> "$LOG_FILE" 2>&1
EOF
)

ensure_session() {
  if ! "$TMUX_BIN" has-session -t "$SESSION_NAME" 2>/dev/null; then
    "$TMUX_BIN" new-session -d -s "$SESSION_NAME" -n "$RUNNER_WINDOW" "$runner_cmd"
    "$TMUX_BIN" select-pane -t "${SESSION_NAME}:${RUNNER_WINDOW}" -T "octoclaw-runner-daemon" >/dev/null 2>&1 || true
  fi
}

ensure_window() {
  if ! "$TMUX_BIN" list-windows -t "$SESSION_NAME" -F "#{window_name}" 2>/dev/null | grep -Fxq "$RUNNER_WINDOW"; then
    "$TMUX_BIN" new-window -d -t "$SESSION_NAME" -n "$RUNNER_WINDOW" "$runner_cmd"
    "$TMUX_BIN" select-pane -t "${SESSION_NAME}:${RUNNER_WINDOW}" -T "octoclaw-runner-daemon" >/dev/null 2>&1 || true
  fi
}

ensure_session
ensure_window
"$TMUX_BIN" set-option -t "$SESSION_NAME" remain-on-exit on >/dev/null 2>&1 || true
"$TMUX_BIN" set-option -t "$SESSION_NAME" allow-rename off >/dev/null 2>&1 || true

pane_dead="$("$TMUX_BIN" list-panes -t "${SESSION_NAME}:${RUNNER_WINDOW}" -F "#{pane_dead}" 2>/dev/null | head -n 1 || true)"
pane_cmd="$("$TMUX_BIN" list-panes -t "${SESSION_NAME}:${RUNNER_WINDOW}" -F "#{pane_current_command}" 2>/dev/null | head -n 1 || true)"

if [[ "$pane_dead" == "1" || -z "$pane_cmd" || "$pane_cmd" == "sleep" ]]; then
  "$TMUX_BIN" respawn-pane -k -t "${SESSION_NAME}:${RUNNER_WINDOW}" "$runner_cmd"
  "$TMUX_BIN" select-pane -t "${SESSION_NAME}:${RUNNER_WINDOW}" -T "octoclaw-runner-daemon" >/dev/null 2>&1 || true
  echo "started"
  exit 0
fi

echo "already_running"
