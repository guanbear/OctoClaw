#!/usr/bin/env python3
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "lib" / "replay_automation.py"
FIXTURES = REPO_ROOT / "tests" / "fixtures" / "runtime-policy-replay-events-v1.json"


class ReplayAutomationTests(unittest.TestCase):
    def run_script(self, *args: str) -> str:
        result = subprocess.run(
            ["python3", str(SCRIPT), *args],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout

    def test_run_skips_when_disabled(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-replay-automation-") as tmpdir:
            config_path = Path(tmpdir) / "octopus-config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "replay_automation": {
                            "enabled": False,
                            "output_dir": str(Path(tmpdir) / "nightly"),
                        }
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            output = self.run_script("run", "--config", str(config_path), "--events", str(FIXTURES), "--format", "json")
            payload = json.loads(output)
            self.assertTrue(payload["skipped"])
            self.assertEqual(payload["reason"], "replay_automation.disabled")

    def test_run_writes_manifest_and_outputs(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-replay-automation-") as tmpdir:
            config_path = Path(tmpdir) / "octopus-config.json"
            out_dir = Path(tmpdir) / "nightly"
            config_path.write_text(
                json.dumps(
                    {
                        "runtime_policy": {
                            "switches": {
                                "route_hint_required": False,
                                "direct_model_override": False,
                                "delegation_enforcement": False,
                            },
                            "hooks": {
                                "before_model_resolve": False,
                                "before_tool_call": False,
                            },
                            "route_stickiness": {"enabled": False},
                        },
                        "replay_automation": {
                            "enabled": True,
                            "output_dir": str(out_dir),
                        },
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            output = self.run_script("run", "--config", str(config_path), "--events", str(FIXTURES), "--format", "json")
            payload = json.loads(output)
            self.assertFalse(payload["skipped"])
            self.assertEqual(payload["phase"], "conservative")
            manifest_path = Path(payload["manifest_path"])
            self.assertTrue(manifest_path.exists())
            self.assertTrue((manifest_path.parent / "summary.json").exists())
            self.assertTrue((manifest_path.parent / "review-blocked.json").exists())
            self.assertTrue((manifest_path.parent / "curated-blocked.json").exists())

    def test_run_with_llm_review_outputs_packet_prompt_and_report(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-replay-automation-") as tmpdir:
            config_path = Path(tmpdir) / "octopus-config.json"
            out_dir = Path(tmpdir) / "nightly"
            config_path.write_text(
                json.dumps(
                    {
                        "runtime_policy": {
                            "switches": {
                                "route_hint_required": False,
                                "direct_model_override": False,
                                "delegation_enforcement": False,
                            },
                            "hooks": {
                                "before_model_resolve": False,
                                "before_tool_call": False,
                            },
                            "route_stickiness": {"enabled": False},
                        },
                        "replay_automation": {
                            "enabled": True,
                            "llm_review_enabled": True,
                            "llm_review_max_cases": 3,
                            "output_dir": str(out_dir),
                        },
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            output = self.run_script("run", "--config", str(config_path), "--events", str(FIXTURES), "--format", "json")
            payload = json.loads(output)
            manifest_path = Path(payload["manifest_path"])
            self.assertTrue((manifest_path.parent / "llm-review-packet.json").exists())
            self.assertTrue((manifest_path.parent / "llm-review-prompt.md").exists())
            self.assertTrue((manifest_path.parent / "llm-review-report.md").exists())

            packet = json.loads((manifest_path.parent / "llm-review-packet.json").read_text(encoding="utf-8"))
            self.assertEqual(packet["schema_version"], "octoclaw.replay_automation.llm_review_packet/v1")
            self.assertLessEqual(len(packet["cases"]), 3)

    def test_render_cron_prints_run_command(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-replay-automation-") as tmpdir:
            config_path = Path(tmpdir) / "octopus-config.json"
            config_path.write_text("{}", encoding="utf-8")
            output = self.run_script("render-cron", "--config", str(config_path), "--events", str(FIXTURES))
            self.assertIn("python3", output)
            self.assertIn("run --config", output)


if __name__ == "__main__":
    unittest.main()
