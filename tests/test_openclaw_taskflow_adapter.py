#!/usr/bin/env python3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lib import openclaw_taskflow_adapter


class OpenClawTaskflowAdapterTests(unittest.TestCase):
    def test_runner_binding_registers_mirror_entry(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-taskflow-") as td:
            mirror_path = Path(td) / "openclaw-taskflow-mirror.json"
            config = {
                "openclaw_taskflow": {
                    "enabled": True,
                    "backend": "mirror",
                    "register_runner_tasks": True,
                    "register_runner_one_task_flows": False,
                    "register_spawn_single_flows": True,
                    "register_spawn_multi_linear_flows": True,
                    "native_binding_enabled": True,
                }
            }
            task = {
                "id": "runner-1",
                "route": "runner",
                "status": "queued",
                "worker_pool": "octoclaw-runner",
                "summary": "check queue depth",
                "session_key": "agent:main:slack:channel:C123:thread:1",
            }

            with patch.object(openclaw_taskflow_adapter, "OPENCLAW_TASKFLOW_MIRROR_FILE", str(mirror_path)):
                binding = openclaw_taskflow_adapter.register_taskflow_binding(task, config=config)
                mirror = openclaw_taskflow_adapter.load_taskflow_mirror()

        self.assertEqual(binding["binding_state"], "mirrored")
        self.assertEqual(binding["create_preference"], "mirror_only")
        self.assertTrue(binding["create_status"])
        self.assertIn("runner-1", mirror["entries"])
        self.assertEqual(mirror["entries"]["runner-1"]["link"]["task_runtime"], "openclaw_task")

    def test_reconcile_spawn_single_binding_binds_native_subagent_task(self) -> None:
        config = {
            "openclaw_taskflow": {
                "enabled": True,
                "backend": "mirror",
                "register_runner_tasks": True,
                "register_runner_one_task_flows": False,
                "register_spawn_single_flows": True,
                "register_spawn_multi_linear_flows": True,
                "native_binding_enabled": True,
            }
        }
        task = {
            "id": "spawn-1",
            "route": "spawn_single",
            "runtime": "subagent",
            "status": "running",
            "worker_pool": "octoclaw-research",
            "summary": "research provider docs",
            "task_description": "research provider docs",
            "session_key": "agent:main:slack:channel:C123:thread:1",
            "session_id": "child-sess-1",
            "run_id": "run-1",
        }
        native_tasks = [
            {
                "taskId": "native-task-1",
                "runtime": "subagent",
                "status": "running",
                "syncMode": "managed",
                "state": "running",
                "revision": 7,
                "runId": "run-1",
                "requesterSessionKey": "agent:main:slack:channel:C123:thread:1",
                "childSessionKey": "child-sess-1",
                "parentFlowId": "flow-1",
                "task": "research provider docs",
            }
        ]
        binding = openclaw_taskflow_adapter.build_taskflow_binding(task, config=config)
        binding["backend"] = "mirror"
        binding["binding_state"] = "mirrored"
        resolved = openclaw_taskflow_adapter.reconcile_native_taskflow_binding(
            task,
            binding=binding,
            native_tasks=native_tasks,
            config=config,
        )

        self.assertEqual(resolved["task_id"], "native-task-1")
        self.assertEqual(resolved["flow_id"], "flow-1")
        self.assertEqual(resolved["binding_state"], "mirrored_bound")
        self.assertEqual(resolved["native_binding_state"], "bound")
        self.assertEqual(resolved["sync_mode"], "managed")
        self.assertEqual(resolved["substrate_state"], "running")
        self.assertEqual(resolved["substrate_revision"], 7)
        self.assertEqual(resolved["native_status"], "running")
        self.assertEqual(resolved["native_runtime"], "subagent")
        self.assertGreater(resolved["native_match_score"], 0)
        self.assertTrue(resolved["native_seen_at"])

    def test_spawn_multi_binding_prefers_linear_flow_shape(self) -> None:
        config = {
            "openclaw_taskflow": {
                "enabled": True,
                "backend": "mirror",
                "register_runner_tasks": True,
                "register_runner_one_task_flows": False,
                "register_spawn_single_flows": True,
                "register_spawn_multi_linear_flows": True,
                "native_binding_enabled": True,
            }
        }
        task = {
            "id": "multi-1",
            "route": "spawn_multi",
            "runtime": "subagent",
            "status": "queued",
            "worker_pool": "octoclaw-research",
            "summary": "coordinate research + review",
            "task_description": "coordinate research + review",
        }

        binding = openclaw_taskflow_adapter.build_taskflow_binding(task, config=config)

        self.assertEqual(binding["flow_kind"], "linear")
        self.assertEqual(binding["flow_runtime"], "openclaw_flow")
        self.assertEqual(binding["create_preference"], "native_preferred")

    def test_enrich_task_record_with_taskflow_promotes_native_binding_facts(self) -> None:
        config = {
            "openclaw_taskflow": {
                "enabled": True,
                "backend": "mirror",
                "register_runner_tasks": True,
                "register_runner_one_task_flows": False,
                "register_spawn_single_flows": True,
                "register_spawn_multi_linear_flows": True,
                "native_binding_enabled": True,
            }
        }
        task = {
            "id": "spawn-2",
            "route": "spawn_single",
            "runtime": "subagent",
            "status": "running",
            "worker_pool": "octoclaw-research",
            "summary": "research provider docs",
            "task_description": "research provider docs",
            "session_key": "agent:main:slack:channel:C123:thread:1",
            "session_id": "child-sess-2",
            "run_id": "run-2",
        }
        native_tasks = [
            {
                "taskId": "native-task-2",
                "runtime": "subagent",
                "status": "running",
                "state": "running",
                "revision": 3,
                "runId": "run-2",
                "requesterSessionKey": "agent:main:slack:channel:C123:thread:1",
                "childSessionKey": "child-sess-2",
                "parentFlowId": "flow-2",
                "task": "research provider docs",
            }
        ]

        enriched = openclaw_taskflow_adapter.enrich_task_record_with_taskflow(
            task,
            native_tasks=native_tasks,
            config=config,
        )

        self.assertEqual(enriched["openclaw_taskflow_backend"], "mirror")
        self.assertEqual(enriched["openclaw_taskflow_state"], "mirrored_bound")
        self.assertEqual(enriched["openclaw_task_runtime"], "openclaw_task")
        self.assertEqual(enriched["openclaw_flow_runtime"], "openclaw_flow")
        self.assertEqual(enriched["openclaw_taskflow_sync_mode"], "mirrored")
        self.assertEqual(enriched["openclaw_taskflow_substrate_state"], "running")
        self.assertEqual(enriched["openclaw_taskflow_substrate_revision"], 3)
        self.assertEqual(enriched["openclaw_native_binding_state"], "bound")
        self.assertEqual(enriched["openclaw_native_status"], "running")
        self.assertEqual(enriched["openclaw_native_runtime"], "subagent")
        self.assertGreater(enriched["openclaw_native_match_score"], 0)
        self.assertTrue(enriched["openclaw_native_seen_at"])
        self.assertIn("create_preference", enriched["artifacts"]["openclaw_taskflow"])

    def test_describe_taskflow_cleanup_marks_terminal_mirror_entries_after_retention(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-taskflow-") as td:
            mirror_path = Path(td) / "openclaw-taskflow-mirror.json"
            mirror_path.write_text(
                '{"schema_version":"octoclaw.taskflow.mirror/v1","updated_at":"2026-04-05T00:00:00Z","entries":{"task-clean":{"task_id":"task-clean","updated_at":"2026-04-01T00:00:00Z","link":{"create_status":"mirror_only"}}}}',
                encoding="utf-8",
            )
            config = {"openclaw_taskflow": {"mirror_cleanup_retention_hours": 24}}
            payload = openclaw_taskflow_adapter.describe_taskflow_cleanup(
                [
                    {
                        "id": "task-clean",
                        "route": "runner",
                        "status": "done",
                        "lifecycle_state": "finished",
                        "updated_at": "2026-04-01T00:00:00Z",
                        "openclaw_taskflow": {"create_status": "mirror_only"},
                    },
                    {
                        "id": "task-bound",
                        "route": "spawn_single",
                        "status": "done",
                        "lifecycle_state": "finished",
                        "updated_at": "2026-04-05T00:00:00Z",
                        "openclaw_taskflow": {"create_status": "native_bound"},
                    },
                ],
                mirror_payload=openclaw_taskflow_adapter.load_taskflow_mirror(str(mirror_path)),
                now=openclaw_taskflow_adapter._parse_time("2026-04-06T12:00:00Z"),
                config=config,
            )

        self.assertEqual(payload["candidate_count"], 1)
        self.assertEqual(payload["eligible_count"], 1)
        self.assertEqual(payload["candidates"][0]["task_id"], "task-clean")
        self.assertTrue(payload["candidates"][0]["eligible_now"])

    def test_cleanup_taskflow_mirror_removes_only_eligible_terminal_entries(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-taskflow-") as td:
            mirror_path = Path(td) / "openclaw-taskflow-mirror.json"
            mirror_path.write_text(
                '{"schema_version":"octoclaw.taskflow.mirror/v1","updated_at":"2026-04-05T00:00:00Z","entries":{"task-clean":{"task_id":"task-clean","updated_at":"2026-04-01T00:00:00Z","link":{"create_status":"mirror_only"}},"task-keep":{"task_id":"task-keep","updated_at":"2026-04-06T10:00:00Z","link":{"create_status":"native_unavailable_fallback_mirror"}}}}',
                encoding="utf-8",
            )
            config = {"openclaw_taskflow": {"mirror_cleanup_retention_hours": 24}}
            result = openclaw_taskflow_adapter.cleanup_taskflow_mirror(
                [
                    {
                        "id": "task-clean",
                        "route": "runner",
                        "status": "done",
                        "lifecycle_state": "finished",
                        "updated_at": "2026-04-01T00:00:00Z",
                        "openclaw_taskflow": {"create_status": "mirror_only"},
                    },
                    {
                        "id": "task-keep",
                        "route": "spawn_single",
                        "status": "done",
                        "lifecycle_state": "finished",
                        "updated_at": "2026-04-06T10:00:00Z",
                        "openclaw_taskflow": {"create_status": "native_unavailable_fallback_mirror"},
                    },
                ],
                path=str(mirror_path),
                now=openclaw_taskflow_adapter._parse_time("2026-04-06T12:00:00Z"),
                config=config,
            )
            mirror = openclaw_taskflow_adapter.load_taskflow_mirror(str(mirror_path))

        self.assertEqual(result["removed_count"], 1)
        self.assertEqual(result["removed_task_ids"], ["task-clean"])
        self.assertNotIn("task-clean", mirror["entries"])
        self.assertIn("task-keep", mirror["entries"])

    @patch("lib.openclaw_taskflow_adapter._run_openclaw_cli")
    def test_cancel_native_taskflow_prefers_flow_cancel(self, mock_cli) -> None:
        mock_cli.return_value = {"ok": True, "status": "ok"}

        result = openclaw_taskflow_adapter.cancel_native_taskflow(
            {
                "id": "task-ctrl-1",
                "openclaw_task_id": "native-task-ctrl-1",
                "openclaw_flow_id": "flow-ctrl-1",
            }
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["target_kind"], "flow")
        self.assertEqual(result["target_id"], "flow-ctrl-1")
        self.assertEqual(mock_cli.call_args[0][0], ["flows", "cancel", "flow-ctrl-1"])


if __name__ == "__main__":
    unittest.main()
