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
            session_dir.mkdir()
            session_file = session_dir / "abc.jsonl"
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
                "agent:main:slack:direct:u0al9t5u89z": {
                    "sessionFile": str(session_file),
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
                        "sessionKey": "agent:main:slack:direct:u0al9t5u89z",
                        "sessionId": "abc",
                        "prompt": "帮我查下 openclaw 最近更新",
                        "route": "spawn_single",
                        "workerPool": "octoclaw-research",
                    },
                    {
                        "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                        "event": "dispatch_called",
                        "at": "2026-04-02T08:00:02Z",
                        "sessionKey": "agent:main:slack:direct:u0al9t5u89z",
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


if __name__ == "__main__":
    unittest.main()
