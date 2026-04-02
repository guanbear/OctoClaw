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
REVIEW_AGENT="${OCTOCLAW_REPLY_REVIEW_AGENT:-octoclaw-reviewer-${REPORT_DAY//-/}-$(date +%H%M%S)}"
TMP_DIR="${WORKSPACE}/tmp/octopus/reply-review/${REPORT_DAY}"
SESSIONS_DIR="${TMP_DIR}/sessions"

mkdir -p "${TMP_DIR}" "${SESSIONS_DIR}"

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"
PYTHON_BIN="${OCTOCLAW_PYTHON_BIN:-python3}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15)

shell_quote() {
  "${PYTHON_BIN}" - "$1" <<'PY'
import shlex, sys
print(shlex.quote(sys.argv[1]))
PY
}

fetch_remote_file() {
  local remote_path="$1"
  local local_path="$2"
  local remote_quoted
  local tmp_path
  remote_quoted="$(shell_quote "${remote_path}")"
  tmp_path="${local_path}.tmp"
  mkdir -p "$(dirname "${local_path}")"
  ssh "${SSH_OPTS[@]}" "${VM_HOST}" "cat ${remote_quoted}" > "${tmp_path}"
  mv "${tmp_path}" "${local_path}"
}

git -C "${REPO_ROOT}" fetch origin codex/release-v0.1.0
git -C "${REPO_ROOT}" reset --hard origin/codex/release-v0.1.0

openclaw agents add "${REVIEW_AGENT}" --workspace "${WORKSPACE}" --model zai/glm-4.7 --non-interactive --json >/dev/null 2>&1 || true

echo "[nightly-reply-review] fetch sessions index ${REPORT_DAY}"
fetch_remote_file "/root/.openclaw/agents/main/sessions/sessions.json" "${TMP_DIR}/sessions.json"
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
  echo "[nightly-reply-review] fetch session $(basename "${remote_file}")"
  fetch_remote_file "${remote_file}" "${SESSIONS_DIR}/$(basename "${remote_file}")"
done < "${TMP_DIR}/session-files.txt"

echo "[nightly-reply-review] fetch replay/task-state"
fetch_remote_file "/workspace/tmp/octopus/runtime-policy-replay.jsonl" "${TMP_DIR}/runtime-policy-replay.jsonl" || true
fetch_remote_file "/workspace/tmp/octopus/task-state.json" "${TMP_DIR}/task-state.json" || true

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

review_cmd=(
  "${PYTHON_BIN}" "${REPO_ROOT}/lib/nightly_reply_review.py"
  --packet "${TMP_DIR}/reply-review-packet.json"
  --day "${REPORT_DAY}"
  --timezone "${TZ_NAME}"
  --agent "${REVIEW_AGENT}"
  --repo-root "${REPO_ROOT}"
  --output "${REPO_ROOT}/reports/reply-review/${REPORT_DAY}.md"
  --prompt-output "${REPO_ROOT}/reports/reply-review/packets/${REPORT_DAY}.prompt.md"
)
if [ "${#REVIEW_ARGS[@]}" -gt 0 ]; then
  review_cmd+=("${REVIEW_ARGS[@]}")
fi
echo "[nightly-reply-review] run AI review"
"${review_cmd[@]}"

git -C "${REPO_ROOT}" add "reports/reply-review/${REPORT_DAY}.md" "reports/reply-review/packets/${REPORT_DAY}.prompt.md"
if ! git -C "${REPO_ROOT}" diff --cached --quiet --exit-code; then
  git -C "${REPO_ROOT}" commit -m "Add nightly reply review for ${REPORT_DAY}"
  git -C "${REPO_ROOT}" push origin HEAD:codex/release-v0.1.0
fi

echo "[nightly-reply-review] done ${REPORT_DAY}"
echo "${REPO_ROOT}/reports/reply-review/${REPORT_DAY}.md"
