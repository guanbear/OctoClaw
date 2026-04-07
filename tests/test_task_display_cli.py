#!/usr/bin/env python3
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from io import StringIO
from unittest.mock import patch

from lib import task_display_cli


class TaskDisplayCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.state_file = os.path.join(self.tmpdir.name, "task-state.json")
        with open(self.state_file, "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "tasks": [
                        {
                            "id": "task-1",
                            "worker_pool": "octoclaw-code",
                            "status": "running",
                            "summary": "fix login 401 and add tests",
                            "route": "spawn_single",
                            "model": "omniroute/cx/gpt-5.4",
                            "started_at": "2026-03-31T10:00:00Z",
                            "updated_at": "2026-03-31T10:05:00Z",
                            "openclaw_taskflow": {
                                "backend": "mirror",
                                "binding_state": "mirrored_bound",
                                "task_runtime": "openclaw_task",
                                "flow_runtime": "openclaw_flow",
                                "native_binding_state": "bound",
                                "create_preference": "native_preferred",
                                "create_status": "native_bound",
                                "task_id": "native-task-1",
                                "flow_id": "flow-1",
                            },
                            "artifacts": {"report_path": "/tmp/task-1.md", "context_pack_path": "/tmp/task-1-context.json"},
                            "task_events_preview": [
                                {
                                    "time": "2026-03-31T10:05:00Z",
                                    "kind": "checkpoint",
                                    "message": "checkpoint saved",
                                    "importance": "normal",
                                }
                            ],
                        },
                        {
                            "id": "task-2",
                            "worker_pool": "octoclaw-runner",
                            "status": "done",
                            "lifecycle_state": "finished",
                            "summary": "check nginx health",
                            "route": "runner",
                            "parent_id": "task-1",
                            "started_at": "2026-03-31T10:01:00Z",
                            "updated_at": "2026-03-31T10:02:00Z",
                            "openclaw_taskflow": {
                                "backend": "mirror",
                                "binding_state": "mirrored",
                                "task_runtime": "openclaw_task",
                                "create_preference": "mirror_only",
                                "create_status": "mirror_only",
                            },
                            "artifacts": {
                                "runner_plan": {
                                    "kind": "local_file_probe",
                                    "command": "tail -n 80 /var/log/nginx/error.log",
                                }
                            },
                        },
                        {
                            "id": "task-3",
                            "worker_pool": "octoclaw-review",
                            "status": "queued",
                            "summary": "review pending",
                            "route": "spawn_single",
                        },
                    ]
                },
                fh,
                ensure_ascii=False,
            )

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def _run(self, argv: list[str]) -> tuple[int, str, str]:
        old_argv = task_display_cli.sys.argv
        out = StringIO()
        err = StringIO()
        try:
            task_display_cli.sys.argv = ["task_display_cli.py", *argv]
            with redirect_stdout(out), redirect_stderr(err):
                code = task_display_cli.main()
            return code, out.getvalue(), err.getvalue()
        finally:
            task_display_cli.sys.argv = old_argv

    def test_anchor_text_includes_task_specific_commands(self) -> None:
        code, out, err = self._run(["--state-file", self.state_file, "anchor", "--id", "task-1"])
        self.assertEqual(code, 0, err)
        self.assertIn("Reply with: details task-1", out)
        self.assertIn("stop task-1", out)

    def test_detail_json_renders_artifacts(self) -> None:
        code, out, err = self._run(["--state-file", self.state_file, "--format", "json", "detail", "--id", "task-1"])
        self.assertEqual(code, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["task_id"], "task-1")
        self.assertEqual(payload["artifacts"][0]["path"], "/tmp/task-1.md")

    def test_detail_text_surfaces_substrate_binding(self) -> None:
        code, out, err = self._run(["--state-file", self.state_file, "detail", "--id", "task-1"])
        self.assertEqual(code, 0, err)
        self.assertIn("Substrate detail: mirror bound to native · bound · flow flow-1", out)
        self.assertIn("OpenClaw binding: task native-task-1 | flow flow-1 | runtime openclaw_task/openclaw_flow", out)
        self.assertIn("Create path: preference native_preferred | status native_bound", out)

    def test_detail_text_surfaces_runner_plan(self) -> None:
        code, out, err = self._run(["--state-file", self.state_file, "detail", "--id", "task-2"])
        self.assertEqual(code, 0, err)
        self.assertIn("Runner plan: local_file_probe | tail -n 80 /var/log/nginx/error.log", out)

    def test_queue_text_groups_tasks(self) -> None:
        code, out, err = self._run(["--state-file", self.state_file, "queue"])
        self.assertEqual(code, 0, err)
        self.assertIn("[running]", out)
        self.assertIn("[queued]", out)

    def test_retrieve_text_surfaces_primary_report(self) -> None:
        code, out, err = self._run(["--state-file", self.state_file, "retrieve", "--id", "task-1"])
        self.assertEqual(code, 0, err)
        self.assertIn("Substrate: mirror bound to native · bound · flow flow-1", out)
        self.assertIn("Create path: preference native_preferred | status native_bound", out)
        self.assertIn("Primary report: /tmp/task-1.md", out)
        self.assertIn("Summary:", out)

    def test_substrate_text_summarizes_inventory(self) -> None:
        code, out, err = self._run(["--state-file", self.state_file, "substrate"])
        self.assertEqual(code, 0, err)
        self.assertIn("Substrate inventory", out)
        self.assertIn("Taskflow tracked", out)
        self.assertIn("Native preferred", out)
        self.assertIn("Cleanup candidates", out)

    @patch("lib.task_display_cli.describe_taskflow_cleanup")
    def test_substrate_cleanup_preview_text_lists_candidates(self, mock_preview) -> None:
        mock_preview.return_value = {
            "retention_hours": 24,
            "candidate_count": 1,
            "eligible_count": 1,
            "candidates": [
                {
                    "task_id": "task-2",
                    "route": "runner",
                    "create_status": "mirror_only",
                    "age_hours": 72,
                    "eligible_now": True,
                }
            ],
        }

        code, out, err = self._run(["--state-file", self.state_file, "substrate", "--cleanup-preview"])
        self.assertEqual(code, 0, err)
        self.assertIn("Substrate cleanup (preview)", out)
        self.assertIn("task-2 | runner | mirror_only | 72h | eligible", out)

    @patch("lib.task_display_cli.cleanup_taskflow_mirror")
    def test_substrate_cleanup_apply_text_reports_removed_entries(self, mock_cleanup) -> None:
        mock_cleanup.return_value = {
            "retention_hours": 24,
            "candidate_count": 2,
            "removed_count": 1,
            "removed_task_ids": ["task-2"],
            "remaining_entries": 1,
        }

        code, out, err = self._run(["--state-file", self.state_file, "substrate", "--cleanup-apply"])
        self.assertEqual(code, 0, err)
        self.assertIn("Substrate cleanup (applied)", out)
        self.assertIn("Removed: `1`", out)
        self.assertIn("task-2", out)

    def test_retrieve_text_surfaces_runner_plan(self) -> None:
        code, out, err = self._run(["--state-file", self.state_file, "retrieve", "--id", "task-2"])
        self.assertEqual(code, 0, err)
        self.assertIn("Runner plan: local_file_probe | tail -n 80 /var/log/nginx/error.log", out)

    def test_graph_text_surfaces_child_relationship(self) -> None:
        code, out, err = self._run(["--state-file", self.state_file, "graph", "--id", "task-1"])
        self.assertEqual(code, 0, err)
        self.assertIn("Task graph: task-1", out)
        self.assertIn("task-1 -> task-2", out)

    def test_timeline_json_includes_child_events(self) -> None:
        code, out, err = self._run(["--state-file", self.state_file, "--format", "json", "timeline", "--id", "task-1"])
        self.assertEqual(code, 0, err)
        payload = json.loads(out)
        kinds = [item["kind"] for item in payload["events"]]
        self.assertIn("checkpoint", kinds)
        self.assertIn("child_started", kinds)

    def test_explorer_text_surfaces_context_pack(self) -> None:
        code, out, err = self._run(["--state-file", self.state_file, "explorer", "--id", "task-1"])
        self.assertEqual(code, 0, err)
        self.assertIn("Context pack: /tmp/task-1-context.json", out)
        self.assertIn("Primary artifacts:", out)

    def test_missing_task_returns_error(self) -> None:
        code, _out, err = self._run(["--state-file", self.state_file, "anchor", "--id", "missing"])
        self.assertEqual(code, 1)
        self.assertIn("task not found", err)


if __name__ == "__main__":
    unittest.main()
