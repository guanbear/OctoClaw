import json
import tempfile
import unittest
from pathlib import Path

from lib import reply_review_packet


class ReplyReviewPacketTests(unittest.TestCase):
    def write_jsonl(self, path: Path, rows: list[dict]) -> None:
        path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n", encoding="utf-8")

    def test_build_packet_extracts_slack_turns_and_replay(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            session_dir = tmp / "sessions"
            session_file = session_dir / "local" / "abc.jsonl"
            session_file.parent.mkdir(parents=True)
            self.write_jsonl(
                session_file,
                [
                    {
                        "type": "message",
                        "timestamp": "2026-04-02T08:00:00Z",
                        "message": {
                            "role": "user",
                            "content": [{"type": "text", "text": "Sender (untrusted metadata):\n```json\n{}\n```\n\n[Thu 2026-04-02 16:00 GMT+8] 帮我查下 openclaw 最近更新"}],
                        },
                    },
                    {
                        "type": "message",
                        "timestamp": "2026-04-02T08:00:05Z",
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "text", "text": "[[reply_to_current]] 已开始调研，我稍后给你总结。"}],
                        },
                    },
                ],
            )
            sessions_index = {
                "local::agent:main:slack:direct:u0al9t5u89z": {
                    "sessionFile": "local/abc.jsonl",
                    "origin": {"provider": "slack", "surface": "slack"},
                }
            }
            sessions_path = tmp / "sessions.json"
            sessions_path.write_text(json.dumps(sessions_index, ensure_ascii=False), encoding="utf-8")
            replay_path = tmp / "runtime-policy-replay.jsonl"
            self.write_jsonl(
                replay_path,
                [
                    {
                        "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                        "event": "policy_resolved",
                        "at": "2026-04-02T08:00:01Z",
                        "sessionKey": "local::agent:main:slack:direct:u0al9t5u89z",
                        "sessionId": "abc",
                        "prompt": "帮我查下 openclaw 最近更新",
                        "route": "spawn_single",
                        "workerPool": "octoclaw-research",
                    },
                    {
                        "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                        "event": "dispatch_called",
                        "at": "2026-04-02T08:00:02Z",
                        "sessionKey": "local::agent:main:slack:direct:u0al9t5u89z",
                        "sessionId": "abc",
                        "route": "spawn_single",
                        "workerPool": "octoclaw-research",
                    },
                ],
            )
            args = type(
                "Args",
                (),
                {
                    "sessions_index": str(sessions_path),
                    "session_dir": str(session_dir),
                    "replay_log": str(replay_path),
                    "task_state": "",
                    "day": "2026-04-02",
                    "timezone": "Asia/Shanghai",
                    "limit": 10,
                    "output": "",
                },
            )()
            packet = reply_review_packet.build_packet(args)
            self.assertEqual(packet["case_count"], 1)
            self.assertEqual(packet["selection_metrics"]["direct_case_count"], 0)
            case = packet["cases"][0]
            self.assertEqual(case["user_prompt"], "帮我查下 openclaw 最近更新")
            self.assertEqual(case["assistant_reply"], "已开始调研，我稍后给你总结。")
            self.assertEqual(case["policy"]["route"], "spawn_single")
            self.assertTrue(case["dispatch"]["called"])
            self.assertEqual(case["policy"]["protected_lane"], "")
            self.assertFalse(case["protected_lane_misroute"])

    def test_build_packet_marks_protected_lane_misroute_when_dispatch_happens(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            session_dir = tmp / "sessions"
            session_file = session_dir / "local" / "meta.jsonl"
            session_file.parent.mkdir(parents=True)
            self.write_jsonl(
                session_file,
                [
                    {
                        "type": "message",
                        "timestamp": "2026-04-02T09:00:00Z",
                        "message": {
                            "role": "user",
                            "content": [{"type": "text", "text": "你现在是啥模型"}],
                        },
                    },
                    {
                        "type": "message",
                        "timestamp": "2026-04-02T09:00:05Z",
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "text", "text": "现在是 zai/glm-4.7。"}],
                        },
                    },
                ],
            )
            sessions_index = {
                "local::agent:main:slack:direct:meta": {
                    "sessionFile": "local/meta.jsonl",
                    "origin": {"provider": "slack", "surface": "slack"},
                }
            }
            sessions_path = tmp / "sessions.json"
            sessions_path.write_text(json.dumps(sessions_index, ensure_ascii=False), encoding="utf-8")
            replay_path = tmp / "runtime-policy-replay.jsonl"
            self.write_jsonl(
                replay_path,
                [
                    {
                        "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                        "event": "policy_resolved",
                        "at": "2026-04-02T09:00:01Z",
                        "sessionKey": "local::agent:main:slack:direct:meta",
                        "sessionId": "meta",
                        "prompt": "你现在是啥模型",
                        "route": "direct",
                        "workerPool": "octoclaw-main",
                        "protectedLane": "control_observer",
                    },
                    {
                        "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                        "event": "dispatch_called",
                        "at": "2026-04-02T09:00:02Z",
                        "sessionKey": "local::agent:main:slack:direct:meta",
                        "sessionId": "meta",
                        "route": "spawn_single",
                        "workerPool": "octoclaw-main",
                        "protectedLane": "control_observer",
                    },
                ],
            )
            args = type(
                "Args",
                (),
                {
                    "sessions_index": str(sessions_path),
                    "session_dir": str(session_dir),
                    "replay_log": str(replay_path),
                    "task_state": "",
                    "day": "2026-04-02",
                    "timezone": "Asia/Shanghai",
                    "limit": 10,
                    "output": "",
                },
            )()
            packet = reply_review_packet.build_packet(args)
            self.assertEqual(packet["case_count"], 1)
            self.assertEqual(packet["selection_metrics"]["protected_lane_case_count"], 1)
            self.assertEqual(packet["selection_metrics"]["protected_lane_misroute_count"], 1)
            case = packet["cases"][0]
            self.assertEqual(case["policy"]["protected_lane"], "control_observer")
            self.assertEqual(case["dispatch"]["protected_lane"], "control_observer")
            self.assertTrue(case["protected_lane_misroute"])

    def test_build_packet_marks_runner_lane_mismatch_when_policy_is_runner_but_no_dispatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            session_dir = tmp / "sessions"
            session_file = session_dir / "local" / "runner.jsonl"
            session_file.parent.mkdir(parents=True)
            self.write_jsonl(
                session_file,
                [
                    {
                        "type": "message",
                        "timestamp": "2026-04-09T06:54:00Z",
                        "message": {
                            "role": "user",
                            "content": [{"type": "text", "text": "帮我查下openclaw 又有新版本了吗 有啥新特性"}],
                        },
                    },
                    {
                        "type": "message",
                        "timestamp": "2026-04-09T06:54:10Z",
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "text", "text": "有新版，我直接查了 GitHub API。"}],
                        },
                    },
                ],
            )
            sessions_index = {
                "local::agent:main:slack:direct:runner": {
                    "sessionFile": "local/runner.jsonl",
                    "origin": {"provider": "slack", "surface": "slack"},
                }
            }
            sessions_path = tmp / "sessions.json"
            sessions_path.write_text(json.dumps(sessions_index, ensure_ascii=False), encoding="utf-8")
            replay_path = tmp / "runtime-policy-replay.jsonl"
            self.write_jsonl(
                replay_path,
                [
                    {
                        "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                        "event": "policy_resolved",
                        "at": "2026-04-09T06:54:01Z",
                        "sessionKey": "local::agent:main:slack:direct:runner",
                        "sessionId": "runner",
                        "prompt": "帮我查下openclaw 又有新版本了吗 有啥新特性",
                        "route": "runner",
                        "systemPreferredRoute": "runner",
                        "workerPool": "octoclaw-runner",
                    },
                ],
            )
            args = type(
                "Args",
                (),
                {
                    "sessions_index": str(sessions_path),
                    "session_dir": str(session_dir),
                    "replay_log": str(replay_path),
                    "task_state": "",
                    "day": "2026-04-09",
                    "timezone": "Asia/Shanghai",
                    "limit": 10,
                    "output": "",
                },
            )()
            packet = reply_review_packet.build_packet(args)
            self.assertEqual(packet["selection_metrics"]["runner_case_count"], 1)
            self.assertEqual(packet["selection_metrics"]["runner_lane_mismatch_count"], 1)
            case = packet["cases"][0]
            self.assertEqual(case["policy"]["route"], "runner")
            self.assertFalse(case["dispatch"]["called"])
            self.assertTrue(case["runner_lane_mismatch"])

    def test_build_packet_skips_internal_delegated_prompts(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            session_dir = tmp / "sessions"
            session_file = session_dir / "abc.jsonl"
            session_dir.mkdir()
            self.write_jsonl(
                session_file,
                [
                    {
                        "type": "message",
                        "timestamp": "2026-04-02T10:00:00Z",
                        "message": {
                            "role": "user",
                            "content": [{"type": "text", "text": "route=spawn_single ; system_preferred_route=spawn_single ; worker_pool=octoclaw-code\nDelegated run: do not solve directly"}],
                        },
                    },
                    {
                        "type": "message",
                        "timestamp": "2026-04-02T10:00:05Z",
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "text", "text": "internal handoff"}],
                        },
                    },
                ],
            )
            sessions_index = {
                "agent:main:slack:direct:u0al9t5u89z": {
                    "sessionFile": str(session_file),
                    "origin": {"provider": "slack", "surface": "slack"},
                }
            }
            sessions_path = tmp / "sessions.json"
            sessions_path.write_text(json.dumps(sessions_index, ensure_ascii=False), encoding="utf-8")
            args = type(
                "Args",
                (),
                {
                    "sessions_index": str(sessions_path),
                    "session_dir": str(session_dir),
                    "replay_log": "",
                    "task_state": "",
                    "day": "2026-04-02",
                    "timezone": "Asia/Shanghai",
                    "limit": 10,
                    "output": "",
                },
            )()
            packet = reply_review_packet.build_packet(args)
            self.assertEqual(packet["case_count"], 0)

    def test_build_packet_prioritizes_short_protected_lane_cases_for_nightly(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            session_dir = tmp / "sessions"
            session_file = session_dir / "local" / "mix.jsonl"
            session_file.parent.mkdir(parents=True)
            self.write_jsonl(
                session_file,
                [
                    {
                        "type": "message",
                        "timestamp": "2026-04-08T00:00:00Z",
                        "message": {
                            "role": "user",
                            "content": [{"type": "text", "text": "你是啥模型"}],
                        },
                    },
                    {
                        "type": "message",
                        "timestamp": "2026-04-08T00:00:30Z",
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "text", "text": "我先派个子任务看一下。"}],
                        },
                    },
                    {
                        "type": "message",
                        "timestamp": "2026-04-08T00:02:00Z",
                        "message": {
                            "role": "user",
                            "content": [{"type": "text", "text": "帮我调研 OpenClaw 2026.4.5 的 breaking changes，然后写个三点总结"}],
                        },
                    },
                    {
                        "type": "message",
                        "timestamp": "2026-04-08T00:02:06Z",
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "text", "text": "我先查一下，稍后给你总结。"}],
                        },
                    },
                ],
            )
            sessions_index = {
                "local::agent:main:slack:direct:mix": {
                    "sessionFile": "local/mix.jsonl",
                    "origin": {"provider": "slack", "surface": "slack"},
                }
            }
            sessions_path = tmp / "sessions.json"
            sessions_path.write_text(json.dumps(sessions_index, ensure_ascii=False), encoding="utf-8")
            args = type(
                "Args",
                (),
                {
                    "sessions_index": str(sessions_path),
                    "session_dir": str(session_dir),
                    "replay_log": "",
                    "task_state": "",
                    "day": "2026-04-08",
                    "timezone": "Asia/Shanghai",
                    "limit": 1,
                    "output": "",
                },
            )()
            packet = reply_review_packet.build_packet(args)
            self.assertEqual(packet["case_count"], 1)
            case = packet["cases"][0]
            self.assertEqual(case["user_prompt"], "你是啥模型")
            self.assertEqual(case["analysis"]["current_expected"]["protected_lane"], "control_observer")
            self.assertIn("direct_policy_missing", case["analysis"]["selection_tags"])
            self.assertIn("delegation_explanation_risk", case["analysis"]["selection_tags"])
            self.assertEqual(packet["selection_metrics"]["direct_case_count"], 1)
            self.assertEqual(packet["selection_metrics"]["protected_lane_case_count"], 1)
            self.assertEqual(packet["selection_metrics"]["direct_policy_missing_count"], 1)


if __name__ == "__main__":
    unittest.main()
