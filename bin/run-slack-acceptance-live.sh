#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PYTHON_BIN="${OCTOCLAW_PYTHON_BIN:-python3}"

ACCEPTANCE_ROOT="${OCTOCLAW_ACCEPTANCE_ROOT:-$HOME/.octoclaw-acceptance}"
ACCEPTANCE_HOME="${OCTOCLAW_ACCEPTANCE_HOME:-$ACCEPTANCE_ROOT/home}"
ACCEPTANCE_WORKSPACE="${OCTOCLAW_ACCEPTANCE_WORKSPACE:-$ACCEPTANCE_ROOT/workspace}"
SOURCE_OPENCLAW_HOME="${OCTOCLAW_SOURCE_OPENCLAW_HOME:-${OPENCLAW_HOME:-$HOME/.openclaw}}"
BLACKBOX_PRESET="${OCTOCLAW_ACCEPTANCE_PRESET:-acceptance}"
SESSION_KEY="${OCTOCLAW_ACCEPTANCE_SESSION_KEY:-}"
TARGET="${OCTOCLAW_ACCEPTANCE_TARGET:-}"
NATIVE_CHANNEL_ID="${OCTOCLAW_ACCEPTANCE_NATIVE_CHANNEL_ID:-}"
THREAD_ID="${OCTOCLAW_ACCEPTANCE_THREAD_ID:-}"
REPLAY_LIMIT="${OCTOCLAW_ACCEPTANCE_REPLAY_LIMIT:-6}"
REUSE_CURRENT_RUNTIME=false

usage() {
  cat <<'EOF'
Usage:
  bash bin/run-slack-acceptance-live.sh [options]

Options:
  --acceptance-root PATH
  --acceptance-home PATH
  --acceptance-workspace PATH
  --source-openclaw-home PATH
  --preset smoke|core6|acceptance
  --reuse-current-runtime    use current OPENCLAW_HOME/WORKSPACE and current gateway/bot
  --session-key KEY
  --target channel:C123|user:U123
  --native-channel-id ID
  --thread-id TS
  --replay-source LABEL=PATH   (repeatable)
  --replay-limit N
  -h, --help

Required env for bootstrap mode:
  OCTOCLAW_ACCEPTANCE_SLACK_BOT_TOKEN
  OCTOCLAW_ACCEPTANCE_SLACK_APP_TOKEN

Behavior:
  1. default: bootstrap isolated acceptance runtime
  2. with --reuse-current-runtime: skip bootstrap and reuse current gateway/runtime
  3. if no session key/target is supplied, print the sessions path and stop
  4. otherwise run unified slack acceptance suite
EOF
}

REPLAY_SOURCES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --acceptance-root)
      ACCEPTANCE_ROOT="$2"
      ACCEPTANCE_HOME="$2/home"
      ACCEPTANCE_WORKSPACE="$2/workspace"
      shift 2
      ;;
    --acceptance-home)
      ACCEPTANCE_HOME="$2"
      shift 2
      ;;
    --acceptance-workspace)
      ACCEPTANCE_WORKSPACE="$2"
      shift 2
      ;;
    --source-openclaw-home)
      SOURCE_OPENCLAW_HOME="$2"
      shift 2
      ;;
    --preset)
      BLACKBOX_PRESET="$2"
      shift 2
      ;;
    --reuse-current-runtime)
      REUSE_CURRENT_RUNTIME=true
      shift 1
      ;;
    --session-key)
      SESSION_KEY="$2"
      shift 2
      ;;
    --target)
      TARGET="$2"
      shift 2
      ;;
    --native-channel-id)
      NATIVE_CHANNEL_ID="$2"
      shift 2
      ;;
    --thread-id)
      THREAD_ID="$2"
      shift 2
      ;;
    --replay-source)
      REPLAY_SOURCES+=("$2")
      shift 2
      ;;
    --replay-limit)
      REPLAY_LIMIT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ "${REUSE_CURRENT_RUNTIME}" = true ]; then
  ACCEPTANCE_HOME="${SOURCE_OPENCLAW_HOME}"
  ACCEPTANCE_WORKSPACE="${OCTOCLAW_ACCEPTANCE_WORKSPACE:-${WORKSPACE:-${SOURCE_OPENCLAW_HOME}/workspace}}"
  echo "[acceptance-live] reuse current runtime/gateway"
else
  if [ -z "${OCTOCLAW_ACCEPTANCE_SLACK_BOT_TOKEN:-}" ] || [ -z "${OCTOCLAW_ACCEPTANCE_SLACK_APP_TOKEN:-}" ]; then
    echo "Missing OCTOCLAW_ACCEPTANCE_SLACK_BOT_TOKEN or OCTOCLAW_ACCEPTANCE_SLACK_APP_TOKEN" >&2
    exit 2
  fi

  echo "[acceptance-live] bootstrap isolated acceptance runtime"
  "${PYTHON_BIN}" "${REPO_ROOT}/lib/acceptance_runtime.py" \
    --source-openclaw-home "${SOURCE_OPENCLAW_HOME}" \
    --target-openclaw-home "${ACCEPTANCE_HOME}" \
    --target-workspace "${ACCEPTANCE_WORKSPACE}" \
    --slack-bot-token "${OCTOCLAW_ACCEPTANCE_SLACK_BOT_TOKEN}" \
    --slack-app-token "${OCTOCLAW_ACCEPTANCE_SLACK_APP_TOKEN}"
fi

SESSIONS_PATH="${ACCEPTANCE_HOME}/agents/main/sessions/sessions.json"
if [ -z "${SESSION_KEY}" ] && [ -z "${TARGET}" ]; then
  BOOTSTRAP_NOTE="bootstrap complete"
  if [ "${REUSE_CURRENT_RUNTIME}" = true ]; then
    BOOTSTRAP_NOTE="single-gateway mode ready"
  fi
  cat <<EOF
[acceptance-live] ${BOOTSTRAP_NOTE}
[acceptance-live] send one warm-up message in Slack, then re-run with either:
  --session-key <acceptance-session-key>
or:
  --target channel:<native-channel-id> --native-channel-id <native-channel-id>
[acceptance-live] sessions file:
  ${SESSIONS_PATH}
EOF
  exit 0
fi

echo "[acceptance-live] run unified slack acceptance suite"
CMD=(
  "${PYTHON_BIN}" "${REPO_ROOT}/lib/slack_acceptance_suite.py"
  --workspace "${ACCEPTANCE_WORKSPACE}"
  --openclaw-home "${ACCEPTANCE_HOME}"
  --blackbox-preset "${BLACKBOX_PRESET}"
  --replay-limit "${REPLAY_LIMIT}"
)
if [ -n "${SESSION_KEY}" ]; then
  CMD+=(--session-key "${SESSION_KEY}")
fi
if [ -n "${TARGET}" ]; then
  CMD+=(--target "${TARGET}")
fi
if [ -n "${NATIVE_CHANNEL_ID}" ]; then
  CMD+=(--native-channel-id "${NATIVE_CHANNEL_ID}")
fi
if [ -n "${THREAD_ID}" ]; then
  CMD+=(--thread-id "${THREAD_ID}")
fi
for source in "${REPLAY_SOURCES[@]}"; do
  CMD+=(--replay-source "${source}")
done

"${CMD[@]}"
