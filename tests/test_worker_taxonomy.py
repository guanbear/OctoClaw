#!/usr/bin/env python3
import unittest

from lib.worker_taxonomy import (
    infer_worker_pool,
    is_runner_task,
    legacy_label_for_worker_pool,
    model_role_for_worker_pool,
    resolve_executor,
    resolve_worker_pool,
    role_display,
    worker_pool_from_legacy_label,
)


class WorkerTaxonomyTests(unittest.TestCase):
    def test_infer_worker_pool_prefers_route_then_work_type(self) -> None:
        self.assertEqual(infer_worker_pool("direct", "research"), "octoclaw-main")
        self.assertEqual(infer_worker_pool("runner", "ops"), "octoclaw-runner")
        self.assertEqual(infer_worker_pool("spawn_single", "code"), "octoclaw-code")
        self.assertEqual(infer_worker_pool("spawn_single", "review"), "octoclaw-review")
        self.assertEqual(infer_worker_pool("spawn_single", "research"), "octoclaw-research")

    def test_research_pool_legacy_label_depends_on_phase_and_profile(self) -> None:
        self.assertEqual(
            legacy_label_for_worker_pool("octoclaw-research", phase="collect", route="spawn_single"),
            "octopus-scout",
        )
        self.assertEqual(
            legacy_label_for_worker_pool("octoclaw-research", phase="inspect", route="spawn_single"),
            "octopus-analyze",
        )
        self.assertEqual(
            legacy_label_for_worker_pool("octoclaw-research", phase="report", route="spawn_single", profile="writer"),
            "octopus-writer",
        )

    def test_spawn_multi_uses_power_selector_role_but_preserves_worker_pool(self) -> None:
        self.assertEqual(
            model_role_for_worker_pool("octoclaw-code", phase="implement", route="spawn_multi", profile="code"),
            "power",
        )
        self.assertEqual(
            legacy_label_for_worker_pool("octoclaw-code", phase="implement", route="spawn_multi", profile="code"),
            "octopus-power",
        )

    def test_legacy_label_fallback_maps_to_worker_pool(self) -> None:
        self.assertEqual(worker_pool_from_legacy_label("octopus-fix"), "octoclaw-code")
        self.assertEqual(worker_pool_from_legacy_label("octopus-test"), "octoclaw-review")
        self.assertEqual(worker_pool_from_legacy_label("octopus-runner"), "octoclaw-runner")

    def test_resolve_worker_pool_prefers_explicit_pool_then_legacy_label(self) -> None:
        self.assertEqual(resolve_worker_pool({"worker_pool": "octoclaw-review", "label": "octopus-fix"}), "octoclaw-review")
        self.assertEqual(resolve_worker_pool({"label": "octopus-fix"}), "octoclaw-code")
        self.assertEqual(resolve_worker_pool({"route": "runner", "work_type": "ops"}), "octoclaw-runner")

    def test_role_display_prefers_worker_pool_but_falls_back_to_legacy_label(self) -> None:
        self.assertEqual(role_display({"worker_pool": "octoclaw-code"})["name"], "螃蟹手")
        self.assertEqual(role_display({"worker_pool": "octoclaw-research"})["emoji"], "🔍")
        self.assertEqual(role_display({"label": "octopus-analyze"})["name"], "章鱼脑")

    def test_executor_and_runner_detection_use_worker_pool_first(self) -> None:
        self.assertEqual(resolve_executor({"worker_pool": "octoclaw-runner"}), "runner")
        self.assertEqual(resolve_executor({"route": "spawn_multi"}), "team")
        self.assertTrue(is_runner_task({"worker_pool": "octoclaw-runner"}))
        self.assertFalse(is_runner_task({"worker_pool": "octoclaw-code"}))


if __name__ == "__main__":
    unittest.main()
