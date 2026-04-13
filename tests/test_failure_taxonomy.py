#!/usr/bin/env python3
"""Tests for failure_taxonomy module."""

import unittest

try:
    from failure_taxonomy import (
        FAILURE_TYPES,
        FAILURE_TYPE_SCHEMA_VERSION,
        OUTCOME_TO_FAILURE,
        default_handoff_state,
        default_outcome_state,
        default_recovery_action,
        failure_type_from_outcome,
        is_retriable,
        is_terminal,
        normalize_failure_type,
        requires_notification,
        validate_failure_type,
    )
except ModuleNotFoundError:
    import sys
    sys.path.insert(0, "lib")
    from failure_taxonomy import (
        FAILURE_TYPES,
        FAILURE_TYPE_SCHEMA_VERSION,
        OUTCOME_TO_FAILURE,
        default_handoff_state,
        default_outcome_state,
        default_recovery_action,
        failure_type_from_outcome,
        is_retriable,
        is_terminal,
        normalize_failure_type,
        requires_notification,
        validate_failure_type,
    )


class TestSchemaVersion(unittest.TestCase):
    def test_schema_version_exists(self):
        self.assertEqual(FAILURE_TYPE_SCHEMA_VERSION, "octoclaw.failure_type/v1")


class TestFailureTypeMetadata(unittest.TestCase):
    def test_all_failure_types_have_valid_metadata(self):
        for failure_type, metadata in FAILURE_TYPES.items():
            self.assertIn("recovery", metadata)
            self.assertIn("outcome", metadata)
            self.assertIn("handoff", metadata)
            self.assertIn("retriable", metadata)
            self.assertIn("terminal", metadata)

    def test_all_failure_types_have_string_values(self):
        for failure_type, metadata in FAILURE_TYPES.items():
            self.assertIsInstance(metadata["recovery"], str)
            self.assertIsInstance(metadata["outcome"], str)
            self.assertIsInstance(metadata["handoff"], str)


class TestIsRetriable(unittest.TestCase):
    def test_failed_not_retriable(self):
        self.assertFalse(is_retriable("failed"))

    def test_timed_out_retriable(self):
        self.assertTrue(is_retriable("timed_out"))

    def test_cancelled_not_retriable(self):
        self.assertFalse(is_retriable("cancelled"))

    def test_lost_retriable(self):
        self.assertTrue(is_retriable("lost"))

    def test_delivery_failed_retriable(self):
        self.assertTrue(is_retriable("delivery_failed"))

    def test_runner_lease_expired_retriable(self):
        self.assertTrue(is_retriable("runner_lease_expired"))

    def test_runner_bootstrap_failed_retriable(self):
        self.assertTrue(is_retriable("runner_bootstrap_failed"))

    def test_unknown_failure_type_defaults_false(self):
        self.assertFalse(is_retriable("unknown_failure"))


class TestIsTerminal(unittest.TestCase):
    def test_failed_terminal(self):
        self.assertTrue(is_terminal("failed"))

    def test_timed_out_terminal(self):
        self.assertTrue(is_terminal("timed_out"))

    def test_cancelled_terminal(self):
        self.assertTrue(is_terminal("cancelled"))

    def test_delivery_failed_not_terminal(self):
        self.assertFalse(is_terminal("delivery_failed"))

    def test_native_unavailable_fallback_mirror_not_terminal(self):
        self.assertFalse(is_terminal("native_unavailable_fallback_mirror"))

    def test_unknown_failure_type_defaults_true(self):
        self.assertTrue(is_terminal("unknown_failure"))


class TestRequiresNotification(unittest.TestCase):
    def test_failed_requires_notification(self):
        self.assertTrue(requires_notification("failed"))

    def test_timed_out_requires_notification(self):
        self.assertTrue(requires_notification("timed_out"))

    def test_cancelled_no_notification(self):
        self.assertFalse(requires_notification("cancelled"))

    def test_lost_no_notification(self):
        self.assertFalse(requires_notification("lost"))

    def test_delivery_failed_no_notification(self):
        self.assertFalse(requires_notification("delivery_failed"))

    def test_native_unavailable_fallback_mirror_no_notification(self):
        self.assertFalse(requires_notification("native_unavailable_fallback_mirror"))

    def test_runner_queue_full_no_notification(self):
        self.assertFalse(requires_notification("runner_queue_full"))

    def test_unknown_failure_type_no_notification(self):
        self.assertFalse(requires_notification("unknown_failure"))


class TestDefaultRecoveryAction(unittest.TestCase):
    def test_failed_recovery(self):
        self.assertEqual(default_recovery_action("failed"), "inspect_and_retry")

    def test_timed_out_recovery(self):
        self.assertEqual(default_recovery_action("timed_out"), "retry_with_fresh_lease")

    def test_cancelled_recovery(self):
        self.assertEqual(default_recovery_action("cancelled"), "none")

    def test_lost_recovery(self):
        self.assertEqual(default_recovery_action("lost"), "reclaim_and_retry")

    def test_unknown_recovery_defaults_inspect_and_retry(self):
        self.assertEqual(default_recovery_action("unknown_failure"), "inspect_and_retry")


class TestDefaultOutcomeState(unittest.TestCase):
    def test_failed_outcome(self):
        self.assertEqual(default_outcome_state("failed"), "failed")

    def test_cancelled_outcome(self):
        self.assertEqual(default_outcome_state("cancelled"), "cancelled")

    def test_delivery_failed_outcome(self):
        self.assertEqual(default_outcome_state("delivery_failed"), "done")

    def test_native_unavailable_fallback_mirror_outcome(self):
        self.assertEqual(default_outcome_state("native_unavailable_fallback_mirror"), "pending")

    def test_unknown_outcome_defaults_failed(self):
        self.assertEqual(default_outcome_state("unknown_failure"), "failed")


class TestDefaultHandoffState(unittest.TestCase):
    def test_failed_handoff(self):
        self.assertEqual(default_handoff_state("failed"), "internal_only")

    def test_cancelled_handoff(self):
        self.assertEqual(default_handoff_state("cancelled"), "none")

    def test_delivery_failed_handoff(self):
        self.assertEqual(default_handoff_state("delivery_failed"), "user_safe_ready")

    def test_lost_handoff(self):
        self.assertEqual(default_handoff_state("lost"), "none")

    def test_unknown_handoff_defaults_none(self):
        self.assertEqual(default_handoff_state("unknown_failure"), "none")


class TestFailureTypeFromOutcome(unittest.TestCase):
    def test_cancelled_outcome_maps_to_cancelled(self):
        self.assertEqual(failure_type_from_outcome("cancelled"), "cancelled")

    def test_failed_with_runner_lease_expired_reason(self):
        result = failure_type_from_outcome("failed", blocked_reason="runner_lease_expired")
        self.assertEqual(result, "runner_lease_expired")

    def test_failed_with_bootstrap_reason(self):
        result = failure_type_from_outcome("failed", blocked_reason="bootstrap failed")
        self.assertEqual(result, "runner_bootstrap_failed")

    def test_failed_with_materialization_reason(self):
        result = failure_type_from_outcome("failed", blocked_reason="materialization error")
        self.assertEqual(result, "materialization_failed")

    def test_failed_default_maps_to_failed(self):
        self.assertEqual(failure_type_from_outcome("failed"), "failed")

    def test_pending_outcome_maps_to_failed(self):
        self.assertEqual(failure_type_from_outcome("pending"), "failed")

    def test_done_outcome_maps_to_failed(self):
        self.assertEqual(failure_type_from_outcome("done"), "failed")


class TestNormalizeFailureType(unittest.TestCase):
    def test_runner_lease_expired_normalizes_to_self(self):
        self.assertEqual(normalize_failure_type("runner_lease_expired"), "runner_lease_expired")

    def test_stale_queued_job_normalizes_to_timed_out(self):
        self.assertEqual(normalize_failure_type("stale_queued_job"), "timed_out")

    def test_runner_bootstrap_failed_normalizes_to_self(self):
        self.assertEqual(normalize_failure_type("runner_bootstrap_failed"), "runner_bootstrap_failed")

    def test_unknown_normalizes_to_failed(self):
        self.assertEqual(normalize_failure_type("unknown_failure"), "failed")

    def test_case_insensitive(self):
        self.assertEqual(normalize_failure_type("Runner_Lease_Expired"), "runner_lease_expired")

    def test_whitespace_stripped(self):
        self.assertEqual(normalize_failure_type("  runner_lease_expired  "), "runner_lease_expired")


class TestValidateFailureType(unittest.TestCase):
    def test_valid_failure_types_accepted(self):
        for failure_type in FAILURE_TYPES:
            self.assertTrue(validate_failure_type(failure_type))

    def test_unknown_failure_type_rejected(self):
        self.assertFalse(validate_failure_type("unknown_failure"))

    def test_empty_string_rejected(self):
        self.assertFalse(validate_failure_type(""))


class TestOutcomeToFailure(unittest.TestCase):
    def test_failed_maps_to_failed(self):
        self.assertEqual(OUTCOME_TO_FAILURE["failed"], "failed")

    def test_cancelled_maps_to_cancelled(self):
        self.assertEqual(OUTCOME_TO_FAILURE["cancelled"], "cancelled")

    def test_blocked_maps_to_failed(self):
        self.assertEqual(OUTCOME_TO_FAILURE["blocked"], "failed")


if __name__ == "__main__":
    unittest.main()