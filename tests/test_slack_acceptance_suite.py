#!/usr/bin/env python3
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lib.slack_acceptance_suite import (
    build_env,
    derive_runtime_paths,
    render_summary,
    run_blackbox_suite,
    run_replay_bundle,
)


class SlackAcceptanceSuiteTests(unittest.TestCase):
    def test_build_env_sets_workspace_and_openclaw_home(self) -> None:
        env = build_env(workspace="/tmp/workspace", openclaw_home="/tmp/openclaw-home")
        self.assertEqual(env["WORKSPACE"], "/tmp/workspace")
        self.assertEqual(env["OPENCLAW_HOME"], "/tmp/openclaw-home")
        self.assertIn("/opt/homebrew/bin", env["PATH"])

    def test_derive_runtime_paths_uses_openclaw_home_defaults(self) -> None:
        derived = derive_runtime_paths(openclaw_home="/tmp/acceptance-home")
        self.assertEqual(derived["openclaw_config"], "/tmp/acceptance-home/openclaw.json")
        self.assertEqual(derived["sessions_path"], "/tmp/acceptance-home/agents/main/sessions/sessions.json")

    @patch("lib.slack_acceptance_suite.run_subprocess")
    def test_run_blackbox_suite_builds_explicit_target_command(self, mock_run) -> None:
        mock_run.return_value = {"ok": True, "returncode": 0, "stdout": "", "stderr": "", "command": []}
        with tempfile.TemporaryDirectory(prefix="octoclaw-blackbox-suite-") as tmpdir:
            root = Path(tmpdir)
            report_path = root / "blackbox-report.json"
            report_path.write_text(json.dumps({"ok": True, "results": []}), encoding="utf-8")
            result = run_blackbox_suite(
                repo_root=root,
                output_dir=root,
                env={},
                preset="core6",
                target="channel:C123",
                native_channel_id="C123",
            )
            self.assertTrue(result["result"]["ok"])
            cmd = mock_run.call_args.kwargs["env"] if False else mock_run.call_args.args[0]
            self.assertIn("--target", cmd)
            self.assertIn("channel:C123", cmd)
            self.assertEqual(result["report"]["ok"], True)

    @patch("lib.slack_acceptance_suite.run_subprocess")
    def test_run_replay_bundle_requires_session_dir(self, mock_run) -> None:
        mock_run.return_value = {"ok": True}
        with tempfile.TemporaryDirectory(prefix="octoclaw-replay-missing-session-dir-") as tmpdir:
            root = Path(tmpdir)
            (root / "merged").mkdir()
            (root / "merged" / "sessions.json").write_text("{}", encoding="utf-8")
            result = run_replay_bundle(
                repo_root=root,
                output_dir=root,
                env={},
                day="2026-04-12",
                timezone_name="Asia/Shanghai",
                replay_limit=4,
                source_spec=f"vm={root}",
            )
            self.assertFalse(result["ok"])
            self.assertIn("missing sessions_index or session_dir", result["error"])
            self.assertFalse(mock_run.called)

    @patch("lib.slack_acceptance_suite.run_subprocess")
    def test_run_replay_bundle_runs_packet_validation_and_failure_summary(self, mock_run) -> None:
        mock_run.side_effect = [
            {"ok": True, "returncode": 0, "stdout": "", "stderr": "", "command": []},
            {"ok": True, "returncode": 0, "stdout": "", "stderr": "", "command": []},
            {"ok": True, "returncode": 0, "stdout": "", "stderr": "", "command": []},
        ]
        with tempfile.TemporaryDirectory(prefix="octoclaw-replay-suite-") as tmpdir:
            root = Path(tmpdir)
            (root / "merged").mkdir()
            (root / "sessions" / "vm").mkdir(parents=True)
            (root / "merged" / "sessions.json").write_text("{}", encoding="utf-8")
            (root / "merged" / "runtime-policy-replay.jsonl").write_text("", encoding="utf-8")
            (root / "merged" / "task-state.json").write_text(json.dumps({"tasks": []}), encoding="utf-8")
            (root / "sessions" / "vm" / "session-test.json").write_text("{}", encoding="utf-8")
            result = run_replay_bundle(
                repo_root=root,
                output_dir=root,
                env={"WORKSPACE": "/tmp/workspace", "OPENCLAW_HOME": "/tmp/openclaw-home"},
                day="2026-04-12",
                timezone_name="Asia/Shanghai",
                replay_limit=4,
                source_spec=f"vm={root}",
            )
            self.assertTrue(result["ok"])
            self.assertEqual(mock_run.call_count, 3)

    def test_render_summary_mentions_blackbox_and_replay(self) -> None:
        text = render_summary(
            {
                "day": "2026-04-12",
                "timezone": "Asia/Shanghai",
                "output_dir": "/tmp/out",
                "ok": True,
                "blackbox_preset": "acceptance",
                "blackbox": {
                    "report_path": "/tmp/out/blackbox-report.json",
                    "result": {"ok": True},
                    "report": {"ok": True, "results": [{}, {}]},
                },
                "replay_runs": [
                    {
                        "label": "vm",
                        "ok": True,
                        "source": {"path": "/tmp/vm-bundle"},
                        "validation_summary": "/tmp/out/replay-vm/replay-validation-summary.json",
                        "failure_report": "/tmp/out/replay-vm/failure-summary.md",
                    }
                ],
            }
        )
        self.assertIn("## Black-box", text)
        self.assertIn("## Replay", text)
        self.assertIn("acceptance", text)


if __name__ == "__main__":
    unittest.main()
