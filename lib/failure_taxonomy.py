#!/usr/bin/env python3
"""Failure type taxonomy for OctoClaw."""

from __future__ import annotations

from typing import Any

FAILURE_TYPE_SCHEMA_VERSION = "octoclaw.failure_type/v1"

FAILURE_TYPES: dict[str, dict[str, str]] = {
    "failed": {"retriable": False, "terminal": True, "outcome": "failed", "handoff": "internal_only", "recovery": "inspect_and_retry"},
    "timed_out": {"retriable": True, "terminal": True, "outcome": "failed", "handoff": "internal_only", "recovery": "retry_with_fresh_lease"},
    "cancelled": {"retriable": False, "terminal": True, "outcome": "cancelled", "handoff": "none", "recovery": "none"},
    "lost": {"retriable": True, "terminal": True, "outcome": "failed", "handoff": "none", "recovery": "reclaim_and_retry"},
    "delivery_failed": {"retriable": True, "terminal": False, "outcome": "done", "handoff": "user_safe_ready", "recovery": "retry_delivery"},
    "materialization_failed": {"retriable": False, "terminal": True, "outcome": "failed", "handoff": "none", "recovery": "replan_or_retry"},
    "native_unavailable_fallback_mirror": {"retriable": False, "terminal": False, "outcome": "pending", "handoff": "none", "recovery": "degrade_to_mirror"},
    "runner_lease_expired": {"retriable": True, "terminal": True, "outcome": "failed", "handoff": "internal_only", "recovery": "requeue_with_fresh_lease"},
    "runner_bootstrap_failed": {"retriable": True, "terminal": True, "outcome": "failed", "handoff": "none", "recovery": "retry_bootstrap"},
    "runner_queue_full": {"retriable": True, "terminal": False, "outcome": "pending", "handoff": "none", "recovery": "wait_for_capacity"},
    "runner_playbook_missing": {"retriable": False, "terminal": True, "outcome": "failed", "handoff": "none", "recovery": "register_playbook"},
    "runner_worker_unhealthy": {"retriable": True, "terminal": False, "outcome": "pending", "handoff": "none", "recovery": "wait_for_healthy_worker"},
    "spawn_backend_unavailable": {"retriable": False, "terminal": True, "outcome": "failed", "handoff": "none", "recovery": "enable_spawn_backend"},
    "policy_decision_required": {"retriable": False, "terminal": True, "outcome": "failed", "handoff": "none", "recovery": "provide_policy_decision"},
    "native_sync_failed": {"retriable": True, "terminal": False, "outcome": "pending", "handoff": "none", "recovery": "reconciler_compensate"},
}

OUTCOME_TO_FAILURE: dict[str, str] = {
    "failed": "failed",
    "cancelled": "cancelled",
    "blocked": "failed",
}


def is_retriable(failure_type: str) -> bool:
    """Check if a failure type is retriable."""
    return FAILURE_TYPES.get(failure_type, {}).get("retriable", False)


def is_terminal(failure_type: str) -> bool:
    """Check if a failure type is terminal."""
    return FAILURE_TYPES.get(failure_type, {}).get("terminal", True)


def requires_notification(failure_type: str) -> bool:
    """Check if a failure type requires notification."""
    if not is_terminal(failure_type):
        return False
    handoff = FAILURE_TYPES.get(failure_type, {}).get("handoff", "none")
    return handoff != "none"


def default_recovery_action(failure_type: str) -> str:
    """Get the default recovery action for a failure type."""
    return FAILURE_TYPES.get(failure_type, {}).get("recovery", "inspect_and_retry")


def default_outcome_state(failure_type: str) -> str:
    """Get the default outcome state for a failure type."""
    return FAILURE_TYPES.get(failure_type, {}).get("outcome", "failed")


def default_handoff_state(failure_type: str) -> str:
    """Get the default handoff state for a failure type."""
    return FAILURE_TYPES.get(failure_type, {}).get("handoff", "none")


def failure_type_from_outcome(outcome_state: str, blocked_reason: str = "") -> str:
    """Map outcome state and blocked reason to canonical failure type."""
    if outcome_state == "cancelled":
        return "cancelled"

    if outcome_state == "failed":
        reason_lower = blocked_reason.lower()
        if "runner_lease_expired" in reason_lower:
            return "runner_lease_expired"
        if "bootstrap" in reason_lower:
            return "runner_bootstrap_failed"
        if "materialization" in reason_lower:
            return "materialization_failed"
        return "failed"

    # Default fallback
    return OUTCOME_TO_FAILURE.get(outcome_state, "failed")


def normalize_failure_type(raw: str) -> str:
    """Map legacy or raw failure type strings to canonical failure type."""
    normalized = raw.lower().strip()

    # Direct mappings
    if normalized == "runner_lease_expired":
        return "runner_lease_expired"
    if normalized == "stale_queued_job":
        return "timed_out"
    if normalized == "runner_bootstrap_failed":
        return "runner_bootstrap_failed"

    # Unknown
    return "failed"


def validate_failure_type(failure_type: str) -> bool:
    """Validate that a failure type is canonical."""
    return failure_type in FAILURE_TYPES