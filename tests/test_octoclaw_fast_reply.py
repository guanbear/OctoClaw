#!/usr/bin/env python3
import json
import os
import subprocess
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
FAST_REPLY_PATH = REPO_ROOT / "extensions" / "octoclaw-fast-reply" / "src" / "index.ts"


def run_fast_reply_expression(expression: str) -> dict:
    script = f"""
import * as mod from {json.dumps(str(FAST_REPLY_PATH))};
const value = await ({expression});
console.log(JSON.stringify(value));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        env={**os.environ},
        check=True,
    )
    return json.loads(result.stdout)


class OctoClawFastReplyTests(unittest.TestCase):
    def test_build_fast_reply_ack_captures_ack_metrics(self) -> None:
        payload = run_fast_reply_expression(
            """(() => mod.buildFastReplyAck('pre_dispatch', {
                required: true,
                text: 'Working on it',
                channel_timeout_ms: 5000,
                fallback_to_progress_update: true,
            }, {
                routeDecisionStartedAt: 1000,
                ackSentAt: 1350,
                replyCompletedAt: 2400,
            }))()"""
        )

        self.assertEqual(payload["mode"], "pre_dispatch")
        self.assertTrue(payload["required"])
        self.assertEqual(payload["text"], "Working on it")
        self.assertEqual(payload["metrics"]["ack_ms"], 350)
        self.assertEqual(payload["metrics"]["total_latency_ms"], 1400)

    def test_compute_fast_reply_metrics_handles_missing_ack(self) -> None:
        payload = run_fast_reply_expression(
            """(() => mod.computeFastReplyMetrics({
                routeDecisionStartedAt: 2000,
                replyCompletedAt: 2750,
            }))()"""
        )

        self.assertNotIn("ack_ms", payload)
        self.assertEqual(payload["total_latency_ms"], 750)

    def test_direct_reply_flow_builds_minimal_context_packet_and_reply_payload(self) -> None:
        payload = run_fast_reply_expression(
            """(() => {
                const context = mod.buildDirectReplyContext({
                  userText: '   summarize the current branch   ',
                  sessionSummary: 'ws5 direct path',
                  route: 'reply',
                  requestKind: 'chat_or_explain',
                  directToolsSeen: ['read', '', 'grep'],
                });
                const reply = mod.buildDirectReply(context, 'Here is the summary.', {
                  routeDecisionStartedAt: 100,
                  ackSentAt: 160,
                  replyCompletedAt: 420,
                });
                return { context, reply };
            })()"""
        )

        self.assertEqual(payload["context"]["userText"], "summarize the current branch")
        self.assertEqual(payload["context"]["sessionSummary"], "ws5 direct path")
        self.assertEqual(payload["context"]["route"], "reply")
        self.assertEqual(payload["context"]["directToolsSeen"], ["read", "grep"])
        self.assertEqual(payload["reply"]["replyText"], "Here is the summary.")
        self.assertEqual(payload["reply"]["handoff"]["kind"], "reply")
        self.assertEqual(payload["reply"]["handoff"]["reply_text"], "Here is the summary.")
        self.assertEqual(payload["reply"]["metrics"]["ack_ms"], 60)
        self.assertEqual(payload["reply"]["metrics"]["total_latency_ms"], 320)


if __name__ == "__main__":
    unittest.main()
