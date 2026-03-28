#!/usr/bin/env python3
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
REPLAY_CURATE_SCRIPT = REPO_ROOT / "lib" / "replay_curate.py"


class ReplayCurateTests(unittest.TestCase):
    def run_curate(self, events_path: Path, *extra_args: str) -> dict:
        result = subprocess.run(
            ["python3", str(REPLAY_CURATE_SCRIPT), "--events", str(events_path), "--format", "json", *extra_args],
            capture_output=True,
            text=True,
            check=True,
        )
        return json.loads(result.stdout)

    def test_curate_dedupes_by_prompt(self) -> None:
        events = [
            {
                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                "event": "agent_end",
                "at": "2026-03-28T10:00:00.000Z",
                "sessionKey": "s1",
                "sessionId": "s1",
                "route": "spawn_single",
                "systemPreferredRoute": "spawn_single",
                "prompt": "Research DeerFlow and summarize tradeoffs",
                "delegated": True,
            },
            {
                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                "event": "agent_end",
                "at": "2026-03-28T10:01:00.000Z",
                "sessionKey": "s2",
                "sessionId": "s2",
                "route": "spawn_single",
                "systemPreferredRoute": "spawn_single",
                "prompt": "Research DeerFlow and summarize tradeoffs",
                "delegated": True,
            },
        ]
        with tempfile.TemporaryDirectory(prefix="octoclaw-replay-curate-") as tmpdir:
            path = Path(tmpdir) / "events.json"
            path.write_text(json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8")
            payload = self.run_curate(path, "--dedupe-by", "prompt")

        self.assertEqual(payload["counts"]["records_selected"], 2)
        self.assertEqual(payload["counts"]["cases_selected"], 1)
        self.assertEqual(payload["cases"][0]["expected_route"], "spawn_single")

    def test_curate_can_include_review_metadata(self) -> None:
        events = [
            {
                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                "event": "agent_end",
                "at": "2026-03-28T10:00:00.000Z",
                "sessionKey": "s3",
                "sessionId": "s3",
                "route": "runner",
                "systemPreferredRoute": "runner",
                "routeHintRequired": False,
                "routeHintSubmitted": False,
                "stickyApplied": True,
                "prompt": "check whether port 8080 is open",
                "delegated": True,
            },
            {
                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                "event": "tool_blocked_before_route_hint",
                "at": "2026-03-28T10:00:01.000Z",
                "sessionKey": "s3",
                "sessionId": "s3",
                "route": "runner",
                "toolName": "exec",
                "requiredTool": "octoclaw_route_hint",
            },
        ]
        with tempfile.TemporaryDirectory(prefix="octoclaw-replay-curate-") as tmpdir:
            path = Path(tmpdir) / "events.jsonl"
            with open(path, "w", encoding="utf-8") as fh:
                for event in events:
                    fh.write(json.dumps(event, ensure_ascii=False) + "\n")
            payload = self.run_curate(path, "--include-events", "--focus", "blocked")

        self.assertEqual(payload["counts"]["cases_selected"], 1)
        self.assertIn("review", payload["cases"][0])
        self.assertTrue(payload["cases"][0]["review"]["sticky_applied"])
        self.assertEqual(payload["cases"][0]["review"]["blocked_events"], ["tool_blocked_before_route_hint"])


if __name__ == "__main__":
    unittest.main()
