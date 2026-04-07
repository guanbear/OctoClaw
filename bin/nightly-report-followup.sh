#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKSPACE_DEFAULT="${HOME}/.openclaw/workspace"
WORKSPACE="${WORKSPACE:-${WORKSPACE_DEFAULT}}"
OPENCLAW_HOME_INPUT="${OPENCLAW_HOME:-${HOME}/.openclaw}"
OPENCLAW_HOME_ROOT="${OPENCLAW_HOME_INPUT}"
if [ -f "${OPENCLAW_HOME_ROOT}/openclaw.json" ]; then
  OPENCLAW_HOME_ROOT="$(cd "${OPENCLAW_HOME_ROOT}/.." && pwd)"
fi
CONFIG_FILE="${OCTOCLAW_CONFIG_FILE:-${WORKSPACE}/tmp/octoclaw-config.json}"
TZ_NAME="${OCTOCLAW_NIGHTLY_FOLLOWUP_TZ:-Asia/Shanghai}"
REPORT_DAY="${1:-}"

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"
PYTHON_BIN="${OCTOCLAW_PYTHON_BIN:-python3}"
export OPENCLAW_HOME="${OPENCLAW_HOME_ROOT}"

cmd=(
  "${PYTHON_BIN}" "${REPO_ROOT}/lib/nightly_report_followup.py"
  run
  --config "${CONFIG_FILE}"
  --repo-root "${REPO_ROOT}"
  --workspace "${WORKSPACE}"
  --timezone "${TZ_NAME}"
  --notify-backend "${OCTOCLAW_NIGHTLY_FOLLOWUP_NOTIFY_BACKEND:-auto}"
  --notify-session-key "${OCTOCLAW_NIGHTLY_FOLLOWUP_NOTIFY_SESSION_KEY:-}"
  --notify-channel "${OCTOCLAW_NIGHTLY_FOLLOWUP_NOTIFY_CHANNEL:-}"
  --notify-target "${OCTOCLAW_NIGHTLY_FOLLOWUP_NOTIFY_TARGET:-}"
  --notify-thread-id "${OCTOCLAW_NIGHTLY_FOLLOWUP_NOTIFY_THREAD_ID:-}"
  --agent-model "${OCTOCLAW_NIGHTLY_FOLLOWUP_AGENT_MODEL:-}"
  --branch "${OCTOCLAW_NIGHTLY_FOLLOWUP_BRANCH:-codex/release-v0.1.0}"
  --max-wait-seconds "${OCTOCLAW_NIGHTLY_FOLLOWUP_MAX_WAIT_SECONDS:-3600}"
  --poll-seconds "${OCTOCLAW_NIGHTLY_FOLLOWUP_POLL_SECONDS:-120}"
  --fix-enabled "${OCTOCLAW_NIGHTLY_FOLLOWUP_FIX_ENABLED:-true}"
)

if [ -n "${REPORT_DAY}" ]; then
  cmd+=(--report-day "${REPORT_DAY}")
fi

"${cmd[@]}"
