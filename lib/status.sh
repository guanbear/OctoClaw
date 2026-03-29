#!/bin/bash
# 八爪鱼状态查询脚本
# 用法：
#   bash /workspace/openclaw/skills/octopus/lib/status.sh
#   bash /workspace/openclaw/skills/octopus/lib/status.sh --format table
#   bash /workspace/openclaw/skills/octopus/lib/status.sh --format lanes

FORMAT="compact"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --format)
            FORMAT="${2:-compact}"
            shift 2
            ;;
        --table)
            FORMAT="table"
            shift
            ;;
        --lanes)
            FORMAT="lanes"
            shift
            ;;
        *)
            shift
            ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

python3 - "$FORMAT" "$SCRIPT_DIR" <<'PYEOF'
import json
import os
import sys
from datetime import datetime, timedelta, timezone

fmt = sys.argv[1] if len(sys.argv) > 1 else "compact"
script_dir = sys.argv[2] if len(sys.argv) > 2 else os.getcwd()
sys.path.insert(0, script_dir)

from octopus_config import (
    CONFIG_FILE,
    MODE_FILE,
    MODEL_POLICY_FILE,
    RUNNER_HEALTH_FILE,
    MAIN_AGENT_SESSIONS_FILE,
    resolve_main_session_key,
    load_json,
    load_octopus_config,
    workbench_config,
)
from clawteam_bridge import load_bridge_summary
from model_health import load_model_health_state
from main_model_drift import assess_main_model_drift
from replay_summary import (
    DEFAULT_MAX_BLOCKED_SESSION_RATE,
    DEFAULT_MIN_DELEGATED_EVENTS,
    DEFAULT_MIN_POLICY_EVENTS,
    DEFAULT_MIN_ROUTE_HINT_SUBMISSION_RATE,
    DEFAULT_MIN_RUNNER_EVENTS,
    DEFAULT_REPLAY_LOG,
    compact_ratio,
    infer_runtime_policy_phase,
    load_events,
    summarize_events,
)
from status_render import (
    build_status_snapshot,
    render_main_model_drift_summary,
    render_model_health_summary,
    render_status_lanes,
    render_status_table,
    render_status_text_compact,
    short_model,
    summarize_model_health,
)

TASK_FILE = "/workspace/tmp/octopus/task-state.json"
RUNNER_QUEUE_FILE = "/workspace/tmp/octopus/runner-queue.json"

now = datetime.now(timezone(timedelta(hours=8)))

mode_data = load_json(MODE_FILE) or {}
policy_data = load_json(MODEL_POLICY_FILE) or {}
config_data = load_octopus_config()
runner_health = load_json(RUNNER_HEALTH_FILE) or {}
model_health_state = load_model_health_state()
RUNNER_STALE_SECONDS = 120
workbench = workbench_config(config_data)
model_auto_cfg = config_data.get("model_auto", {}) if isinstance(config_data, dict) else {}
auto_policy_ready = bool(model_auto_cfg.get("enabled", True)) and any(
    isinstance(policy_data.get(key), dict) and policy_data.get(key)
    for key in ("profiles", "worker_pools", "worker_pool_phases")
)

mode = "auto"
mode_label = "自动选模（policy-first）"


def summarize_replay_status(config: dict) -> dict | None:
    runtime_policy = config.get("runtime_policy") if isinstance(config, dict) else {}
    if not isinstance(runtime_policy, dict):
        return None
    switches = runtime_policy.get("switches")
    if not isinstance(switches, dict) or not switches.get("replay_logging", False):
        return None

    phase = infer_runtime_policy_phase(runtime_policy)
    replay_path = DEFAULT_REPLAY_LOG
    if not replay_path.exists():
        return {
            "phase": phase,
            "missing": True,
            "path": str(replay_path),
        }

    summary_phase = "guided" if phase == "enforced" else phase
    events, source_format, invalid_lines = load_events(replay_path)
    summary = summarize_events(
        events,
        source_path=str(replay_path),
        source_format=source_format,
        invalid_lines=invalid_lines,
        phase=summary_phase,
        min_policy_events=DEFAULT_MIN_POLICY_EVENTS,
        min_runner_events=DEFAULT_MIN_RUNNER_EVENTS,
        min_delegated_events=DEFAULT_MIN_DELEGATED_EVENTS,
        max_blocked_session_rate=DEFAULT_MAX_BLOCKED_SESSION_RATE,
        min_route_hint_submission_rate=DEFAULT_MIN_ROUTE_HINT_SUBMISSION_RATE,
    )
    summary["effective_phase"] = phase
    summary["missing"] = False
    return summary


def worker_pool_model_full(worker_pool):
    return str(policy_data.get("worker_pools", {}).get(worker_pool, "") or "").strip() or "?"


def _extract_session_model_from_file(session_file):
    if not session_file or not os.path.exists(session_file):
        return ("", "")
    try:
        with open(session_file, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except Exception:
        return ("", "")

    def is_real_inference_model(provider, model_id):
        provider = str(provider or "").strip().lower()
        model_id = str(model_id or "").strip().lower()
        full = f"{provider}/{model_id}" if provider else model_id
        if not model_id:
            return False
        ignored_prefixes = (
            "openclaw/",
            "system/",
        )
        ignored_models = {
            "delivery-mirror",
            "tool-result",
        }
        if full.startswith(ignored_prefixes):
            return False
        if model_id in ignored_models:
            return False
        return True

    for raw in reversed(lines[-400:]):
        try:
            event = json.loads(raw)
        except Exception:
            continue
        if event.get("type") == "custom" and event.get("customType") == "model-snapshot":
            data = event.get("data") or {}
            provider = str(data.get("provider") or "").strip()
            model_id = str(data.get("modelId") or "").strip()
            if is_real_inference_model(provider, model_id):
                return (f"{provider}/{model_id}" if provider else model_id, "model-snapshot")
        if event.get("type") == "model_change":
            provider = str(event.get("provider") or "").strip()
            model_id = str(event.get("modelId") or "").strip()
            if is_real_inference_model(provider, model_id):
                return (f"{provider}/{model_id}" if provider else model_id, "model_change")
        if event.get("type") == "message":
            msg = event.get("message") or {}
            if msg.get("role") == "assistant":
                provider = str(msg.get("provider") or "").strip()
                model_id = str(msg.get("model") or "").strip()
                if is_real_inference_model(provider, model_id):
                    return (f"{provider}/{model_id}" if provider else model_id, "assistant-message")
    return ("", "")


def load_main_session_actual_model():
    session_key = resolve_main_session_key(config_data) or "agent:main:main"
    session_index = load_json(MAIN_AGENT_SESSIONS_FILE) or {}
    session_entry = session_index.get(session_key) or {}
    if not session_entry and session_key:
        for value in session_index.values():
            if isinstance(value, dict) and str(value.get("channelSessionKey", "") or "").strip() == session_key:
                session_entry = value
                break
    if not session_entry and session_key != "agent:main:main":
        session_entry = session_index.get("agent:main:main") or {}
    session_file = str(session_entry.get("sessionFile") or "").strip()
    model_path, source = _extract_session_model_from_file(session_file)
    return {
        "session_key": session_key,
        "session_file": session_file,
        "model_path": model_path,
        "source": source,
    }


def load_tasks():
    if not os.path.exists(TASK_FILE):
        return []
    try:
        with open(TASK_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        tasks = data.get("tasks", [])
        tasks = [task for task in tasks if task.get("source") in {"octoclaw", "octopus"}]
        queue_raw = load_json(RUNNER_QUEUE_FILE) or {}
        jobs = queue_raw.get("jobs", []) if isinstance(queue_raw, dict) else []
        queue_by_id = {
            str(job.get("id")): job
            for job in jobs
            if isinstance(job, dict) and str(job.get("id", "")).startswith("runner-")
        }
        for task in tasks:
            job = queue_by_id.get(str(task.get("id", "")))
            if not job:
                continue
            job_status = str(job.get("status", "") or "")
            if job_status in ("done", "failed"):
                task["status"] = "done" if job_status == "done" else "failed"
                task["summary"] = str(job.get("summary") or task.get("summary") or "")
                if job.get("started_at"):
                    task["started_at"] = job.get("started_at")
                if job.get("finished_at"):
                    task["completed_at"] = job.get("finished_at")
                if job.get("model"):
                    task["model"] = job.get("model")
                if job.get("task_description"):
                    task["task_description"] = job.get("task_description")
        return tasks
    except Exception:
        return []


ts = now.strftime("%Y-%m-%d %H:%M")
print(f"🐙 八爪鱼状态 [{ts}]")
print("━━━━━━━━━━━━━━━━━━━━")
print(f"⚙️  模式：{mode_label}")
backend = config_data.get("notification", {}).get("backend", "auto")
print(f"🔔 通知：{backend}")
bridge_summary = load_bridge_summary()
if bridge_summary.get("enabled"):
    counts = bridge_summary.get("counts", {}) or {}
    bridge_tasks = sum(int(v or 0) for v in counts.values())
    backend = bridge_summary.get("backend", "mirror")
    cli_note = ""
    if backend in ("hybrid", "cli"):
        cli_note = " · cli-ready" if bridge_summary.get("cli_available") else " · cli-missing"
    print(
        f"🤝 Bridge：{bridge_summary.get('team', 'octoclaw-validation')} · "
        f"{backend}{cli_note} · tasks {bridge_tasks} · "
        f"lineages {bridge_summary.get('lineage_count', 0)} · inbox {bridge_summary.get('inbox_count', 0)}"
    )
replay_status = summarize_replay_status(config_data)
if replay_status:
    if replay_status.get("missing"):
        print(f"🧪 RuntimePolicy：{replay_status.get('phase', 'conservative')} · replay missing")
    else:
        promotion = replay_status.get("promotion", {}) or {}
        effective_phase = str(replay_status.get("effective_phase") or promotion.get("phase") or "conservative")
        target = str(promotion.get("target") or effective_phase)
        ready = bool(promotion.get("ready"))
        next_label = f"建议升 {target}" if ready and effective_phase != "enforced" else f"继续 {effective_phase}"
        if effective_phase == "enforced":
            next_label = "已在 enforced"
        task_metrics = replay_status.get("task_metrics", {}) or {}
        route_hint_metrics = replay_status.get("route_hint_metrics", {}) or {}
        tool_metrics = replay_status.get("tool_metrics", {}) or {}
        observed_packs = replay_status.get("observed_language_packs", {}) or {}
        packs_text = ", ".join(observed_packs.keys()) if observed_packs else "n/a"
        print(
            f"🧪 RuntimePolicy：{effective_phase} · {next_label} · "
            f"tasks {task_metrics.get('task_event_count', 0)} · "
            f"runner {task_metrics.get('runner_task_count', 0)} · "
            f"delegated {task_metrics.get('delegated_task_count', 0)}"
        )
        print(
            "   replay: "
            f"hint {compact_ratio(route_hint_metrics.get('submission_rate'))} · "
            f"blocked {compact_ratio(tool_metrics.get('blocked_session_rate'))} · "
            f"packs {packs_text}"
        )
runner_health_ok = False
runner_health_age = None
if isinstance(runner_health, dict) and runner_health.get("worker_id"):
    runner_job = runner_health.get("job_id", "")
    runner_note = ""
    heartbeat = runner_health.get("last_heartbeat_at", "")
    heartbeat_dt = None
    try:
        if heartbeat:
            if heartbeat.endswith("Z"):
                heartbeat = heartbeat[:-1] + "+00:00"
            heartbeat_dt = datetime.fromisoformat(heartbeat)
            if heartbeat_dt.tzinfo:
                heartbeat_dt = heartbeat_dt.astimezone(now.tzinfo)
    except Exception:
        heartbeat_dt = None
    if heartbeat_dt:
        runner_health_age = int(max(0, (now - heartbeat_dt).total_seconds()))
        runner_health_ok = runner_health_age <= RUNNER_STALE_SECONDS
    if runner_job and heartbeat_dt and runner_health_ok and (now - heartbeat_dt).total_seconds() <= 30:
        runner_note = f" · 当前任务 {runner_job}"
    stale_note = ""
    if runner_health_age is not None and not runner_health_ok:
        stale_note = f" · stale {runner_health_age}s"
    print(f"🏃 Runner：{runner_health.get('worker_id')}{runner_note}{stale_note}")
main_session_model = load_main_session_actual_model()
actual_model = main_session_model.get("model_path", "")
model_health_summary = summarize_model_health(model_health_state)
for line in render_model_health_summary(model_health_summary):
    print(line)
print("A) 🤖 主会话实际模型：" + (actual_model or "?"))
print(f"B) 🧭 OctoClaw 调度策略：{mode_label}")
print(
    "   runner → "
    f"{worker_pool_model_full('octoclaw-runner')}  |  research → {worker_pool_model_full('octoclaw-research')}  |  "
    f"code → {worker_pool_model_full('octoclaw-code')}  |  review → {worker_pool_model_full('octoclaw-review')}"
)
main_model = str(policy_data.get("main_model", "") or "").strip()
if main_model:
    print(f"   策略主链 → {main_model}")
main_drift = assess_main_model_drift(config=config_data)
for line in render_main_model_drift_summary(main_drift):
    print(line)
print(f"🖥️  视图：{fmt}")
workbench_mode = str(workbench.get("supervisor_mode", "auto") or "auto").strip() or "auto"
tmux_session_name = str(workbench.get("tmux_session_name", "") or "").strip()
if workbench_mode == "tmux" and tmux_session_name:
    runner_window = str(workbench.get("tmux_runner_window_name", "runner") or "runner").strip() or "runner"
    patrol_window = str(workbench.get("tmux_patrol_window_name", "patrol") or "patrol").strip() or "patrol"
    print(f"🧰 Workbench：tmux {tmux_session_name} · runner={runner_window} · patrol={patrol_window}")
else:
    print(f"🧰 Workbench：{workbench_mode}")
print("━━━━━━━━━━━━━━━━━━━━")

tasks = load_tasks()
if not runner_health_ok and isinstance(runner_health, dict) and runner_health.get("worker_id"):
    for task in tasks:
        if str(task.get("executor", "") or "") == "runner" and str(task.get("status", "") or "") in ("running", "dispatched"):
            task["status"] = "queued"
            task["summary"] = str(task.get("summary") or "runner 心跳过期，等待恢复")
snapshot = build_status_snapshot(tasks, now=now)

if fmt == "table":
    print(render_status_table(snapshot))
elif fmt == "lanes":
    print(render_status_lanes(snapshot))
else:
    print(render_status_text_compact(snapshot))

print("━━━━━━━━━━━━━━━━━━━━")
PYEOF
