#!/usr/bin/env python3
import itertools
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lib.slack_e2e_acceptance import (
    choose_slack_session,
    evaluate_messages,
    load_slack_config,
    resolve_channel_id_for_target,
    run_scenario,
)


class SlackE2EAcceptanceTests(unittest.TestCase):
    def test_load_slack_config_reads_bot_token(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-slack-config-") as tmpdir:
            path = Path(tmpdir) / "openclaw.json"
            path.write_text(
                json.dumps(
                    {
                        "channels": {
                            "slack": {
                                "enabled": True,
                                "botToken": "xoxb-test",
                                "appToken": "xapp-test",
                                "groupPolicy": "open",
                                "dmPolicy": "open",
                            }
                        }
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            cfg = load_slack_config(str(path))
            self.assertTrue(cfg["enabled"])
            self.assertEqual(cfg["bot_token"], "xoxb-test")
            self.assertEqual(cfg["group_policy"], "open")

    def test_choose_slack_session_prefers_threaded_direct_session(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-sessions-") as tmpdir:
            path = Path(tmpdir) / "sessions.json"
            path.write_text(
                json.dumps(
                    {
                        "agent:main:slack:channel:acceptance": {
                            "updatedAt": 10,
                            "chatType": "channel",
                            "origin": {
                                "provider": "slack",
                                "to": "channel:acceptance",
                            },
                            "deliveryContext": {"channel": "slack"},
                        },
                        "agent:main:main": {
                            "updatedAt": 20,
                            "chatType": "direct",
                            "origin": {
                                "provider": "slack",
                                "to": "user:U123",
                                "nativeChannelId": "D123",
                            },
                            "deliveryContext": {"channel": "slack", "to": "user:U123"},
                        },
                        "agent:main:main:thread:1712345.000100": {
                            "updatedAt": 30,
                            "chatType": "direct",
                            "origin": {
                                "provider": "slack",
                                "to": "user:U123",
                                "nativeChannelId": "D123",
                                "threadId": "1712345.000100",
                            },
                            "deliveryContext": {
                                "channel": "slack",
                                "to": "user:U123",
                                "threadId": "1712345.000100",
                            },
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            chosen = choose_slack_session(str(path))
            self.assertEqual(chosen["session_key"], "agent:main:main:thread:1712345.000100")
            self.assertEqual(chosen["native_channel_id"], "D123")
            self.assertEqual(chosen["thread_id"], "1712345.000100")

    @patch("lib.slack_e2e_acceptance.slack_api_call")
    def test_resolve_channel_id_for_target_opens_dm(self, mock_call) -> None:
        mock_call.return_value = {"ok": True, "channel": {"id": "D456"}}
        channel_id = resolve_channel_id_for_target("xoxb-test", "user:U456")
        self.assertEqual(channel_id, "D456")
        self.assertEqual(mock_call.call_args[0][1], "conversations.open")

    def test_evaluate_messages_computes_ack_and_final(self) -> None:
        summary = evaluate_messages(
            [
                {"ts": "100.700"},
                {"ts": "102.100"},
            ],
            started_at=100.0,
            ack_deadline_ms=1000,
            final_timeout_s=5,
        )
        self.assertTrue(summary["ack_seen"])
        self.assertEqual(summary["ack_latency_ms"], 700)
        self.assertTrue(summary["final_seen"])

    @patch("lib.slack_e2e_acceptance.fetch_slack_messages")
    @patch("lib.slack_e2e_acceptance.send_agent_message")
    @patch("lib.slack_e2e_acceptance.resolve_channel_id_for_target")
    def test_run_scenario_reports_ok_with_messages(
        self,
        mock_channel,
        mock_send,
        mock_fetch,
    ) -> None:
        mock_channel.return_value = "D123"
        mock_send.return_value = {"ok": True, "status": "accepted", "runId": "run-1"}
        steady = [{"ts": "100.500", "text": "好，我去看一下。"}, {"ts": "102.000", "text": "最新 release 仍是 v2026.4.9。"}]
        mock_fetch.side_effect = itertools.chain(
            [
                [],
                [{"ts": "100.500", "text": "好，我去看一下。"}],
                steady,
                steady,
            ],
            itertools.repeat(steady),
        )
        with patch(
            "lib.slack_e2e_acceptance.time.time",
            side_effect=itertools.chain(
                [100.0, 100.2, 100.3, 100.4, 100.8, 100.9, 101.0, 101.1, 102.6, 102.7, 104.2, 104.3],
                itertools.repeat(120.0),
            ),
        ), patch(
            "lib.slack_e2e_acceptance.time.sleep",
            return_value=None,
        ):
            result = run_scenario(
                {
                    "session_key": "agent:main:main",
                    "target": "user:U123",
                    "native_channel_id": "D123",
                    "thread_id": "",
                },
                {
                    "name": "fresh_live_lookup",
                    "prompt": "查下 openclaw 最近 release",
                    "ack_deadline_ms": 1500,
                    "final_timeout_s": 10,
                },
                slack_token="xoxb-test",
                poll_interval_s=0.2,
                quiet_window_s=1.0,
            )
        self.assertTrue(result["ok"])
        self.assertEqual(result["evaluation"]["message_count"], 2)
        self.assertEqual(result["messages"][0]["text"], "好，我去看一下。")


if __name__ == "__main__":
    unittest.main()
