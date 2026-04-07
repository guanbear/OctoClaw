#!/usr/bin/env python3
"""Summarize OctoClaw runtime-policy replay logs."""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    from octopus_config import WORKSPACE
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.octopus_config import WORKSPACE
try:
    from status_render import summarize_taskflow_substrate
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from lib.status_render import summarize_taskflow_substrate

DEFAULT_WORKSPACE = WORKSPACE
DEFAULT_REPLAY_LOG = Path(DEFAULT_WORKSPACE) / "tmp" / "octopus" / "runtime-policy-replay.jsonl"
DEFAULT_TASK_STATE = Path(DEFAULT_WORKSPACE) / "tmp" / "octopus" / "task-state.json"
DEFAULT_MIN_POLICY_EVENTS = 30
DEFAULT_MIN_RUNNER_EVENTS = 3
DEFAULT_MIN_DELEGATED_EVENTS = 10
DEFAULT_MAX_BLOCKED_SESSION_RATE = 0.15
DEFAULT_MIN_ROUTE_HINT_SUBMISSION_RATE = 0.85
TOOL_BLOCK_EVENTS = {
    "tool_blocked_before_route_hint",
    "tool_blocked_manual_delegation",
    "tool_blocked_delegation_policy",
}


def parse_timestamp(value: str) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def event_session_key(event: dict[str, Any]) -> str:
    return str(event.get("sessionKey") or event.get("sessionId") or "").strip()


def load_events(path: Path) -> tuple[list[dict[str, Any]], str, int]:
    if not path.exists():
        raise FileNotFoundError(f"replay log not found: {path}")

    raw = path.read_text(encoding="utf-8")
    stripped = raw.lstrip()
    if not stripped:
        return [], "empty", 0

    if stripped.startswith("["):
        data = json.loads(raw)
        if not isinstance(data, list):
            raise ValueError("JSON replay input must be an array of event objects")
        events = [item for item in data if isinstance(item, dict)]
        invalid = len(data) - len(events)
        return events, "json_array", invalid

    events: list[dict[str, Any]] = []
    invalid = 0
    for line in raw.splitlines():
        text = line.strip()
        if not text:
            continue
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            invalid += 1
            continue
        if isinstance(payload, dict):
            events.append(payload)
        else:
            invalid += 1
    return events, "jsonl", invalid


def count_boolean(items: list[dict[str, Any]], key: str) -> int:
    return sum(1 for item in items if bool(item.get(key)))


def collect_session_ids(items: list[dict[str, Any]]) -> set[str]:
    return {key for key in (event_session_key(item) for item in items) if key}


def ratio(numerator: int, denominator: int) -> float | None:
    if denominator <= 0:
        return None
    return round(numerator / denominator, 4)


def compact_ratio(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:.1%}"


def infer_runtime_policy_phase(runtime_policy: dict[str, Any] | None) -> str:
    if not isinstance(runtime_policy, dict):
        return "conservative"
    switches = runtime_policy.get("switches")
    hooks = runtime_policy.get("hooks")
    route_stickiness = runtime_policy.get("route_stickiness")
    if not isinstance(switches, dict):
        switches = {}
    if not isinstance(hooks, dict):
        hooks = {}
    if not isinstance(route_stickiness, dict):
        route_stickiness = {}

    if bool(switches.get("route_hint_required")):
        return "enforced"
    if bool(switches.get("direct_model_override")) or bool(hooks.get("before_model_resolve")):
        return "enforced"
    if (
        bool(switches.get("delegation_enforcement"))
        or bool(switches.get("route_hint_required"))
        or bool(hooks.get("before_tool_call"))
        or bool(route_stickiness.get("enabled"))
    ):
        return "guided"
    return "conservative"


def count_routes(items: list[dict[str, Any]], key: str) -> dict[str, int]:
    counts = Counter(str(item.get(key, "") or "").strip() for item in items if str(item.get(key, "") or "").strip())
    return dict(sorted(counts.items()))


def count_worker_pools(items: list[dict[str, Any]]) -> dict[str, int]:
    counts = Counter(
        str(item.get("workerPool", item.get("worker_pool", "")) or "").strip()
        for item in items
        if str(item.get("workerPool", item.get("worker_pool", "")) or "").strip()
    )
    return dict(sorted(counts.items()))


def collect_language_pack_usage(events: list[dict[str, Any]]) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for event in events:
        packs = event.get("routeLanguagePacks", event.get("route_language_packs"))
        if not isinstance(packs, list):
            continue
        normalized = [str(item or "").strip() for item in packs if str(item or "").strip()]
        if normalized:
            counts["+".join(normalized)] += 1
    return dict(sorted(counts.items()))


def _string_field(event: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = str(event.get(key, "") or "").strip()
        if value:
            return value
    return ""


def _bool_field(event: dict[str, Any], *keys: str) -> bool:
    for key in keys:
        if key in event:
            return bool(event.get(key))
    return False


def _dict_field(event: dict[str, Any], *keys: str) -> dict[str, Any]:
    for key in keys:
        value = event.get(key)
        if isinstance(value, dict):
            return value
    return {}


def count_work_contracts(items: list[dict[str, Any]]) -> dict[str, int]:
    counts = Counter(_string_field(item, "workContract", "work_contract") for item in items if _string_field(item, "workContract", "work_contract"))
    return dict(sorted(counts.items()))


def count_budget_field(items: list[dict[str, Any]], field: str) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for item in items:
        budget = _dict_field(item, "budgetPolicy", "budget_policy")
        value = str(budget.get(field, "") or "").strip()
        if value:
            counts[value] += 1
    return dict(sorted(counts.items()))


def count_string_field(items: list[dict[str, Any]], *keys: str) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for item in items:
        value = _string_field(item, *keys)
        if value:
            counts[value] += 1
    return dict(sorted(counts.items()))


def build_promotion_checks(
    summary: dict[str, Any],
    *,
    phase: str,
    min_policy_events: int,
    min_runner_events: int,
    min_delegated_events: int,
    max_blocked_session_rate: float,
    min_route_hint_submission_rate: float,
) -> dict[str, Any]:
    task_metrics = summary["task_metrics"]
    route_hint_metrics = summary["route_hint_metrics"]
    tool_metrics = summary["tool_metrics"]

    checks: list[dict[str, Any]] = []

    policy_events = int(task_metrics["task_event_count"])
    runner_events = int(task_metrics["runner_task_count"])
    delegated_events = int(task_metrics["delegated_task_count"])
    blocked_session_rate = tool_metrics["blocked_session_rate"]
    route_hint_submission_rate = route_hint_metrics["submission_rate"]
    route_hint_required_count = int(route_hint_metrics["required_count"])

    checks.append(
        {
            "name": "sample_size",
            "ok": policy_events >= min_policy_events,
            "detail": f"{policy_events}/{min_policy_events} policy tasks observed",
        }
    )
    checks.append(
        {
            "name": "runner_traffic",
            "ok": runner_events >= min_runner_events,
            "detail": f"{runner_events}/{min_runner_events} runner tasks observed",
        }
    )
    checks.append(
        {
            "name": "delegated_traffic",
            "ok": delegated_events >= min_delegated_events,
            "detail": f"{delegated_events}/{min_delegated_events} delegated tasks observed",
        }
    )
    checks.append(
        {
            "name": "tool_block_pressure",
            "ok": blocked_session_rate is None or blocked_session_rate <= max_blocked_session_rate,
            "detail": f"blocked session rate {compact_ratio(blocked_session_rate)} (max {max_blocked_session_rate:.1%})",
        }
    )

    if phase == "guided":
        checks.append(
            {
                "name": "route_hint_coverage",
                "ok": (
                    route_hint_required_count == 0
                    or (
                        route_hint_submission_rate is not None
                        and route_hint_submission_rate >= min_route_hint_submission_rate
                    )
                ),
                "detail": (
                    f"route hint submission {compact_ratio(route_hint_submission_rate)} "
                    f"(required tasks: {route_hint_required_count}, min {min_route_hint_submission_rate:.1%})"
                ),
            }
        )

    ready = all(check["ok"] for check in checks)
    target = "guided" if phase == "conservative" else "enforced"
    return {
        "phase": phase,
        "target": target,
        "ready": ready,
        "checks": checks,
    }


def load_task_state_snapshot(path: Path) -> dict[str, Any]:
    resolved = path.expanduser().resolve()
    if not resolved.exists():
        return {
            "path": str(resolved),
            "available": False,
            "tracked": 0,
            "mirrored": 0,
            "native_bound": 0,
            "native_active": 0,
            "checkpointed": 0,
            "artifact_ready": 0,
            "handoff_ready": 0,
            "delivered": 0,
        }
    try:
        payload = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {
            "path": str(resolved),
            "available": False,
            "tracked": 0,
            "mirrored": 0,
            "native_bound": 0,
            "native_active": 0,
            "checkpointed": 0,
            "artifact_ready": 0,
            "handoff_ready": 0,
            "delivered": 0,
        }
    tasks = payload.get("tasks", []) if isinstance(payload, dict) else []
    if not isinstance(tasks, list):
        tasks = []
    summary = summarize_taskflow_substrate([task for task in tasks if isinstance(task, dict)])
    return {
        "path": str(resolved),
        "available": True,
        **summary,
    }


def summarize_events(
    events: list[dict[str, Any]],
    *,
    source_path: str,
    source_format: str,
    invalid_lines: int,
    phase: str,
    min_policy_events: int,
    min_runner_events: int,
    min_delegated_events: int,
    max_blocked_session_rate: float,
    min_route_hint_submission_rate: float,
    task_state_path: str = "",
) -> dict[str, Any]:
    event_counts = Counter(str(event.get("event", "") or "").strip() for event in events if str(event.get("event", "") or "").strip())
    policy_events = [event for event in events if event.get("event") == "policy_resolved"]
    agent_end_events = [event for event in events if event.get("event") == "agent_end"]
    route_hint_events = [event for event in events if event.get("event") == "route_hint_submitted"]
    dispatch_events = [event for event in events if event.get("event") == "dispatch_called"]
    blocked_events = [event for event in events if event.get("event") in TOOL_BLOCK_EVENTS]

    task_basis = "policy_resolved" if policy_events else "agent_end"
    task_events = policy_events or agent_end_events

    timestamps = [ts for ts in (parse_timestamp(str(event.get("at", "") or "")) for event in events) if ts is not None]
    session_ids = collect_session_ids(events)
    blocked_sessions = collect_session_ids(blocked_events)
    delegated_task_events = [event for event in task_events if str(event.get("route", "") or "") != "direct"]
    runner_task_events = [event for event in task_events if str(event.get("route", "") or "") == "runner"]
    protected_lane_events = [event for event in task_events if _string_field(event, "protectedLane", "protected_lane")]
    sticky_task_events = [event for event in task_events if "stickyApplied" in event]
    sticky_persist_events = [event for event in [*route_hint_events, *dispatch_events] if "stickyPersisted" in event]
    protected_lane_sessions = collect_session_ids(protected_lane_events)
    dispatch_sessions = collect_session_ids(dispatch_events)
    protected_lane_misroute_sessions = {
        key
        for key in protected_lane_sessions
        if key in dispatch_sessions
    }
    protected_lane_misroute_sessions.update(
        key
        for key in (
            event_session_key(event)
            for event in protected_lane_events
            if _string_field(event, "route") and _string_field(event, "route") != "direct"
        )
        if key
    )

    route_hint_required_count = count_boolean(task_events, "routeHintRequired")
    route_hint_submitted_count = len(route_hint_events)
    route_change_count = sum(
        1
        for event in route_hint_events
        if str(event.get("finalRoute", "") or "").strip()
        and str(event.get("systemPreferredRoute", "") or "").strip()
        and str(event.get("finalRoute", "") or "").strip() != str(event.get("systemPreferredRoute", "") or "").strip()
    )
    work_contract_shift_count = sum(
        1
        for event in task_events
        if _string_field(event, "workContractHint", "work_contract_hint")
        and _string_field(event, "workContract", "work_contract")
        and _string_field(event, "workContractHint", "work_contract_hint") != _string_field(event, "workContract", "work_contract")
    )
    sticky_override_count = sum(
        1
        for event in route_hint_events
        if _bool_field(event, "stickyApplied", "sticky_applied")
        and _string_field(event, "finalRoute", "final_route")
        and _string_field(event, "systemPreferredRoute", "system_preferred_route")
        and _string_field(event, "finalRoute", "final_route") != _string_field(event, "systemPreferredRoute", "system_preferred_route")
    )
    review_required_count = sum(1 for event in task_events if _bool_field(event, "reviewRequired", "review_required"))

    summary = {
        "schema_version": "octoclaw.replay_summary/v1",
        "loop_phase": "summarize",
        "source": {
            "path": source_path,
            "format": source_format,
            "invalid_lines": invalid_lines,
        },
        "window": {
            "first_event_at": min(timestamps).isoformat() if timestamps else "",
            "last_event_at": max(timestamps).isoformat() if timestamps else "",
        },
        "events": {
            "total": len(events),
            "sessions": len(session_ids),
            "by_type": dict(sorted(event_counts.items())),
        },
        "task_metrics": {
            "task_basis": task_basis,
            "task_event_count": len(task_events),
            "route_counts": count_routes(task_events, "route"),
            "system_preferred_route_counts": count_routes(task_events, "systemPreferredRoute"),
            "protected_lane_counts": count_string_field(task_events, "protectedLane", "protected_lane"),
            "work_contract_counts": count_work_contracts(task_events),
            "worker_pool_counts": count_worker_pools(task_events),
            "delegated_task_count": len(delegated_task_events),
            "runner_task_count": len(runner_task_events),
            "sticky_applied_count": count_boolean(sticky_task_events, "stickyApplied"),
            "sticky_applied_rate": ratio(count_boolean(sticky_task_events, "stickyApplied"), len(task_events)),
            "sticky_persisted_count": count_boolean(sticky_persist_events, "stickyPersisted"),
        },
        "route_hint_metrics": {
            "required_count": route_hint_required_count,
            "submitted_count": route_hint_submitted_count,
            "submission_rate": ratio(route_hint_submitted_count, route_hint_required_count),
            "route_change_count": route_change_count,
            "route_change_rate": ratio(route_change_count, route_hint_submitted_count),
            "sticky_override_count": sticky_override_count,
            "work_contract_shift_count": work_contract_shift_count,
        },
        "policy_diff": {
            "route_change_count": route_change_count,
            "route_change_rate": ratio(route_change_count, route_hint_submitted_count),
            "sticky_override_count": sticky_override_count,
            "work_contract_shift_count": work_contract_shift_count,
            "protected_lane_misroute_count": len(protected_lane_misroute_sessions),
        },
        "protected_lane_metrics": {
            "count": len(protected_lane_events),
            "session_count": len(protected_lane_sessions),
            "dispatch_session_count": len(protected_lane_sessions & dispatch_sessions),
            "dispatch_session_rate": ratio(len(protected_lane_sessions & dispatch_sessions), len(protected_lane_sessions)),
            "misroute_session_count": len(protected_lane_misroute_sessions),
            "misroute_session_rate": ratio(len(protected_lane_misroute_sessions), len(protected_lane_sessions)),
        },
        "dispatch_metrics": {
            "dispatch_called_count": len(dispatch_events),
            "dispatch_called_session_count": len(dispatch_sessions),
            "delegated_session_count": len(collect_session_ids(delegated_task_events)),
            "dispatch_session_coverage_rate": ratio(
                len(dispatch_sessions),
                len(collect_session_ids(delegated_task_events)),
            ),
        },
        "tool_metrics": {
            "blocked_event_count": len(blocked_events),
            "blocked_event_types": dict(sorted(Counter(str(event.get("event", "") or "") for event in blocked_events).items())),
            "blocked_session_count": len(blocked_sessions),
            "blocked_session_rate": ratio(len(blocked_sessions), len(session_ids)),
        },
        "economics_metrics": {
            "budget_cap_counts": count_budget_field(task_events, "budget_cap"),
            "retry_cap_counts": count_budget_field(task_events, "retry_cap"),
            "max_workers_counts": count_budget_field(task_events, "max_workers"),
            "latency_target_counts": count_budget_field(task_events, "latency_target"),
            "interruptibility_counts": count_budget_field(task_events, "interruptibility"),
            "upgrade_allowed_count": sum(1 for event in task_events if _bool_field(_dict_field(event, "budgetPolicy", "budget_policy"), "upgrade_allowed")),
            "review_required_count": review_required_count,
        },
        "observed_language_packs": collect_language_pack_usage(events),
        "substrate_metrics": load_task_state_snapshot(Path(task_state_path or DEFAULT_TASK_STATE)),
    }
    summary["promotion"] = build_promotion_checks(
        summary,
        phase=phase,
        min_policy_events=min_policy_events,
        min_runner_events=min_runner_events,
        min_delegated_events=min_delegated_events,
        max_blocked_session_rate=max_blocked_session_rate,
        min_route_hint_submission_rate=min_route_hint_submission_rate,
    )
    return summary


def render_text(summary: dict[str, Any]) -> str:
    source = summary["source"]
    events = summary["events"]
    task_metrics = summary["task_metrics"]
    route_hint_metrics = summary["route_hint_metrics"]
    policy_diff = summary["policy_diff"]
    protected_lane_metrics = summary["protected_lane_metrics"]
    dispatch_metrics = summary["dispatch_metrics"]
    tool_metrics = summary["tool_metrics"]
    economics_metrics = summary["economics_metrics"]
    substrate_metrics = summary["substrate_metrics"]
    promotion = summary["promotion"]

    lines = [
        "OctoClaw Replay Summary",
        "",
        f"- Source: `{source['path']}` ({source['format']})",
        f"- Events: `{events['total']}`",
        f"- Sessions: `{events['sessions']}`",
        f"- Task basis: `{task_metrics['task_basis']}`",
    ]
    if source["invalid_lines"]:
        lines.append(f"- Invalid lines skipped: `{source['invalid_lines']}`")
    if summary["window"]["first_event_at"] and summary["window"]["last_event_at"]:
        lines.append(f"- Window: `{summary['window']['first_event_at']}` -> `{summary['window']['last_event_at']}`")

    lines.extend(
        [
            "",
            "Task Metrics",
            f"- Task events: `{task_metrics['task_event_count']}`",
            f"- Route counts: `{json.dumps(task_metrics['route_counts'], ensure_ascii=False)}`",
            f"- System preferred counts: `{json.dumps(task_metrics['system_preferred_route_counts'], ensure_ascii=False)}`",
            f"- Protected lane counts: `{json.dumps(task_metrics['protected_lane_counts'], ensure_ascii=False)}`",
            f"- Work contract counts: `{json.dumps(task_metrics['work_contract_counts'], ensure_ascii=False)}`",
            f"- Worker pool counts: `{json.dumps(task_metrics['worker_pool_counts'], ensure_ascii=False)}`",
            f"- Delegated tasks: `{task_metrics['delegated_task_count']}`",
            f"- Runner tasks: `{task_metrics['runner_task_count']}`",
            f"- Sticky applied: `{task_metrics['sticky_applied_count']}` ({compact_ratio(task_metrics['sticky_applied_rate'])})",
            "",
            "Route Hint Metrics",
            f"- Required: `{route_hint_metrics['required_count']}`",
            f"- Submitted: `{route_hint_metrics['submitted_count']}` ({compact_ratio(route_hint_metrics['submission_rate'])})",
            "",
            "Policy Diff",
            f"- Final route changed from system preferred: `{policy_diff['route_change_count']}` ({compact_ratio(policy_diff['route_change_rate'])})",
            f"- Sticky overrides of system preferred: `{policy_diff['sticky_override_count']}`",
            f"- Work contract shifts from hint: `{policy_diff['work_contract_shift_count']}`",
            f"- Protected-lane misroutes: `{policy_diff['protected_lane_misroute_count']}`",
            "",
            "Protected Lanes",
            f"- Protected lane events: `{protected_lane_metrics['count']}`",
            f"- Protected lane sessions: `{protected_lane_metrics['session_count']}`",
            f"- Protected lane dispatch sessions: `{protected_lane_metrics['dispatch_session_count']}` ({compact_ratio(protected_lane_metrics['dispatch_session_rate'])})",
            f"- Protected lane misroutes: `{protected_lane_metrics['misroute_session_count']}` ({compact_ratio(protected_lane_metrics['misroute_session_rate'])})",
            "",
            "Dispatch / Blocks",
            f"- Dispatch called: `{dispatch_metrics['dispatch_called_count']}` ({compact_ratio(dispatch_metrics['dispatch_session_coverage_rate'])} session coverage)",
            f"- Blocked sessions: `{tool_metrics['blocked_session_count']}` ({compact_ratio(tool_metrics['blocked_session_rate'])})",
            f"- Blocked event types: `{json.dumps(tool_metrics['blocked_event_types'], ensure_ascii=False)}`",
            "",
            "Economics",
            f"- Budget caps: `{json.dumps(economics_metrics['budget_cap_counts'], ensure_ascii=False)}`",
            f"- Retry caps: `{json.dumps(economics_metrics['retry_cap_counts'], ensure_ascii=False)}`",
            f"- Max workers: `{json.dumps(economics_metrics['max_workers_counts'], ensure_ascii=False)}`",
            f"- Latency targets: `{json.dumps(economics_metrics['latency_target_counts'], ensure_ascii=False)}`",
            f"- Interruptibility: `{json.dumps(economics_metrics['interruptibility_counts'], ensure_ascii=False)}`",
            f"- Review required: `{economics_metrics['review_required_count']}`",
            "",
            "Substrate Snapshot",
            f"- Task state: `{substrate_metrics['path']}`",
            f"- Available: `{substrate_metrics['available']}`",
            f"- Tracked/mirrored: `{substrate_metrics['tracked']}/{substrate_metrics['mirrored']}`",
            f"- Native bound/active: `{substrate_metrics['native_bound']}/{substrate_metrics['native_active']}`",
            f"- Checkpoints/artifacts: `{substrate_metrics['checkpointed']}/{substrate_metrics['artifact_ready']}`",
            f"- Handoff ready/delivered: `{substrate_metrics['handoff_ready']}/{substrate_metrics['delivered']}`",
            "",
            f"Promotion Heuristic: `{promotion['phase']}` -> `{promotion['target']}`",
        ]
    )
    for check in promotion["checks"]:
        status = "PASS" if check["ok"] else "HOLD"
        lines.append(f"- [{status}] {check['name']}: {check['detail']}")
    lines.append("")
    lines.append(f"Suggested next preset: `{promotion['target'] if promotion['ready'] else promotion['phase']}`")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Summarize OctoClaw runtime-policy replay events")
    parser.add_argument("--events", default=str(DEFAULT_REPLAY_LOG), help="Replay log path (JSONL or JSON array)")
    parser.add_argument("--task-state", default=str(DEFAULT_TASK_STATE), help="Optional task-state snapshot path for substrate metrics")
    parser.add_argument("--phase", choices=("conservative", "guided"), default="conservative")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    parser.add_argument("--output", default="", help="Optional file to write the summary to")
    parser.add_argument("--min-policy-events", type=int, default=DEFAULT_MIN_POLICY_EVENTS)
    parser.add_argument("--min-runner-events", type=int, default=DEFAULT_MIN_RUNNER_EVENTS)
    parser.add_argument("--min-delegated-events", type=int, default=DEFAULT_MIN_DELEGATED_EVENTS)
    parser.add_argument("--max-blocked-session-rate", type=float, default=DEFAULT_MAX_BLOCKED_SESSION_RATE)
    parser.add_argument("--min-route-hint-submission-rate", type=float, default=DEFAULT_MIN_ROUTE_HINT_SUBMISSION_RATE)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    path = Path(args.events).expanduser().resolve()
    events, source_format, invalid_lines = load_events(path)
    summary = summarize_events(
        events,
        source_path=str(path),
        source_format=source_format,
        invalid_lines=invalid_lines,
        phase=args.phase,
        min_policy_events=args.min_policy_events,
        min_runner_events=args.min_runner_events,
        min_delegated_events=args.min_delegated_events,
        max_blocked_session_rate=args.max_blocked_session_rate,
        min_route_hint_submission_rate=args.min_route_hint_submission_rate,
        task_state_path=args.task_state,
    )

    if args.format == "json":
        output = json.dumps(summary, ensure_ascii=False, indent=2)
    else:
        output = render_text(summary)

    if args.output:
        Path(args.output).expanduser().resolve().write_text(output + "\n", encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
