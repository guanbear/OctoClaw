#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "lib" / "task-state-update.py"


class TaskStateUpdateArchiveTests(unittest.TestCase):
    def test_archive_stale_dispatched_marks_old_tasks_deferred(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            state_dir = workspace / "tmp" / "octopus"
            state_dir.mkdir(parents=True, exist_ok=True)
            report_path = state_dir / "shared" / "stale-report.md"
            now = datetime.now(timezone.utc).astimezone()
            old_time = (now - timedelta(minutes=45)).isoformat()
            fresh_time = (now - timedelta(minutes=5)).isoformat()
            state = {
                "tasks": [
                    {
                        "id": "stale-task",
                        "status": "dispatched",
                        "summary": "old stale dispatch",
                        "spawned_at": old_time,
                        "updated_at": old_time,
                        "report_path": str(report_path),
                    },
                    {
                        "id": "fresh-task",
                        "status": "dispatched",
                        "summary": "recent dispatch",
                        "spawned_at": fresh_time,
                        "updated_at": fresh_time,
                    },
                ],
                "updated_at": old_time,
            }
            (state_dir / "task-state.json").write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")

            subprocess.run(
                ["python3", str(SCRIPT), "archive-stale-dispatched", "--minutes", "20"],
                check=True,
                env={**os.environ, "WORKSPACE": str(workspace)},
                capture_output=True,
                text=True,
            )

            updated = json.loads((state_dir / "task-state.json").read_text(encoding="utf-8"))
            tasks = {item["id"]: item for item in updated["tasks"]}

            self.assertEqual(tasks["stale-task"]["status"], "deferred")
            self.assertEqual(tasks["stale-task"]["recovery_action"], "maintenance_archived_stale_dispatched")
            self.assertIn("maintenance_archive", tasks["stale-task"]["artifacts"])
            self.assertEqual(tasks["fresh-task"]["status"], "dispatched")
            self.assertTrue(report_path.exists())
            self.assertIn("OctoClaw Archived Stale Dispatch", report_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
