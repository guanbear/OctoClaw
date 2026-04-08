#!/usr/bin/env python3
import json
import subprocess
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
BOUNDARY_SCRIPT = REPO_ROOT / "lib" / "auto-router-boundary.mjs"


class AutoRouterBoundaryTests(unittest.TestCase):
    def test_boundary_manifest_exposes_public_surface_and_internal_coupling(self) -> None:
        result = subprocess.run(
            ["node", str(BOUNDARY_SCRIPT)],
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
            check=True,
        )
        payload = json.loads(result.stdout)

        self.assertEqual(payload["schema_version"], "octoclaw.auto_router.boundary/v1")
        self.assertEqual(payload["extractable_readiness"]["status"], "baseline")
        public_names = [item["name"] for item in payload["public_surface_shortlist"]]
        self.assertIn("recommendation_payload", public_names)
        self.assertIn("model_intel_facts_plane", public_names)
        self.assertIn("router_eval_baseline", public_names)
        internal_areas = [item["area"] for item in payload["internal_only_runtime_coupling"]]
        self.assertIn("policy_adapter", internal_areas)
        self.assertIn("delegated_lane_consumption", internal_areas)


if __name__ == "__main__":
    unittest.main()
