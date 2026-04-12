#!/usr/bin/env python3
"""Bootstrap an isolated OpenClaw acceptance runtime under workspace paths."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any


def _text(value: Any) -> str:
    return str(value or "").strip()


def resolve_source_home(explicit: str = "") -> Path:
    raw = _text(explicit) or _text(os.environ.get("OPENCLAW_HOME")) or str(Path.home() / ".openclaw")
    return Path(os.path.expanduser(raw)).resolve()


def resolve_default_workspace(explicit: str = "") -> Path:
    raw = _text(explicit) or _text(os.environ.get("WORKSPACE")) or "/workspace"
    return Path(os.path.expanduser(raw)).resolve()


def default_acceptance_paths(base_workspace: Path) -> tuple[Path, Path]:
    return (
        (base_workspace / "tmp" / "octoclaw-acceptance-home").resolve(),
        (base_workspace / "tmp" / "octoclaw-acceptance-workspace").resolve(),
    )


def load_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def copy_if_exists(source: Path, target: Path) -> bool:
    if not source.exists():
        return False
    ensure_dir(target.parent)
    shutil.copy2(source, target)
    return True


def patch_acceptance_config(
    payload: dict[str, Any],
    *,
    bot_token: str = "",
    app_token: str = "",
    group_policy: str = "",
    dm_policy: str = "",
    gateway_port: int = 18790,
    gateway_bind: str = "127.0.0.1",
) -> dict[str, Any]:
    result = dict(payload)
    channels = result.get("channels")
    if not isinstance(channels, dict):
        channels = {}
        result["channels"] = channels
    slack = channels.get("slack")
    if not isinstance(slack, dict):
        slack = {}
        channels["slack"] = slack
    slack["enabled"] = True
    if bot_token:
        slack["botToken"] = bot_token
    if app_token:
        slack["appToken"] = app_token
    if group_policy:
        slack["groupPolicy"] = group_policy
    if dm_policy:
        slack["dmPolicy"] = dm_policy

    gateway = result.get("gateway")
    if not isinstance(gateway, dict):
        gateway = {}
        result["gateway"] = gateway
    gateway["port"] = int(gateway_port)
    gateway["bind"] = _text(gateway_bind) or "127.0.0.1"
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Bootstrap an isolated acceptance OpenClaw home/workspace.")
    parser.add_argument("--source-openclaw-home", default="")
    parser.add_argument("--target-openclaw-home", default="")
    parser.add_argument("--target-workspace", default="")
    parser.add_argument("--slack-bot-token", default=_text(os.environ.get("OCTOCLAW_ACCEPTANCE_SLACK_BOT_TOKEN")))
    parser.add_argument("--slack-app-token", default=_text(os.environ.get("OCTOCLAW_ACCEPTANCE_SLACK_APP_TOKEN")))
    parser.add_argument("--group-policy", default="open")
    parser.add_argument("--dm-policy", default="open")
    parser.add_argument("--gateway-port", type=int, default=18790)
    parser.add_argument("--gateway-bind", default="127.0.0.1")
    parser.add_argument("--skip-rollout", action="store_true")
    parser.add_argument("--output", default="")
    return parser.parse_args()


def run_rollout(repo_root: Path, *, target_home: Path, target_workspace: Path) -> dict[str, Any]:
    cmd = [
        "bash",
        str(repo_root / "bin" / "runtime-policy-rollout.sh"),
        "install",
        "--openclaw-home",
        str(target_home),
        "--workspace",
        str(target_workspace),
        "--openclaw-config",
        str(target_home / "openclaw.json"),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return {
        "ok": result.returncode == 0,
        "returncode": result.returncode,
        "command": cmd,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }


def bootstrap_acceptance_runtime(
    *,
    repo_root: Path,
    source_home: Path,
    target_home: Path,
    target_workspace: Path,
    slack_bot_token: str = "",
    slack_app_token: str = "",
    group_policy: str = "open",
    dm_policy: str = "open",
    gateway_port: int = 18790,
    gateway_bind: str = "127.0.0.1",
    run_rollout_install: bool = True,
) -> dict[str, Any]:
    copied: list[str] = []
    source_config = source_home / "openclaw.json"
    target_config = target_home / "openclaw.json"
    ensure_dir(target_home)
    ensure_dir(target_workspace / "tmp" / "octopus")
    ensure_dir(target_home / "agents" / "main" / "sessions")
    ensure_dir(target_home / "agents" / "main" / "agent")

    config_payload = load_json(source_config)
    config_payload = patch_acceptance_config(
        config_payload,
        bot_token=slack_bot_token,
        app_token=slack_app_token,
        group_policy=group_policy,
        dm_policy=dm_policy,
        gateway_port=gateway_port,
        gateway_bind=gateway_bind,
    )
    write_json(target_config, config_payload)
    copied.append(str(target_config))

    for relative in (
        Path("agents/main/agent/auth-profiles.json"),
        Path("agents/main/agent/models.json"),
    ):
        source_path = source_home / relative
        target_path = target_home / relative
        if copy_if_exists(source_path, target_path):
            copied.append(str(target_path))

    rollout = {"ok": True, "skipped": True}
    if run_rollout_install:
        rollout = run_rollout(repo_root, target_home=target_home, target_workspace=target_workspace)

    return {
        "ok": bool(rollout.get("ok")),
        "source_openclaw_home": str(source_home),
        "target_openclaw_home": str(target_home),
        "target_workspace": str(target_workspace),
        "openclaw_config": str(target_config),
        "sessions_path": str(target_home / "agents" / "main" / "sessions" / "sessions.json"),
        "copied_files": copied,
        "rollout": rollout,
    }


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    base_workspace = resolve_default_workspace(args.target_workspace)
    default_home, default_workspace = default_acceptance_paths(base_workspace)
    source_home = resolve_source_home(args.source_openclaw_home)
    target_home = Path(_text(args.target_openclaw_home) or str(default_home)).expanduser().resolve()
    target_workspace = Path(_text(args.target_workspace) or str(default_workspace)).expanduser().resolve()
    result = bootstrap_acceptance_runtime(
        repo_root=repo_root,
        source_home=source_home,
        target_home=target_home,
        target_workspace=target_workspace,
        slack_bot_token=_text(args.slack_bot_token),
        slack_app_token=_text(args.slack_app_token),
        group_policy=_text(args.group_policy) or "open",
        dm_policy=_text(args.dm_policy) or "open",
        gateway_port=int(args.gateway_port or 18790),
        gateway_bind=_text(args.gateway_bind) or "127.0.0.1",
        run_rollout_install=not args.skip_rollout,
    )
    if args.output:
        write_json(Path(args.output).expanduser().resolve(), result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
