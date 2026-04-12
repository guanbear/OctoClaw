#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
WORKSPACE="${WORKSPACE:-${HOME}/.openclaw/workspace}"
CONFIG_FILE="${OCTOCLAW_CONFIG_FILE:-${WORKSPACE}/tmp/octoclaw-config.json}"
EVENTS_PATH="${REPLAY_EVENTS_PATH:-${WORKSPACE}/tmp/octopus/runtime-policy-replay.jsonl}"
EXTRA_ARGS=()

usage() {
    cat <<'EOF'
Usage:
  bin/replay-automation.sh enable [options]
  bin/replay-automation.sh disable [options]
  bin/replay-automation.sh show [options]
  bin/replay-automation.sh run [options]
  bin/replay-automation.sh render-cron [options]

Options:
  --config PATH
  --events PATH
  --output-dir PATH
  --format text|json
  --enabled BOOL
  --schedule-hour-local N
  --summary-enabled BOOL
  --review-enabled BOOL
  --curate-enabled BOOL
  --llm-review-enabled BOOL
  --llm-review-max-cases N
  --force
EOF
}

COMMAND="${1:-}"
if [ -z "$COMMAND" ]; then
    usage
    exit 1
fi
shift

while [ $# -gt 0 ]; do
    case "$1" in
        --config)
            CONFIG_FILE="$2"
            shift 2
            ;;
        --events)
            EVENTS_PATH="$2"
            shift 2
            ;;
        --output-dir|--format|--enabled|--schedule-hour-local|--summary-enabled|--review-enabled|--curate-enabled|--llm-review-enabled|--llm-review-max-cases)
            EXTRA_ARGS+=("$1" "$2")
            shift 2
            ;;
        --force)
            EXTRA_ARGS+=("$1")
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            printf 'Unknown option: %s\n' "$1" >&2
            usage
            exit 1
            ;;
    esac
done

case "$COMMAND" in
    enable)
        exec "$PYTHON_BIN" "${REPO_ROOT}/lib/replay_automation.py" merge-config --config "$CONFIG_FILE" --enabled true "${EXTRA_ARGS[@]}"
        ;;
    disable)
        exec "$PYTHON_BIN" "${REPO_ROOT}/lib/replay_automation.py" merge-config --config "$CONFIG_FILE" --enabled false "${EXTRA_ARGS[@]}"
        ;;
    show)
        exec "$PYTHON_BIN" "${REPO_ROOT}/lib/replay_automation.py" show-config --config "$CONFIG_FILE"
        ;;
    run)
        exec "$PYTHON_BIN" "${REPO_ROOT}/lib/replay_automation.py" run --config "$CONFIG_FILE" --events "$EVENTS_PATH" "${EXTRA_ARGS[@]}"
        ;;
    render-cron)
        exec "$PYTHON_BIN" "${REPO_ROOT}/lib/replay_automation.py" render-cron --config "$CONFIG_FILE" --events "$EVENTS_PATH"
        ;;
    *)
        printf 'Unknown command: %s\n' "$COMMAND" >&2
        usage
        exit 1
        ;;
esac
