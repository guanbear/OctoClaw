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

    def test_render_policy_can_override_route_language_packs(self) -> None:
        result = subprocess.run(
            [
                "python3",
                str(ROLLOUT_SCRIPT),
                "render-policy",
                "--preset",
                "conservative",
                "--route-language-packs",
                "zh,en,ja,es",
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        payload = json.loads(result.stdout)
        self.assertEqual(payload["route_language_packs"]["enabled"], ["zh", "en", "ja", "es"])

    def test_merge_and_cleanup_openclaw_plugin_config(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-plugin-rollout-test-") as tmpdir:
            config_path = Path(tmpdir) / "openclaw.json"
            config_path.write_text(
                json.dumps(
                    {
                        "plugins": {
                            "enabled": True,
                            "allow": ["openclaw-weixin"],
                            "entries": {
                                "openclaw-weixin": {
                                    "enabled": True,
                                }
                            },
                        }
                    }
                ),
                encoding="utf-8",
            )

            subprocess.run(
                [
                    "python3",
                    str(ROLLOUT_SCRIPT),
                    "merge-openclaw-plugin",
                    "--config",
                    str(config_path),
                    "--octoclaw-root",
                    "/workspace/openclaw/skills/octopus",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            merged = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertIn("octoclaw-runtime", merged["plugins"]["allow"])
            self.assertTrue(merged["plugins"]["entries"]["octoclaw-runtime"]["enabled"])
            self.assertEqual(
                merged["plugins"]["entries"]["octoclaw-runtime"]["config"]["octoclawRoot"],
                "/workspace/openclaw/skills/octopus",
            )
            self.assertTrue(
                merged["plugins"]["entries"]["octoclaw-runtime"]["hooks"]["allowPromptInjection"]
            )

            subprocess.run(
                [
                    "python3",
                    str(ROLLOUT_SCRIPT),
                    "cleanup-openclaw-plugin",
                    "--config",
                    str(config_path),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            cleaned = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertNotIn("octoclaw-runtime", cleaned["plugins"]["allow"])
            self.assertNotIn("octoclaw-runtime", cleaned["plugins"]["entries"])


if __name__ == "__main__":
    unittest.main()
