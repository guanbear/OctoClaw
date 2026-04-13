#!/usr/bin/env python3
"""Reconciler core for OctoClaw — periodic state-drift detection and repair.

Designed for cron invocation (every 5 minutes) with --apply as default.
Can also be invoked manually with --dry-run.

SAFETY:
- Never modifies terminal tasks.
- Never creates new tasks.
- Each item processed independently — failure on one doesn't block others.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from typing import Any

try:
    from read_projection import read_tasks, read_task
except ModuleNotFoundError:  # pragma: no cover
    from lib.read_projection import read_tasks, read_task

try:
    from failure_taxonomy import normalize_failure_type, default_outcome_state, default_recovery_action
except ModuleNotFoundError:  # pragma: no cover
    from lib.failure_taxonomy import normalize_failure_type, default_outcome_state, default_recovery_action

try:
    from completion_state_machine import infer_next_lifecycle, is_terminal_lifecycle
except ModuleNotFoundError:  # pragma: no cover
    from lib.completion_state_machine import infer_next_lifecycle, is_terminal_lifecycle

try:
    from completion_relay import relay_task_completion
except ModuleNotFoundError:  # pragma: no cover
    relay_task_completion = None  # type: ignore[assignment]

try:
    from lifecycle_event_schema import build_lifecycle_event_payload
except ModuleNotFoundError:  # pragma: no cover
    build_lifecycle_event_payload = None  # type: ignore[assignment]

try:
    from octopus_config import load_json, WORKSPACE
except ModuleNotFoundError:  # pragma: no cover
    from lib.octopus_config import load_json, WORKSPACE

try:
    from task_events import append_task_event
except ModuleNotFoundError:  # pragma: no cover
    append_task_event = None  # type: ignore[assignment]

try:
    from notifier import send_task_notification
except (ModuleNotFoundError, ImportError):  # pragma: no cover
    send_task_notification = None  # type: ignore[assignment]

RECONCILER_SCHEMA_VERSION = "octoclaw.reconciler/v1"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _text(value: Any) -> str:
    return str(value or "").strip()


def _parse_iso_time(value: str) -> datetime | None:
    """Parse an ISO timestamp string; return None on failure."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _is_stale(task: dict[str, Any], max_stale_minutes: int) -> bool:
    """Check if a running/queued task is stale based on updated_at or expected_done_at."""
    updated_at_str = _text(task.get("updated_at"))
    expected_done_at_str = _text(task.get("expected_done_at"))
    now = _now_utc()

    # Check updated_at staleness
    if updated_at_str:
        updated_at = _parse_iso_time(updated_at_str)
        if updated_at:
            age_minutes = (now - updated_at).total_seconds() / 60.0
            if age_minutes > max_stale_minutes:
                return True

    # Check expected_done_at overrun
    if expected_done_at_str:
        expected_done_at = _parse_iso_time(expected_done_at_str)
        if expected_done_at and now > expected_done_at:
            return True

    # If no updated_at at all and task is running/queued, it's stale
    if not updated_at_str:
        started_at_str = _text(task.get("started_at")) or _text(task.get("spawned_at"))
        if not started_at_str:
            return True
        started_at = _parse_iso_time(started_at_str)
        if started_at:
            age_minutes = (now - started_at).total_seconds() / 60.0
            if age_minutes > max_stale_minutes:
                return True

    return False


def _is_lost(task: dict[str, Any], max_lost_minutes: int) -> bool:
    """Check if a running task is lost (no heartbeat/update for max_lost_minutes)."""
    updated_at_str = _text(task.get("updated_at"))
    now = _now_utc()

    # Primary check: updated_at
    if updated_at_str:
        updated_at = _parse_iso_time(updated_at_str)
        if updated_at:
            age_minutes = (now - updated_at).total_seconds() / 60.0
            return age_minutes > max_lost_minutes

    # Fallback: started_at/spawned_at
    started_at_str = _text(task.get("started_at")) or _text(task.get("spawned_at"))
    if started_at_str:
        started_at = _parse_iso_time(started_at_str)
        if started_at:
            age_minutes = (now - started_at).total_seconds() / 60.0
            return age_minutes > max_lost_minutes

    # No timestamps at all — lost
    return True


def _task_lifecycle_state(task: dict[str, Any]) -> str:
    """Get lifecycle_state from a normalized task record."""
    return _text(task.get("lifecycle_state"))


def _task_handoff_state(task: dict[str, Any]) -> str:
    """Get handoff_state from a normalized task record."""
    return _text(task.get("handoff_state"))


def _task_outcome_state(task: dict[str, Any]) -> str:
    """Get outcome_state from a normalized task record."""
    return _text(task.get("outcome_state"))


# ---------------------------------------------------------------------------
# Reconcilers
# ---------------------------------------------------------------------------

def reconcile_stale_tasks(
    max_stale_minutes: int = 30,
    workspace: str = "",
    dry_run: bool = False,
) -> dict[str, Any]:
    """Detect and reconcile stale running/queued tasks.

    Scans all tasks in running or queued lifecycle state.
    If updated_at is older than max_stale_minutes, or expected_done_at is past,
    the task is considered stale and reconciled.

    Returns:
        {reconciled_count: int, items: [{task_id, action, result}], errors: []}
    """
    items: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    try:
        tasks = read_tasks(workspace=workspace)
    except Exception as exc:
        return {
            "reconciled_count": 0,
            "items": [],
            "errors": [{"error": str(exc), "phase": "read_tasks"}],
        }

    active_states = {"running", "queued"}

    for task in tasks:
        task_id = _text(task.get("id", ""))
        if not task_id:
            continue

        try:
            lifecycle = _task_lifecycle_state(task)
            if lifecycle not in active_states:
                continue

            # Never touch terminal tasks (safety)
            if is_terminal_lifecycle(lifecycle):
                continue

            if not _is_stale(task, max_stale_minutes):
                continue

            if dry_run:
                items.append({
                    "task_id": task_id,
                    "action": "would_timeout",
                    "result": "dry_run",
                })
                continue

            # Emit job_timed_out event
            if append_task_event is not None:
                try:
                    append_task_event(task, "job_timed_out", message=f"Task stale after {max_stale_minutes} minutes")
                except Exception:
                    pass  # Event emission failure shouldn't block reconciliation

            # Call relay_task_completion with failed/timed_out
            relay_result: dict[str, Any] = {"ok": False, "error": "relay_unavailable"}
            if relay_task_completion is not None:
                try:
                    relay_result = relay_task_completion(
                        task_id=task_id,
                        status="failed",
                        summary=f"Task timed out after {max_stale_minutes} minutes",
                        failure_type="timed_out",
                        workspace=workspace,
                    )
                except Exception as exc:
                    relay_result = {"ok": False, "error": str(exc)}

            items.append({
                "task_id": task_id,
                "action": "timed_out",
                "result": relay_result,
            })
        except Exception as exc:
            errors.append({"task_id": task_id, "error": str(exc), "phase": "reconcile_stale"})

    return {
        "reconciled_count": len(items),
        "items": items,
        "errors": errors,
    }


def reconcile_delivery_failed(
    max_retries: int = 3,
    cooldown_seconds: int = 60,
    workspace: str = "",
    dry_run: bool = False,
) -> dict[str, Any]:
    """Retry delivery for tasks with delivery_failed events.

    Scans tasks with handoff_state == 'user_safe_ready' (completed but not delivered).
    Checks delivery-relay.jsonl for delivery_failed events.
    If retry_count < max_retries and cooldown has passed, retries delivery.

    Returns:
        {reconciled_count: int, items: [{task_id, action, result}], errors: []}
    """
    items: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    try:
        tasks = read_tasks(workspace=workspace)
    except Exception as exc:
        return {
            "reconciled_count": 0,
            "items": [],
            "errors": [{"error": str(exc), "phase": "read_tasks"}],
        }

    now = _now_utc()

    for task in tasks:
        task_id = _text(task.get("id", ""))
        if not task_id:
            continue

        try:
            handoff = _task_handoff_state(task)
            if handoff != "user_safe_ready":
                continue

            retry_count = int(task.get("retry_count") or 0)
            if retry_count >= max_retries:
                continue

            # Check cooldown based on updated_at
            updated_at_str = _text(task.get("updated_at"))
            if updated_at_str:
                updated_at = _parse_iso_time(updated_at_str)
                if updated_at and (now - updated_at).total_seconds() < cooldown_seconds:
                    continue

            if dry_run:
                items.append({
                    "task_id": task_id,
                    "action": "would_retry_delivery",
                    "result": "dry_run",
                })
                continue

            # Retry delivery via notifier if available
            relay_result: dict[str, Any] = {"ok": False, "error": "delivery_handler_unavailable"}
            if send_task_notification is not None:
                try:
                    relay_result = send_task_notification(task, workspace=workspace)
                except Exception as exc:
                    relay_result = {"ok": False, "error": str(exc)}

            items.append({
                "task_id": task_id,
                "action": "delivery_retried",
                "result": relay_result,
            })
        except Exception as exc:
            errors.append({"task_id": task_id, "error": str(exc), "phase": "reconcile_delivery"})

    return {
        "reconciled_count": len(items),
        "items": items,
        "errors": errors,
    }


def reconcile_notification_retry(
    max_retries: int = 3,
    workspace: str = "",
    dry_run: bool = False,
) -> dict[str, Any]:
    """Retry notification for terminal tasks with no delivery notification sent.

    Scans tasks with terminal outcome but no delivery notification sent.
    Retries notification via send_task_notification if importable.

    Returns:
        {reconciled_count: int, items: [{task_id, action, result}], errors: []}
    """
    items: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    try:
        tasks = read_tasks(workspace=workspace)
    except Exception as exc:
        return {
            "reconciled_count": 0,
            "items": [],
            "errors": [{"error": str(exc), "phase": "read_tasks"}],
        }

    terminal_outcomes = {"done", "failed", "cancelled"}
    delivered_handoff = "delivered"

    for task in tasks:
        task_id = _text(task.get("id", ""))
        if not task_id:
            continue

        try:
            lifecycle = _task_lifecycle_state(task)
            outcome = _task_outcome_state(task)
            handoff = _task_handoff_state(task)

            # Must be terminal lifecycle with terminal outcome
            if not is_terminal_lifecycle(lifecycle):
                continue
            if outcome not in terminal_outcomes:
                continue

            # Must not already be delivered
            if handoff == delivered_handoff:
                continue

            retry_count = int(task.get("retry_count") or 0)
            if retry_count >= max_retries:
                continue

            if dry_run:
                items.append({
                    "task_id": task_id,
                    "action": "would_retry_notification",
                    "result": "dry_run",
                })
                continue

            # Retry notification
            relay_result: dict[str, Any] = {"ok": False, "error": "notification_handler_unavailable"}
            if send_task_notification is not None:
                try:
                    relay_result = send_task_notification(task, workspace=workspace)
                except Exception as exc:
                    relay_result = {"ok": False, "error": str(exc)}

            items.append({
                "task_id": task_id,
                "action": "notification_retried",
                "result": relay_result,
            })
        except Exception as exc:
            errors.append({"task_id": task_id, "error": str(exc), "phase": "reconcile_notification"})

    return {
        "reconciled_count": len(items),
        "items": items,
        "errors": errors,
    }


def reconcile_lost_tasks(
    max_lost_minutes: int = 120,
    workspace: str = "",
    dry_run: bool = False,
) -> dict[str, Any]:
    """Detect and mark lost tasks — running with no heartbeat/update.

    Finds tasks in running state with NO heartbeat/update in max_lost_minutes.
    Marks as 'lost' failure type.

    Returns:
        {reconciled_count: int, items: [{task_id, action, result}], errors: []}
    """
    items: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    try:
        tasks = read_tasks(workspace=workspace)
    except Exception as exc:
        return {
            "reconciled_count": 0,
            "items": [],
            "errors": [{"error": str(exc), "phase": "read_tasks"}],
        }

    for task in tasks:
        task_id = _text(task.get("id", ""))
        if not task_id:
            continue

        try:
            lifecycle = _task_lifecycle_state(task)

            # Only running tasks can be lost
            if lifecycle != "running":
                continue

            # Safety: never touch terminal
            if is_terminal_lifecycle(lifecycle):
                continue

            if not _is_lost(task, max_lost_minutes):
                continue

            if dry_run:
                items.append({
                    "task_id": task_id,
                    "action": "would_mark_lost",
                    "result": "dry_run",
                })
                continue

            # Emit event
            if append_task_event is not None:
                try:
                    append_task_event(task, "task_failed", message=f"Task lost — no heartbeat for {max_lost_minutes} minutes")
                except Exception:
                    pass

            # Mark as lost via relay
            relay_result: dict[str, Any] = {"ok": False, "error": "relay_unavailable"}
            if relay_task_completion is not None:
                try:
                    relay_result = relay_task_completion(
                        task_id=task_id,
                        status="failed",
                        summary=f"Task lost — no heartbeat for {max_lost_minutes} minutes",
                        failure_type="lost",
                        workspace=workspace,
                    )
                except Exception as exc:
                    relay_result = {"ok": False, "error": str(exc)}

            items.append({
                "task_id": task_id,
                "action": "marked_lost",
                "result": relay_result,
            })
        except Exception as exc:
            errors.append({"task_id": task_id, "error": str(exc), "phase": "reconcile_lost"})

    return {
        "reconciled_count": len(items),
        "items": items,
        "errors": errors,
    }


def reconcile_all(
    workspace: str = "",
    dry_run: bool = False,
) -> dict[str, Any]:
    """Run all reconcilers and return combined report.

    Returns:
        {stale: {...}, delivery: {...}, notification: {...}, lost: {...},
         total_reconciled: int, errors: []}
    """
    stale = reconcile_stale_tasks(workspace=workspace, dry_run=dry_run)
    delivery = reconcile_delivery_failed(workspace=workspace, dry_run=dry_run)
    notification = reconcile_notification_retry(workspace=workspace, dry_run=dry_run)
    lost = reconcile_lost_tasks(workspace=workspace, dry_run=dry_run)

    total_reconciled = (
        stale.get("reconciled_count", 0)
        + delivery.get("reconciled_count", 0)
        + notification.get("reconciled_count", 0)
        + lost.get("reconciled_count", 0)
    )

    all_errors: list[dict[str, Any]] = []
    for section_name, section in [("stale", stale), ("delivery", delivery), ("notification", notification), ("lost", lost)]:
        for err in section.get("errors", []):
            err_with_section = dict(err)
            err_with_section["section"] = section_name
            all_errors.append(err_with_section)

    return {
        "stale": stale,
        "delivery": delivery,
        "notification": notification,
        "lost": lost,
        "total_reconciled": total_reconciled,
        "errors": all_errors,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    """CLI entry point for reconciler."""
    parser = argparse.ArgumentParser(
        description="OctoClaw reconciler — detect and repair state drift",
    )
    subparsers = parser.add_subparsers(dest="command", help="Reconciler subcommand")

    # Common flags
    def add_common_flags(p: argparse.ArgumentParser) -> None:
        p.add_argument("--dry-run", action="store_true", default=True,
                        help="Dry run mode (default: True for manual invocation)")
        p.add_argument("--apply", action="store_true", default=False,
                        help="Apply changes (opposite of --dry-run)")
        p.add_argument("--workspace", default="", help="Workspace path override")
        p.add_argument("--task-id", default="", help="Reconcile specific task")

    # Subcommands
    stale_parser = subparsers.add_parser("stale", help="Reconcile stale tasks")
    add_common_flags(stale_parser)
    stale_parser.add_argument("--max-stale-minutes", type=int, default=30)

    delivery_parser = subparsers.add_parser("delivery", help="Retry failed deliveries")
    add_common_flags(delivery_parser)
    delivery_parser.add_argument("--max-retries", type=int, default=3)
    delivery_parser.add_argument("--cooldown-seconds", type=int, default=60)

    notification_parser = subparsers.add_parser("notification", help="Retry failed notifications")
    add_common_flags(notification_parser)
    notification_parser.add_argument("--max-retries", type=int, default=3)

    lost_parser = subparsers.add_parser("lost", help="Reconcile lost tasks")
    add_common_flags(lost_parser)
    lost_parser.add_argument("--max-lost-minutes", type=int, default=120)

    all_parser = subparsers.add_parser("all", help="Run all reconcilers")
    add_common_flags(all_parser)

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(0)

    dry_run = not args.apply  # --apply overrides --dry-run

    if args.command == "stale":
        report = reconcile_stale_tasks(
            max_stale_minutes=args.max_stale_minutes,
            workspace=args.workspace,
            dry_run=dry_run,
        )
    elif args.command == "delivery":
        report = reconcile_delivery_failed(
            max_retries=args.max_retries,
            cooldown_seconds=args.cooldown_seconds,
            workspace=args.workspace,
            dry_run=dry_run,
        )
    elif args.command == "notification":
        report = reconcile_notification_retry(
            max_retries=args.max_retries,
            workspace=args.workspace,
            dry_run=dry_run,
        )
    elif args.command == "lost":
        report = reconcile_lost_tasks(
            max_lost_minutes=args.max_lost_minutes,
            workspace=args.workspace,
            dry_run=dry_run,
        )
    elif args.command == "all":
        report = reconcile_all(
            workspace=args.workspace,
            dry_run=dry_run,
        )
    else:
        parser.print_help()
        sys.exit(0)
        return  # pragma: no cover

    print(json.dumps(report, ensure_ascii=False, indent=2, default=str))

    # Exit codes: 0 = nothing to reconcile, 1 = errors, 2 = items reconciled
    total = report.get("reconciled_count", report.get("total_reconciled", 0))
    errs = report.get("errors", [])
    if errs:
        sys.exit(1)
    elif total > 0:
        sys.exit(2)
    else:
        sys.exit(0)


if __name__ == "__main__":
    main()
