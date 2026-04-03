#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKSPACE_DEFAULT="${HOME}/.openclaw/workspace"
WORKSPACE="${WORKSPACE:-${WORKSPACE_DEFAULT}}"
TZ_NAME="${OCTOCLAW_REPLAY_VALIDATION_TZ:-Asia/Shanghai}"
REPORT_DAY="${1:-$(TZ="${TZ_NAME}" date -v-1d +%F 2>/dev/null || TZ="${TZ_NAME}" python3 - <<'PY'\nfrom datetime import datetime, timedelta\nfrom zoneinfo import ZoneInfo\nprint((datetime.now(ZoneInfo(\"Asia/Shanghai\")) - timedelta(days=1)).strftime(\"%Y-%m-%d\"))\nPY\n)}"
OPENCLAW_HOME_INPUT="${OPENCLAW_HOME:-${HOME}/.openclaw}"
OPENCLAW_HOME_ROOT="${OPENCLAW_HOME_INPUT}"
if [ -f "${OPENCLAW_HOME_ROOT}/openclaw.json" ]; then
  OPENCLAW_HOME_ROOT="$(cd "${OPENCLAW_HOME_ROOT}/.." && pwd)"
fi
SESSIONS_INDEX="${OCTOCLAW_REPLAY_VALIDATION_SESSIONS_INDEX:-${OPENCLAW_HOME_ROOT}/.openclaw/agents/main/sessions/sessions.json}"
LIMIT="${OCTOCLAW_REPLAY_VALIDATION_LIMIT:-3}"
REPLY_REVIEW_PACKET="${WORKSPACE}/tmp/octopus/reply-review/${REPORT_DAY}/reply-review-packet.json"

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"
PYTHON_BIN="${OCTOCLAW_PYTHON_BIN:-python3}"

git -C "${REPO_ROOT}" fetch origin codex/release-v0.1.0
git -C "${REPO_ROOT}" reset --hard origin/codex/release-v0.1.0

REPORT_PATH="${REPO_ROOT}/reports/reply-review-validation/${REPORT_DAY}.md"
CASES_PATH="${REPO_ROOT}/reports/reply-review-validation/packets/${REPORT_DAY}.json"

echo "[nightly-replay-validation] replay ${REPORT_DAY}"
validation_cmd=(
  "${PYTHON_BIN}" "${REPO_ROOT}/lib/replay_validation.py"
  --day "${REPORT_DAY}"
  --timezone "${TZ_NAME}"
  --limit "${LIMIT}"
  --workspace "${WORKSPACE}"
  --openclaw-home "${OPENCLAW_HOME_ROOT}"
  --output "${REPORT_PATH}"
  --cases-output "${CASES_PATH}"
)
if [ -f "${REPLY_REVIEW_PACKET}" ]; then
  validation_cmd+=(--packet "${REPLY_REVIEW_PACKET}" --source-label "reply-review-packet(local real conversations)")
else
  validation_cmd+=(--sessions-index "${SESSIONS_INDEX}" --source-label "sessions-index(local)")
fi
"${validation_cmd[@]}"

git -C "${REPO_ROOT}" add "${REPORT_PATH#"${REPO_ROOT}/"}" "${CASES_PATH#"${REPO_ROOT}/"}"
if ! git -C "${REPO_ROOT}" diff --cached --quiet --exit-code; then
  git -C "${REPO_ROOT}" commit -m "Add nightly replay validation for ${REPORT_DAY}"
  git -C "${REPO_ROOT}" push origin HEAD:codex/release-v0.1.0
fi

echo "[nightly-replay-validation] done ${REPORT_DAY}"
echo "${REPORT_PATH}"
