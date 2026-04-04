#!/usr/bin/env python3
"""Unified runtime observation pass for OctoClaw."""

from __future__ import annotations

import argparse
import json
from typing import Any

try:
    from octopus_config import WORKSPACE
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.octopus_config import WORKSPACE

try:
    from runtime_snapshot import observe_runtime_snapshot
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.runtime_snapshot import observe_runtime_snapshot

def observe_runtime_once(*, workspace: str = WORKSPACE) -> dict[str, Any]:
    return observe_runtime_snapshot(workspace=workspace)


def render_observer_text(payload: dict[str, Any]) -> str:
    runner = payload.get("runner", {}) if isinstance(payload.get("runner", {}), dict) else {}
    counts = payload.get("counts", {}) if isinstance(payload.get("counts", {}), dict) else {}
    changes = payload.get("changes", {}) if isinstance(payload.get("changes", {}), dict) else {}
    runner_mode = str(runner.get("mode", "") or payload.get("runner_execution_mode", "") or "").strip() or "ondemand"
    runner_state = str(runner.get("state", "") or "healthy").strip() or "healthy"
    age = runner.get("age_seconds")
    age_text = f" age={age}s" if isinstance(age, int) else ""
    return "\n".join(
        [
            f"Runtime observer [{str(payload.get('observed_at', '') or '').strip()}]",
            f"- Runner: {runner_state}{age_text} mode={runner_mode}",
            (
                f"- Counts: active {int(counts.get('active', 0) or 0)} · queued {int(counts.get('queued', 0) or 0)} · "
                f"running {int(counts.get('running', 0) or 0)} · pending {int(counts.get('pending', 0) or 0)} · "
                f"final {int(counts.get('final', 0) or 0)}"
            ),
            (
                f"- Changes: progress {int(changes.get('progress_hydrated', 0) or 0)} · "
                f"results {int(changes.get('results_hydrated', 0) or 0)} · "
                f"heartbeat {int(changes.get('heartbeat_reassigned', 0) or 0)} · "
                f"recovered {int(changes.get('dead_agent_recovered', 0) or 0)}"
            ),
        ]
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Observe and refresh OctoClaw runtime state once")
    parser.add_argument("--workspace", default=WORKSPACE)
    parser.add_argument("--format", choices=["text", "json"], default="text")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    payload = observe_runtime_once(workspace=args.workspace)
    if args.format == "json":
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(render_observer_text(payload))


if __name__ == "__main__":
    main()
