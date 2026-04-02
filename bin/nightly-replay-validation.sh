#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKSPACE_DEFAULT="${HOME}/.openclaw/workspace"
WORKSPACE="${WORKSPACE:-${WORKSPACE_DEFAULT}}"
TZ_NAME="${OCTOCLAW_REPLAY_VALIDATION_TZ:-Asia/Shanghai}"
REPORT_DAY="${1:-$(TZ="${TZ_NAME}" date -v-1d +%F 2>/dev/null || TZ="${TZ_NAME}" python3 - <<'PY'\nfrom datetime import datetime, timedelta\nfrom zoneinfo import ZoneInfo\nprint((datetime.now(ZoneInfo(\"Asia/Shanghai\")) - timedelta(days=1)).strftime(\"%Y-%m-%d\"))\nPY\n)}"
OPENCLAW_HOME="${OPENCLAW_HOME:-${HOME}/.openclaw}"
SESSIONS_INDEX="${OCTOCLAW_REPLAY_VALIDATION_SESSIONS_INDEX:-${OPENCLAW_HOME}/agents/main/sessions/sessions.json}"
LIMIT="${OCTOCLAW_REPLAY_VALIDATION_LIMIT:-3}"

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"
PYTHON_BIN="${OCTOCLAW_PYTHON_BIN:-python3}"

git -C "${REPO_ROOT}" fetch origin codex/release-v0.1.0
git -C "${REPO_ROOT}" reset --hard origin/codex/release-v0.1.0

REPORT_PATH="${REPO_ROOT}/reports/reply-review-validation/${REPORT_DAY}.md"
CASES_PATH="${REPO_ROOT}/reports/reply-review-validation/packets/${REPORT_DAY}.json"

echo "[nightly-replay-validation] replay ${REPORT_DAY}"
"${PYTHON_BIN}" "${REPO_ROOT}/lib/replay_validation.py" \
  --sessions-index "${SESSIONS_INDEX}" \
  --day "${REPORT_DAY}" \
  --timezone "${TZ_NAME}" \
  --limit "${LIMIT}" \
  --workspace "${WORKSPACE}" \
  --openclaw-home "${OPENCLAW_HOME}" \
  --output "${REPORT_PATH}" \
  --cases-output "${CASES_PATH}"

git -C "${REPO_ROOT}" add "${REPORT_PATH#"${REPO_ROOT}/"}" "${CASES_PATH#"${REPO_ROOT}/"}"
if ! git -C "${REPO_ROOT}" diff --cached --quiet --exit-code; then
  git -C "${REPO_ROOT}" commit -m "Add nightly replay validation for ${REPORT_DAY}"
  git -C "${REPO_ROOT}" push origin HEAD:codex/release-v0.1.0
fi

echo "[nightly-replay-validation] done ${REPORT_DAY}"
echo "${REPORT_PATH}"
