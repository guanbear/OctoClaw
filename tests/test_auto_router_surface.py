#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SURFACE_SCRIPT = REPO_ROOT / "lib" / "auto-router-surface.mjs"


class AutoRouterSurfaceTests(unittest.TestCase):
    def test_surface_manifest_command_returns_boundary_manifest(self) -> None:
        result = subprocess.run(
            ["node", str(SURFACE_SCRIPT), "manifest"],
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
            check=True,
        )
        payload = json.loads(result.stdout)
        self.assertEqual(payload["schema_version"], "octoclaw.auto_router.boundary/v1")
        self.assertEqual(payload["extractable_readiness"]["status"], "baseline")

    def test_surface_facts_command_reads_workspace_local_facts_plane(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-auto-router-surface-") as workspace:
            tmp_octopus = Path(workspace) / "tmp" / "octopus"
            tmp_octopus.mkdir(parents=True, exist_ok=True)
            (tmp_octopus / "model-catalog.json").write_text(
                json.dumps({"models": [{"id": "openai/gpt-5.4"}], "facts_plane": {"source_precedence": {"runtime": ["provider_runtime_observation"]}}}),
                encoding="utf-8",
            )
            (tmp_octopus / "model-policy.json").write_text(
                json.dumps({"main_model": "openai/gpt-5.4", "facts_plane": {"source_precedence": {"runtime": ["provider_runtime_observation"]}}}),
                encoding="utf-8",
            )
            (tmp_octopus / "model-intel-source-status.json").write_text(
                json.dumps({"sources": {"runtime_health": {"active": True, "freshness": "fresh"}}}),
                encoding="utf-8",
            )
            result = subprocess.run(
                ["node", str(SURFACE_SCRIPT), "facts"],
                capture_output=True,
                text=True,
                cwd=str(REPO_ROOT),
                env={**os.environ, "WORKSPACE": workspace},
                check=True,
            )
        payload = json.loads(result.stdout)
        self.assertEqual(payload["schema_version"], "octoclaw.auto_router.surface_facts/v1")
        self.assertEqual(payload["summary"]["model_count"], 1)
        self.assertEqual(payload["summary"]["main_model"], "openai/gpt-5.4")
        self.assertIn("catalog", payload["files"])

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
        self.assertEqual(payload["package_name"], "octoclaw-auto-router")


if __name__ == "__main__":
    unittest.main()
