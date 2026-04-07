#!/usr/bin/env python3
import unittest

from lib import nightly_failure_summary


class NightlyFailureSummaryTests(unittest.TestCase):
    def test_summarize_failures_filters_by_local_day_and_renders_markdown(self) -> None:
        rows = [
            {
                "id": "code-1",
                "status": "failed",
                "route": "spawn_single",
                "worker_pool": "octoclaw-code",
                "timeout_reason": "tool_error",
                "summary": "tool invocation failed",
                "completed_at": "2026-04-07T08:12:00Z",
            },
            {
                "id": "research-1",
                "status": "done",
                "route": "spawn_single",
                "worker_pool": "octoclaw-research",
                "completed_at": "2026-04-07T09:00:00Z",
            },
            {
                "id": "code-older",
                "status": "failed",
                "route": "spawn_single",
                "worker_pool": "octoclaw-code",
                "completed_at": "2026-04-06T08:12:00Z",
            },
        ]

        summary = nightly_failure_summary.summarize_failures(
            rows,
            day="2026-04-07",
            timezone_name="Asia/Shanghai",
        )

        self.assertEqual(summary["failure_count"], 1)
        self.assertEqual(summary["by_route"]["spawn_single"], 1)
        self.assertEqual(summary["by_worker_pool"]["octoclaw-code"], 1)
        self.assertEqual(summary["by_reason"]["tool_error"], 1)

        markdown = nightly_failure_summary.render_markdown(summary)
        self.assertIn("Nightly Failure Summary (2026-04-07)", markdown)
        self.assertIn("`code-1`", markdown)
        self.assertIn("tool invocation failed", markdown)


if __name__ == "__main__":
    unittest.main()
