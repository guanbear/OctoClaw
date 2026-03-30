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

    def test_blocked_command_writes_final_blocked_handoff_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "blocked",
                    "--id",
                    "research-blocked-1",
                    "--summary",
                    "Evidence boundary summary ready",
                    "--user-safe-summary",
                    "The source could not be fetched reliably, but a safe blocked explanation is ready.",
                    "--blocked-on",
                    "source_access",
                    "--blocked-reason",
                    "Target article returned inaccessible content",
                    "--report-path",
                    str(workspace / "tmp" / "octopus" / "shared" / "research-blocked-1.md"),
                ],
                check=True,
                env={**os.environ, "WORKSPACE": str(workspace)},
                capture_output=True,
                text=True,
            )

            state = json.loads((workspace / "tmp" / "octopus" / "task-state.json").read_text(encoding="utf-8"))
            task = state["tasks"][0]

            self.assertEqual(task["status"], "blocked")
            self.assertEqual(task["lifecycle_state"], "finished")
            self.assertEqual(task["outcome_state"], "blocked")
            self.assertEqual(task["handoff_state"], "user_safe_ready")
            self.assertEqual(task["blocked_on"], "source_access")
            self.assertEqual(task["deliverable_kind"], "blocked_explanation")
            self.assertIn("safe blocked explanation", task["user_safe_summary"])
            self.assertTrue(task["completed_at"])

    def test_event_command_appends_checkpoint_event_and_updates_summary(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            env = {**os.environ, "WORKSPACE": str(workspace)}
            subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "upsert",
                    "--id",
                    "research-1",
                    "--status",
                    "running",
                    "--summary",
                    "gathering references",
                    "--route",
                    "spawn_single",
                    "--runtime",
                    "subagent",
                    "--worker-pool",
                    "octoclaw-research",
                ],
                check=True,
                env=env,
                capture_output=True,
                text=True,
            )

            subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "event",
                    "--id",
                    "research-1",
                    "--kind",
                    "checkpoint",
                    "--message",
                    "first checkpoint ready",
                    "--summary",
                    "checkpoint summary",
                ],
                check=True,
                env=env,
                capture_output=True,
                text=True,
            )

            state = json.loads((workspace / "tmp" / "octopus" / "task-state.json").read_text(encoding="utf-8"))
            task = state["tasks"][0]
            self.assertEqual(task["summary"], "checkpoint summary")

            events = (workspace / "tmp" / "octopus" / "task-events.jsonl").read_text(encoding="utf-8").splitlines()
            self.assertTrue(any('"kind": "checkpoint"' in line for line in events))

    def test_upsert_writes_ownership_and_worker_session_stores(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            env = {**os.environ, "WORKSPACE": str(workspace)}
            subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "upsert",
                    "--id",
                    "research-ownership-1",
                    "--status",
                    "running",
                    "--summary",
                    "investigate timeout",
                    "--route",
                    "spawn_single",
                    "--runtime",
                    "subagent",
                    "--worker-pool",
                    "octoclaw-research",
                    "--agent-id",
                    "octo-worker-1",
                    "--session-id",
                    "sess-1",
                    "--run-id",
                    "run-1",
                    "--session-status",
                    "active",
                    "--last-observed-at",
                    "+1",
                ],
                check=True,
                env=env,
                capture_output=True,
                text=True,
            )

            ownership_store = json.loads((workspace / "tmp" / "octopus" / "task-ownership.json").read_text(encoding="utf-8"))
            worker_store = json.loads((workspace / "tmp" / "octopus" / "worker-session-store.json").read_text(encoding="utf-8"))

            ownership = ownership_store["tasks"]["research-ownership-1"]
            self.assertEqual(ownership["state"], "claimed")
            self.assertEqual(ownership["owner_id"], "octo-worker-1")

            resume_keys = worker_store["task_index"]["research-ownership-1"]
            self.assertEqual(len(resume_keys), 1)
            resume = worker_store["sessions"][resume_keys[0]]
            self.assertEqual(resume["resume_state"], "active")
            self.assertEqual(resume["agent_id"], "octo-worker-1")

    def test_checklist_command_persists_and_survives_followup_upsert(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            env = {**os.environ, "WORKSPACE": str(workspace)}
            subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "upsert",
                    "--id",
                    "research-checklist-1",
                    "--status",
                    "running",
                    "--summary",
                    "compare providers",
                    "--route",
                    "spawn_single",
                    "--runtime",
                    "subagent",
                    "--worker-pool",
                    "octoclaw-research",
                ],
                check=True,
                env=env,
                capture_output=True,
                text=True,
            )

            subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "checklist",
                    "--id",
                    "research-checklist-1",
                    "--checklist-json",
                    json.dumps(
                        {
                            "kind": "explicit",
                            "items": [
                                {"id": "collect", "title": "Collect sources", "state": "done"},
                                {"id": "summarize", "title": "Write summary", "state": "pending"},
                            ],
                        },
                        ensure_ascii=False,
                    ),
                    "--message",
                    "checklist initialized",
                ],
                check=True,
                env=env,
                capture_output=True,
                text=True,
            )

            subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "upsert",
                    "--id",
                    "research-checklist-1",
                    "--status",
                    "running",
                    "--summary",
                    "continue provider comparison",
                ],
                check=True,
                env=env,
                capture_output=True,
                text=True,
            )

            state = json.loads((workspace / "tmp" / "octopus" / "task-state.json").read_text(encoding="utf-8"))
            task = state["tasks"][0]
            checklist = task["checklist"]
            self.assertEqual(checklist["completed_count"], 1)
            self.assertEqual(checklist["open_count"], 1)
            self.assertEqual(checklist["items"][0]["state"], "done")

            checklist_store = json.loads((workspace / "tmp" / "octopus" / "task-checklists.json").read_text(encoding="utf-8"))
            self.assertIn("research-checklist-1", checklist_store["tasks"])

            events = (workspace / "tmp" / "octopus" / "task-events.jsonl").read_text(encoding="utf-8").splitlines()
            self.assertTrue(any('"kind": "checklist_updated"' in line for line in events))


if __name__ == "__main__":
    unittest.main()
