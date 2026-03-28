#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="${WORKSPACE:-/workspace}"
QUEUE_PY="$SCRIPT_DIR/runner_queue.py"
TASK_STATE_PY="$SCRIPT_DIR/task-state-update.py"

POLL_INTERVAL="${RUNNER_POLL_INTERVAL_SECONDS:-3}"
HEARTBEAT_INTERVAL="${RUNNER_HEARTBEAT_INTERVAL_SECONDS:-10}"
DEFAULT_TIMEOUT="${RUNNER_DEFAULT_TIMEOUT_SECONDS:-120}"
MAX_AGE_MINUTES="${RUNNER_MAX_AGE_MINUTES:-120}"
MAX_IDLE_SECONDS="${RUNNER_MAX_IDLE_SECONDS:-900}"
MAX_JOBS="${RUNNER_MAX_JOBS_PER_WORKER:-30}"
WORKER_ID="${RUNNER_WORKER_ID:-runner-$(hostname)-$$}"
STARTED_AT="$(python3 - <<'PY'
from datetime import datetime, timezone
print(datetime.now(timezone.utc).astimezone().isoformat())
PY
)"
START_EPOCH="$(date +%s)"

jobs_completed=0
last_heartbeat=0
last_job_epoch="$START_EPOCH"

python3 "$QUEUE_PY" ensure >/dev/null

heartbeat() {
  python3 "$QUEUE_PY" heartbeat \
    --worker-id "$WORKER_ID" \
    --pid "$$" \
    --job-id "${1:-}" \
    --jobs-completed "$jobs_completed" \
    --started-at "$STARTED_AT" >/dev/null
}

update_task_running() {
  local job_id="$1"
  local model="$2"
  local summary="$3"
  local task_description="$4"
  python3 "$TASK_STATE_PY" upsert \
    --id "$job_id" \
    --label octopus-runner \
    --model "$model" \
    --status running \
    --summary "$summary" \
    --tier trivial \
    --task-description "$task_description" \
    --title "$summary" \
    --executor runner \
    --route runner \
    --runtime runner \
    --worker-pool octoclaw-runner \
    --work-type ops \
    --phase inspect \
    --protocol normal \
    --profile ops-fast \
    --review-required false >/dev/null
}

finish_task() {
  local job_id="$1"
  local outcome="$2"
  local summary="$3"
  local report_path="${4:-}"
  local artifacts_json="${5:-}"
  local cmd=(python3 "$TASK_STATE_PY" "$outcome" --id "$job_id" --summary "$summary")
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

  job_json="$(python3 "$QUEUE_PY" claim --worker-id "$WORKER_ID")"
  if [[ "$job_json" == "{}" ]]; then
    if (( jobs_completed > 0 )) && (( MAX_IDLE_SECONDS > 0 )) && (( now_epoch - last_job_epoch >= MAX_IDLE_SECONDS )); then
      recycle_runner "max_idle_seconds_reached"
    fi
    sleep "$POLL_INTERVAL"
    continue
  fi

  job_dump="$(python3 - "$job_json" <<'PY'
import base64
import json
import sys

job = json.loads(sys.argv[1])
for key in ("id", "command", "cwd", "timeout_seconds", "summary", "model", "task_description"):
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
    python3 - "$1" <<'PY'
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
  cwd="${cwd:-/workspace}"
  timeout_seconds="${timeout_seconds:-$DEFAULT_TIMEOUT}"

  results_dir="${WORKSPACE}/tmp/octopus/runner-results"
  mkdir -p "$results_dir"
  stdout_file="${results_dir}/${job_id}.stdout.log"
  stderr_file="${results_dir}/${job_id}.stderr.log"
  meta_file="${results_dir}/${job_id}.json"

  heartbeat "$job_id"
  update_task_running "$job_id" "$model" "$summary" "$task_description"

  set +e
  (
    cd "$cwd" 2>/dev/null || cd "$WORKSPACE"
    python3 - "$command" "$timeout_seconds" "$stdout_file" "$stderr_file" <<'PY'
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
  report_dump="$(python3 - "$meta_file" "$job_id" "$command" "$cwd" "$timeout_seconds" "$exit_code" "$stdout_file" "$stderr_file" "$result_status" "$report_file" "$WORKER_ID" <<'PY'
import base64
import json
import os
import sys
from datetime import datetime, timezone

(
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
    summary = f"runner完成: {first}" if first else "runner完成"
else:
    summary = f"runner失败 exit={exit_code}: {first}" if first else f"runner失败 exit={exit_code}"

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
}

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
    "execution_backend": "runner_queue",
    "finished_at": datetime.now(timezone.utc).astimezone().isoformat(),
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

  python3 "$QUEUE_PY" complete \
    --id "$job_id" \
    --status "$result_status" \
    --summary "$result_summary" \
    --exit-code "$exit_code" \
    --result-path "$meta_file" >/dev/null

  finish_task "$job_id" "$result_status" "$result_summary" "$report_path" "$artifacts_json"

  jobs_completed=$((jobs_completed + 1))
  last_job_epoch="$(date +%s)"
  heartbeat ""

  if (( jobs_completed >= MAX_JOBS )); then
    recycle_runner "max_jobs_reached"
  fi
  if (( MAX_AGE_MINUTES > 0 )) && (( last_job_epoch - START_EPOCH >= MAX_AGE_MINUTES * 60 )); then
    recycle_runner "max_age_minutes_reached_post_job"
  fi
done
