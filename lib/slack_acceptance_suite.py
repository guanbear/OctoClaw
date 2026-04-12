#!/usr/bin/env python3
"""Unified Slack acceptance suite for black-box and replay validation."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

try:
    from slack_e2e_acceptance import inspect_replay_source
except ModuleNotFoundError:  # pragma: no cover
    from lib.slack_e2e_acceptance import inspect_replay_source


DEFAULT_TIMEZONE = "Asia/Shanghai"


def _text(value: Any) -> str:
    return str(value or "").strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run unified Slack acceptance suite (black-box + replay).")
    parser.add_argument("--day", default="")
    parser.add_argument("--timezone", default=DEFAULT_TIMEZONE)
    parser.add_argument("--workspace", default="")
    parser.add_argument("--openclaw-home", default="")
    parser.add_argument("--output-dir", default="")
    parser.add_argument("--skip-blackbox", action="store_true")
    parser.add_argument("--skip-replay", action="store_true")
    parser.add_argument("--blackbox-preset", choices=["smoke", "core6", "acceptance"], default="acceptance")
    parser.add_argument("--session-key", default="")
    parser.add_argument("--target", default="")
    parser.add_argument("--native-channel-id", default="")
    parser.add_argument("--thread-id", default="")
    parser.add_argument("--chat-type", choices=["", "direct", "channel"], default="")
    parser.add_argument("--sessions-path", default="")
    parser.add_argument("--openclaw-config", default="")
    parser.add_argument("--replay-source", action="append", default=[])
    parser.add_argument("--replay-limit", type=int, default=6)
    return parser.parse_args()


def default_day(timezone_name: str) -> str:
    return datetime.now(ZoneInfo(timezone_name)).strftime("%Y-%m-%d")


def build_env(*, workspace: str = "", openclaw_home: str = "") -> dict[str, str]:
    env = dict(os.environ)
    path_parts = ["/opt/homebrew/bin", "/usr/local/bin", env.get("PATH", "")]
    env["PATH"] = ":".join(part for part in path_parts if part)
    if _text(workspace):
        env["WORKSPACE"] = _text(workspace)
    if _text(openclaw_home):
        env["OPENCLAW_HOME"] = _text(openclaw_home)
    return env


def derive_runtime_paths(*, openclaw_home: str = "", sessions_path: str = "", openclaw_config: str = "") -> dict[str, str]:
    home = _text(openclaw_home)
    resolved_sessions = _text(sessions_path)
    resolved_config = _text(openclaw_config)
    if home:
        if not resolved_sessions:
            resolved_sessions = str(Path(home) / "agents" / "main" / "sessions" / "sessions.json")
        if not resolved_config:
            resolved_config = str(Path(home) / "openclaw.json")
    return {
        "sessions_path": resolved_sessions,
        "openclaw_config": resolved_config,
    }


def run_subprocess(cmd: list[str], *, env: dict[str, str]) -> dict[str, Any]:
    result = subprocess.run(cmd, capture_output=True, text=True, env=env)
    return {
        "ok": result.returncode == 0,
        "returncode": result.returncode,
        "command": cmd,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }


def maybe_load_json(path: str) -> Any:
    candidate = Path(path)
    if not candidate.exists():
        return None
    try:
        return json.loads(candidate.read_text(encoding="utf-8"))
    except Exception:
        return None


def run_blackbox_suite(
    *,
    repo_root: Path,
    output_dir: Path,
    env: dict[str, str],
    preset: str,
    session_key: str = "",
    target: str = "",
    native_channel_id: str = "",
    thread_id: str = "",
    chat_type: str = "",
    sessions_path: str = "",
    openclaw_config: str = "",
) -> dict[str, Any]:
    report_path = output_dir / "blackbox-report.json"
    derived = derive_runtime_paths(openclaw_home=_text(env.get("OPENCLAW_HOME")), sessions_path=sessions_path, openclaw_config=openclaw_config)
    cmd = [sys.executable, str(repo_root / "lib" / "slack_e2e_acceptance.py"), "--preset", preset, "--output", str(report_path)]
    if session_key:
        cmd.extend(["--session-key", session_key])
    if target:
        cmd.extend(["--target", target])
    if native_channel_id:
        cmd.extend(["--native-channel-id", native_channel_id])
    if thread_id:
        cmd.extend(["--thread-id", thread_id])
    if chat_type:
        cmd.extend(["--chat-type", chat_type])
    if derived["sessions_path"]:
        cmd.extend(["--sessions-path", derived["sessions_path"]])
    if derived["openclaw_config"]:
        cmd.extend(["--openclaw-config", derived["openclaw_config"]])
    result = run_subprocess(cmd, env=env)
    return {
        "mode": "blackbox",
        "report_path": str(report_path),
        "result": result,
        "report": maybe_load_json(str(report_path)),
    }


def run_replay_bundle(
    *,
    repo_root: Path,
    output_dir: Path,
    env: dict[str, str],
    day: str,
    timezone_name: str,
    replay_limit: int,
    source_spec: str,
) -> dict[str, Any]:
    source = inspect_replay_source(source_spec)
    label = _text(source.get("label")) or "replay"
    source_dir = output_dir / f"replay-{label}"
    source_dir.mkdir(parents=True, exist_ok=True)
    if not source.get("ok"):
        return {"mode": "replay", "label": label, "source": source, "ok": False, "error": source.get("error")}
    sessions_index = _text(source.get("sessions_index"))
    session_dir = _text(source.get("session_dir"))
    replay_log = _text(source.get("replay_log"))
    task_state = _text(source.get("task_state"))
    if not sessions_index or not session_dir:
        return {
            "mode": "replay",
            "label": label,
            "source": source,
            "ok": False,
            "error": "replay bundle missing sessions_index or session_dir",
        }

    packet_path = source_dir / "reply-review-packet.json"
    validation_report = source_dir / "replay-validation.md"
    validation_cases = source_dir / "replay-validation-cases.json"
    validation_summary = source_dir / "replay-validation-summary.json"
    failure_report = source_dir / "failure-summary.md"
    failure_json = source_dir / "failure-summary.json"

    packet_cmd = [
        sys.executable,
        str(repo_root / "lib" / "reply_review_packet.py"),
        "--sessions-index",
        sessions_index,
        "--session-dir",
        session_dir,
        "--day",
        day,
        "--timezone",
        timezone_name,
        "--limit",
        str(replay_limit),
        "--output",
        str(packet_path),
    ]
    if replay_log:
        packet_cmd.extend(["--replay-log", replay_log])
    if task_state:
        packet_cmd.extend(["--task-state", task_state])
    packet_result = run_subprocess(packet_cmd, env=env)

    validation_result: dict[str, Any] | None = None
    if packet_result["ok"]:
        validation_cmd = [
            sys.executable,
            str(repo_root / "lib" / "replay_validation.py"),
            "--packet",
            str(packet_path),
            "--day",
            day,
            "--timezone",
            timezone_name,
            "--limit",
            str(replay_limit),
            "--output",
            str(validation_report),
            "--cases-output",
            str(validation_cases),
            "--summary-output",
            str(validation_summary),
            "--source-label",
            f"acceptance-replay({label})",
        ]
        if _text(env.get("WORKSPACE")):
            validation_cmd.extend(["--workspace", _text(env.get("WORKSPACE"))])
        if _text(env.get("OPENCLAW_HOME")):
            validation_cmd.extend(["--openclaw-home", _text(env.get("OPENCLAW_HOME"))])
        validation_result = run_subprocess(validation_cmd, env=env)

    failure_result: dict[str, Any] | None = None
    if task_state:
        failure_cmd = [
            sys.executable,
            str(repo_root / "lib" / "nightly_failure_summary.py"),
            "--task-state",
            task_state,
            "--day",
            day,
            "--timezone",
            timezone_name,
            "--output",
            str(failure_report),
            "--json-output",
            str(failure_json),
        ]
        failure_result = run_subprocess(failure_cmd, env=env)

    replay_ok = bool(packet_result.get("ok")) and bool(validation_result is None or validation_result.get("ok"))
    return {
        "mode": "replay",
        "label": label,
        "ok": replay_ok,
        "source": source,
        "packet_path": str(packet_path),
        "validation_report": str(validation_report),
        "validation_cases": str(validation_cases),
        "validation_summary": str(validation_summary),
        "failure_report": str(failure_report) if task_state else "",
        "failure_json": str(failure_json) if task_state else "",
        "packet_result": packet_result,
        "validation_result": validation_result,
        "failure_result": failure_result,
        "packet": maybe_load_json(str(packet_path)),
        "validation": maybe_load_json(str(validation_summary)),
        "failures": maybe_load_json(str(failure_json)) if task_state else None,
    }


def render_summary(report: dict[str, Any]) -> str:
    lines = [
        f"# Slack Acceptance Suite ({report['day']})",
        "",
        f"- Timezone: `{report['timezone']}`",
        f"- Output dir: `{report['output_dir']}`",
        f"- Overall ok: `{report['ok']}`",
        "",
    ]
    blackbox = report.get("blackbox")
    if isinstance(blackbox, dict) and blackbox:
        blackbox_report = blackbox.get("report") if isinstance(blackbox.get("report"), dict) else {}
        lines.extend(
            [
                "## Black-box",
                "",
                f"- Preset: `{report.get('blackbox_preset', '')}`",
                f"- OK: `{bool(blackbox.get('result', {}).get('ok')) and bool(blackbox_report.get('ok', False))}`",
                f"- Report: `{blackbox.get('report_path', '')}`",
                f"- Scenario count: `{len(blackbox_report.get('results', []) if isinstance(blackbox_report.get('results'), list) else [])}`",
                "",
            ]
        )
    replay_runs = report.get("replay_runs") if isinstance(report.get("replay_runs"), list) else []
    if replay_runs:
        lines.extend(["## Replay", ""])
        for run in replay_runs:
            lines.append(f"- `{run.get('label', '')}` ok=`{run.get('ok')}` source=`{run.get('source', {}).get('path', '')}`")
            if run.get("validation_summary"):
                lines.append(f"  - validation summary: `{run.get('validation_summary')}`")
            if run.get("failure_report"):
                lines.append(f"  - failure report: `{run.get('failure_report')}`")
        lines.append("")
    return "\n".join(lines).strip() + "\n"


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    day = _text(args.day) or default_day(args.timezone)
    workspace = _text(args.workspace) or os.environ.get("WORKSPACE", "")
    openclaw_home = _text(args.openclaw_home) or os.environ.get("OPENCLAW_HOME", "")
    output_dir = Path(_text(args.output_dir) or str(Path(workspace or ".") / "tmp" / "octopus" / "slack-acceptance" / day)).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    env = build_env(workspace=workspace, openclaw_home=openclaw_home)

    blackbox: dict[str, Any] | None = None
    replay_runs: list[dict[str, Any]] = []
    if not args.skip_blackbox:
        blackbox = run_blackbox_suite(
            repo_root=repo_root,
            output_dir=output_dir,
            env=env,
            preset=args.blackbox_preset,
            session_key=args.session_key,
            target=args.target,
            native_channel_id=args.native_channel_id,
            thread_id=args.thread_id,
            chat_type=args.chat_type,
            sessions_path=args.sessions_path,
            openclaw_config=args.openclaw_config,
        )
    if not args.skip_replay:
        replay_runs = [
            run_replay_bundle(
                repo_root=repo_root,
                output_dir=output_dir,
                env=env,
                day=day,
                timezone_name=args.timezone,
                replay_limit=args.replay_limit,
                source_spec=spec,
            )
            for spec in args.replay_source
        ]

    blackbox_ok = True
    if blackbox:
        blackbox_report = blackbox.get("report") if isinstance(blackbox.get("report"), dict) else {}
        blackbox_ok = bool(blackbox.get("result", {}).get("ok")) and bool(blackbox_report.get("ok", False))
    replay_ok = all(bool(item.get("ok")) for item in replay_runs) if replay_runs else True
    report = {
        "ok": blackbox_ok and replay_ok,
        "day": day,
        "timezone": args.timezone,
        "output_dir": str(output_dir),
        "workspace": workspace,
        "openclaw_home": openclaw_home,
        "blackbox_preset": args.blackbox_preset,
        "blackbox": blackbox,
        "replay_runs": replay_runs,
    }
    json_path = output_dir / "suite-report.json"
    summary_path = output_dir / "suite-summary.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    summary_path.write_text(render_summary(report), encoding="utf-8")
    print(json.dumps({"ok": report["ok"], "report": str(json_path), "summary": str(summary_path)}, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
