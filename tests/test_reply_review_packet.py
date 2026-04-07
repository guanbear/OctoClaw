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
            case = packet["cases"][0]
            self.assertEqual(case["policy"]["protected_lane"], "control_observer")
            self.assertEqual(case["dispatch"]["protected_lane"], "control_observer")
            self.assertTrue(case["protected_lane_misroute"])

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


if __name__ == "__main__":
    unittest.main()
