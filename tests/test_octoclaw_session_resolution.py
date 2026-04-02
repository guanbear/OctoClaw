#!/usr/bin/env python3
import importlib
import json
import os
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

    def test_resolve_main_session_prefers_namespaced_im_main_session(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-session-main-") as tmpdir:
            sessions_path = Path(tmpdir) / "sessions.json"
            main_sessions_path = Path(tmpdir) / "main-sessions.json"
            sessions_path.write_text("{}", encoding="utf-8")
            main_sessions_path.write_text(
                json.dumps(
                    {
                        "agent:main:main": {
                            "updatedAt": 10,
                            "sessionId": "main-root",
                        },
                        "agent:main:slack:direct:u123": {
                            "updatedAt": 50,
                            "sessionId": "slack-main",
                            "modelOverride": "MiniMax-M2.7",
                        },
                        "agent:main:clawteam-octoclaw-validation-worker": {
                            "updatedAt": 60,
                            "sessionId": "worker-main",
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            with (
                patch.object(self.module, "SESSIONS_FILE", str(sessions_path)),
                patch.object(self.module, "MAIN_AGENT_SESSIONS_FILE", str(main_sessions_path)),
            ):
                resolved = self.module.resolve_main_session_key({"main_session": {"strategy": "latest_user_session"}})

        self.assertEqual(resolved, "agent:main:slack:direct:u123")

    def test_workspace_infers_from_skill_root_when_env_missing(self) -> None:
        with patch.dict(
            os.environ,
            {
                "WORKSPACE": "",
                "OCTOCLAW_WORKSPACE": "",
                "OCTOCLAW_SKILL_ROOT": "/Users/demo/workspace/openclaw/skills/octopus",
            },
            clear=False,
        ), patch("os.path.isdir", return_value=False):
            module = importlib.reload(self.module)

        self.assertEqual(module.WORKSPACE, "/Users/demo/workspace")

    def test_workspace_prefers_explicit_env_over_inferred_path(self) -> None:
        with patch.dict(
            os.environ,
            {
                "WORKSPACE": "/tmp/octoclaw-explicit",
                "OCTOCLAW_WORKSPACE": "",
                "OCTOCLAW_SKILL_ROOT": "/Users/demo/workspace/openclaw/skills/octopus",
            },
            clear=False,
        ), patch("os.path.isdir", return_value=False):
            module = importlib.reload(self.module)

        self.assertEqual(module.WORKSPACE, "/tmp/octoclaw-explicit")


if __name__ == "__main__":
    unittest.main()
