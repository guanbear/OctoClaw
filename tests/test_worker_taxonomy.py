#!/usr/bin/env python3
import unittest

from lib.worker_taxonomy import (
    infer_worker_pool,
    is_runner_task,
    model_role_for_worker_pool,
    resolve_model_band,
    resolve_executor,
    resolve_phase,
    resolve_work_type,
    resolve_worker_pool,
    role_display,
)


class WorkerTaxonomyTests(unittest.TestCase):
    def test_infer_worker_pool_prefers_route_then_work_type(self) -> None:
        self.assertEqual(infer_worker_pool("direct", "research"), "octoclaw-main")
        self.assertEqual(infer_worker_pool("runner", "ops"), "octoclaw-runner")
        self.assertEqual(infer_worker_pool("spawn_single", "code"), "octoclaw-code")
        self.assertEqual(infer_worker_pool("spawn_single", "review"), "octoclaw-review")
        self.assertEqual(infer_worker_pool("spawn_single", "research"), "octoclaw-research")

    def test_selector_role_uses_new_taxonomy(self) -> None:
        self.assertEqual(
            model_role_for_worker_pool("octoclaw-research", phase="report", route="spawn_single", profile="writer"),
            "writer",
        )
        self.assertEqual(
            model_role_for_worker_pool("octoclaw-code", phase="implement", route="spawn_multi", profile="code"),
            "team",
        )

    def test_resolve_worker_pool_prefers_explicit_pool_then_route_and_work_type(self) -> None:
        self.assertEqual(resolve_worker_pool({"worker_pool": "octoclaw-review"}), "octoclaw-review")
        self.assertEqual(resolve_worker_pool({"route": "spawn_single", "work_type": "code"}), "octoclaw-code")
        self.assertEqual(resolve_worker_pool({"route": "runner", "work_type": "ops"}), "octoclaw-runner")

    def test_work_type_and_phase_can_be_derived_from_worker_pool_first(self) -> None:
        self.assertEqual(resolve_work_type({"worker_pool": "octoclaw-code"}), "code")
        self.assertEqual(resolve_phase({"worker_pool": "octoclaw-review"}), "verify")
        self.assertEqual(resolve_phase({"worker_pool": "octoclaw-research", "profile": "writer"}), "report")

    def test_role_display_uses_worker_pool_without_legacy_labels(self) -> None:
        self.assertEqual(role_display({"worker_pool": "octoclaw-code"})["name"], "Code")
        self.assertEqual(role_display({"worker_pool": "octoclaw-research"})["emoji"], "🔍")
        self.assertEqual(role_display("octoclaw-runner")["name"], "Runner")

    def test_model_band_resolution_ignores_removed_tier_fields(self) -> None:
        self.assertEqual(resolve_model_band({"worker_pool": "octoclaw-code"}), "strong")
        self.assertEqual(resolve_model_band({"route": "runner", "unexpected_band": "legacy"}), "fast")

    def test_executor_and_runner_detection_use_worker_pool_first(self) -> None:
        self.assertEqual(resolve_executor({"worker_pool": "octoclaw-runner"}), "runner")
        self.assertEqual(resolve_executor({"route": "spawn_multi"}), "team")
        self.assertTrue(is_runner_task({"worker_pool": "octoclaw-runner"}))
        self.assertFalse(is_runner_task({"worker_pool": "octoclaw-code"}))


if __name__ == "__main__":
    unittest.main()
