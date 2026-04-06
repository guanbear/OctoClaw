#!/usr/bin/env python3
import importlib
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

patrol = importlib.import_module("patrol")


class PatrolSessionMatchingTests(unittest.TestCase):
    def test_build_session_candidates_prefers_session_key_over_label(self) -> None:
        task = {
            "id": "task-1",
            "worker_pool": "octoclaw-code",
            "managed_by_octoclaw": True,
            "session_key": "wechat:dm:target",
            "label": "stale-label",
            "spawned_at": "2026-03-29T10:00:00+00:00",
        }
        sessions = {
            "wechat:dm:target": {
                "label": "different-label",
                "sessionId": "sess-target",
                "updatedAt": "2026-03-29T10:05:00+00:00",
            },
            "slack:dm:other": {
                "label": "stale-label",
                "sessionId": "sess-old",
                "updatedAt": "2026-03-29T10:06:00+00:00",
            },
        }

        candidates = patrol.build_session_candidates(task, sessions)

        self.assertEqual(candidates[0]["_session_key"], "wechat:dm:target")
        self.assertGreater(candidates[0]["_match_score"], candidates[-1]["_match_score"])

    def test_build_session_candidates_uses_agent_identity_for_custom_agent_safe_matching(self) -> None:
        task = {
            "id": "task-2",
            "worker_pool": "octoclaw-research",
            "managed_by_octoclaw": True,
            "agent_id": "octo-worker-2",
            "owner": "octo-worker-2",
        }
        sessions = {
            "agent:main:custom-reviewer": {
                "label": "octo-worker-2",
                "agentId": "custom-reviewer",
                "sessionId": "sess-wrong",
                "updatedAt": "2026-03-29T10:06:00+00:00",
            },
            "agent:main:octo-worker-2": {
                "label": "unrelated-label",
                "agentId": "octo-worker-2",
                "sessionId": "sess-right",
                "updatedAt": "2026-03-29T10:05:00+00:00",
            },
        }

        candidates = patrol.build_session_candidates(task, sessions)

        self.assertEqual(candidates[0]["sessionId"], "sess-right")
        self.assertEqual(candidates[0]["_session_key"], "agent:main:octo-worker-2")

    def test_check_main_model_drift_uses_default_config_loader(self) -> None:
        with (
            patch.object(patrol, "os") as os_mock,
            patch("main_model_drift.main_session_drift_config", return_value={"enabled": False}) as drift_cfg_mock,
            patch("main_model_drift.assess_main_model_drift", return_value={"enabled": False}),
        ):
            os_mock.path.exists.return_value = False
            patrol.check_main_model_drift()

        drift_cfg_mock.assert_called_once_with()

    def test_build_session_candidates_requires_expected_spawn_session_for_managed_tasks(self) -> None:
        task = {
            "id": "task-3",
            "worker_pool": "octoclaw-research",
            "managed_by_octoclaw": True,
            "owner": "main",
            "agent_id": "main",
            "session_id": "old-stale-session",
            "artifacts": {
                "spawn_execution": {
                    "backend": "native",
                    "session_id": "expected-child-session",
                    "child_session_key": "agent:main:subagent:research-3",
                }
            },
        }
        sessions = {
            "agent:main:main": {
                "label": "main",
                "agentName": "main",
                "sessionId": "old-stale-session",
                "updatedAt": "2026-03-29T10:06:00+00:00",
            },
            "agent:main:subagent:research-3": {
                "label": "main",
                "agentName": "main",
                "sessionId": "expected-child-session",
                "updatedAt": "2026-03-29T10:07:00+00:00",
            },
        }

        candidates = patrol.build_session_candidates(task, sessions)

        self.assertEqual([item["_session_key"] for item in candidates], ["agent:main:subagent:research-3"])


if __name__ == "__main__":
    unittest.main()
