#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKSPACE_DEFAULT="${HOME}/.openclaw/workspace"
WORKSPACE="${WORKSPACE:-${WORKSPACE_DEFAULT}}"
CONFIG_FILE="${OCTOCLAW_CONFIG_FILE:-${WORKSPACE}/tmp/octoclaw-config.json}"
VM_HOST="${OCTOCLAW_REPLY_REVIEW_SOURCE_HOST:-root@45.141.139.142}"
TZ_NAME="${OCTOCLAW_REPLY_REVIEW_TZ:-Asia/Shanghai}"
SKIP_AGENT="${OCTOCLAW_REPLY_REVIEW_SKIP_AGENT:-false}"
REPORT_DAY="${1:-$(TZ="${TZ_NAME}" date -v-1d +%F 2>/dev/null || TZ="${TZ_NAME}" python3 - <<'PY'\nfrom datetime import datetime, timedelta\nfrom zoneinfo import ZoneInfo\nprint((datetime.now(ZoneInfo(\"Asia/Shanghai\")) - timedelta(days=1)).strftime(\"%Y-%m-%d\"))\nPY\n)}"
TMP_DIR="${WORKSPACE}/tmp/octopus/reply-review/${REPORT_DAY}"
SESSIONS_DIR="${TMP_DIR}/sessions"

mkdir -p "${TMP_DIR}" "${SESSIONS_DIR}"

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"
PYTHON_BIN="${OCTOCLAW_PYTHON_BIN:-python3}"

git -C "${REPO_ROOT}" fetch origin codex/release-v0.1.0
git -C "${REPO_ROOT}" reset --hard origin/codex/release-v0.1.0

scp "${VM_HOST}:/root/.openclaw/agents/main/sessions/sessions.json" "${TMP_DIR}/sessions.json"
python3 - <<'PY' "${TMP_DIR}/sessions.json" "${TMP_DIR}/session-files.txt"
import json, sys
from pathlib import Path
src = Path(sys.argv[1])
out = Path(sys.argv[2])
payload = json.loads(src.read_text())
rows = []
for session_key, meta in payload.items():
    origin = (meta or {}).get("origin") or (meta or {}).get("source") or {}
    provider = ""
    if isinstance(origin, dict):
        provider = str(origin.get("provider") or origin.get("surface") or "").lower()
    if ":slack:" not in session_key and provider != "slack":
        continue
    session_file = str((meta or {}).get("sessionFile") or "").strip()
    if session_file:
        rows.append(session_file)
out.write_text("\n".join(sorted(set(rows))) + "\n")
PY

while IFS= read -r remote_file; do
  [ -n "${remote_file}" ] || continue
  scp "${VM_HOST}:${remote_file}" "${SESSIONS_DIR}/$(basename "${remote_file}")"
done < "${TMP_DIR}/session-files.txt"

scp "${VM_HOST}:/workspace/tmp/octopus/runtime-policy-replay.jsonl" "${TMP_DIR}/runtime-policy-replay.jsonl" || true
scp "${VM_HOST}:/workspace/tmp/octopus/task-state.json" "${TMP_DIR}/task-state.json" || true

"${PYTHON_BIN}" "${REPO_ROOT}/lib/reply_review_packet.py" \
  --sessions-index "${TMP_DIR}/sessions.json" \
  --session-dir "${SESSIONS_DIR}" \
  --replay-log "${TMP_DIR}/runtime-policy-replay.jsonl" \
  --task-state "${TMP_DIR}/task-state.json" \
  --day "${REPORT_DAY}" \
  --timezone "${TZ_NAME}" \
  --output "${TMP_DIR}/reply-review-packet.json"

REVIEW_ARGS=()
if [ "${SKIP_AGENT}" = "true" ]; then
  REVIEW_ARGS+=(--skip-agent)
fi

"${PYTHON_BIN}" "${REPO_ROOT}/lib/nightly_reply_review.py" \
  --packet "${TMP_DIR}/reply-review-packet.json" \
  --day "${REPORT_DAY}" \
  --timezone "${TZ_NAME}" \
  --repo-root "${REPO_ROOT}" \
  --output "${REPO_ROOT}/reports/reply-review/${REPORT_DAY}.md" \
  --prompt-output "${REPO_ROOT}/reports/reply-review/packets/${REPORT_DAY}.prompt.md" \
  "${REVIEW_ARGS[@]}"

git -C "${REPO_ROOT}" add "reports/reply-review/${REPORT_DAY}.md" "reports/reply-review/packets/${REPORT_DAY}.prompt.md"
if ! git -C "${REPO_ROOT}" diff --cached --quiet --exit-code; then
  git -C "${REPO_ROOT}" commit -m "Add nightly reply review for ${REPORT_DAY}"
  git -C "${REPO_ROOT}" push origin HEAD:codex/release-v0.1.0
fi

echo "${REPO_ROOT}/reports/reply-review/${REPORT_DAY}.md"
