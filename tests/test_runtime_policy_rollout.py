#!/usr/bin/env python3
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
ROLLOUT_SCRIPT = REPO_ROOT / "lib" / "runtime_policy_rollout.py"


class RuntimePolicyRolloutTests(unittest.TestCase):
    def test_render_policy_conservative_defaults(self) -> None:
        result = subprocess.run(
            ["python3", str(ROLLOUT_SCRIPT), "render-policy", "--preset", "conservative"],
            capture_output=True,
            text=True,
            check=True,
        )
        payload = json.loads(result.stdout)
        self.assertTrue(payload["enabled"])
        self.assertTrue(payload["switches"]["hard_runner_only"])
        self.assertFalse(payload["switches"]["route_hint_required"])
        self.assertFalse(payload["switches"]["delegation_enforcement"])
        self.assertFalse(payload["hooks"]["before_model_resolve"])
        self.assertFalse(payload["route_stickiness"]["enabled"])

    def test_merge_and_cleanup_runtime_policy(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-rollout-test-") as tmpdir:
            config_path = Path(tmpdir) / "octopus-config.json"
            config_path.write_text(json.dumps({"notification": {"backend": "auto"}}), encoding="utf-8")

            subprocess.run(
                [
                    "python3",
                    str(ROLLOUT_SCRIPT),
                    "merge-config",
                    "--config",
                    str(config_path),
                    "--preset",
                    "guided",
                    "--direct-model-override",
                    "false",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            merged = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertIn("runtime_policy", merged)
            self.assertTrue(merged["runtime_policy"]["switches"]["route_hint_required"])
            self.assertFalse(merged["runtime_policy"]["switches"]["direct_model_override"])
            self.assertTrue(merged["notification"]["backend"] == "auto")

            subprocess.run(
                ["python3", str(ROLLOUT_SCRIPT), "cleanup-config", "--config", str(config_path)],
                check=True,
                capture_output=True,
                text=True,
            )
            cleaned = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertNotIn("runtime_policy", cleaned)
            self.assertIn("notification", cleaned)


if __name__ == "__main__":
    unittest.main()
