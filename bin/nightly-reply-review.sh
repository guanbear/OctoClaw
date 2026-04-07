#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKSPACE_DEFAULT="${HOME}/.openclaw/workspace"
WORKSPACE="${WORKSPACE:-${WORKSPACE_DEFAULT}}"
CONFIG_FILE="${OCTOCLAW_CONFIG_FILE:-${WORKSPACE}/tmp/octoclaw-config.json}"
VM_HOST="${OCTOCLAW_REPLY_REVIEW_SOURCE_HOST:-root@45.141.139.142}"
SOURCE_MODE="${OCTOCLAW_REPLY_REVIEW_SOURCE_MODE:-local}"
TZ_NAME="${OCTOCLAW_REPLY_REVIEW_TZ:-Asia/Shanghai}"
SKIP_AGENT="${OCTOCLAW_REPLY_REVIEW_SKIP_AGENT:-false}"
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"
PYTHON_BIN="${OCTOCLAW_PYTHON_BIN:-python3}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15)
REMOTE_SESSIONS_INDEX="/root/.openclaw/agents/main/sessions/sessions.json"
REMOTE_REPLAY_LOG="/workspace/tmp/octopus/runtime-policy-replay.jsonl"
REMOTE_TASK_STATE="/workspace/tmp/octopus/task-state.json"

default_report_day() {
  TZ="${TZ_NAME}" date -v-1d +%F 2>/dev/null || TZ="${TZ_NAME}" "${PYTHON_BIN}" - <<'PY'
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
print((datetime.now(ZoneInfo("Asia/Shanghai")) - timedelta(days=1)).strftime("%Y-%m-%d"))
PY
}

REPORT_DAY="${1:-$(default_report_day)}"
REVIEW_AGENT="${OCTOCLAW_REPLY_REVIEW_AGENT:-octoclaw-reviewer-${REPORT_DAY//-/}-$(date +%H%M%S)}"
TMP_DIR="${WORKSPACE}/tmp/octopus/reply-review/${REPORT_DAY}"
SESSIONS_DIR="${TMP_DIR}/sessions"
MERGED_DIR="${TMP_DIR}/merged"
LOCAL_OPENCLAW_HOME="${OPENCLAW_HOME:-${HOME}/.openclaw}"
OPENCLAW_HOME_ROOT="${LOCAL_OPENCLAW_HOME}"
if [ -f "${OPENCLAW_HOME_ROOT}/openclaw.json" ]; then
  OPENCLAW_HOME_ROOT="$(cd "${OPENCLAW_HOME_ROOT}/.." && pwd)"
fi
LOCAL_SESSIONS_INDEX="${OCTOCLAW_REPLY_REVIEW_SESSIONS_INDEX:-${OPENCLAW_HOME_ROOT}/.openclaw/agents/main/sessions/sessions.json}"
LOCAL_REPLAY_LOG="${WORKSPACE}/tmp/octopus/runtime-policy-replay.jsonl"
LOCAL_TASK_STATE="${WORKSPACE}/tmp/octopus/task-state.json"

mkdir -p "${TMP_DIR}" "${SESSIONS_DIR}" "${MERGED_DIR}"

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

copy_local_file() {
  local source_path="$1"
  local local_path="$2"
  mkdir -p "$(dirname "${local_path}")"
  cp "${source_path}" "${local_path}"
}

extract_slack_session_files() {
  local sessions_index_path="$1"
  local output_path="$2"
  "${PYTHON_BIN}" - <<'PY' "${sessions_index_path}" "${output_path}"
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
}

stage_source_artifacts() {
  local label="$1"
  local mode="$2"
  local source_dir="${TMP_DIR}/${label}"
  local sessions_index_path="${source_dir}/sessions.json"
  local session_files_path="${source_dir}/session-files.txt"
  local replay_log_path="${source_dir}/runtime-policy-replay.jsonl"
  local task_state_path="${source_dir}/task-state.json"
  local staged_session_dir="${SESSIONS_DIR}/${label}"

  mkdir -p "${source_dir}" "${staged_session_dir}"

  if [ "${mode}" = "remote" ]; then
    echo "[nightly-reply-review] fetch ${label} sessions index ${REPORT_DAY}"
    fetch_remote_file "${REMOTE_SESSIONS_INDEX}" "${sessions_index_path}"
  else
    echo "[nightly-reply-review] use ${label} sessions index ${REPORT_DAY}"
    copy_local_file "${LOCAL_SESSIONS_INDEX}" "${sessions_index_path}"
  fi

  extract_slack_session_files "${sessions_index_path}" "${session_files_path}"

  while IFS= read -r source_file; do
    [ -n "${source_file}" ] || continue
    echo "[nightly-reply-review] fetch ${label} session $(basename "${source_file}")"
    if [ "${mode}" = "remote" ]; then
      fetch_remote_file "${source_file}" "${staged_session_dir}/$(basename "${source_file}")"
    else
      copy_local_file "${source_file}" "${staged_session_dir}/$(basename "${source_file}")"
    fi
  done < "${session_files_path}"

  echo "[nightly-reply-review] fetch ${label} replay/task-state"
  if [ "${mode}" = "remote" ]; then
    fetch_remote_file "${REMOTE_REPLAY_LOG}" "${replay_log_path}" || true
    fetch_remote_file "${REMOTE_TASK_STATE}" "${task_state_path}" || true
  else
    cp "${LOCAL_REPLAY_LOG}" "${replay_log_path}" 2>/dev/null || true
    cp "${LOCAL_TASK_STATE}" "${task_state_path}" 2>/dev/null || true
  fi
}

merge_staged_sources() {
  local merged_sessions_path="$1"
  local merged_replay_path="$2"
  local merged_task_state_path="$3"
  shift 3
  "${PYTHON_BIN}" - <<'PY' "${TMP_DIR}" "${SESSIONS_DIR}" "${merged_sessions_path}" "${merged_replay_path}" "${merged_task_state_path}" "$@"
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

tmp_dir = Path(sys.argv[1])
sessions_root = Path(sys.argv[2])
merged_sessions_path = Path(sys.argv[3])
merged_replay_path = Path(sys.argv[4])
merged_task_state_path = Path(sys.argv[5])
labels = list(sys.argv[6:])
namespace = len(labels) > 1


def load_sessions_index(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    payload = json.loads(path.read_text())
    if isinstance(payload, dict):
        return {str(k): v for k, v in payload.items() if isinstance(v, dict)}
    if isinstance(payload, list):
        result: dict[str, dict] = {}
        for item in payload:
            if not isinstance(item, dict):
                continue
            session_key = str(item.get("sessionKey") or item.get("id") or "").strip()
            if session_key:
                result[session_key] = item
        return result
    return {}


def namespaced(label: str, value: str) -> str:
    if not namespace:
        return value
    return f"{label}::{value}"


merged_sessions: dict[str, dict] = {}
for label in labels:
    index_path = tmp_dir / label / "sessions.json"
    staged_dir = sessions_root / label
    for session_key, meta in load_sessions_index(index_path).items():
        row = copy.deepcopy(meta)
        raw_session_file = str(row.get("sessionFile") or "").strip()
        if raw_session_file:
            session_name = Path(raw_session_file).name
            row["sessionFile"] = str(Path(label) / session_name)
        origin = row.get("origin")
        if not isinstance(origin, dict):
            origin = {}
        origin = dict(origin)
        origin["replyReviewSource"] = label
        row["origin"] = origin
        row["replyReviewSource"] = label
        merged_sessions[namespaced(label, session_key)] = row
        staged_path = staged_dir / Path(raw_session_file).name if raw_session_file else None
        if staged_path and not staged_path.exists():
            continue

merged_sessions_path.parent.mkdir(parents=True, exist_ok=True)
merged_sessions_path.write_text(json.dumps(merged_sessions, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

with merged_replay_path.open("w", encoding="utf-8") as out:
    for label in labels:
        replay_path = tmp_dir / label / "runtime-policy-replay.jsonl"
        if not replay_path.exists():
            continue
        for line in replay_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            raw = line.strip()
            if not raw.startswith("{"):
                continue
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(payload, dict):
                continue
            session_key = str(payload.get("sessionKey") or "").strip()
            if session_key:
                payload["sessionKey"] = namespaced(label, session_key)
            payload["replyReviewSource"] = label
            out.write(json.dumps(payload, ensure_ascii=False) + "\n")

merged_tasks: list[dict] = []
base_task_state: dict | None = None
for label in labels:
    task_state_path = tmp_dir / label / "task-state.json"
    if not task_state_path.exists():
        continue
    try:
        payload = json.loads(task_state_path.read_text())
    except json.JSONDecodeError:
        continue
    if not isinstance(payload, dict):
        continue
    if base_task_state is None:
        base_task_state = {k: copy.deepcopy(v) for k, v in payload.items() if k != "tasks"}
    for task in payload.get("tasks") or []:
        if not isinstance(task, dict):
            continue
        row = copy.deepcopy(task)
        if namespace and row.get("id"):
            row["id"] = namespaced(label, str(row["id"]))
        deps = row.get("deps")
        if namespace and isinstance(deps, list):
            row["deps"] = [namespaced(label, str(dep)) for dep in deps]
        for field in ("session_key", "sessionKey"):
            if namespace and row.get(field):
                row[field] = namespaced(label, str(row[field]))
        row["replyReviewSource"] = label
        merged_tasks.append(row)

if base_task_state is None:
    base_task_state = {"tasks": []}
base_task_state["tasks"] = merged_tasks
merged_task_state_path.parent.mkdir(parents=True, exist_ok=True)
merged_task_state_path.write_text(json.dumps(base_task_state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
}

case "${SOURCE_MODE}" in
  local|remote|both)
    ;;
  *)
    echo "[nightly-reply-review] unsupported source mode: ${SOURCE_MODE}" >&2
    exit 1
    ;;
esac

git -C "${REPO_ROOT}" fetch origin codex/release-v0.1.0
git -C "${REPO_ROOT}" reset --hard origin/codex/release-v0.1.0

OPENCLAW_HOME="${OPENCLAW_HOME_ROOT}" openclaw agents add "${REVIEW_AGENT}" --workspace "${WORKSPACE}" --model zai/glm-4.7 --non-interactive --json >/dev/null 2>&1 || true

SOURCE_LABELS=()
if [ "${SOURCE_MODE}" = "local" ] || [ "${SOURCE_MODE}" = "both" ]; then
  stage_source_artifacts "local" "local"
  SOURCE_LABELS+=("local")
fi
if [ "${SOURCE_MODE}" = "remote" ] || [ "${SOURCE_MODE}" = "both" ]; then
  stage_source_artifacts "remote" "remote"
  SOURCE_LABELS+=("remote")
fi

MERGED_SESSIONS_INDEX="${MERGED_DIR}/sessions.json"
MERGED_REPLAY_LOG="${MERGED_DIR}/runtime-policy-replay.jsonl"
MERGED_TASK_STATE="${MERGED_DIR}/task-state.json"
merge_staged_sources "${MERGED_SESSIONS_INDEX}" "${MERGED_REPLAY_LOG}" "${MERGED_TASK_STATE}" "${SOURCE_LABELS[@]}"

"${PYTHON_BIN}" "${REPO_ROOT}/lib/reply_review_packet.py" \
  --sessions-index "${MERGED_SESSIONS_INDEX}" \
  --session-dir "${SESSIONS_DIR}" \
  --replay-log "${MERGED_REPLAY_LOG}" \
  --task-state "${MERGED_TASK_STATE}" \
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
