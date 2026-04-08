import unittest
from pathlib import Path
import json
import tempfile

from lib.replay_validation import Turn, ensure_text, is_safe_replay_prompt, score_turn, select_packet_turns, select_turns, turns_from_packet


class ReplayValidationTests(unittest.TestCase):
    def test_score_turn_prefers_substantive_prompts(self):
        rich = Turn(
            session_key="agent:main:main",
            session_file="/tmp/a.jsonl",
            user_timestamp="2026-04-02T10:00:00+08:00",
            user_prompt="帮我调研 OpenClaw 3.31 的 task flow，并先给我一个三点总结。",
            assistant_reply="处理中",
        )
        trivial = Turn(
            session_key="agent:main:main",
            session_file="/tmp/b.jsonl",
            user_timestamp="2026-04-02T10:01:00+08:00",
            user_prompt="ping",
            assistant_reply="pong",
        )
        self.assertGreater(score_turn(rich), score_turn(trivial))

    def test_select_turns_dedupes_by_prompt(self):
        turns = [
            Turn("k1", "/tmp/a", "2026-04-02T10:00:00+08:00", "帮我调研 OpenClaw 3.31 的 task flow", "A"),
            Turn("k2", "/tmp/b", "2026-04-02T10:01:00+08:00", "帮我调研 OpenClaw 3.31 的 task flow", "B"),
            Turn("k3", "/tmp/c", "2026-04-02T10:02:00+08:00", "请帮我总结 breaking changes", "C"),
        ]
        selected = select_turns(turns, 5)
        prompts = [turn.user_prompt for turn in selected]
        self.assertEqual(prompts.count("帮我调研 OpenClaw 3.31 的 task flow"), 1)

    def test_safe_replay_prompt_filters_destructive_install(self):
        self.assertFalse(is_safe_replay_prompt("给我的机器里安装 ffmpeg/ffprobe"))
        self.assertFalse(is_safe_replay_prompt("给当前 Slack 会话开 elevated"))
        self.assertTrue(is_safe_replay_prompt("帮我调研 OpenClaw 3.31 的 task flow，并先给我一个三点总结。"))

    def test_ensure_text_decodes_timeout_bytes(self):
        self.assertEqual(ensure_text(b"timeout bytes"), "timeout bytes")
        self.assertEqual(ensure_text("already text"), "already text")
        self.assertEqual(ensure_text(None), "")

    def test_packet_turn_selection_keeps_short_protected_cases(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            packet_path = Path(tmpdir) / "packet.json"
            packet_path.write_text(
                json.dumps(
                    {
                        "cases": [
                            {
                                "session_key": "s1",
                                "session_file": "/tmp/s1.jsonl",
                                "user_timestamp": "2026-04-08T09:00:00+08:00",
                                "user_prompt": "你是啥模型",
                                "assistant_reply": "当前是 zhipu/GLM-5.1。",
                            },
                            {
                                "session_key": "s2",
                                "session_file": "/tmp/s2.jsonl",
                                "user_timestamp": "2026-04-08T09:01:00+08:00",
                                "user_prompt": "帮我调研 OpenClaw 2026.4.5 的 task flow",
                                "assistant_reply": "处理中",
                            },
                        ]
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            turns = turns_from_packet(packet_path)
            selected = select_packet_turns(turns, 2)
            self.assertEqual([turn.user_prompt for turn in selected], ["你是啥模型", "帮我调研 OpenClaw 2026.4.5 的 task flow"])


if __name__ == "__main__":
    unittest.main()
