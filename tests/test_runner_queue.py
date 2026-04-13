#!/usr/bin/env python3
import argparse
import importlib
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import MagicMock, patch

REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(LIB_DIR) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(LIB_DIR))

runner_queue = importlib.import_module("runner_queue")


class EmitJobEventTests(unittest.TestCase):
    def test_emits_when_append_task_event_available(self):
        mock_fn = MagicMock()
        with patch.object(runner_queue, "append_task_event", mock_fn):
            runner_queue._emit_job_event({"id": "j1"}, "job_enqueued", "Runner job enqueued")
        mock_fn.assert_called_once_with({"id": "j1"}, "job_enqueued", message="Runner job enqueued")

    def test_skips_when_job_missing_id(self):
        mock_fn = MagicMock()
        with patch.object(runner_queue, "append_task_event", mock_fn):
            runner_queue._emit_job_event({}, "job_enqueued", "Runner job enqueued")
            runner_queue._emit_job_event({"id": ""}, "job_enqueued", "Runner job enqueued")
            runner_queue._emit_job_event(None, "job_enqueued", "Runner job enqueued")
        mock_fn.assert_not_called()

    def test_swallows_exceptions(self):
        mock_fn = MagicMock(side_effect=RuntimeError("boom"))
        with patch.object(runner_queue, "append_task_event", mock_fn):
            runner_queue._emit_job_event({"id": "j1"}, "job_enqueued", "test")

    def test_noop_when_append_task_event_is_none(self):
        with patch.object(runner_queue, "append_task_event", None):
            runner_queue._emit_job_event({"id": "j1"}, "job_enqueued", "test")


class QueueStatusByCapacityGroupTests(unittest.TestCase):
    def test_groups_by_capacity_group(self):
        state = {
            "jobs": [
                {"id": "1", "status": "queued", "capacity_group": "gpu"},
                {"id": "2", "status": "running", "capacity_group": "gpu"},
                {"id": "3", "status": "done", "capacity_group": "cpu"},
                {"id": "4", "status": "failed", "capacity_group": "cpu"},
                {"id": "5", "status": "queued", "capacity_group": ""},
            ]
        }
        result = runner_queue.queue_status_by_capacity_group(state)
        self.assertEqual(result["gpu"], {"queued": 1, "running": 1, "done": 0, "failed": 0, "total": 2})
        self.assertEqual(result["cpu"], {"queued": 0, "running": 0, "done": 1, "failed": 1, "total": 2})
        self.assertEqual(result["unknown"], {"queued": 1, "running": 0, "done": 0, "failed": 0, "total": 1})

    def test_unknown_for_missing_capacity_group(self):
        state = {"jobs": [{"id": "1", "status": "queued"}]}
        result = runner_queue.queue_status_by_capacity_group(state)
        self.assertIn("unknown", result)
        self.assertEqual(result["unknown"]["total"], 1)

    def test_empty_state(self):
        result = runner_queue.queue_status_by_capacity_group({})
        self.assertEqual(result, {})

    def test_non_dict_state(self):
        result = runner_queue.queue_status_by_capacity_group(None)
        self.assertEqual(result, {})

    def test_skips_non_dict_jobs(self):
        state = {"jobs": ["not a dict", {"id": "1", "status": "queued", "capacity_group": "gpu"}]}
        result = runner_queue.queue_status_by_capacity_group(state)
        self.assertEqual(len(result), 1)
        self.assertEqual(result["gpu"]["total"], 1)


class LaneGroupingArgsTests(unittest.TestCase):
    def test_enqueue_stores_capacity_group(self):
        with tempfile.TemporaryDirectory(prefix="octoclaw-rq-lane-") as workspace:
            queue_path = Path(workspace) / "tmp" / "octopus" / "runner-queue.json"
            queue_path.parent.mkdir(parents=True, exist_ok=True)
            queue_path.write_text(
                json.dumps({"jobs": [], "updated_at": ""}), encoding="utf-8"
            )
            with patch.object(runner_queue, "RUNNER_QUEUE_FILE", str(queue_path)), \
                 patch.object(runner_queue, "append_task_event", None):
                with redirect_stdout(io.StringIO()):
                    runner_queue.cmd_enqueue(
                        argparse.Namespace(
                            id="lane-1",
                            shell_command="echo hi",
                            summary="",
                            cwd=workspace,
                            timeout_seconds=30,
                            model_band="fast",
                            model="",
                            task_description="",
                            session_key="",
                            session_id="",
                            agent_id="",
                            agent_namespace="",
                            managed_by_octoclaw="",
                            artifacts_json={},
                            capacity_group="gpu-heavy",
                            lane_key="project-x",
                            dispatch_key="batch-001",
                        )
                    )
            state = json.loads(queue_path.read_text(encoding="utf-8"))
            job = state["jobs"][0]
            self.assertEqual(job["capacity_group"], "gpu-heavy")
            self.assertEqual(job["lane_key"], "project-x")
            self.assertEqual(job["dispatch_key"], "batch-001")

    def test_enqueue_omits_empty_lane_fields(self):
        with tempfile.TemporaryDirectory(prefix="octoclaw-rq-lane-") as workspace:
            queue_path = Path(workspace) / "tmp" / "octopus" / "runner-queue.json"
            queue_path.parent.mkdir(parents=True, exist_ok=True)
            queue_path.write_text(
                json.dumps({"jobs": [], "updated_at": ""}), encoding="utf-8"
            )
            with patch.object(runner_queue, "RUNNER_QUEUE_FILE", str(queue_path)), \
                 patch.object(runner_queue, "append_task_event", None):
                with redirect_stdout(io.StringIO()):
                    runner_queue.cmd_enqueue(
                        argparse.Namespace(
                            id="lane-2",
                            shell_command="echo hi",
                            summary="",
                            cwd=workspace,
                            timeout_seconds=30,
                            model_band="fast",
                            model="",
                            task_description="",
                            session_key="",
                            session_id="",
                            agent_id="",
                            agent_namespace="",
                            managed_by_octoclaw="",
                            artifacts_json={},
                            capacity_group="",
                            lane_key="",
                            dispatch_key="",
                        )
                    )
            state = json.loads(queue_path.read_text(encoding="utf-8"))
            job = state["jobs"][0]
            self.assertNotIn("capacity_group", job)
            self.assertNotIn("lane_key", job)
            self.assertNotIn("dispatch_key", job)


class EventEmissionIntegrationTests(unittest.TestCase):
    def test_enqueue_emits_job_enqueued(self):
        mock_emit = MagicMock()
        with tempfile.TemporaryDirectory(prefix="octoclaw-rq-emit-") as workspace:
            queue_path = Path(workspace) / "tmp" / "octopus" / "runner-queue.json"
            queue_path.parent.mkdir(parents=True, exist_ok=True)
            queue_path.write_text(
                json.dumps({"jobs": [], "updated_at": ""}), encoding="utf-8"
            )
            with patch.object(runner_queue, "RUNNER_QUEUE_FILE", str(queue_path)), \
                 patch.object(runner_queue, "_emit_job_event", mock_emit):
                with redirect_stdout(io.StringIO()):
                    runner_queue.cmd_enqueue(
                        argparse.Namespace(
                            id="ev-1",
                            shell_command="echo",
                            summary="",
                            cwd=workspace,
                            timeout_seconds=10,
                            model_band="fast",
                            model="",
                            task_description="",
                            session_key="",
                            session_id="",
                            agent_id="",
                            agent_namespace="",
                            managed_by_octoclaw="",
                            artifacts_json={},
                            capacity_group="",
                            lane_key="",
                            dispatch_key="",
                        )
                    )
        mock_emit.assert_called_once()
        args = mock_emit.call_args
        self.assertEqual(args[0][1], "job_enqueued")

    def test_claim_emits_job_claimed(self):
        mock_emit = MagicMock()
        with tempfile.TemporaryDirectory(prefix="octoclaw-rq-emit-") as workspace:
            queue_path = Path(workspace) / "tmp" / "octopus" / "runner-queue.json"
            queue_path.parent.mkdir(parents=True, exist_ok=True)
            queue_path.write_text(
                json.dumps({"jobs": [{"id": "c1", "status": "queued"}], "updated_at": ""}),
                encoding="utf-8",
            )
            with patch.object(runner_queue, "RUNNER_QUEUE_FILE", str(queue_path)), \
                 patch.object(runner_queue, "_emit_job_event", mock_emit):
                with redirect_stdout(io.StringIO()):
                    runner_queue.cmd_claim(
                        argparse.Namespace(worker_id="w1", job_id="c1")
                    )
        mock_emit.assert_called_once()
        args = mock_emit.call_args
        self.assertEqual(args[0][1], "job_claimed")

    def test_complete_emits_job_completed(self):
        mock_emit = MagicMock()
        with tempfile.TemporaryDirectory(prefix="octoclaw-rq-emit-") as workspace:
            queue_path = Path(workspace) / "tmp" / "octopus" / "runner-queue.json"
            queue_path.parent.mkdir(parents=True, exist_ok=True)
            queue_path.write_text(
                json.dumps({"jobs": [{"id": "d1", "status": "running"}], "updated_at": ""}),
                encoding="utf-8",
            )
            with patch.object(runner_queue, "RUNNER_QUEUE_FILE", str(queue_path)), \
                 patch.object(runner_queue, "_emit_job_event", mock_emit):
                with redirect_stdout(io.StringIO()):
                    runner_queue.cmd_complete(
                        argparse.Namespace(id="d1", status="done", summary="", exit_code=0, result_path="")
                    )
        mock_emit.assert_called_once()
        args = mock_emit.call_args
        self.assertEqual(args[0][1], "job_completed")

    def test_complete_emits_job_failed(self):
        mock_emit = MagicMock()
        with tempfile.TemporaryDirectory(prefix="octoclaw-rq-emit-") as workspace:
            queue_path = Path(workspace) / "tmp" / "octopus" / "runner-queue.json"
            queue_path.parent.mkdir(parents=True, exist_ok=True)
            queue_path.write_text(
                json.dumps({"jobs": [{"id": "f1", "status": "running"}], "updated_at": ""}),
                encoding="utf-8",
            )
            with patch.object(runner_queue, "RUNNER_QUEUE_FILE", str(queue_path)), \
                 patch.object(runner_queue, "_emit_job_event", mock_emit):
                with redirect_stdout(io.StringIO()):
                    runner_queue.cmd_complete(
                        argparse.Namespace(id="f1", status="failed", summary="", exit_code=1, result_path="")
                    )
        mock_emit.assert_called_once()
        args = mock_emit.call_args
        self.assertEqual(args[0][1], "job_failed")

    def test_recover_emits_job_timed_out(self):
        mock_emit = MagicMock()
        with tempfile.TemporaryDirectory(prefix="octoclaw-rq-emit-") as workspace:
            queue_path = Path(workspace) / "tmp" / "octopus" / "runner-queue.json"
            health_path = Path(workspace) / "tmp" / "octopus" / "runner-health.json"
            queue_path.parent.mkdir(parents=True, exist_ok=True)
            queue_path.write_text(
                json.dumps(
                    {
                        "jobs": [
                            {
                                "id": "stale-1",
                                "status": "running",
                                "worker_id": "runner-old",
                                "started_at": "2026-04-10T00:00:00+00:00",
                            }
                        ],
                        "updated_at": "2026-04-10T00:00:00+00:00",
                    }
                ),
                encoding="utf-8",
            )
            health_path.write_text(
                json.dumps({"worker_id": "runner-new", "last_heartbeat_at": "2026-04-10T00:10:00+00:00"}),
                encoding="utf-8",
            )
            with patch.object(runner_queue, "RUNNER_QUEUE_FILE", str(queue_path)), \
                 patch.object(runner_queue, "RUNNER_HEALTH_FILE", str(health_path)), \
                 patch.object(runner_queue, "_emit_job_event", mock_emit):
                runner_queue.recover_stale_running_jobs(lease_timeout_seconds=90, heartbeat_stale_seconds=60)
        mock_emit.assert_called_once()
        args = mock_emit.call_args
        self.assertEqual(args[0][1], "job_timed_out")


if __name__ == "__main__":
    unittest.main()
