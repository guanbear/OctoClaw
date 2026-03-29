#!/usr/bin/env python3
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from io import StringIO

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
                            "artifacts": {"report_path": "/tmp/task-1.md"},
                        },
                        {
                            "id": "task-2",
                            "worker_pool": "octoclaw-runner",
                            "status": "queued",
                            "summary": "check nginx health",
                            "route": "runner",
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

    def test_queue_text_groups_tasks(self) -> None:
        code, out, err = self._run(["--state-file", self.state_file, "queue"])
        self.assertEqual(code, 0, err)
        self.assertIn("[running]", out)
        self.assertIn("[queued]", out)

    def test_missing_task_returns_error(self) -> None:
        code, _out, err = self._run(["--state-file", self.state_file, "anchor", "--id", "missing"])
        self.assertEqual(code, 1)
        self.assertIn("task not found", err)


if __name__ == "__main__":
    unittest.main()
