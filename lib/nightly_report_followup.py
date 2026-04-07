#!/usr/bin/env python3
"""VM-side nightly follow-up for macmini replay validation reports."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

try:
    from notifier import send_task_notification
    from octopus_config import DEFAULT_CONFIG, CONFIG_FILE, deep_merge, load_json, load_octopus_config, resolve_main_session_key
    from session_ops import resolve_message_target_from_session_key, send_channel_message
except ModuleNotFoundError:
    from lib.notifier import send_task_notification
    from lib.octopus_config import DEFAULT_CONFIG, CONFIG_FILE, deep_merge, load_json, load_octopus_config, resolve_main_session_key
    from lib.session_ops import resolve_message_target_from_session_key, send_channel_message


DEFAULT_TIMEZONE = "Asia/Shanghai"
DEFAULT_BRANCH = "codex/release-v0.1.0"
DEFAULT_REPORT_TEMPLATE = "reports/reply-review-validation/{day}.md"
DEFAULT_OUTPUT_TEMPLATE = "tmp/octopus/nightly-followup/{day}/followup-report.md"
DEFAULT_LOG_TEMPLATE = "tmp/octopus/nightly-followup/{day}/run.json"


def parse_bool(value: str | None) -> bool:
    if value is None:
        return False
    text = str(value).strip().lower()
    return text in {"1", "true", "yes", "on"}


def normalize_openclaw_home(openclaw_home: str) -> str:
    candidate = Path(str(openclaw_home or "")).expanduser()
    if not str(candidate):
        return str(Path.home())
    if candidate.name == ".openclaw":
        return str(candidate.parent)
    if (candidate / "openclaw.json").exists():
        return str(candidate.parent)
    return str(candidate)


def default_report_day(timezone_name: str) -> str:
    tz = ZoneInfo(timezone_name)
    return (datetime.now(tz) - timedelta(days=1)).strftime("%Y-%m-%d")


def render_template(template: str, *, day: str) -> str:
    return str(template).format(day=day)


def build_report_path(repo_root: Path, day: str, template: str = DEFAULT_REPORT_TEMPLATE) -> Path:
    return repo_root / render_template(template, day=day)


def build_output_path(workspace: Path, day: str, template: str = DEFAULT_OUTPUT_TEMPLATE) -> Path:
    return workspace / render_template(template, day=day)


def build_log_path(workspace: Path, day: str, template: str = DEFAULT_LOG_TEMPLATE) -> Path:
    return workspace / render_template(template, day=day)


def build_followup_prompt(
    *,
    report_path: Path,
    output_report_path: Path,
    repo_root: Path,
    fix_enabled: bool,
) -> str:
    fix_instructions = (
        "If you identify a high-confidence, low-risk fix, implement it directly in the repo, "
        "then run focused verification."
        if fix_enabled
        else "Do not edit code. Limit yourself to analysis, suggested fixes, and verification advice."
    )
    return "\n".join(
        [
            "You are the VM-side OctoClaw nightly follow-up worker.",
            "",
            f"Read the replay validation report at `{report_path}` and use it as the primary input.",
            f"Work in repo `{repo_root}`.",
            fix_instructions,
            "",
            "Required workflow:",
            "1. Read the report and identify the most actionable regression or bug signal.",
            "2. Inspect the relevant code and confirm whether the issue is still present.",
            "3. If fix_enabled and confidence is high, make the smallest reasonable fix.",
            "4. Run targeted verification commands for the area you touched.",
            f"5. Write a markdown follow-up report to `{output_report_path}`.",
            "",
            "The markdown report must contain exactly these sections:",
            "1. Executive Summary",
            "2. Findings Confirmed",
            "3. Changes Made",
            "4. Verification",
            "5. Risks / Follow-ups",
            "",
            "In your final chat reply, keep it short and include:",
            "- status",
            "- whether code changed",
            "- verification outcome",
            f"- report path `{output_report_path}`",
        ]
    )


def parse_agent_json(stdout_text: str) -> tuple[str, dict[str, Any]]:
    raw = (stdout_text or "").strip()
    if not raw:
        return "", {}
    payload = json.loads(raw)
    parts: list[str] = []
    for item in payload.get("payloads", []):
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if text:
            parts.append(text)
    return "\n\n".join(parts).strip(), payload


def _run(
    args: list[str],
    *,
    env: dict[str, str] | None = None,
    timeout: int | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        check=False,
        capture_output=True,
        text=True,
        env=env,
        timeout=timeout,
    )


def timeout_result(reason: str, exc: subprocess.TimeoutExpired) -> dict[str, Any]:
    stdout = exc.stdout if isinstance(exc.stdout, str) else ""
    stderr = exc.stderr if isinstance(exc.stderr, str) else ""
    return {
        "ok": False,
        "reason": reason,
        "return_code": None,
        "reply_text": "",
        "payload": {},
        "stderr": (stderr or stdout or str(exc)).strip(),
    }


def sync_repo(repo_root: Path, branch: str) -> dict[str, Any]:
    fetch = _run(["git", "-C", str(repo_root), "fetch", "origin", branch])
    if fetch.returncode != 0:
        return {
            "ok": False,
            "step": "fetch",
            "return_code": fetch.returncode,
            "stderr": (fetch.stderr or fetch.stdout or "").strip(),
        }
    reset = _run(["git", "-C", str(repo_root), "reset", "--hard", f"origin/{branch}"])
    return {
        "ok": reset.returncode == 0,
        "step": "reset" if reset.returncode != 0 else "done",
        "return_code": reset.returncode,
        "stderr": (reset.stderr or reset.stdout or "").strip(),
    }


def wait_for_report(
    *,
    repo_root: Path,
    branch: str,
    report_path: Path,
    max_wait_seconds: int,
    poll_seconds: int,
    sync_with_git: bool,
) -> dict[str, Any]:
    attempts = 0
    start = time.time()
    last_sync: dict[str, Any] | None = None
    while True:
        attempts += 1
        if sync_with_git:
            last_sync = sync_repo(repo_root, branch)
            if not last_sync.get("ok"):
                return {
                    "ok": False,
                    "reason": "git_sync_failed",
                    "attempts": attempts,
                    "report_path": str(report_path),
                    "sync": last_sync,
                }
        if report_path.exists() and report_path.stat().st_size > 0:
            return {
                "ok": True,
                "attempts": attempts,
                "wait_seconds": int(time.time() - start),
                "report_path": str(report_path),
                "sync": last_sync or {"ok": True, "step": "skipped"},
            }
        elapsed = time.time() - start
        if elapsed >= max_wait_seconds:
            return {
                "ok": False,
                "reason": "report_timeout",
                "attempts": attempts,
                "wait_seconds": int(elapsed),
                "report_path": str(report_path),
                "sync": last_sync or {"ok": True, "step": "skipped"},
            }
        time.sleep(max(1, poll_seconds))


def collect_git_change_summary(repo_root: Path) -> dict[str, Any]:
    status = _run(["git", "-C", str(repo_root), "status", "--short"])
    lines = [line.rstrip() for line in (status.stdout or "").splitlines() if line.strip()]
    changed_files = [line[3:].strip() for line in lines if len(line) >= 4]
    return {
        "status_lines": lines,
        "changed_files": changed_files,
        "changed": bool(lines),
    }


def run_followup_agent(
    *,
    repo_root: Path,
    workspace: Path,
    openclaw_home: str,
    agent_name: str,
    session_id: str,
    prompt: str,
    model: str,
    timeout_seconds: int,
) -> dict[str, Any]:
    env = os.environ.copy()
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + env.get("PATH", "")
    env["WORKSPACE"] = str(workspace)
    env["OPENCLAW_HOME"] = openclaw_home

    add_args = [
        "openclaw",
        "agents",
        "add",
        agent_name,
        "--workspace",
        str(workspace),
        "--non-interactive",
        "--json",
    ]
    if model:
        add_args.extend(["--model", model])
    try:
        add_proc = _run(add_args, env=env, timeout=60)
    except subprocess.TimeoutExpired as exc:
        return timeout_result("agent_add_timeout", exc)
    if add_proc.returncode != 0:
        return {
            "ok": False,
            "reason": "agent_add_failed",
            "return_code": add_proc.returncode,
            "stderr": (add_proc.stderr or add_proc.stdout or "").strip(),
        }

    run_args = [
        "openclaw",
        "agent",
        "--agent",
        agent_name,
        "--session-id",
        session_id,
        "--thinking",
        "medium",
        "--json",
        "--message",
        prompt,
    ]
    try:
        proc = _run(run_args, env=env, timeout=timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        return timeout_result("agent_run_timeout", exc)
    reply_text = ""
    payload: dict[str, Any] = {}
    try:
        reply_text, payload = parse_agent_json(proc.stdout or "")
    except Exception:
        reply_text = (proc.stdout or "").strip()
    return {
        "ok": proc.returncode == 0,
        "return_code": proc.returncode,
        "reply_text": reply_text,
        "payload": payload,
        "stderr": (proc.stderr or "").strip(),
    }


def build_notification_task(
    *,
    day: str,
    session_key: str,
    report_path: Path,
    followup_report_path: Path,
    wait_result: dict[str, Any],
    agent_result: dict[str, Any],
    git_summary: dict[str, Any],
) -> dict[str, Any]:
    changed_files = git_summary.get("changed_files", []) if isinstance(git_summary, dict) else []
    changed_preview = ", ".join(changed_files[:5]) if changed_files else "none"
    verification_line = "agent exited cleanly" if agent_result.get("ok") else "agent failed"
    user_summary = (
        f"{day} nightly follow-up finished. "
        f"Report ready after {wait_result.get('wait_seconds', 0)}s. "
        f"Code changed: {'yes' if git_summary.get('changed') else 'no'}. "
        f"Changed files: {changed_preview}. "
        f"Verification: {verification_line}. "
        f"Follow-up report: {followup_report_path}"
    )
    return {
        "id": f"nightly-followup-{day.replace('-', '')}",
        "session_key": session_key,
        "worker_pool": "octoclaw-review",
        "route": "runner",
        "status": "done" if agent_result.get("ok") else "failed",
        "handoff_state": "user_safe_ready",
        "summary": f"Nightly follow-up for replay validation {day}",
        "user_safe_summary": user_summary,
        "report_path": str(followup_report_path),
        "artifacts": {
            "report_path": str(followup_report_path),
            "source_report_path": str(report_path),
            "changed_files": changed_files,
        },
    }


def send_notification(
    *,
    config: dict[str, Any],
    backend: str,
    report_day: str,
    report_path: Path,
    followup_report_path: Path,
    wait_result: dict[str, Any],
    agent_result: dict[str, Any],
    git_summary: dict[str, Any],
    notify_session_key: str,
    notify_channel: str,
    notify_target: str,
    notify_thread_id: str,
) -> dict[str, Any]:
    resolved_backend = (backend or "auto").strip().lower() or "auto"
    session_key = notify_session_key.strip() or resolve_main_session_key(config)
    if notify_channel and notify_target:
        message = build_notification_task(
            day=report_day,
            session_key="",
            report_path=report_path,
            followup_report_path=followup_report_path,
            wait_result=wait_result,
            agent_result=agent_result,
            git_summary=git_summary,
        )["user_safe_summary"]
        result = send_channel_message(
            notify_channel,
            notify_target,
            message,
            thread_id=notify_thread_id.strip(),
        )
        result["mode"] = "direct_channel"
        return result
    if not session_key:
        return {"ok": False, "reason": "notify_target_missing"}
    task = build_notification_task(
        day=report_day,
        session_key=session_key,
        report_path=report_path,
        followup_report_path=followup_report_path,
        wait_result=wait_result,
        agent_result=agent_result,
        git_summary=git_summary,
    )
    if resolved_backend == "auto":
        parsed = resolve_message_target_from_session_key(session_key)
        if parsed.get("ok"):
            resolved_backend = str(parsed.get("origin") or "").strip().lower() or "auto"
    result = send_task_notification(task, backend=resolved_backend, config=config)
    result["mode"] = "task_notification"
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Nightly follow-up for macmini replay reports")
    subparsers = parser.add_subparsers(dest="command", required=True)

    run = subparsers.add_parser("run")
    run.add_argument("--config", default="")
    run.add_argument("--repo-root", default="")
    run.add_argument("--workspace", default="")
    run.add_argument("--report-day", default="")
    run.add_argument("--timezone", default=DEFAULT_TIMEZONE)
    run.add_argument("--report-template", default=DEFAULT_REPORT_TEMPLATE)
    run.add_argument("--output-template", default=DEFAULT_OUTPUT_TEMPLATE)
    run.add_argument("--log-template", default=DEFAULT_LOG_TEMPLATE)
    run.add_argument("--branch", default=DEFAULT_BRANCH)
    run.add_argument("--sync-with-git", default="true")
    run.add_argument("--max-wait-seconds", type=int, default=3600)
    run.add_argument("--poll-seconds", type=int, default=120)
    run.add_argument("--fix-enabled", default="true")
    run.add_argument("--agent-model", default="")
    run.add_argument("--agent-name", default="")
    run.add_argument("--timeout-seconds", type=int, default=1800)
    run.add_argument("--notify-backend", default="auto")
    run.add_argument("--notify-session-key", default="")
    run.add_argument("--notify-channel", default="")
    run.add_argument("--notify-target", default="")
    run.add_argument("--notify-thread-id", default="")
    run.add_argument("--format", choices=("text", "json"), default="text")

    cron = subparsers.add_parser("render-cron")
    cron.add_argument("--schedule-hour", type=int, default=1)
    cron.add_argument("--schedule-minute", type=int, default=20)
    cron.add_argument("--workspace", default="/workspace")
    cron.add_argument("--openclaw-home", default="/root/.openclaw")
    return parser


def load_config(config_path: str) -> dict[str, Any]:
    configured = str(config_path or "").strip()
    if not configured or Path(configured).resolve() == Path(CONFIG_FILE).resolve():
        return load_octopus_config()
    data = load_json(configured)
    if isinstance(data, dict):
        return deep_merge(DEFAULT_CONFIG, data)
    return json.loads(json.dumps(DEFAULT_CONFIG))


def run_command(args: argparse.Namespace) -> dict[str, Any]:
    repo_root = Path(args.repo_root or Path(__file__).resolve().parents[1]).resolve()
    workspace = Path(args.workspace or os.environ.get("WORKSPACE") or DEFAULT_CONFIG.get("workspace", "/workspace")).resolve()
    report_day = args.report_day or default_report_day(args.timezone)
    report_path = build_report_path(repo_root, report_day, args.report_template)
    followup_report_path = build_output_path(workspace, report_day, args.output_template)
    log_path = build_log_path(workspace, report_day, args.log_template)
    followup_report_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    cfg = load_config(args.config)
    wait_result = wait_for_report(
        repo_root=repo_root,
        branch=args.branch,
        report_path=report_path,
        max_wait_seconds=max(0, args.max_wait_seconds),
        poll_seconds=max(1, args.poll_seconds),
        sync_with_git=parse_bool(args.sync_with_git),
    )
    result: dict[str, Any] = {
        "report_day": report_day,
        "report_path": str(report_path),
        "followup_report_path": str(followup_report_path),
        "log_path": str(log_path),
        "wait_result": wait_result,
        "agent_result": {},
        "git_summary": {},
        "notification": {},
    }
    if wait_result.get("ok"):
        prompt = build_followup_prompt(
            report_path=report_path,
            output_report_path=followup_report_path,
            repo_root=repo_root,
            fix_enabled=parse_bool(args.fix_enabled),
        )
        stamp = datetime.now().strftime("%Y%m%d%H%M%S")
        agent_name = args.agent_name or f"octoclaw-nightly-followup-{report_day.replace('-', '')}-{stamp}"
        session_id = f"{agent_name}-s1"
        openclaw_home = normalize_openclaw_home(str(os.environ.get("OPENCLAW_HOME") or Path.home() / ".openclaw"))
        agent_result = run_followup_agent(
            repo_root=repo_root,
            workspace=workspace,
            openclaw_home=openclaw_home,
            agent_name=agent_name,
            session_id=session_id,
            prompt=prompt,
            model=str(args.agent_model or "").strip(),
            timeout_seconds=max(60, args.timeout_seconds),
        )
        result["agent_result"] = agent_result
        if not followup_report_path.exists():
            followup_report_path.write_text(
                (agent_result.get("reply_text") or "Nightly follow-up completed without a structured report.").strip() + "\n",
                encoding="utf-8",
            )
        git_summary = collect_git_change_summary(repo_root)
        result["git_summary"] = git_summary
        result["notification"] = send_notification(
            config=cfg,
            backend=args.notify_backend,
            report_day=report_day,
            report_path=report_path,
            followup_report_path=followup_report_path,
            wait_result=wait_result,
            agent_result=agent_result,
            git_summary=git_summary,
            notify_session_key=args.notify_session_key,
            notify_channel=args.notify_channel,
            notify_target=args.notify_target,
            notify_thread_id=args.notify_thread_id,
        )
    else:
        failure_text = (
            f"{report_day} nightly follow-up skipped: {wait_result.get('reason', 'unknown')} "
            f"while waiting for {report_path}"
        )
        followup_report_path.write_text(failure_text + "\n", encoding="utf-8")
        result["notification"] = send_notification(
            config=cfg,
            backend=args.notify_backend,
            report_day=report_day,
            report_path=report_path,
            followup_report_path=followup_report_path,
            wait_result=wait_result,
            agent_result={"ok": False, "reason": wait_result.get("reason", "wait_failed")},
            git_summary={"changed": False, "changed_files": [], "status_lines": []},
            notify_session_key=args.notify_session_key,
            notify_channel=args.notify_channel,
            notify_target=args.notify_target,
            notify_thread_id=args.notify_thread_id,
        )
    log_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result


def render_cron_command(args: argparse.Namespace) -> str:
    log_dir = f"{args.workspace}/tmp/octopus/nightly-followup"
    return (
        f"{args.schedule_minute} {args.schedule_hour} * * * "
        f"export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; "
        f"export OPENCLAW_HOME={normalize_openclaw_home(args.openclaw_home)}; "
        f"export WORKSPACE={args.workspace}; "
        f"cd {args.workspace}/openclaw/skills/octopus && "
        f"bash ./bin/nightly-report-followup.sh >> {log_dir}/cron.log 2>&1 "
        "# octoclaw-nightly-followup"
    )


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.command == "render-cron":
        print(render_cron_command(args))
        return 0
    result = run_command(args)
    if args.format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        status = "ok" if result.get("agent_result", {}).get("ok") else "failed"
        print(f"nightly-followup {result['report_day']} {status}")
        print(result["followup_report_path"])
    return 0 if result.get("wait_result", {}).get("ok") and result.get("agent_result", {}).get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
