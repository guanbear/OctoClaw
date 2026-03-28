#!/usr/bin/env python3
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
ROLLOUT_SCRIPT = REPO_ROOT / "lib" / "runtime_policy_rollout.py"
FIXTURES_PATH = REPO_ROOT / "tests" / "fixtures" / "runtime-policy-replay-events-v1.json"


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

    def test_check_uses_replay_fixture_and_infers_conservative_phase(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-rollout-check-") as tmpdir:
            config_path = Path(tmpdir) / "octopus-config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "runtime_policy": {
                            "enabled": True,
                            "switches": {
                                "hard_runner_only": True,
                                "route_hint_required": False,
                                "replay_logging": True,
                                "direct_model_override": False,
                                "delegation_enforcement": False,
                            },
                            "hooks": {
                                "before_model_resolve": False,
                                "before_prompt_build": True,
                                "before_tool_call": False,
                                "agent_end": True,
                            },
                            "route_stickiness": {"enabled": False},
                        }
                    }
                ),
                encoding="utf-8",
            )
            result = subprocess.run(
                [
                    "python3",
                    str(ROLLOUT_SCRIPT),
                    "check",
                    "--config",
                    str(config_path),
                    "--events",
                    str(FIXTURES_PATH),
                    "--format",
                    "json",
                    "--min-policy-events",
                    "1",
                    "--min-runner-events",
                    "0",
                    "--min-delegated-events",
                    "1",
                    "--max-blocked-session-rate",
                    "1.0",
                ],
                capture_output=True,
                text=True,
                check=True,
            )
        payload = json.loads(result.stdout)
        self.assertEqual(payload["observation"]["current_phase"], "conservative")
        self.assertEqual(payload["observation"]["summary_phase"], "conservative")
        self.assertEqual(payload["observation"]["suggested_preset"], "guided")
        self.assertTrue(payload["promotion"]["ready"])

    def test_recommend_outputs_guided_summary_for_enforced_runtime(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-rollout-recommend-") as tmpdir:
            config_path = Path(tmpdir) / "octopus-config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "runtime_policy": {
                            "enabled": True,
                            "switches": {
                                "hard_runner_only": True,
                                "route_hint_required": True,
                                "replay_logging": True,
                                "direct_model_override": True,
                                "delegation_enforcement": True,
                            },
                            "hooks": {
                                "before_model_resolve": True,
                                "before_prompt_build": True,
                                "before_tool_call": True,
                                "agent_end": True,
                            },
                            "route_stickiness": {"enabled": True},
                        }
                    }
                ),
                encoding="utf-8",
            )
            result = subprocess.run(
                [
                    "python3",
                    str(ROLLOUT_SCRIPT),
                    "recommend",
                    "--config",
                    str(config_path),
                    "--events",
                    str(FIXTURES_PATH),
                    "--format",
                    "json",
                    "--min-policy-events",
                    "1",
                    "--min-runner-events",
                    "0",
                    "--min-delegated-events",
                    "1",
                    "--max-blocked-session-rate",
                    "1.0",
                ],
                capture_output=True,
                text=True,
                check=True,
            )
        payload = json.loads(result.stdout)
        self.assertEqual(payload["current_phase"], "enforced")
        self.assertEqual(payload["summary_phase"], "guided")
        self.assertEqual(payload["suggested_preset"], "enforced")
        self.assertFalse(payload["ready"])


if __name__ == "__main__":
    unittest.main()
