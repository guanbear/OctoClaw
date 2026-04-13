#!/usr/bin/env python3

from __future__ import annotations

import unittest

try:
    from lib.completion_state_machine import (
        COMPLETION_STATE_MACHINE_VERSION,
        VALID_LIFECYCLE_TRANSITIONS,
        VALID_OUTCOME_TRANSITIONS,
        VALID_HANDOFF_TRANSITIONS,
        TERMINAL_LIFECYCLE,
        TERMINAL_OUTCOME,
        TERMINAL_HANDOFF,
        is_valid_lifecycle_transition,
        is_valid_outcome_transition,
        is_valid_handoff_transition,
        is_terminal_lifecycle,
        is_terminal_outcome,
        is_terminal_handoff,
        validate_transition,
        infer_next_lifecycle,
    )
except ModuleNotFoundError:
    from completion_state_machine import (
        COMPLETION_STATE_MACHINE_VERSION,
        VALID_LIFECYCLE_TRANSITIONS,
        VALID_OUTCOME_TRANSITIONS,
        VALID_HANDOFF_TRANSITIONS,
        TERMINAL_LIFECYCLE,
        TERMINAL_OUTCOME,
        TERMINAL_HANDOFF,
        is_valid_lifecycle_transition,
        is_valid_outcome_transition,
        is_valid_handoff_transition,
        is_terminal_lifecycle,
        is_terminal_outcome,
        is_terminal_handoff,
        validate_transition,
        infer_next_lifecycle,
    )


class TestSchemaVersion(unittest.TestCase):

    def test_version_string(self):
        self.assertEqual(COMPLETION_STATE_MACHINE_VERSION, "octoclaw.completion_state_machine/v1")


class TestTransitionMapsAreImmutable(unittest.TestCase):

    def test_lifecycle_transitions_use_frozenset_values(self):
        for key, vals in VALID_LIFECYCLE_TRANSITIONS.items():
            with self.subTest(state=key):
                self.assertIsInstance(vals, frozenset)

    def test_outcome_transitions_use_frozenset_values(self):
        for key, vals in VALID_OUTCOME_TRANSITIONS.items():
            with self.subTest(state=key):
                self.assertIsInstance(vals, frozenset)

    def test_handoff_transitions_use_frozenset_values(self):
        for key, vals in VALID_HANDOFF_TRANSITIONS.items():
            with self.subTest(state=key):
                self.assertIsInstance(vals, frozenset)

    def test_terminal_lifecycle_is_frozenset(self):
        self.assertIsInstance(TERMINAL_LIFECYCLE, frozenset)

    def test_terminal_outcome_is_frozenset(self):
        self.assertIsInstance(TERMINAL_OUTCOME, frozenset)

    def test_terminal_handoff_is_frozenset(self):
        self.assertIsInstance(TERMINAL_HANDOFF, frozenset)


class TestValidLifecycleTransitions(unittest.TestCase):

    def test_planned_to_queued(self):
        self.assertTrue(is_valid_lifecycle_transition("planned", "queued"))

    def test_planned_to_cancelled(self):
        self.assertTrue(is_valid_lifecycle_transition("planned", "cancelled"))

    def test_queued_to_running(self):
        self.assertTrue(is_valid_lifecycle_transition("queued", "running"))

    def test_running_to_finalizing(self):
        self.assertTrue(is_valid_lifecycle_transition("running", "finalizing"))

    def test_finalizing_to_finished(self):
        self.assertTrue(is_valid_lifecycle_transition("finalizing", "finished"))


class TestInvalidLifecycleTransitions(unittest.TestCase):

    def test_finished_to_running_rejected(self):
        self.assertFalse(is_valid_lifecycle_transition("finished", "running"))

    def test_cancelled_to_running_rejected(self):
        self.assertFalse(is_valid_lifecycle_transition("cancelled", "running"))

    def test_planned_to_finished_rejected(self):
        self.assertFalse(is_valid_lifecycle_transition("planned", "finished"))

    def test_unknown_from_state_rejected(self):
        self.assertFalse(is_valid_lifecycle_transition("nonexistent", "queued"))

    def test_finished_has_no_outgoing(self):
        for target in ["planned", "queued", "running", "finalizing"]:
            with self.subTest(target=target):
                self.assertFalse(is_valid_lifecycle_transition("finished", target))


class TestValidOutcomeTransitions(unittest.TestCase):

    def test_pending_to_done(self):
        self.assertTrue(is_valid_outcome_transition("pending", "done"))

    def test_pending_to_failed(self):
        self.assertTrue(is_valid_outcome_transition("pending", "failed"))

    def test_blocked_to_done(self):
        self.assertTrue(is_valid_outcome_transition("blocked", "done"))

    def test_partial_to_done(self):
        self.assertTrue(is_valid_outcome_transition("partial", "done"))

    def test_partial_to_cancelled(self):
        self.assertTrue(is_valid_outcome_transition("partial", "cancelled"))


class TestInvalidOutcomeTransitions(unittest.TestCase):

    def test_done_to_pending_rejected(self):
        self.assertFalse(is_valid_outcome_transition("done", "pending"))

    def test_failed_to_done_rejected(self):
        self.assertFalse(is_valid_outcome_transition("failed", "done"))

    def test_cancelled_to_done_rejected(self):
        self.assertFalse(is_valid_outcome_transition("cancelled", "done"))

    def test_done_has_no_outgoing(self):
        for target in ["pending", "done", "failed", "blocked", "partial"]:
            with self.subTest(target=target):
                self.assertFalse(is_valid_outcome_transition("done", target))


class TestValidHandoffTransitions(unittest.TestCase):

    def test_none_to_internal_only(self):
        self.assertTrue(is_valid_handoff_transition("none", "internal_only"))

    def test_internal_only_to_user_safe_ready(self):
        self.assertTrue(is_valid_handoff_transition("internal_only", "user_safe_ready"))

    def test_user_safe_ready_to_delivered(self):
        self.assertTrue(is_valid_handoff_transition("user_safe_ready", "delivered"))


class TestInvalidHandoffTransitions(unittest.TestCase):

    def test_delivered_to_none_rejected(self):
        self.assertFalse(is_valid_handoff_transition("delivered", "none"))

    def test_none_to_delivered_rejected(self):
        self.assertFalse(is_valid_handoff_transition("none", "delivered"))

    def test_delivered_has_no_outgoing(self):
        for target in ["none", "internal_only", "user_safe_ready", "delivered"]:
            with self.subTest(target=target):
                self.assertFalse(is_valid_handoff_transition("delivered", target))


class TestIsTerminalLifecycle(unittest.TestCase):

    def test_finished_is_terminal(self):
        self.assertTrue(is_terminal_lifecycle("finished"))

    def test_cancelled_is_terminal(self):
        self.assertTrue(is_terminal_lifecycle("cancelled"))

    def test_running_is_not_terminal(self):
        self.assertFalse(is_terminal_lifecycle("running"))

    def test_planned_is_not_terminal(self):
        self.assertFalse(is_terminal_lifecycle("planned"))


class TestIsTerminalOutcome(unittest.TestCase):

    def test_done_is_terminal(self):
        self.assertTrue(is_terminal_outcome("done"))

    def test_failed_is_terminal(self):
        self.assertTrue(is_terminal_outcome("failed"))

    def test_cancelled_is_terminal(self):
        self.assertTrue(is_terminal_outcome("cancelled"))

    def test_pending_is_not_terminal(self):
        self.assertFalse(is_terminal_outcome("pending"))

    def test_blocked_is_not_terminal(self):
        self.assertFalse(is_terminal_outcome("blocked"))


class TestIsTerminalHandoff(unittest.TestCase):

    def test_delivered_is_terminal(self):
        self.assertTrue(is_terminal_handoff("delivered"))

    def test_none_is_not_terminal(self):
        self.assertFalse(is_terminal_handoff("none"))

    def test_internal_only_is_not_terminal(self):
        self.assertFalse(is_terminal_handoff("internal_only"))


class TestTerminalStatesHaveNoOutgoingTransitions(unittest.TestCase):

    def test_all_terminal_lifecycle_states_have_empty_transitions(self):
        for state in TERMINAL_LIFECYCLE:
            with self.subTest(state=state):
                self.assertEqual(VALID_LIFECYCLE_TRANSITIONS.get(state, frozenset()), frozenset())

    def test_all_terminal_outcome_states_have_empty_transitions(self):
        for state in TERMINAL_OUTCOME:
            with self.subTest(state=state):
                self.assertEqual(VALID_OUTCOME_TRANSITIONS.get(state, frozenset()), frozenset())

    def test_all_terminal_handoff_states_have_empty_transitions(self):
        for state in TERMINAL_HANDOFF:
            with self.subTest(state=state):
                self.assertEqual(VALID_HANDOFF_TRANSITIONS.get(state, frozenset()), frozenset())


class TestValidateTransition(unittest.TestCase):

    def setUp(self):
        self.task = {
            "lifecycle_state": "running",
            "outcome_state": "pending",
            "handoff_state": "none",
        }

    def test_valid_transition_all_dimensions(self):
        result = validate_transition(
            self.task,
            target_lifecycle="finalizing",
            target_outcome="done",
            target_handoff="internal_only",
        )
        self.assertTrue(result["valid"])
        self.assertEqual(result["violations"], [])

    def test_valid_transition_lifecycle_only(self):
        result = validate_transition(self.task, target_lifecycle="finalizing")
        self.assertTrue(result["valid"])

    def test_empty_target_skips_dimension(self):
        result = validate_transition(self.task)
        self.assertTrue(result["valid"])
        self.assertEqual(result["violations"], [])

    def test_catches_single_violation(self):
        result = validate_transition(self.task, target_lifecycle="planned")
        self.assertFalse(result["valid"])
        self.assertEqual(len(result["violations"]), 1)

    def test_catches_multiple_violations_simultaneously(self):
        task = {
            "lifecycle_state": "finished",
            "outcome_state": "done",
            "handoff_state": "none",
        }
        result = validate_transition(
            task,
            target_lifecycle="running",
            target_outcome="pending",
            target_handoff="delivered",
        )
        self.assertFalse(result["valid"])
        self.assertEqual(len(result["violations"]), 3)

    def test_returns_from_to_fields(self):
        result = validate_transition(
            self.task,
            target_lifecycle="finalizing",
            target_outcome="done",
            target_handoff="internal_only",
        )
        self.assertEqual(result["from_lifecycle"], "running")
        self.assertEqual(result["to_lifecycle"], "finalizing")
        self.assertEqual(result["from_outcome"], "pending")
        self.assertEqual(result["to_outcome"], "done")
        self.assertEqual(result["from_handoff"], "none")
        self.assertEqual(result["to_handoff"], "internal_only")

    def test_missing_task_keys_default_to_empty(self):
        result = validate_transition({}, target_lifecycle="planned")
        self.assertFalse(result["valid"])
        self.assertEqual(result["from_lifecycle"], "")


class TestInferNextLifecycle(unittest.TestCase):

    def test_cancelled_status(self):
        self.assertEqual(infer_next_lifecycle({"status": "cancelled"}), "cancelled")

    def test_done_status(self):
        self.assertEqual(infer_next_lifecycle({"status": "done"}), "finished")

    def test_completed_status(self):
        self.assertEqual(infer_next_lifecycle({"status": "completed"}), "finished")

    def test_failed_status(self):
        self.assertEqual(infer_next_lifecycle({"status": "failed"}), "finished")

    def test_running_status(self):
        self.assertEqual(infer_next_lifecycle({"status": "running"}), "running")

    def test_in_progress_status(self):
        self.assertEqual(infer_next_lifecycle({"status": "in_progress"}), "running")

    def test_queued_status(self):
        self.assertEqual(infer_next_lifecycle({"status": "queued"}), "queued")

    def test_pending_status(self):
        self.assertEqual(infer_next_lifecycle({"status": "pending"}), "queued")

    def test_dispatched_status(self):
        self.assertEqual(infer_next_lifecycle({"status": "dispatched"}), "queued")

    def test_unknown_status_defaults_to_planned(self):
        self.assertEqual(infer_next_lifecycle({"status": "unknown"}), "planned")

    def test_empty_status_defaults_to_planned(self):
        self.assertEqual(infer_next_lifecycle({}), "planned")

    def test_status_is_case_insensitive(self):
        self.assertEqual(infer_next_lifecycle({"status": "Running"}), "running")
        self.assertEqual(infer_next_lifecycle({"status": "DONE"}), "finished")


if __name__ == "__main__":
    unittest.main()
