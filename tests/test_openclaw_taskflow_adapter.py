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


if __name__ == "__main__":
    unittest.main()
