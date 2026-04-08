#!/usr/bin/env python3
import json
import subprocess
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
LAYOUT_SCRIPT = REPO_ROOT / "lib" / "auto-router-package-layout.mjs"
SURFACE_SCRIPT = REPO_ROOT / "lib" / "auto-router-surface.mjs"


class AutoRouterPackageLayoutTests(unittest.TestCase):
    def test_layout_manifest_has_public_entries_and_exclusions(self) -> None:
        result = subprocess.run(
            ["node", str(LAYOUT_SCRIPT)],
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
            check=True,
        )
        payload = json.loads(result.stdout)
        self.assertEqual(payload["schema_version"], "octoclaw.auto_router.package_layout/v1")
        self.assertEqual(payload["package_name"], "octoclaw-auto-router")
        self.assertEqual(payload["status"], "prep_baseline")
        entry_names = [entry["name"] for entry in payload["public_entries"]]
        self.assertIn("layout", entry_names)
        self.assertIn("recommend", entry_names)
        self.assertIn("sync", entry_names)
        self.assertIn("lib/octoclaw_policy.py", payload["explicit_runtime_exclusions"])

    def test_surface_layout_command_returns_package_layout_manifest(self) -> None:
        result = subprocess.run(
            ["node", str(SURFACE_SCRIPT), "layout"],
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
            check=True,
        )
        payload = json.loads(result.stdout)
        self.assertEqual(payload["schema_version"], "octoclaw.auto_router.package_layout/v1")
        self.assertEqual(payload["future_layout"]["root"], "packages/octoclaw-auto-router")


if __name__ == "__main__":
    unittest.main()
