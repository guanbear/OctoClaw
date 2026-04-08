#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKSPACE_DEFAULT="${HOME}/.openclaw/workspace"
WORKSPACE="${WORKSPACE:-${WORKSPACE_DEFAULT}}"
TZ_NAME="${OCTOCLAW_NIGHTLY_ANALYSIS_TZ:-Asia/Shanghai}"
OPENCLAW_HOME_INPUT="${OPENCLAW_HOME:-${HOME}/.openclaw}"
OPENCLAW_HOME_ROOT="${OPENCLAW_HOME_INPUT}"
if [ -f "${OPENCLAW_HOME_ROOT}/openclaw.json" ]; then
  OPENCLAW_HOME_ROOT="$(cd "${OPENCLAW_HOME_ROOT}/.." && pwd)"
fi
SESSIONS_INDEX="${OCTOCLAW_NIGHTLY_ANALYSIS_SESSIONS_INDEX:-${OPENCLAW_HOME_ROOT}/.openclaw/agents/main/sessions/sessions.json}"
SESSION_DIR="${OCTOCLAW_NIGHTLY_ANALYSIS_SESSION_DIR:-${OPENCLAW_HOME_ROOT}/.openclaw/agents/main/sessions}"
REPLAY_LOG="${OCTOCLAW_NIGHTLY_ANALYSIS_REPLAY_LOG:-${WORKSPACE}/tmp/octopus/runtime-policy-replay.jsonl}"
TASK_STATE="${OCTOCLAW_NIGHTLY_ANALYSIS_TASK_STATE:-${WORKSPACE}/tmp/octopus/task-state.json}"
PYTHON_BIN="${OCTOCLAW_PYTHON_BIN:-python3}"
LIMIT="${OCTOCLAW_NIGHTLY_ANALYSIS_LIMIT:-24}"
SKIP_AGENT="${OCTOCLAW_NIGHTLY_ANALYSIS_SKIP_AGENT:-false}"
NOTIFY_BACKEND="${OCTOCLAW_NIGHTLY_ANALYSIS_NOTIFY_BACKEND:-slack}"
NOTIFY_SESSION_KEY="${OCTOCLAW_NIGHTLY_ANALYSIS_NOTIFY_SESSION_KEY:-}"
NOTIFY_CHANNEL="${OCTOCLAW_NIGHTLY_ANALYSIS_NOTIFY_CHANNEL:-}"
NOTIFY_TARGET="${OCTOCLAW_NIGHTLY_ANALYSIS_NOTIFY_TARGET:-}"
NOTIFY_THREAD_ID="${OCTOCLAW_NIGHTLY_ANALYSIS_NOTIFY_THREAD_ID:-}"

default_report_day() {
  TZ="${TZ_NAME}" date -v-1d +%F 2>/dev/null || TZ="${TZ_NAME}" "${PYTHON_BIN}" - <<'PY'
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

print((datetime.now(ZoneInfo("Asia/Shanghai")) - timedelta(days=1)).strftime("%Y-%m-%d"))
PY
}

REPORT_DAY="${1:-$(default_report_day)}"
BASE_DIR="${WORKSPACE}/tmp/octopus/nightly-analysis/${REPORT_DAY}"
PACKET_PATH="${BASE_DIR}/reply-review-packet.json"
VALIDATION_REPORT="${BASE_DIR}/replay-validation.md"
VALIDATION_CASES="${BASE_DIR}/replay-validation-cases.json"
REPLY_REVIEW_REPORT="${BASE_DIR}/reply-review.md"
REPLY_REVIEW_PROMPT="${BASE_DIR}/reply-review.prompt.md"
REPLY_REVIEW_ERROR="${BASE_DIR}/reply-review.error.log"
FAILURE_REPORT="${BASE_DIR}/failure-summary.md"
FAILURE_JSON="${BASE_DIR}/failure-summary.json"
SUMMARY_PATH="${BASE_DIR}/summary.txt"

mkdir -p "${BASE_DIR}"
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"

echo "[nightly-analysis] build reply-review packet ${REPORT_DAY}"
"${PYTHON_BIN}" "${REPO_ROOT}/lib/reply_review_packet.py" \
  --sessions-index "${SESSIONS_INDEX}" \
  --session-dir "${SESSION_DIR}" \
  --replay-log "${REPLAY_LOG}" \
  --task-state "${TASK_STATE}" \
  --day "${REPORT_DAY}" \
  --timezone "${TZ_NAME}" \
  --limit "${LIMIT}" \
  --output "${PACKET_PATH}"

echo "[nightly-analysis] replay validation ${REPORT_DAY}"
"${PYTHON_BIN}" "${REPO_ROOT}/lib/replay_validation.py" \
  --day "${REPORT_DAY}" \
  --timezone "${TZ_NAME}" \
  --limit "${LIMIT}" \
  --workspace "${WORKSPACE}" \
  --openclaw-home "${OPENCLAW_HOME_ROOT}" \
  --packet "${PACKET_PATH}" \
  --source-label "reply-review-packet(local nightly analysis)" \
  --output "${VALIDATION_REPORT}" \
  --cases-output "${VALIDATION_CASES}"

echo "[nightly-analysis] reply review ${REPORT_DAY}"
rm -f "${REPLY_REVIEW_ERROR}"
if [ "${SKIP_AGENT}" = "true" ]; then
  "${PYTHON_BIN}" "${REPO_ROOT}/lib/nightly_reply_review.py" \
    --packet "${PACKET_PATH}" \
    --day "${REPORT_DAY}" \
    --timezone "${TZ_NAME}" \
    --repo-root "${REPO_ROOT}" \
    --output "${REPLY_REVIEW_REPORT}" \
    --prompt-output "${REPLY_REVIEW_PROMPT}" \
    --skip-agent
else
  if ! "${PYTHON_BIN}" "${REPO_ROOT}/lib/nightly_reply_review.py" \
    --packet "${PACKET_PATH}" \
    --day "${REPORT_DAY}" \
    --timezone "${TZ_NAME}" \
    --repo-root "${REPO_ROOT}" \
    --output "${REPLY_REVIEW_REPORT}" \
      --prompt-output "${REPLY_REVIEW_PROMPT}" \
    2>"${REPLY_REVIEW_ERROR}"; then
    echo "[nightly-analysis] reply review agent failed; fallback to packet-only review"
    "${PYTHON_BIN}" "${REPO_ROOT}/lib/nightly_reply_review.py" \
      --packet "${PACKET_PATH}" \
      --day "${REPORT_DAY}" \
      --timezone "${TZ_NAME}" \
      --repo-root "${REPO_ROOT}" \
      --output "${REPLY_REVIEW_REPORT}" \
      --prompt-output "${REPLY_REVIEW_PROMPT}" \
      --skip-agent
    "${PYTHON_BIN}" - <<'PY' "${REPLY_REVIEW_REPORT}" "${REPLY_REVIEW_ERROR}"
from pathlib import Path
import sys

report = Path(sys.argv[1])
error = Path(sys.argv[2])
text = report.read_text(encoding="utf-8").rstrip()
detail = error.read_text(encoding="utf-8", errors="ignore").strip() if error.exists() else "unknown error"
report.write_text(
    text
    + "\n\n## Agent Review Fallback\n\n"
    + "- Agent review failed during nightly analysis; packet-only review was generated instead.\n"
    + f"- Error: `{detail[:400]}`\n",
    encoding="utf-8",
)
PY
  else
    rm -f "${REPLY_REVIEW_ERROR}"
  fi
fi

echo "[nightly-analysis] failure summary ${REPORT_DAY}"
"${PYTHON_BIN}" "${REPO_ROOT}/lib/nightly_failure_summary.py" \
  --task-state "${TASK_STATE}" \
  --day "${REPORT_DAY}" \
  --timezone "${TZ_NAME}" \
  --output "${FAILURE_REPORT}" \
  --json-output "${FAILURE_JSON}" > /dev/null

"${PYTHON_BIN}" - <<'PY' "${REPORT_DAY}" "${PACKET_PATH}" "${VALIDATION_REPORT}" "${REPLY_REVIEW_REPORT}" "${FAILURE_REPORT}" "${SUMMARY_PATH}" "${REPLY_REVIEW_ERROR}"
from pathlib import Path
import json
import sys

day, packet_path, validation_path, reply_review_path, failure_path, summary_path, reply_review_error = sys.argv[1:]

def first_meaningful_line(path: str) -> str:
    candidate = Path(path)
    if not candidate.exists():
        return "missing"
    for raw in candidate.read_text(encoding="utf-8", errors="ignore").splitlines():
        text = raw.strip()
        if not text:
            continue
        if text.startswith("#"):
            continue
        return text
    return "generated"

packet = {}
packet_candidate = Path(packet_path)
if packet_candidate.exists():
    try:
        packet = json.loads(packet_candidate.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        packet = {}
selection_metrics = packet.get("selection_metrics") if isinstance(packet, dict) else {}
reply_review_mode = "semantic"
error_candidate = Path(reply_review_error)
if error_candidate.exists() and error_candidate.stat().st_size > 0:
    reply_review_mode = "packet-only fallback"

summary = "\n".join(
    [
        f"OctoClaw nightly analysis {day}",
        "",
        "- Mode: analysis-only (no autofix)",
        f"- Reply review mode: {reply_review_mode}",
        f"- Packet selection metrics: {json.dumps(selection_metrics, ensure_ascii=False, sort_keys=True) if selection_metrics else '{}'}",
        f"- Replay validation: {validation_path}",
        f"  {first_meaningful_line(validation_path)}",
        f"- Reply review: {reply_review_path}",
        f"  {first_meaningful_line(reply_review_path)}",
        f"- Failure summary: {failure_path}",
        f"  {first_meaningful_line(failure_path)}",
    ]
) + "\n"
Path(summary_path).write_text(summary, encoding="utf-8")
print(summary, end="")
PY

if [ -n "${NOTIFY_SESSION_KEY}" ] || { [ -n "${NOTIFY_CHANNEL}" ] && [ -n "${NOTIFY_TARGET}" ]; }; then
  echo "[nightly-analysis] send notification ${REPORT_DAY}"
  "${PYTHON_BIN}" - <<'PY' "${REPO_ROOT}" "${SUMMARY_PATH}" "${NOTIFY_BACKEND}" "${NOTIFY_SESSION_KEY}" "${NOTIFY_CHANNEL}" "${NOTIFY_TARGET}" "${NOTIFY_THREAD_ID}"
from pathlib import Path
import sys

repo_root = Path(sys.argv[1])
summary_path = Path(sys.argv[2])
backend = sys.argv[3]
session_key = sys.argv[4]
channel = sys.argv[5]
target = sys.argv[6]
thread_id = sys.argv[7]

sys.path.insert(0, str(repo_root / "lib"))
from session_ops import resolve_message_target_from_session_key, send_channel_message

message = summary_path.read_text(encoding="utf-8")
if session_key:
    resolved = resolve_message_target_from_session_key(session_key)
    if resolved.get("ok"):
        channel = resolved.get("origin", "") or backend
        target = resolved.get("target", "") or target
        thread_id = resolved.get("thread_id", "") or thread_id

if channel and target:
    result = send_channel_message(channel, target, message, thread_id=thread_id)
    if not result.get("ok"):
        raise SystemExit(f"nightly analysis notify failed: {result}")
    print(result)
PY
fi

echo "[nightly-analysis] done ${REPORT_DAY}"
echo "${SUMMARY_PATH}"
