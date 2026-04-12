#!/usr/bin/env python3
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lib.slack_acceptance_suite import (
    build_env,
    derive_runtime_paths,
    inspect_boundary_audit,
    load_replay_events,
    render_summary,
    resolve_runtime_replay_log,
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

    def test_resolve_runtime_replay_log_uses_workspace(self) -> None:
        self.assertTrue(
            resolve_runtime_replay_log(workspace="/tmp/workspace").endswith(
                "/tmp/workspace/tmp/octopus/runtime-policy-replay.jsonl"
            )
        )

    def test_load_replay_events_reads_jsonl(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-replay-events-") as tmpdir:
            path = Path(tmpdir) / "runtime-policy-replay.jsonl"
            path.write_text(
                "\n".join(
                    [
                        json.dumps({"event": "policy_resolved", "prompt": "hello"}, ensure_ascii=False),
                        "{bad json}",
                        json.dumps({"event": "agent_end"}, ensure_ascii=False),
                    ]
                ) + "\n",
                encoding="utf-8",
            )
            events = load_replay_events(str(path))
            self.assertEqual(len(events), 2)
            self.assertEqual(events[0]["event"], "policy_resolved")

    def test_inspect_boundary_audit_rejects_contaminated_subagent_match(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-boundary-audit-") as tmpdir:
            replay = Path(tmpdir) / "runtime-policy-replay.jsonl"
            replay.write_text(
                json.dumps(
                    {
                        "event": "policy_resolved",
                        "prompt": "[codex-slack-e2e scenario=plain_chat] 自动化",
                        "sessionBoundaryStatus": "contaminated_subagent_identity",
                        "sessionKey": "octoclaw-subagent-code-1",
                        "canonicalSessionKey": "agent:main:main",
                    },
                    ensure_ascii=False,
                ) + "\n",
                encoding="utf-8",
            )
            audit = inspect_boundary_audit(
                blackbox_report={"results": [{"name": "plain_chat"}]},
                replay_log_path=str(replay),
            )
            self.assertFalse(audit["ok"])
            self.assertTrue(audit["coverage_ok"])
            self.assertEqual(audit["observed_count"], 1)
            self.assertEqual(audit["results"][0]["name"], "plain_chat")
            self.assertIn("contaminated_subagent_identity", audit["results"][0]["failures"])
            self.assertIn("session_key_is_subagent", audit["results"][0]["failures"])

    def test_inspect_boundary_audit_accepts_clean_canonical_session(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-boundary-audit-clean-") as tmpdir:
            replay = Path(tmpdir) / "runtime-policy-replay.jsonl"
            replay.write_text(
                json.dumps(
                    {
                        "event": "policy_resolved",
                        "prompt": "[codex-slack-e2e scenario=plain_chat] 自动化",
                        "sessionBoundaryStatus": "clean",
                        "sessionKey": "agent:main:main",
                        "canonicalSessionKey": "agent:main:main",
                    },
                    ensure_ascii=False,
                ) + "\n",
                encoding="utf-8",
            )
            audit = inspect_boundary_audit(
                blackbox_report={"results": [{"name": "plain_chat"}]},
                replay_log_path=str(replay),
            )
            self.assertTrue(audit["ok"])
            self.assertTrue(audit["coverage_ok"])
            self.assertTrue(audit["results"][0]["ok"])
            self.assertTrue(audit["results"][0]["observed"])

    def test_inspect_boundary_audit_reports_missing_policy_as_coverage_gap(self) -> None:
        audit = inspect_boundary_audit(
            blackbox_report={"results": [{"name": "plain_chat"}]},
            replay_log_path="/tmp/does-not-exist",
        )
        self.assertTrue(audit["ok"])
        self.assertFalse(audit["coverage_ok"])
        self.assertEqual(audit["observed_count"], 0)
        self.assertEqual(audit["total_count"], 1)
        self.assertFalse(audit["results"][0]["observed"])
        self.assertEqual(audit["results"][0]["failures"], ["policy_not_observed"])

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
                    "boundary_audit": {
                        "ok": True,
                        "coverage_ok": False,
                        "observed_count": 1,
                        "total_count": 2,
                        "replay_log_path": "/tmp/workspace/tmp/octopus/runtime-policy-replay.jsonl",
                        "results": [{"name": "plain_chat", "ok": True, "observed": True, "session_boundary_status": "clean", "failures": []}],
                    },
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
        self.assertIn("## Session Boundary Audit", text)
        self.assertIn("Coverage OK", text)
        self.assertIn("## Replay", text)
        self.assertIn("acceptance", text)


if __name__ == "__main__":
    unittest.main()
