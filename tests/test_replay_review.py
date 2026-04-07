#!/usr/bin/env python3
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
REPLAY_REVIEW_SCRIPT = REPO_ROOT / "lib" / "replay_review.py"
FIXTURES_PATH = REPO_ROOT / "tests" / "fixtures" / "runtime-policy-replay-events-v1.json"


class ReplayReviewTests(unittest.TestCase):
    def run_review(self, *extra_args: str, events_path: Path = FIXTURES_PATH) -> dict:
        result = subprocess.run(
            ["python3", str(REPLAY_REVIEW_SCRIPT), "--events", str(events_path), "--format", "json", *extra_args],
            capture_output=True,
            text=True,
            check=True,
        )
        return json.loads(result.stdout)

    def test_review_builds_session_records_and_tags(self) -> None:
        payload = self.run_review("--focus", "all")
        self.assertEqual(payload["schema_version"], "octoclaw.replay_review/v1")
        self.assertEqual(payload["source"]["format"], "json_array")
        self.assertEqual(payload["counts"]["sessions_total"], 3)
        self.assertEqual(payload["counts"]["by_route"], {"spawn_single": 1})
        first = payload["records"][0]
        self.assertIn("blocked", payload["counts"]["by_tag"])
        self.assertIn("delegated", first["tags"])
        self.assertEqual(first["route_language_packs"], [])
        self.assertTrue(first["normalized_prompt"])
        self.assertTrue(first["prompt_hash"])
        self.assertIn(first["candidate_severity"], {"low", "medium", "high"})

    def test_review_focus_filters_blocked_sessions(self) -> None:
        payload = self.run_review("--focus", "blocked")
        self.assertEqual(payload["counts"]["sessions_selected"], 2)
        self.assertTrue(all("blocked" in record["tags"] for record in payload["records"]))

    def test_review_tags_protected_lane_misroutes(self) -> None:
        events = [
            {
                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                "event": "policy_resolved",
                "at": "2026-04-08T10:00:00.000Z",
                "sessionKey": "meta-session",
                "sessionId": "meta-session",
                "route": "direct",
                "systemPreferredRoute": "direct",
                "workerPool": "octoclaw-main",
                "protectedLane": "control_observer",
                "prompt": "你现在是啥模型",
            },
            {
                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                "event": "dispatch_called",
                "at": "2026-04-08T10:00:01.000Z",
                "sessionKey": "meta-session",
                "sessionId": "meta-session",
                "route": "spawn_single",
                "systemPreferredRoute": "direct",
                "workerPool": "octoclaw-main",
                "protectedLane": "control_observer",
                "executed": True,
            },
        ]
        with tempfile.TemporaryDirectory(prefix="octoclaw-replay-review-") as tmpdir:
            events_path = Path(tmpdir) / "events.jsonl"
            events_path.write_text("\n".join(json.dumps(event, ensure_ascii=False) for event in events) + "\n", encoding="utf-8")
            payload = self.run_review("--focus", "all", events_path=events_path)
        self.assertEqual(payload["counts"]["by_tag"]["protected_lane"], 1)
        self.assertEqual(payload["counts"]["by_tag"]["protected_lane_misroute"], 1)
        record = payload["records"][0]
        self.assertEqual(record["protected_lane"], "control_observer")
        self.assertIn("protected_lane", record["tags"])
        self.assertIn("protected_lane_misroute", record["tags"])


if __name__ == "__main__":
    unittest.main()
