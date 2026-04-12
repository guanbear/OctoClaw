#!/usr/bin/env python3
import itertools
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from lib.slack_e2e_acceptance import (
    build_exec_env,
    build_harness_prompt,
    choose_slack_session,
    detect_delivery_mode,
    evaluate_messages,
    evaluate_content_assertions,
    fetch_observed_messages,
    get_scenarios_for_preset,
    inspect_replay_source,
    load_slack_config,
    resolve_channel_id_for_target,
    run_scenario,
)


class SlackE2EAcceptanceTests(unittest.TestCase):
    def test_build_harness_prompt_wraps_user_question(self) -> None:
        prompt = build_harness_prompt("fresh_live_lookup", "查下 openclaw 最近 release")
        self.assertIn("codex-slack-e2e", prompt)
        self.assertIn("fresh_live_lookup", prompt)
        self.assertIn("查下 openclaw 最近 release", prompt)

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

    @patch("lib.slack_e2e_acceptance.load_json")
    def test_build_exec_env_reads_default_config_path(self, mock_load_json) -> None:
        mock_load_json.return_value = {"gateway": {"bind": "127.0.0.1", "port": 18789, "auth": {"mode": "token", "token": "tok"}}}
        env = build_exec_env()
        self.assertEqual(env.get("OPENCLAW_GATEWAY_URL"), "ws://127.0.0.1:18789")
        self.assertEqual(env.get("OPENCLAW_GATEWAY_TOKEN"), "tok")

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

    def test_choose_slack_session_can_match_explicit_target(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-sessions-target-") as tmpdir:
            path = Path(tmpdir) / "sessions.json"
            path.write_text(
                json.dumps(
                    {
                        "agent:main:acceptance": {
                            "updatedAt": 10,
                            "chatType": "channel",
                            "origin": {
                                "provider": "slack",
                                "to": "channel:C_ACCEPT",
                                "nativeChannelId": "C_ACCEPT",
                            },
                            "deliveryContext": {"channel": "slack", "to": "channel:C_ACCEPT"},
                        },
                        "agent:main:main": {
                            "updatedAt": 30,
                            "chatType": "direct",
                            "origin": {
                                "provider": "slack",
                                "to": "user:U123",
                                "nativeChannelId": "D123",
                            },
                            "deliveryContext": {"channel": "slack", "to": "user:U123"},
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            chosen = choose_slack_session(str(path), target="channel:C_ACCEPT")
            self.assertEqual(chosen["session_key"], "agent:main:acceptance")
            self.assertEqual(chosen["native_channel_id"], "C_ACCEPT")

    def test_choose_slack_session_allows_explicit_native_channel_for_legacy_session(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-sessions-legacy-") as tmpdir:
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
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            chosen = choose_slack_session(
                str(path),
                session_key="agent:main:slack:channel:acceptance",
                native_channel_id="C0AS4DAPPU3",
            )
            self.assertEqual(chosen["session_key"], "agent:main:slack:channel:acceptance")
            self.assertEqual(chosen["native_channel_id"], "C0AS4DAPPU3")

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

    def test_detect_delivery_mode_flags_embedded_fallback(self) -> None:
        self.assertEqual(
            detect_delivery_mode(
                {
                    "mode": "cli",
                    "returncode": 0,
                    "stderr": "Gateway agent failed; falling back to embedded: Error: gateway closed (1008): pairing required",
                }
            ),
            "gateway_pairing_required",
        )

    def test_detect_delivery_mode_flags_gateway_rpc(self) -> None:
        self.assertEqual(detect_delivery_mode({"mode": "gateway_rpc"}), "gateway_rpc")

    @patch("lib.slack_e2e_acceptance.fetch_slack_messages")
    def test_fetch_observed_messages_combines_root_and_thread(self, mock_fetch) -> None:
        mock_fetch.side_effect = [
            [
                {"ts": "100.500", "text": "root ack"},
                {"ts": "101.000", "text": "root final"},
            ],
            [
                {"ts": "100.700", "text": "thread ack"},
            ],
        ]
        observed = fetch_observed_messages(
            "xoxb-test",
            channel_id="D123",
            oldest_root="100.000",
            thread_id="1712345.000100",
            oldest_thread="1712345.000100",
            limit=10,
        )
        self.assertEqual(
            [(item["ts"], item["_delivery_scope"]) for item in observed],
            [("100.500", "root"), ("100.700", "thread"), ("101.000", "root")],
        )

    @patch("lib.slack_e2e_acceptance.fetch_observed_messages")
    @patch("lib.slack_e2e_acceptance.fetch_slack_messages")
    @patch("lib.slack_e2e_acceptance.launch_agent_turn")
    @patch("lib.slack_e2e_acceptance.resolve_channel_id_for_target")
    def test_run_scenario_reports_ok_with_messages(
        self,
        mock_channel,
        mock_launch,
        mock_baseline_fetch,
        mock_fetch,
    ) -> None:
        mock_channel.return_value = "D123"
        proc = MagicMock()
        proc.communicate.return_value = ('{"payloads":[{"text":"done"}]}', "")
        proc.returncode = 0
        mock_launch.return_value = {"ok": True, "process": proc, "command": ["openclaw", "agent"]}
        steady = [{"ts": "100.500", "text": "好，我去看一下。"}, {"ts": "102.000", "text": "最新 release 仍是 v2026.4.9。"}]
        mock_baseline_fetch.side_effect = [[], []]
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
        self.assertTrue(result["evaluation"]["ack_verifiable"])
        self.assertEqual(result["messages"][0]["text"], "好，我去看一下。")
        self.assertEqual(result["messages"][0]["delivery_scope"], "")
        self.assertEqual(result["send_result"]["returncode"], 0)
        self.assertIn("codex-slack-e2e", mock_launch.call_args[0][1])
        self.assertTrue(result["evaluation"]["content_assertions"]["passed"])

    @patch("lib.slack_e2e_acceptance.fetch_observed_messages")
    @patch("lib.slack_e2e_acceptance.fetch_slack_messages")
    @patch("lib.slack_e2e_acceptance.launch_agent_turn")
    @patch("lib.slack_e2e_acceptance.resolve_channel_id_for_target")
    def test_run_scenario_allows_embedded_fallback_without_strict_ack(
        self,
        mock_channel,
        mock_launch,
        mock_baseline_fetch,
        mock_fetch,
    ) -> None:
        mock_channel.return_value = "D123"
        proc = MagicMock()
        proc.communicate.return_value = (
            "",
            "Gateway agent failed; falling back to embedded: Error: gateway closed (1008): pairing required",
        )
        proc.returncode = 0
        mock_launch.return_value = {"ok": True, "process": proc, "command": ["/opt/homebrew/bin/openclaw", "agent"]}
        mock_baseline_fetch.side_effect = [[], []]
        mock_fetch.side_effect = itertools.repeat(
            [{"ts": "130.000", "text": "最终结果", "_delivery_scope": "root"}]
        )
        with patch(
            "lib.slack_e2e_acceptance.time.time",
            side_effect=itertools.chain([100.0, 100.1, 100.2, 104.5, 104.6], itertools.repeat(120.0)),
        ), patch("lib.slack_e2e_acceptance.time.sleep", return_value=None):
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
                    "final_timeout_s": 60,
                },
                slack_token="xoxb-test",
                poll_interval_s=0.2,
                quiet_window_s=1.0,
            )
        self.assertTrue(result["ok"])
        self.assertFalse(result["evaluation"]["ack_verifiable"])
        self.assertEqual(result["delivery_mode"], "gateway_pairing_required")

    def test_get_scenarios_for_preset_core6_contains_required_cases(self) -> None:
        names = [item["name"] for item in get_scenarios_for_preset("core6")]
        self.assertEqual(
            names,
            [
                "plain_chat",
                "fresh_live_lookup",
                "provenance_followup",
                "local_surface_lookup",
                "execution_followup",
                "delegated_work",
            ],
        )

    def test_get_scenarios_for_preset_acceptance_includes_compound(self) -> None:
        names = [item["name"] for item in get_scenarios_for_preset("acceptance")]
        self.assertIn("compound_request", names)

    def test_evaluate_content_assertions_rejects_internal_route_leak(self) -> None:
        result = evaluate_content_assertions(
            [{"text": "route 判定 spawn_single，但实际没有派下去"}],
            {
                "assertions": {
                    "must_not_include_any": ["route 判定", "spawn_single"],
                }
            },
        )
        self.assertFalse(result["passed"])
        self.assertTrue(result["checked"])

    def test_evaluate_content_assertions_accepts_control_ui_address(self) -> None:
        result = evaluate_content_assertions(
            [{"text": "控制地址是 http://127.0.0.1:18789/"}],
            {
                "assertions": {
                    "final_must_include_any": ["127.0.0.1", "localhost", "http://"],
                }
            },
        )
        self.assertTrue(result["passed"])

    def test_inspect_replay_source_summarizes_directory_bundle(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-replay-source-") as tmpdir:
            root = Path(tmpdir)
            (root / "merged").mkdir()
            (root / "sessions" / "vm").mkdir(parents=True)
            (root / "merged" / "sessions.json").write_text("{}", encoding="utf-8")
            (root / "merged" / "runtime-policy-replay.jsonl").write_text("", encoding="utf-8")
            (root / "merged" / "task-state.json").write_text("{}", encoding="utf-8")
            (root / "sessions" / "vm" / "session-test.json").write_text("{}", encoding="utf-8")
            summary = inspect_replay_source(f"vm={root}")
            self.assertTrue(summary["ok"])
            self.assertEqual(summary["label"], "vm")
            self.assertTrue(summary["sessions_index"].endswith("merged/sessions.json"))
            self.assertTrue(summary["session_dir"].endswith("sessions"))
            self.assertEqual(summary["session_file_count"], 1)


if __name__ == "__main__":
    unittest.main()
