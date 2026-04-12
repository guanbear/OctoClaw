#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB_DIR="$SKILL_ROOT/lib"

# shellcheck source=/dev/null
source "$LIB_DIR/workspace.sh"
WORKSPACE="$(resolve_octoclaw_workspace "$LIB_DIR")"
PYTHON_BIN="$(resolve_octoclaw_python)"
RUNTIME_OBSERVER_PY="$LIB_DIR/runtime_observer.py"

if [ -f "$LIB_DIR/config.sh" ]; then
    # shellcheck source=/dev/null
    source "$LIB_DIR/config.sh"
fi

PATROL_MODE="${PATROL_MODE:-loop}"
PATROL_INTERVAL="${PATROL_INTERVAL:-60}"
SUPERVISOR_MODE="${SUPERVISOR_MODE:-auto}"
TMUX_SESSION_NAME="${TMUX_SESSION_NAME:-octoclaw-runtime}"
TMUX_RUNNER_WINDOW_NAME="${TMUX_RUNNER_WINDOW_NAME:-runner}"
TMUX_PATROL_WINDOW_NAME="${TMUX_PATROL_WINDOW_NAME:-patrol}"
RUNNER_POLL_INTERVAL_SECONDS="${RUNNER_POLL_INTERVAL_SECONDS:-3}"
RUNNER_HEARTBEAT_INTERVAL_SECONDS="${RUNNER_HEARTBEAT_INTERVAL_SECONDS:-10}"
RUNNER_DEFAULT_TIMEOUT_SECONDS="${RUNNER_DEFAULT_TIMEOUT_SECONDS:-120}"
RUNNER_MAX_AGE_MINUTES="${RUNNER_MAX_AGE_MINUTES:-120}"
RUNNER_MAX_IDLE_SECONDS="${RUNNER_MAX_IDLE_SECONDS:-900}"
RUNNER_MAX_JOBS_PER_WORKER="${RUNNER_MAX_JOBS_PER_WORKER:-30}"
RUNNER_MODE="${RUNNER_MODE:-}"
if [ -z "$RUNNER_MODE" ]; then
    RUNNER_MODE="$("$PYTHON_BIN" -c "import sys; sys.path.insert(0, '$LIB_DIR'); from octopus_config import resolve_runner_mode; print(resolve_runner_mode())")"
fi
case "$RUNNER_MODE" in
    on_demand)
        RUNNER_MODE="ondemand"
        ;;
    daemon|ondemand)
        ;;
    *)
        RUNNER_MODE="ondemand"
        ;;
esac

OPENCLAW_SERVICE="${OPENCLAW_SERVICE:-openclaw.service}"
RUNNER_SERVICE="${RUNNER_SERVICE:-octoclaw-runner.service}"

PATROL_PKG="$LIB_DIR/patrol"
RUNNER_QUEUE_PY="$LIB_DIR/runner_queue.py"
STATUS_SH="$LIB_DIR/status.sh"
RUNNER_HEALTH_FILE="$WORKSPACE/tmp/octopus/runner-health.json"
RUNNER_PID_FILE="$WORKSPACE/tmp/octopus/runner-daemon.pid"

print_usage() {
    cat <<'EOF'
OctoClaw Runtime Control (single macmini deployment)

Recommended commands:
  status              render compact operator status view
  observe-once        print runtime observer snapshot (read-only)
  reconcile-once      single reconcile pass (detect + bounded recovery)
  repair-once         single repair pass (detect + recovery + force)
  runner-status       print runner queue/health details

Gateway control:
  up openclaw          start OpenClaw gateway
  down openclaw        stop OpenClaw gateway
  restart openclaw     restart OpenClaw gateway

Runner pool:
  up runner           start runner pool
  down runner         stop runner pool
  restart runner      restart runner pool
  runner-status       print runner pool status

Recommended runtime path:
  Gateway (always on) → Node runtime extension → native task/runner pool
  Use observe-once / reconcile-once / repair-once for on-demand diagnostics.
  No patrol loop or runner daemon is needed for normal operation.

Runtime env:
  RUNNER_MODE=ondemand  on-demand runner (default, recommended)
  RUNNER_MODE=daemon    resident runner mode (opt-in acceleration)
EOF
}

systemd_available() {
    command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

tmux_available() {
    command -v tmux >/dev/null 2>&1
}

resolve_supervisor_mode() {
    case "$SUPERVISOR_MODE" in
        systemd|tmux|shell)
            printf '%s\n' "$SUPERVISOR_MODE"
            return 0
            ;;
    esac
    if [ "$PATROL_MODE" = "loop" ] && systemd_available; then
        printf '%s\n' "systemd"
        return 0
    fi
    printf '%s\n' "shell"
}

pid_is_running() {
    local pid="$1"
    [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1
}

read_pid_file() {
    local path="$1"
    if [ -f "$path" ]; then
        cat "$path" 2>/dev/null || true
    fi
}

tmux_session_exists() {
    tmux has-session -t "$TMUX_SESSION_NAME" 2>/dev/null
}

tmux_window_exists() {
    local window_name="$1"
    tmux_session_exists && tmux list-windows -t "$TMUX_SESSION_NAME" -F '#W' 2>/dev/null | grep -Fxq "$window_name"
}

tmux_shell_quote() {
    printf "%q" "$1"
}

build_tmux_runner_command() {
    printf 'cd %s && export WORKSPACE=%s RUNNER_POLL_INTERVAL_SECONDS=%s RUNNER_HEARTBEAT_INTERVAL_SECONDS=%s RUNNER_DEFAULT_TIMEOUT_SECONDS=%s RUNNER_MAX_AGE_MINUTES=%s RUNNER_MAX_IDLE_SECONDS=%s RUNNER_MAX_JOBS_PER_WORKER=%s && exec %s runner_loop' \
        "$(tmux_shell_quote "$SKILL_ROOT")" \
        "$(tmux_shell_quote "$WORKSPACE")" \
        "$(tmux_shell_quote "$RUNNER_POLL_INTERVAL_SECONDS")" \
        "$(tmux_shell_quote "$RUNNER_HEARTBEAT_INTERVAL_SECONDS")" \
        "$(tmux_shell_quote "$RUNNER_DEFAULT_TIMEOUT_SECONDS")" \
        "$(tmux_shell_quote "$RUNNER_MAX_AGE_MINUTES")" \
        "$(tmux_shell_quote "$RUNNER_MAX_IDLE_SECONDS")" \
        "$(tmux_shell_quote "$RUNNER_MAX_JOBS_PER_WORKER")" \
        "$(tmux_shell_quote "$PYTHON_BIN")"
}

tmux_start_window() {
    local window_name="$1"
    local command="$2"
    if ! tmux_available; then
        echo "tmux unavailable"
        return 1
    fi
    if tmux_session_exists; then
        if tmux_window_exists "$window_name"; then
            tmux respawn-window -k -t "${TMUX_SESSION_NAME}:${window_name}" "$command"
        else
            tmux new-window -d -t "$TMUX_SESSION_NAME" -n "$window_name" "$command"
        fi
        return 0
    fi
    tmux new-session -d -s "$TMUX_SESSION_NAME" -n "$window_name" "$command"
}

tmux_stop_window() {
    local window_name="$1"
    if tmux_window_exists "$window_name"; then
        tmux kill-window -t "${TMUX_SESSION_NAME}:${window_name}" >/dev/null 2>&1 || true
    fi
}

background_spawn() {
    if command -v setsid >/dev/null 2>&1; then
        setsid "$@" >/dev/null 2>&1 &
        return 0
    fi
    nohup "$@" >/dev/null 2>&1 &
}

service_state() {
    local service_name="$1"
    if systemd_available; then
        systemctl is-active "$service_name" 2>/dev/null || echo "inactive"
        return 0
    fi
    echo "unmanaged"
}

start_openclaw_service() {
    if systemd_available; then
        systemctl start "$OPENCLAW_SERVICE"
    elif command -v openclaw >/dev/null 2>&1; then
        openclaw gateway start 2>&1 || echo "⚠️  openclaw gateway start failed"
    else
        echo "❌ no systemd and no openclaw CLI; cannot start gateway"
    fi
}

stop_openclaw_service() {
    if systemd_available; then
        systemctl stop "$OPENCLAW_SERVICE" >/dev/null 2>&1 || true
    elif command -v openclaw >/dev/null 2>&1; then
        openclaw gateway stop 2>&1 || echo "⚠️  openclaw gateway stop failed"
    else
        echo "❌ no systemd and no openclaw CLI; cannot stop gateway"
    fi
}

restart_openclaw_service() {
    if systemd_available; then
        systemctl restart "$OPENCLAW_SERVICE"
    elif command -v openclaw >/dev/null 2>&1; then
        openclaw gateway restart 2>&1 || echo "⚠️  openclaw gateway restart failed"
    else
        echo "❌ no systemd and no openclaw CLI; cannot restart gateway"
    fi
}

start_runner_runtime() {
    if [ "$RUNNER_MODE" = "ondemand" ]; then
        rm -f "$RUNNER_PID_FILE" "$RUNNER_HEALTH_FILE"
        return 0
    fi
    local mode
    mode="$(resolve_supervisor_mode)"
    mkdir -p "$WORKSPACE/tmp/octopus"
    case "$mode" in
        systemd)
            systemctl start "$RUNNER_SERVICE"
            ;;
        tmux)
            tmux_start_window "$TMUX_RUNNER_WINDOW_NAME" "$(build_tmux_runner_command)"
            ;;
        *)
            local pid
            pid="$(read_pid_file "$RUNNER_PID_FILE")"
            if pid_is_running "$pid"; then
                return 0
            fi
            rm -f "$RUNNER_PID_FILE" "$RUNNER_HEALTH_FILE"
            background_spawn env \
                WORKSPACE="$WORKSPACE" \
                RUNNER_POLL_INTERVAL_SECONDS="$RUNNER_POLL_INTERVAL_SECONDS" \
                RUNNER_HEARTBEAT_INTERVAL_SECONDS="$RUNNER_HEARTBEAT_INTERVAL_SECONDS" \
                RUNNER_DEFAULT_TIMEOUT_SECONDS="$RUNNER_DEFAULT_TIMEOUT_SECONDS" \
                RUNNER_MAX_AGE_MINUTES="$RUNNER_MAX_AGE_MINUTES" \
                RUNNER_MAX_IDLE_SECONDS="$RUNNER_MAX_IDLE_SECONDS" \
                RUNNER_MAX_JOBS_PER_WORKER="$RUNNER_MAX_JOBS_PER_WORKER" \
                "$PYTHON_BIN" -m runner_queue runner_loop
            ;;
    esac
}

stop_runner_runtime() {
    if [ "$RUNNER_MODE" = "ondemand" ]; then
        rm -f "$RUNNER_PID_FILE" "$RUNNER_HEALTH_FILE"
        return 0
    fi
    local mode
    mode="$(resolve_supervisor_mode)"
    case "$mode" in
        systemd)
            systemctl stop "$RUNNER_SERVICE" >/dev/null 2>&1 || true
            rm -f "$RUNNER_PID_FILE" "$RUNNER_HEALTH_FILE"
            ;;
        tmux)
            tmux_stop_window "$TMUX_RUNNER_WINDOW_NAME"
            rm -f "$RUNNER_PID_FILE" "$RUNNER_HEALTH_FILE"
            ;;
        *)
            local pid
            pid="$(read_pid_file "$RUNNER_PID_FILE")"
            if pid_is_running "$pid"; then
                kill "$pid" >/dev/null 2>&1 || true
            fi
            rm -f "$RUNNER_PID_FILE" "$RUNNER_HEALTH_FILE"
            ;;
    esac
}

restart_runner_runtime() {
    stop_runner_runtime
    start_runner_runtime
}

run_patrol_once() {
    export WORKSPACE
    "$PYTHON_BIN" -m patrol "$@"
}

run_reconcile_once() {
    run_patrol_once reconcile-once
}

run_repair_once() {
    run_patrol_once repair-once
}

run_runner_status() {
    export WORKSPACE
    "$PYTHON_BIN" "$RUNTIME_OBSERVER_PY" --workspace "$WORKSPACE" --format runner
}

run_observer_once() {
    export WORKSPACE
    "$PYTHON_BIN" "$RUNTIME_OBSERVER_PY" --workspace "$WORKSPACE" --format text
}

print_process_snapshot() {
    local mode
    mode="$(resolve_supervisor_mode)"
    echo "supervisor_mode=$mode"
    echo "workspace=$WORKSPACE"
    echo "runner_mode=$RUNNER_MODE"
    echo "patrol_default_mode=ondemand_reconcile_only"
    echo "openclaw_service=$(service_state "$OPENCLAW_SERVICE")"
    if [ "$RUNNER_MODE" = "ondemand" ]; then
        echo "runner_service=ondemand"
        echo "runner_pid="
        echo "runner_running=ondemand"
    elif [ "$mode" = "systemd" ]; then
        echo "runner_service=$(service_state "$RUNNER_SERVICE")"
    elif [ "$mode" = "tmux" ]; then
        if tmux_available && tmux_session_exists; then
            echo "tmux_session=$TMUX_SESSION_NAME"
            echo "runner_window=$([ "$(tmux_window_exists "$TMUX_RUNNER_WINDOW_NAME"; echo $?)" -eq 0 ] && echo present || echo missing)"
        else
            echo "tmux_session=missing"
            echo "runner_window=missing"
        fi
    else
        local runner_pid
        runner_pid="$(read_pid_file "$RUNNER_PID_FILE")"
        echo "runner_pid=${runner_pid:-}"
        echo "runner_running=$([ -n "$runner_pid" ] && pid_is_running "$runner_pid" && echo true || echo false)"
    fi
    echo "legacy_patrol_loop=removed"
    echo "runner_health_file=$RUNNER_HEALTH_FILE"
    echo "runner_health_present=$([ -f "$RUNNER_HEALTH_FILE" ] && echo true || echo false)"
}

run_status() {
    export WORKSPACE
    bash "$STATUS_SH" --format compact
    echo "━━━━━━━━━━━━━━━━━━━━"
    print_process_snapshot
}

run_action() {
    local action="$1"
    local target="$2"
    case "$target" in
        all)
            run_action "$action" openclaw
            run_action "$action" runtime
            ;;
        runtime)
            run_action "$action" runner
            ;;
        openclaw)
            case "$action" in
                up) start_openclaw_service ;;
                down) stop_openclaw_service ;;
                restart|reload) restart_openclaw_service ;;
            esac
            ;;
        runner)
            case "$action" in
                up) start_runner_runtime ;;
                down) stop_runner_runtime ;;
                restart|reload) restart_runner_runtime ;;
            esac
            ;;
        patrol|patrol-loop)
            echo "ERROR: patrol loop is no longer supported." >&2
            echo "Use: octoclawctl observe-once | reconcile-once | repair-once" >&2
            exit 1
            ;;
        *)
            echo "unknown target: $target" >&2
            exit 1
            ;;
    esac
}

COMMAND="${1:-status}"
TARGET="${2:-all}"

case "$COMMAND" in
    status)
        run_status
        ;;
    ps)
        print_process_snapshot
        run_runner_status
        ;;
    up|down|restart|reload)
        run_action "$COMMAND" "$TARGET"
        run_status
        ;;
    reconcile-once)
        run_reconcile_once
        ;;
    repair-once)
        run_repair_once
        ;;
    patrol-once)
        echo "patrol-once removed; use reconcile-once or repair-once." >&2
        exit 1
        ;;
    observe-once)
        run_observer_once
        ;;
    runner-status|runner-pool-status)
        run_runner_status
        ;;
    -h|--help|help)
        print_usage
        ;;
    *)
        echo "unknown command: $COMMAND" >&2
        print_usage >&2
        exit 1
        ;;
esac
