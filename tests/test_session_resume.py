#!/usr/bin/env python3
import importlib
import os
import tempfile
import unittest
from unittest.mock import patch

import lib.runtime_coordination as runtime_coordination
from lib.session_resume import build_resume_prompt_section, clear_resume_context, load_resume_context, save_resume_context


def _configure_runtime_workspace(module, workspace: str) -> None:
    module.WORKSPACE = workspace
    module.ARTIFACT_INDEX_FILE = os.path.join(workspace, "tmp", "octopus", "artifact-index.json")
    module.OWNERSHIP_STORE_FILE = os.path.join(workspace, "tmp", "octopus", "task-ownership.json")
    module.WORKER_SESSION_STORE_FILE = os.path.join(workspace, "tmp", "octopus", "worker-session-store.json")
    module.TASK_CHECKLIST_STORE_FILE = os.path.join(workspace, "tmp", "octopus", "task-checklists.json")
    module.upsert_artifact_index.__kwdefaults__["path"] = module.ARTIFACT_INDEX_FILE
    module.upsert_ownership.__kwdefaults__["path"] = module.OWNERSHIP_STORE_FILE
    module.upsert_worker_session.__kwdefaults__["path"] = module.WORKER_SESSION_STORE_FILE
    module.resolve_task_checklist.__kwdefaults__["path"] = module.TASK_CHECKLIST_STORE_FILE
    module.upsert_checklist.__kwdefaults__["path"] = module.TASK_CHECKLIST_STORE_FILE


class SessionResumeTests(unittest.TestCase):
    def test_save_and_load_resume_context_round_trip(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-session-resume-") as tmpdir:
            saved = save_resume_context(
                "task-1",
                {
                    "current_phase": "research",
                    "progress_summary": "Collected 3 sources and drafted a comparison.",
                    "open_checklist_items": ["verify provider limits", "write summary"],
                    "last_tool_result": "rg found the pricing references",
                },
                workspace=tmpdir,
            )
            loaded = load_resume_context("task-1", workspace=tmpdir)

        self.assertEqual(saved, loaded)
        self.assertEqual(loaded["current_phase"], "research")
        self.assertEqual(loaded["open_checklist_items"], ["verify provider limits", "write summary"])

    def test_build_resume_prompt_section_returns_empty_when_missing(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-session-resume-") as tmpdir:
            self.assertEqual(build_resume_prompt_section("missing-task", workspace=tmpdir), "")

    def test_build_resume_prompt_section_formats_context(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-session-resume-") as tmpdir:
            save_resume_context(
                "task-1",
                {
                    "phase": "handoff",
                    "summary": "Main findings are ready for user-safe wording.",
                    "open_items": [{"id": "handoff", "title": "Prepare handoff"}, "send reply"],
                    "last_result": "worker_result status=done",
                },
                workspace=tmpdir,
            )
            section = build_resume_prompt_section("task-1", workspace=tmpdir)

        self.assertIn("## Resumed task context", section)
        self.assertIn("- Phase: handoff", section)
        self.assertIn("- Progress: Main findings are ready for user-safe wording.", section)
        self.assertIn("- Open items: Prepare handoff, send reply", section)
        self.assertIn("- Last result: worker_result status=done", section)

    def test_clear_resume_context_returns_empty_load(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-session-resume-") as tmpdir:
            save_resume_context("task-1", {"current_phase": "research"}, workspace=tmpdir)
            clear_resume_context("task-1", workspace=tmpdir)

            self.assertEqual(load_resume_context("task-1", workspace=tmpdir), {})

    def test_sync_runtime_surfaces_saves_resume_context_when_present(self) -> None:
        original_workspace = os.environ.get("WORKSPACE")
        with tempfile.TemporaryDirectory(prefix="octoclaw-session-resume-") as tmpdir:
            with patch.dict(os.environ, {"WORKSPACE": tmpdir}, clear=False):
                reloaded = importlib.reload(runtime_coordination)
                _configure_runtime_workspace(reloaded, tmpdir)
                reloaded.sync_runtime_surfaces(
                    {
                        "id": "task-1",
                        "status": "running",
                        "route": "spawn_single",
                        "runtime": "subagent",
                        "worker_pool": "octoclaw-research",
                        "updated_at": "2026-04-03T00:00:00+00:00",
                        "agent_id": "octo-worker-1",
                        "session_id": "sess-1",
                        "run_id": "run-1",
                        "resume_context": {
                            "current_phase": "research",
                            "progress_summary": "Collected key references.",
                            "open_checklist_items": ["draft answer"],
                            "last_tool_result": "read 2 docs",
                        },
                    }
                )

                loaded = load_resume_context("task-1", workspace=tmpdir)

        if original_workspace is None:
            os.environ.pop("WORKSPACE", None)
        else:
            os.environ["WORKSPACE"] = original_workspace
        importlib.reload(runtime_coordination)

        self.assertEqual(loaded["current_phase"], "research")
        self.assertEqual(loaded["open_checklist_items"], ["draft answer"])

    def test_mark_task_for_reassignment_clears_resume_context(self) -> None:
        original_workspace = os.environ.get("WORKSPACE")
        with tempfile.TemporaryDirectory(prefix="octoclaw-session-resume-") as tmpdir:
            save_resume_context("task-1", {"current_phase": "research"}, workspace=tmpdir)
            with patch.dict(os.environ, {"WORKSPACE": tmpdir}, clear=False):
                reloaded = importlib.reload(runtime_coordination)
                _configure_runtime_workspace(reloaded, tmpdir)
                reloaded.mark_task_for_reassignment(
                    {
                        "id": "task-1",
                        "status": "running",
                        "lifecycle_state": "running",
                        "owner": "agent-1",
                        "agent_id": "agent-1",
                        "session_id": "sess-1",
                        "run_id": "run-1",
                    }
                )
                loaded = load_resume_context("task-1", workspace=tmpdir)

        if original_workspace is None:
            os.environ.pop("WORKSPACE", None)
        else:
            os.environ["WORKSPACE"] = original_workspace
        importlib.reload(runtime_coordination)

        self.assertEqual(loaded, {})


if __name__ == "__main__":
    unittest.main()
