#!/usr/bin/env python3
import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

patrol = importlib.import_module("patrol")


class PatrolNotificationTests(unittest.TestCase):
    @patch("patrol.save_task_state")
    @patch("patrol.list_native_openclaw_tasks")
    def test_refresh_openclaw_taskflow_bindings_updates_active_spawn_tasks(self, mock_list_native, mock_save) -> None:
        tasks = [
            {
                "id": "spawn-1",
                "status": "running",
                "route": "spawn_single",
                "runtime": "subagent",
                "worker_pool": "octoclaw-research",
                "summary": "research provider docs",
                "task_description": "research provider docs",
                "session_key": "agent:main:slack:channel:C123:thread:1",
                "session_id": "child-sess-1",
                "run_id": "run-1",
            }
        ]
        mock_list_native.return_value = [
            {
                "taskId": "native-task-1",
                "runtime": "subagent",
                "status": "running",
                "runId": "run-1",
                "requesterSessionKey": "agent:main:slack:channel:C123:thread:1",
                "childSessionKey": "child-sess-1",
                "parentFlowId": "flow-1",
                "task": "research provider docs",
            }
        ]

        changed = patrol.refresh_openclaw_taskflow_bindings(tasks)

        self.assertTrue(changed)
        self.assertEqual(tasks[0]["openclaw_task_id"], "native-task-1")
        self.assertEqual(tasks[0]["openclaw_flow_id"], "flow-1")
        mock_save.assert_called_once()

    @patch("patrol.save_task_state")
    @patch("patrol.list_native_openclaw_tasks")
    def test_refresh_openclaw_taskflow_bindings_mirrors_runner_without_native_tasks(self, mock_list_native, mock_save) -> None:
        tasks = [
            {
                "id": "runner-1",
                "status": "running",
                "route": "runner",
                "runtime": "runner",
                "worker_pool": "octoclaw-runner",
                "summary": "check cron health",
                "task_description": "check cron health",
                "session_key": "agent:main:slack:direct:u-runner",
                "session_id": "sess-runner-1",
                "run_id": "run-runner-1",
            }
        ]
        mock_list_native.return_value = []

        changed = patrol.refresh_openclaw_taskflow_bindings(tasks)

        self.assertTrue(changed)
        self.assertEqual(tasks[0]["openclaw_taskflow_backend"], "mirror")
        self.assertEqual(tasks[0]["openclaw_taskflow_state"], "mirrored")
        self.assertEqual(tasks[0]["openclaw_task_runtime"], "openclaw_task")
        self.assertEqual(tasks[0]["openclaw_flow_runtime"], "")
        self.assertEqual(tasks[0]["openclaw_flow_kind"], "")
        artifacts = tasks[0].get("artifacts", {})
        self.assertIsInstance(artifacts, dict)
        binding = artifacts.get("openclaw_taskflow", {})
        self.assertEqual(binding.get("task_runtime"), "openclaw_task")
        self.assertEqual(binding.get("session_key"), "agent:main:slack:direct:u-runner")
        mock_save.assert_called_once()

    @patch("patrol.save_task_state")
    @patch("patrol.list_native_openclaw_tasks")
    def test_refresh_openclaw_taskflow_bindings_skips_final_and_direct_tasks(self, mock_list_native, mock_save) -> None:
        tasks = [
            {"id": "done-1", "status": "done", "route": "spawn_single", "worker_pool": "octoclaw-code"},
            {"id": "direct-1", "status": "running", "route": "direct", "worker_pool": "octoclaw-main"},
        ]
        mock_list_native.return_value = [{"taskId": "native-task-1", "runtime": "subagent", "status": "running"}]

        changed = patrol.refresh_openclaw_taskflow_bindings(tasks)

        self.assertFalse(changed)
        mock_save.assert_not_called()

    @patch("patrol.save_task_state")
    def test_annotate_runner_task_preserves_session_binding(self, mock_save) -> None:
        record = {
            "id": "runner-1",
            "status": "running",
            "route": "runner",
            "runtime": "runner",
            "worker_pool": "octoclaw-runner",
            "summary": "check nginx logs",
            "session_key": "agent:main:slack:direct:u-runner",
            "session_id": "sess-runner-1",
            "run_id": "run-runner-1",
            "agent_id": "agent:main:main",
            "agent_namespace": "octoclaw",
        }

        with patch.object(
            patrol,
            "load_task_state",
            return_value={"tasks": [dict(record)], "updated_at": ""},
        ), patch.object(patrol, "load_main_agent_sessions", return_value={}):
            tasks = patrol.annotate_tasks_with_session_state([dict(record)])

        self.assertEqual(tasks[0]["session_key"], "agent:main:slack:direct:u-runner")
        self.assertEqual(tasks[0]["session_id"], "sess-runner-1")
        self.assertEqual(tasks[0]["session_status"], "runner_local")
        mock_save.assert_called_once()

    def test_extract_session_worker_result_parses_structured_result(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-patrol-home-") as home:
            session_dir = Path(home) / ".openclaw" / "agents" / "main" / "sessions"
            session_dir.mkdir(parents=True, exist_ok=True)
            transcript = session_dir / "sess-result-1.jsonl"
            transcript.write_text(
                json.dumps(
                    {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "text",
                                "text": "---RESULT---\n"
                                '{"status":"done","summary":"release analysis ready","user_safe_summary":"可以升级，但先注意认证配置变更。","report":"/tmp/release.md","artifacts":["/tmp/release.md"],"files":[],"risks":["auth migration"],"verification":[],"next_step":"none"}',
                            }
                        ],
                    },
                    ensure_ascii=False,
                )
                + "\n",
                encoding="utf-8",
            )

            with patch.dict(os.environ, {"HOME": home}, clear=False):
                payload = patrol.extract_session_worker_result(
                    "sess-result-1",
                    task_id="research-1",
                    default_report="/tmp/fallback.md",
                )

        self.assertIsNotNone(payload)
        self.assertEqual(payload["status"], "done")
        self.assertEqual(payload["task_id"], "research-1")
        self.assertEqual(payload["report"], "/tmp/release.md")
        self.assertEqual(payload["user_safe_summary"], "可以升级，但先注意认证配置变更。")

    @patch("patrol.subprocess.run")
    def test_hydrate_completed_session_results_finishes_task_via_task_state_update(self, mock_run) -> None:
        mock_run.return_value.returncode = 0
        mock_run.return_value.stdout = ""
        mock_run.return_value.stderr = ""
        with tempfile.TemporaryDirectory(prefix="octoclaw-patrol-home-") as home:
            session_dir = Path(home) / ".openclaw" / "agents" / "main" / "sessions"
            session_dir.mkdir(parents=True, exist_ok=True)
            (session_dir / "sess-result-2.jsonl").write_text(
                json.dumps(
                    {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "text",
                                "text": "---RESULT---\n"
                                '{"status":"done","summary":"release analysis ready","user_safe_summary":"推荐升级，但注意 MiniMax 图片生成配置。","report":"/tmp/release-2.md","artifacts":["/tmp/release-2.md"],"files":[],"risks":[],"verification":[],"next_step":"none"}',
                            }
                        ],
                    },
                    ensure_ascii=False,
                )
                + "\n",
                encoding="utf-8",
            )

            with patch.dict(os.environ, {"HOME": home}, clear=False):
                hydrated = patrol.hydrate_completed_session_results(
                    [
                        {
                            "id": "research-2",
                            "status": "running",
                            "route": "spawn_single",
                            "runtime": "subagent",
                            "worker_pool": "octoclaw-research",
                            "summary": "collecting release notes",
                            "session_id": "sess-result-2",
                            "session_status": "completed",
                            "session_last_event": "success",
                            "session_has_result": True,
                            "report_path": "/tmp/release-2.md",
                            "artifacts": {},
                        }
                    ]
                )

        self.assertEqual(hydrated, 1)
        cmd = mock_run.call_args[0][0]
        self.assertIn("done", cmd)
        self.assertIn("--id", cmd)
        self.assertIn("research-2", cmd)

    @patch("patrol.subprocess.run")
    def test_hydrate_completed_session_results_finishes_when_transcript_has_result_before_session_status_catches_up(self, mock_run) -> None:
        mock_run.return_value.returncode = 0
        mock_run.return_value.stdout = ""
        mock_run.return_value.stderr = ""
        with tempfile.TemporaryDirectory(prefix="octoclaw-patrol-home-") as home:
            session_dir = Path(home) / ".openclaw" / "agents" / "main" / "sessions"
            session_dir.mkdir(parents=True, exist_ok=True)
            (session_dir / "sess-result-3.jsonl").write_text(
                json.dumps(
                    {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "text",
                                "text": "---RESULT---\n"
                                '{"status":"done","summary":"task finished early","user_safe_summary":"结果已经整理好了。","report":"/tmp/release-3.md","artifacts":["/tmp/release-3.md"],"files":[],"risks":[],"verification":[],"next_step":"none"}',
                            }
                        ],
                    },
                    ensure_ascii=False,
                )
                + "\n",
                encoding="utf-8",
            )

            with patch.dict(os.environ, {"HOME": home}, clear=False):
                hydrated = patrol.hydrate_completed_session_results(
                    [
                        {
                            "id": "research-3",
                            "status": "running",
                            "route": "spawn_single",
                            "runtime": "subagent",
                            "worker_pool": "octoclaw-research",
                            "summary": "collecting release notes",
                            "session_id": "sess-result-3",
                            "session_status": "running",
                            "session_last_event": "streaming",
                            "session_has_result": False,
                            "report_path": "/tmp/release-3.md",
                            "artifacts": {},
                        }
                    ]
                )

        self.assertEqual(hydrated, 1)
        cmd = mock_run.call_args[0][0]
        self.assertIn("done", cmd)
        self.assertIn("research-3", cmd)

    @patch("patrol.subprocess.run")
    def test_hydrate_completed_session_results_rehydrates_incomplete_handoff_from_transcript(self, mock_run) -> None:
        mock_run.return_value.returncode = 0
        mock_run.return_value.stdout = ""
        mock_run.return_value.stderr = ""
        with tempfile.TemporaryDirectory(prefix="octoclaw-patrol-home-") as home:
            session_dir = Path(home) / ".openclaw" / "agents" / "main" / "sessions"
            session_dir.mkdir(parents=True, exist_ok=True)
            (session_dir / "sess-result-4.jsonl").write_text(
                json.dumps(
                    {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "text",
                                "text": "---RESULT---\n"
                                '{"status":"done","summary":"release analysis ready","user_safe_summary":"可以升级，但要先检查 3.31 的认证变更。","report":"/tmp/release-4.md","artifacts":["/tmp/release-4.md"],"files":[],"risks":[],"verification":[],"next_step":"none"}',
                            }
                        ],
                    },
                    ensure_ascii=False,
                )
                + "\n",
                encoding="utf-8",
            )

            with patch.dict(os.environ, {"HOME": home}, clear=False):
                hydrated = patrol.hydrate_completed_session_results(
                    [
                        {
                            "id": "research-4",
                            "status": "running",
                            "route": "spawn_single",
                            "runtime": "subagent",
                            "worker_pool": "octoclaw-research",
                            "summary": "collecting release notes",
                            "session_id": "sess-result-4",
                            "session_status": "running",
                            "session_last_event": "streaming",
                            "session_has_result": False,
                            "artifacts": {
                                "worker_result": {
                                    "status": "done",
                                    "summary": "release analysis ready",
                                }
                            },
                        }
                    ]
                )

        self.assertEqual(hydrated, 1)
        cmd = mock_run.call_args[0][0]
        self.assertIn("done", cmd)
        self.assertIn("research-4", cmd)
        self.assertIn("--user-safe-summary", cmd)

    @patch("patrol.send_task_notification")
    def test_send_state_change_task_anchor_skips_tasks_without_session_key(self, mock_send) -> None:
        sent = patrol.send_state_change_task_anchor(
            {
                "id": "task-1",
                "status": "running",
                "summary": "fix login issue",
            }
        )

        self.assertFalse(sent["ok"])
        mock_send.assert_not_called()

    @patch("patrol.send_task_notification")
    def test_send_state_change_task_anchor_sends_for_session_bound_task(self, mock_send) -> None:
        mock_send.return_value = {"ok": True, "backend": "slack", "messageId": "m-1", "action": "send"}

        sent = patrol.send_state_change_task_anchor(
            {
                "id": "task-1",
                "session_key": "agent:main:slack:channel:C123:thread:1712345.000100",
                "worker_pool": "octoclaw-code",
                "status": "running",
                "summary": "fix login issue",
                "route": "spawn_single",
            }
        )

        self.assertTrue(sent["ok"])
        self.assertEqual(sent["message_id"], "m-1")
        mock_send.assert_called_once()

    @patch("patrol.send_task_notification")
    def test_send_state_change_task_anchors_dedupes_task_ids_and_persists_ids(self, mock_send) -> None:
        mock_send.side_effect = [
            {"ok": True, "backend": "slack", "messageId": "m-1", "action": "send"},
            {"ok": True, "backend": "slack", "messageId": "m-2", "action": "send"},
        ]

        sent = patrol.send_state_change_task_anchors(
            [
                {"id": "task-1", "session_key": "slack:channel:C123", "status": "running"},
                {"id": "task-1", "session_key": "slack:channel:C123", "status": "running"},
                {"id": "task-2", "session_key": "slack:channel:C123:thread:1", "status": "done"},
            ],
            anchor_messages={"existing": {"message_id": "old"}},
        )

        self.assertEqual(sent["sent"], 2)
        self.assertEqual(sent["task_anchor_messages"]["task-1"]["message_id"], "m-1")
        self.assertEqual(sent["task_anchor_messages"]["task-2"]["message_id"], "m-2")
        self.assertEqual(mock_send.call_count, 2)

    @patch("patrol.send_task_notification")
    def test_send_state_change_task_anchor_passes_existing_anchor_message_id(self, mock_send) -> None:
        mock_send.return_value = {"ok": True, "backend": "slack", "messageId": "m-1", "action": "edit"}

        sent = patrol.send_state_change_task_anchor(
            {
                "id": "task-1",
                "session_key": "agent:main:slack:channel:C123:thread:1712345.000100",
                "worker_pool": "octoclaw-code",
                "status": "running",
                "summary": "fix login issue",
                "route": "spawn_single",
            },
            anchor_state={"message_id": "1712345.000200"},
        )

        self.assertTrue(sent["ok"])
        self.assertEqual(sent["action"], "edit")
        self.assertEqual(mock_send.call_args[1]["existing_message_id"], "1712345.000200")

    @patch("patrol.sync_task")
    @patch("patrol.sync_runtime_surfaces")
    @patch("patrol.append_task_event")
    @patch("patrol.save_task_state")
    @patch("patrol.load_task_state")
    @patch("patrol.is_agent_alive", return_value=False)
    def test_patrol_heartbeat_check_requeues_claimed_tasks(
        self,
        mock_is_alive,
        mock_load_state,
        mock_save_state,
        mock_append_event,
        mock_sync_surfaces,
        mock_sync_task,
    ) -> None:
        mock_load_state.return_value = {
            "tasks": [
                {
                    "id": "task-1",
                    "status": "running",
                    "lifecycle_state": "running",
                    "route": "spawn_single",
                    "runtime": "subagent",
                    "worker_pool": "octoclaw-code",
                    "summary": "patch auth middleware",
                    "task_description": "patch auth middleware",
                    "owner": "agent-1",
                    "agent_id": "agent-1",
                    "session_id": "sess-1",
                    "run_id": "run-1",
                }
            ],
            "updated_at": "",
        }

        updated = patrol.patrol_heartbeat_check("/tmp/octoclaw-heartbeat-check", stale_after_seconds=60)

        self.assertEqual(len(updated), 1)
        self.assertEqual(updated[0]["status"], "queued")
        self.assertEqual(updated[0]["owner"], "")
        self.assertEqual(updated[0]["recovery_reason"], "heartbeat_stale")
        mock_is_alive.assert_called_once()
        mock_save_state.assert_called_once()
        mock_append_event.assert_called_once()
        self.assertEqual(mock_append_event.call_args[0][1], "ownership_reassigned")
        mock_sync_surfaces.assert_called_once()
        mock_sync_task.assert_called_once()

    @patch("patrol.append_task_event")
    @patch("patrol.sync_runtime_surfaces")
    @patch("patrol.sync_task")
    def test_recover_dead_agent_tasks_requeues_missing_session_owner(self, mock_sync_task, mock_sync_runtime_surfaces, mock_append_task_event) -> None:
        with patch.object(
            patrol,
            "load_task_state",
            return_value={
                "tasks": [
                    {
                        "id": "task-1",
                        "status": "running",
                        "route": "spawn_single",
                        "runtime": "subagent",
                        "worker_pool": "octoclaw-research",
                        "session_status": "missing",
                        "agent_id": "octo-worker-1",
                        "session_id": "sess-1",
                        "run_id": "run-1",
                        "summary": "research provider docs",
                    }
                ],
                "updated_at": "",
            },
        ), patch.object(patrol, "save_task_state") as mock_save:
            recovered = patrol.recover_dead_agent_tasks(
                [
                    {
                        "id": "task-1",
                        "status": "running",
                        "route": "spawn_single",
                        "runtime": "subagent",
                        "worker_pool": "octoclaw-research",
                        "session_status": "missing",
                        "agent_id": "octo-worker-1",
                        "session_id": "sess-1",
                        "run_id": "run-1",
                        "summary": "research provider docs",
                    }
                ]
            )

        self.assertEqual(len(recovered), 1)
        self.assertEqual(recovered[0]["status"], "queued")
        self.assertEqual(recovered[0]["recovery_action"], "dead_agent_recovered")
        mock_save.assert_called_once()
        mock_sync_task.assert_called_once()
        mock_sync_runtime_surfaces.assert_called_once()
        mock_append_task_event.assert_called_once()

    def test_get_recent_done_tasks_includes_final_blocked_handoffs(self) -> None:
        now = patrol.now_utc()
        completed_at = (now - patrol.timedelta(minutes=5)).isoformat()
        tasks = [
            {
                "id": "research-blocked-1",
                "status": "blocked",
                "summary": "source boundary ready",
                "completed_at": completed_at,
                "route": "spawn_single",
                "worker_pool": "octoclaw-research",
                "artifacts": {
                    "worker_result": {
                        "status": "blocked",
                        "summary": "The source is inaccessible, but the blocked explanation is ready.",
                    }
                },
            }
        ]

        recent = patrol.get_recent_done_tasks(tasks)

        self.assertEqual([item["id"] for item in recent], ["research-blocked-1"])
        self.assertEqual(recent[0]["_finish_type"], "blocked")

    def test_get_recent_done_tasks_skips_internal_done_without_handoff(self) -> None:
        now = patrol.now_utc()
        completed_at = (now - patrol.timedelta(minutes=5)).isoformat()
        tasks = [
            {
                "id": "research-internal-1",
                "status": "done",
                "summary": "",
                "completed_at": completed_at,
                "route": "spawn_single",
                "worker_pool": "octoclaw-research",
                "review_required": True,
                "artifacts": {
                    "worker_result": {
                        "status": "done",
                        "summary": "",
                        "user_safe_summary": "",
                        "report": "",
                        "next_step": "none",
                    }
                },
            }
        ]

        recent = patrol.get_recent_done_tasks(tasks)

        self.assertEqual(recent, [])

    def test_get_recent_done_tasks_includes_ready_done_handoffs(self) -> None:
        now = patrol.now_utc()
        completed_at = (now - patrol.timedelta(minutes=5)).isoformat()
        tasks = [
            {
                "id": "research-ready-1",
                "status": "done",
                "summary": "final summary ready",
                "user_safe_summary": "这是可以直接发给用户的总结。",
                "completed_at": completed_at,
                "route": "spawn_single",
                "worker_pool": "octoclaw-research",
                "review_required": True,
                "report_path": "/tmp/research-ready-1.md",
            }
        ]

        recent = patrol.get_recent_done_tasks(tasks)

        self.assertEqual([item["id"] for item in recent], ["research-ready-1"])
        self.assertEqual(recent[0]["_finish_type"], "done")


if __name__ == "__main__":
    unittest.main()
