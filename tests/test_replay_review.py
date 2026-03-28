#!/usr/bin/env python3
import json
import subprocess
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
REPLAY_REVIEW_SCRIPT = REPO_ROOT / "lib" / "replay_review.py"
FIXTURES_PATH = REPO_ROOT / "tests" / "fixtures" / "runtime-policy-replay-events-v1.json"


class ReplayReviewTests(unittest.TestCase):
    def run_review(self, *extra_args: str) -> dict:
        result = subprocess.run(
            ["python3", str(REPLAY_REVIEW_SCRIPT), "--events", str(FIXTURES_PATH), "--format", "json", *extra_args],
            capture_output=True,
            text=True,
            check=True,
        )
        return json.loads(result.stdout)

    def test_review_builds_session_records_and_tags(self) -> None:
        payload = self.run_review("--focus", "all")
        self.assertEqual(payload["source"]["format"], "json_array")
        self.assertEqual(payload["counts"]["sessions_total"], 3)
        self.assertEqual(payload["counts"]["by_route"], {"spawn_single": 1})
        first = payload["records"][0]
        self.assertIn("blocked", payload["counts"]["by_tag"])
        self.assertIn("delegated", first["tags"])
        self.assertEqual(first["route_language_packs"], [])

    def test_review_focus_filters_blocked_sessions(self) -> None:
        payload = self.run_review("--focus", "blocked")
        self.assertEqual(payload["counts"]["sessions_selected"], 2)
        self.assertTrue(all("blocked" in record["tags"] for record in payload["records"]))


if __name__ == "__main__":
    unittest.main()
