#!/bin/bash
# runner_loop.sh — legacy worker loop
# 默认架构下 runner 不再依赖独立 shell loop；如需继续使用旧 loop，
# 必须显式设置 OCTOCLAW_ENABLE_LEGACY_LOOPS=1。

if [[ "${OCTOCLAW_ENABLE_LEGACY_LOOPS:-}" != "1" ]]; then
  echo "runner_loop.sh is legacy-only. Use the gateway-managed runner pool or on-demand runner mode instead."
  exit 0
fi

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/workspace.sh"
WORKSPACE="$(resolve_octoclaw_workspace "$SCRIPT_DIR")"
PYTHON_BIN="${OCTOCLAW_PYTHON_BIN:-$(resolve_octoclaw_python)}"
QUEUE_PY="$SCRIPT_DIR/runner_queue.py"
TASK_STATE_PY="$SCRIPT_DIR/task-state-update.py"

POLL_INTERVAL="${RUNNER_POLL_INTERVAL_SECONDS:-3}"
HEARTBEAT_INTERVAL="${RUNNER_HEARTBEAT_INTERVAL_SECONDS:-10}"
DEFAULT_TIMEOUT="${RUNNER_DEFAULT_TIMEOUT_SECONDS:-120}"
MAX_AGE_MINUTES="${RUNNER_MAX_AGE_MINUTES:-120}"
MAX_IDLE_SECONDS="${RUNNER_MAX_IDLE_SECONDS:-900}"
MAX_JOBS="${RUNNER_MAX_JOBS_PER_WORKER:-30}"
WORKER_ID="${RUNNER_WORKER_ID:-runner-$(hostname)-$$}"
STARTED_AT="$("$PYTHON_BIN" - <<'PY'
from datetime import datetime, timezone
print(datetime.now(timezone.utc).astimezone().isoformat())
PY
)"
START_EPOCH="$(date +%s)"

jobs_completed=0
last_heartbeat=0
last_job_epoch="$START_EPOCH"

"$PYTHON_BIN" "$QUEUE_PY" ensure >/dev/null

heartbeat() {
  local job_id="${1:-}"
  local job_status="${2:-}"
  local cmd=(
    "$PYTHON_BIN" "$QUEUE_PY" heartbeat
    --worker-id "$WORKER_ID"
    --pid "$$"
    --job-id "$job_id"
    --jobs-completed "$jobs_completed"
    --started-at "$STARTED_AT"
  )
  if [[ -n "$job_status" ]]; then
    cmd+=(--job-status "$job_status")
  fi
  "${cmd[@]}" >/dev/null
}

update_task_running() {
  local job_id="$1"
  local model="$2"
  local summary="$3"
  local task_description="$4"
  local session_key="${5:-}"
  local session_id="${6:-}"
  local agent_id="${7:-}"
  local agent_namespace="${8:-}"
  local managed_by_octoclaw="${9:-}"
  local cmd=(
    "$PYTHON_BIN" "$TASK_STATE_PY" upsert
    --id "$job_id"
    --model "$model"
    --status running
    --summary "$summary"
    --model-band fast
    --task-description "$task_description"
    --title "$summary"
    --executor runner
    --route runner
    --runtime runner
    --worker-pool octoclaw-runner
    --work-type ops
    --phase inspect
    --protocol normal
    --profile ops-fast
    --review-required false
  )
  if [[ -n "$session_key" ]]; then
    cmd+=(--session-key "$session_key")
  fi
  if [[ -n "$session_id" ]]; then
    cmd+=(--session-id "$session_id")
  fi
  if [[ -n "$agent_id" ]]; then
    cmd+=(--agent-id "$agent_id")
  fi
  if [[ -n "$agent_namespace" ]]; then
    cmd+=(--agent-namespace "$agent_namespace")
  fi
  if [[ -n "$managed_by_octoclaw" ]]; then
    cmd+=(--managed-by-octoclaw "$managed_by_octoclaw")
  fi
  "${cmd[@]}" >/dev/null
}

record_runner_started() {
  local job_id="$1"
  local worker_id="$2"
  local payload
  payload="$("$PYTHON_BIN" - "$job_id" "$worker_id" <<'PY'
import json
import sys

job_id = sys.argv[1] if len(sys.argv) > 1 else ""
worker_id = sys.argv[2] if len(sys.argv) > 2 else ""
print(json.dumps({
    "runner_job_id": job_id,
    "worker_id": worker_id,
    "execution_backend": "runner_queue",
}))
PY
)"
  "$PYTHON_BIN" "$TASK_STATE_PY" event \
    --id "$job_id" \
    --kind runner_started \
    --message "runner started on ${worker_id}" \
    --event-json "$payload" >/dev/null
}

finish_task() {
  local job_id="$1"
  local outcome="$2"
  local summary="$3"
  local report_path="${4:-}"
  local artifacts_json="${5:-}"
  local cmd=("$PYTHON_BIN" "$TASK_STATE_PY" "$outcome" --id "$job_id" --summary "$summary")
  if [[ -n "$report_path" ]]; then
    cmd+=(--report-path "$report_path")
  fi
  if [[ -n "$artifacts_json" ]]; then
    cmd+=(--artifacts-json "$artifacts_json")
  fi
  "${cmd[@]}" >/dev/null
}

recycle_runner() {
  local reason="$1"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] runner_loop recycle: ${reason} jobs_completed=${jobs_completed}"
  exit 0
}

while true; do
  now_epoch="$(date +%s)"
  if (( MAX_AGE_MINUTES > 0 )) && (( now_epoch - START_EPOCH >= MAX_AGE_MINUTES * 60 )); then
    recycle_runner "max_age_minutes_reached"
  fi
  if (( now_epoch - last_heartbeat >= HEARTBEAT_INTERVAL )); then
    heartbeat ""
    last_heartbeat="$now_epoch"
  fi

  claim_args=("$PYTHON_BIN" "$QUEUE_PY" claim --worker-id "$WORKER_ID")
  preferred_job_id="${RUNNER_PREFERRED_JOB_ID:-}"
  if [[ -z "$preferred_job_id" && "$WORKER_ID" == runner-ondemand-* ]]; then
    preferred_job_id="${WORKER_ID#runner-ondemand-}"
  fi
  if [[ -z "$preferred_job_id" && "$WORKER_ID" == runner-bootstrap-* ]]; then
    preferred_job_id="${WORKER_ID#runner-bootstrap-}"
  fi
  if [[ -n "$preferred_job_id" ]]; then
    claim_args+=(--job-id "$preferred_job_id")
  fi
  job_json="$("${claim_args[@]}")"
  if [[ "$job_json" == "{}" ]]; then
    if (( jobs_completed > 0 )) && (( MAX_IDLE_SECONDS > 0 )) && (( now_epoch - last_job_epoch >= MAX_IDLE_SECONDS )); then
      recycle_runner "max_idle_seconds_reached"
    fi
    sleep "$POLL_INTERVAL"
    continue
  fi

  job_dump="$("$PYTHON_BIN" - "$job_json" <<'PY'
import base64
import json
import sys

job = json.loads(sys.argv[1])
for key in ("id", "command", "cwd", "timeout_seconds", "summary", "model", "task_description", "session_key", "session_id", "agent_id", "agent_namespace", "managed_by_octoclaw"):
    value = str(job.get(key, ""))
    print(base64.b64encode(value.encode("utf-8")).decode("ascii"))
PY
)"

  job_fields=()
  while IFS= read -r line; do
    job_fields+=("$line")
  done <<EOF
$job_dump
EOF
  decode_field() {
    "$PYTHON_BIN" - "$1" <<'PY'
import base64
import sys
raw = sys.argv[1] if len(sys.argv) > 1 else ""
if not raw:
    print("")
else:
    print(base64.b64decode(raw.encode("ascii")).decode("utf-8"))
PY
  }
  job_id="$(decode_field "${job_fields[0]:-}")"
  command="$(decode_field "${job_fields[1]:-}")"
  cwd="$(decode_field "${job_fields[2]:-}")"
  timeout_seconds="$(decode_field "${job_fields[3]:-}")"
  summary="$(decode_field "${job_fields[4]:-}")"
  model="$(decode_field "${job_fields[5]:-}")"
task_description="$(decode_field "${job_fields[6]:-}")"
session_key="$(decode_field "${job_fields[7]:-}")"
session_id="$(decode_field "${job_fields[8]:-}")"
agent_id="$(decode_field "${job_fields[9]:-}")"
agent_namespace="$(decode_field "${job_fields[10]:-}")"
managed_by_octoclaw="$(decode_field "${job_fields[11]:-}")"
  cwd="${cwd:-$WORKSPACE}"
  timeout_seconds="${timeout_seconds:-$DEFAULT_TIMEOUT}"

  results_dir="${WORKSPACE}/tmp/octopus/runner-results"
  mkdir -p "$results_dir"
  stdout_file="${results_dir}/${job_id}.stdout.log"
  stderr_file="${results_dir}/${job_id}.stderr.log"
  meta_file="${results_dir}/${job_id}.json"

  heartbeat "$job_id"
  update_task_running "$job_id" "$model" "$summary" "$task_description" "$session_key" "$session_id" "$agent_id" "$agent_namespace" "$managed_by_octoclaw"
  record_runner_started "$job_id" "$WORKER_ID"

  set +e
  (
    cd "$cwd" 2>/dev/null || cd "$WORKSPACE"
    "$PYTHON_BIN" - "$command" "$timeout_seconds" "$stdout_file" "$stderr_file" <<'PY'
import subprocess
import sys

command, timeout_seconds, stdout_file, stderr_file = sys.argv[1:]
with open(stdout_file, "w", encoding="utf-8") as stdout_fp, open(stderr_file, "w", encoding="utf-8") as stderr_fp:
    try:
        result = subprocess.run(
            ["/bin/bash", "-lc", command],
            stdout=stdout_fp,
            stderr=stderr_fp,
            timeout=int(timeout_seconds),
            check=False,
        )
        raise SystemExit(result.returncode)
    except subprocess.TimeoutExpired:
        stderr_fp.write(f"runner timeout after {timeout_seconds}s\n")
        raise SystemExit(124)
PY
  )
  exit_code=$?
  set -e

  result_status="done"
  if [[ $exit_code -ne 0 ]]; then
    result_status="failed"
  fi

  report_file="${WORKSPACE}/tmp/octopus/shared/${job_id}.md"
report_dump="$("$PYTHON_BIN" - "$SCRIPT_DIR" "$meta_file" "$job_id" "$command" "$cwd" "$timeout_seconds" "$exit_code" "$stdout_file" "$stderr_file" "$result_status" "$report_file" "$WORKER_ID" "$session_key" "$session_id" "$agent_id" "$agent_namespace" "$managed_by_octoclaw" <<'PY'
import base64
import json
import os
import sys
from datetime import datetime, timezone

script_dir = sys.argv[1]
if script_dir not in sys.path:
    sys.path.insert(0, script_dir)

from runtime_protocol import normalize_worker_result

(
    _script_dir,
    meta_file,
    job_id,
    command,
    cwd,
    timeout_seconds,
    exit_code,
    stdout_file,
    stderr_file,
    status,
    report_path,
    worker_id,
    session_key,
    session_id,
    agent_id,
    agent_namespace,
    managed_by_octoclaw,
) = sys.argv[1:]

def read_text(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""

def excerpt(text: str, limit_lines: int = 40, limit_chars: int = 1600) -> str:
    lines = [line.rstrip() for line in text.splitlines()]
    if limit_lines > 0:
        lines = lines[:limit_lines]
    payload = "\n".join(lines).strip()
    if len(payload) <= limit_chars:
        return payload
    return payload[: limit_chars - 1].rstrip() + "…"

def first_line(*texts: str) -> str:
    for text in texts:
        for raw in text.splitlines():
            line = raw.strip()
            if line:
                return line
    return ""

def compact_text(text: str, limit: int = 120) -> str:
    collapsed = " ".join((text or "").strip().split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 1].rstrip() + "…"

stdout_text = read_text(stdout_file)
stderr_text = read_text(stderr_file)
stdout_excerpt = excerpt(stdout_text)
stderr_excerpt = excerpt(stderr_text)
first = compact_text(first_line(stderr_text, stdout_text) if status == "failed" else first_line(stdout_text, stderr_text), 110)

if status == "done":
    summary = f"Runner completed · {first}" if first and not first.startswith(('{', '[')) else "Runner completed"
else:
    summary = f"Runner failed exit={exit_code} · {first}" if first and not first.startswith(('{', '[')) else f"Runner failed exit={exit_code}"

report_lines = [
    f"# Runner Result: {job_id}",
    "",
    f"- status: {status}",
    f"- exit_code: {exit_code}",
    f"- cwd: `{cwd}`",
    f"- timeout_seconds: {timeout_seconds}",
    f"- worker_id: {worker_id}",
    "",
    "## Command",
    "```bash",
    command,
    "```",
    "",
    f"- stdout_file: `{stdout_file}`",
    f"- stderr_file: `{stderr_file}`",
]

if stdout_excerpt:
    report_lines.extend(["", "## Stdout Excerpt", "```text", stdout_excerpt, "```"])
if stderr_excerpt:
    report_lines.extend(["", "## Stderr Excerpt", "```text", stderr_excerpt, "```"])

os.makedirs(os.path.dirname(report_path), exist_ok=True)
with open(report_path, "w", encoding="utf-8") as fh:
    fh.write("\n".join(report_lines).rstrip() + "\n")

artifacts = {
    "execution_backend": "runner_queue",
    "command": command,
    "cwd": cwd,
    "timeout_seconds": int(timeout_seconds or 0),
    "exit_code": int(exit_code),
    "stdout_file": stdout_file,
    "stderr_file": stderr_file,
    "stdout_excerpt": stdout_excerpt,
    "stderr_excerpt": stderr_excerpt,
    "result_path": meta_file,
    "report_path": report_path,
    "worker_id": worker_id,
    "session_key": session_key,
    "session_id": session_id,
    "agent_id": agent_id,
    "agent_namespace": agent_namespace,
    "managed_by_octoclaw": managed_by_octoclaw,
}
worker_result = normalize_worker_result(
    {
        "task_id": job_id,
        "status": status,
        "summary": summary,
        "report": report_path,
        "artifacts": [report_path],
        "files": [],
        "risks": [],
        "next_step": "none" if status == "done" else "inspect report and retry or replan",
    },
    task_id=job_id,
    default_report=report_path,
)
artifacts["worker_result"] = worker_result

payload = {
    "id": job_id,
    "command": command,
    "cwd": cwd,
    "timeout_seconds": int(timeout_seconds or 0),
    "exit_code": int(exit_code),
    "stdout_file": stdout_file,
    "stderr_file": stderr_file,
    "stdout_excerpt": stdout_excerpt,
    "stderr_excerpt": stderr_excerpt,
    "status": status,
    "summary": summary,
    "report_path": report_path,
    "result_path": meta_file,
    "worker_id": worker_id,
    "session_key": session_key,
    "session_id": session_id,
    "agent_id": agent_id,
    "agent_namespace": agent_namespace,
    "managed_by_octoclaw": managed_by_octoclaw,
    "execution_backend": "runner_queue",
    "finished_at": datetime.now(timezone.utc).astimezone().isoformat(),
    "worker_result": worker_result,
}
with open(meta_file, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, ensure_ascii=False, indent=2)

for value in (summary, report_path, json.dumps(artifacts, ensure_ascii=False)):
    print(base64.b64encode(value.encode("utf-8")).decode("ascii"))
PY
)"

  report_fields=()
  while IFS= read -r line; do
    report_fields+=("$line")
  done <<EOF
$report_dump
EOF
  result_summary="$(decode_field "${report_fields[0]:-}")"
  report_path="$(decode_field "${report_fields[1]:-}")"
  artifacts_json="$(decode_field "${report_fields[2]:-}")"

  "$PYTHON_BIN" "$QUEUE_PY" complete \
    --id "$job_id" \
    --status "$result_status" \
    --summary "$result_summary" \
    --exit-code "$exit_code" \
    --result-path "$meta_file" >/dev/null

  finish_task "$job_id" "$result_status" "$result_summary" "$report_path" "$artifacts_json"

  jobs_completed=$((jobs_completed + 1))
  last_job_epoch="$(date +%s)"
  heartbeat "$job_id" "$result_status"

  if (( jobs_completed >= MAX_JOBS )); then
    recycle_runner "max_jobs_reached"
  fi
  if (( MAX_AGE_MINUTES > 0 )) && (( last_job_epoch - START_EPOCH >= MAX_AGE_MINUTES * 60 )); then
    recycle_runner "max_age_minutes_reached_post_job"
  fi
done
