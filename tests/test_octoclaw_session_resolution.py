#!/usr/bin/env python3
import importlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class OctoClawSessionResolutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = importlib.import_module("lib.octopus_config")

    def test_resolve_main_session_uses_latest_user_session_without_channel_allowlist(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-session-") as tmpdir:
            sessions_path = Path(tmpdir) / "sessions.json"
            main_sessions_path = Path(tmpdir) / "main-sessions.json"
            sessions_path.write_text(
                json.dumps(
                    {
                        "slack:dm:old": {"updatedAt": 10},
                        "wechat:dm:newest": {"updatedAt": 30},
                        "webchat:thread:alpha": {"updatedAt": 20},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            main_sessions_path.write_text("{}", encoding="utf-8")

            with (
                patch.object(self.module, "SESSIONS_FILE", str(sessions_path)),
                patch.object(self.module, "MAIN_AGENT_SESSIONS_FILE", str(main_sessions_path)),
            ):
                resolved = self.module.resolve_main_session_key({"main_session": {"strategy": "latest_user_session"}})

        self.assertEqual(resolved, "wechat:dm:newest")

    def test_resolve_main_session_origin_match_uses_generic_origin_detection(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-session-origin-") as tmpdir:
            sessions_path = Path(tmpdir) / "sessions.json"
            main_sessions_path = Path(tmpdir) / "main-sessions.json"
            sessions_path.write_text(
                json.dumps(
                    {
                        "slack:dm:old": {"updatedAt": 10},
                        "wechat:dm:newest": {"updatedAt": 30},
                        "webchat:thread:alpha": {"updatedAt": 20},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            main_sessions_path.write_text("{}", encoding="utf-8")

            with (
                patch.object(self.module, "SESSIONS_FILE", str(sessions_path)),
                patch.object(self.module, "MAIN_AGENT_SESSIONS_FILE", str(main_sessions_path)),
            ):
                resolved = self.module.resolve_main_session_key(
                    {"main_session": {"strategy": "origin_match", "origin": "webchat"}}
                )

        self.assertEqual(resolved, "webchat:thread:alpha")


if __name__ == "__main__":
    unittest.main()
