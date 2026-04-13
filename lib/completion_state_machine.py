"""Formal state machine for task lifecycle/outcome/handoff transitions."""

from __future__ import annotations

COMPLETION_STATE_MACHINE_VERSION = "octoclaw.completion_state_machine/v1"

# ---------------------------------------------------------------------------
# Lifecycle state transitions
# ---------------------------------------------------------------------------
VALID_LIFECYCLE_TRANSITIONS: dict[str, frozenset[str]] = {
    "planned": frozenset({"queued", "cancelled"}),
    "queued": frozenset({"running", "cancelled"}),
    "running": frozenset({"finalizing", "cancelled"}),
    "finalizing": frozenset({"finished", "cancelled"}),
    "finished": frozenset(),   # terminal
    "cancelled": frozenset(),  # terminal
}

# ---------------------------------------------------------------------------
# Outcome state transitions
# ---------------------------------------------------------------------------
VALID_OUTCOME_TRANSITIONS: dict[str, frozenset[str]] = {
    "pending": frozenset({"done", "failed", "blocked", "partial", "cancelled"}),
    "done": frozenset(),      # terminal
    "blocked": frozenset({"done", "failed", "partial", "cancelled"}),
    "failed": frozenset(),    # terminal
    "partial": frozenset({"done", "failed", "cancelled"}),
    "cancelled": frozenset(),  # terminal
}

# ---------------------------------------------------------------------------
# Handoff state transitions
# ---------------------------------------------------------------------------
VALID_HANDOFF_TRANSITIONS: dict[str, frozenset[str]] = {
    "none": frozenset({"internal_only"}),
    "internal_only": frozenset({"user_safe_ready"}),
    "user_safe_ready": frozenset({"delivered"}),
    "delivered": frozenset(),  # terminal
}

# ---------------------------------------------------------------------------
# Terminal state sets
# ---------------------------------------------------------------------------
TERMINAL_LIFECYCLE = frozenset({"finished", "cancelled"})
TERMINAL_OUTCOME = frozenset({"done", "failed", "cancelled"})
TERMINAL_HANDOFF = frozenset({"delivered"})

# ---------------------------------------------------------------------------
# Status-to-lifecycle mapping for infer_next_lifecycle
# ---------------------------------------------------------------------------
_CANCELLED_STATUSES = frozenset({"cancelled"})
_FINISHED_STATUSES = frozenset({"done", "completed", "failed"})
_RUNNING_STATUSES = frozenset({"running", "in_progress"})
_QUEUED_STATUSES = frozenset({"queued", "pending", "dispatched"})


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def is_valid_lifecycle_transition(from_state: str, to_state: str) -> bool:
    """Check if a lifecycle state transition is allowed."""
    allowed = VALID_LIFECYCLE_TRANSITIONS.get(from_state)
    if allowed is None:
        return False
    return to_state in allowed


def is_valid_outcome_transition(from_state: str, to_state: str) -> bool:
    """Check if an outcome state transition is allowed."""
    allowed = VALID_OUTCOME_TRANSITIONS.get(from_state)
    if allowed is None:
        return False
    return to_state in allowed


def is_valid_handoff_transition(from_state: str, to_state: str) -> bool:
    """Check if a handoff state transition is allowed."""
    allowed = VALID_HANDOFF_TRANSITIONS.get(from_state)
    if allowed is None:
        return False
    return to_state in allowed


def is_terminal_lifecycle(state: str) -> bool:
    """Check if a lifecycle state is terminal."""
    return state in TERMINAL_LIFECYCLE


def is_terminal_outcome(state: str) -> bool:
    """Check if an outcome state is terminal."""
    return state in TERMINAL_OUTCOME


def is_terminal_handoff(state: str) -> bool:
    """Check if a handoff state is terminal."""
    return state in TERMINAL_HANDOFF


# ---------------------------------------------------------------------------
# Comprehensive validation
# ---------------------------------------------------------------------------

def validate_transition(
    task: dict,
    target_lifecycle: str = "",
    target_outcome: str = "",
    target_handoff: str = "",
) -> dict:
    """Validate all requested state transitions for a task.

    Checks each dimension independently and collects ALL violations.

    Args:
        task: Task dictionary with keys lifecycle_state, outcome_state,
              handoff_state.
        target_lifecycle: Desired next lifecycle state (empty skips check).
        target_outcome: Desired next outcome state (empty skips check).
        target_handoff: Desired next handoff state (empty skips check).

    Returns:
        Dict with valid, violations, from/to pairs for each dimension.
    """
    from_lifecycle = str(task.get("lifecycle_state") or "")
    from_outcome = str(task.get("outcome_state") or "")
    from_handoff = str(task.get("handoff_state") or "")

    violations: list[str] = []

    if target_lifecycle:
        if not is_valid_lifecycle_transition(from_lifecycle, target_lifecycle):
            violations.append(
                f"invalid lifecycle transition: {from_lifecycle} -> {target_lifecycle}"
            )

    if target_outcome:
        if not is_valid_outcome_transition(from_outcome, target_outcome):
            violations.append(
                f"invalid outcome transition: {from_outcome} -> {target_outcome}"
            )

    if target_handoff:
        if not is_valid_handoff_transition(from_handoff, target_handoff):
            violations.append(
                f"invalid handoff transition: {from_handoff} -> {target_handoff}"
            )

    return {
        "valid": len(violations) == 0,
        "violations": violations,
        "from_lifecycle": from_lifecycle,
        "to_lifecycle": target_lifecycle,
        "from_outcome": from_outcome,
        "to_outcome": target_outcome,
        "from_handoff": from_handoff,
        "to_handoff": target_handoff,
    }


# ---------------------------------------------------------------------------
# Infer next lifecycle state from task status
# ---------------------------------------------------------------------------

def infer_next_lifecycle(task: dict) -> str:
    """Infer what lifecycle state a task SHOULD be in based on its status.

    Args:
        task: Task dictionary with a ``status`` key.

    Returns:
        The inferred lifecycle state string.
    """
    status = str(task.get("status") or "").lower()

    if status in _CANCELLED_STATUSES:
        return "cancelled"
    if status in _FINISHED_STATUSES:
        return "finished"
    if status in _RUNNING_STATUSES:
        return "running"
    if status in _QUEUED_STATUSES:
        return "queued"
    return "planned"
