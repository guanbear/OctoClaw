#!/usr/bin/env python3
import json
import tempfile
import unittest
from pathlib import Path

from lib.artifact_retrieval import (
    build_artifact_context_section,
    get_artifact_content,
    prune_artifact_index,
    search_artifacts,
)


def _write_index(workspace: str, payload: dict) -> None:
    index_path = Path(workspace) / "tmp" / "octopus" / "artifact-index.json"
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class ArtifactRetrievalTests(unittest.TestCase):
    def test_search_artifacts_returns_empty_without_index(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-artifact-search-") as tmpdir:
            self.assertEqual(search_artifacts(workspace=tmpdir), [])

    def test_search_artifacts_supports_tag_filter_and_limit(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-artifact-search-") as tmpdir:
            _write_index(
                tmpdir,
                {
                    "schema_version": "octoclaw.artifact_index/v1",
                    "updated_at": "2026-04-02T00:00:00+00:00",
                    "artifacts": {
                        "a-1": {
                            "artifact_id": "a-1",
                            "task_id": "task-1",
                            "kind": "report",
                            "title": "Exec summary",
                            "tags": ["release", "report"],
                            "updated_at": "2026-04-02T00:03:00+00:00",
                        },
                        "a-2": {
                            "artifact_id": "a-2",
                            "task_id": "task-2",
                            "kind": "code",
                            "title": "patch.diff",
                            "tags": ["code"],
                            "updated_at": "2026-04-02T00:02:00+00:00",
                        },
                        "a-3": {
                            "artifact_id": "a-3",
                            "task_id": "task-3",
                            "kind": "report",
                            "title": "Rollout notes",
                            "tags": ["release", "report"],
                            "updated_at": "2026-04-02T00:01:00+00:00",
                        },
                    },
                    "task_index": {
                        "task-1": ["a-1"],
                        "task-2": ["a-2"],
                        "task-3": ["a-3"],
                    },
                    "thread_index": {},
                },
            )

            filtered = search_artifacts(workspace=tmpdir, tags=["report"])
            limited = search_artifacts(workspace=tmpdir, artifact_types=["report"], limit=1)

        self.assertEqual([item["artifact_id"] for item in filtered], ["a-1", "a-3"])
        self.assertEqual([item["artifact_id"] for item in limited], ["a-1"])

    def test_get_artifact_content_reads_from_path(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-artifact-content-") as tmpdir:
            report_path = Path(tmpdir) / "report.md"
            report_path.write_text("report-body", encoding="utf-8")
            _write_index(
                tmpdir,
                {
                    "artifacts": {
                        "a-1": {
                            "artifact_id": "a-1",
                            "task_id": "task-1",
                            "kind": "report",
                            "path": str(report_path),
                            "updated_at": "2026-04-02T00:00:00+00:00",
                        }
                    },
                    "task_index": {"task-1": ["a-1"]},
                    "thread_index": {},
                },
            )

            content = get_artifact_content("a-1", workspace=tmpdir)

        self.assertEqual(content, "report-body")

    def test_get_artifact_content_falls_back_to_inline_content(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-artifact-content-") as tmpdir:
            _write_index(
                tmpdir,
                {
                    "artifacts": {
                        "a-2": {
                            "artifact_id": "a-2",
                            "task_id": "task-1",
                            "kind": "report",
                            "content": "inline summary",
                            "updated_at": "2026-04-02T00:00:00+00:00",
                        }
                    },
                    "task_index": {"task-1": ["a-2"]},
                    "thread_index": {},
                },
            )

            content = get_artifact_content("a-2", workspace=tmpdir)
            missing = get_artifact_content("missing", workspace=tmpdir)

        self.assertEqual(content, "inline summary")
        self.assertIsNone(missing)

    def test_prune_artifact_index_keeps_latest_entries_per_task(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-artifact-prune-") as tmpdir:
            _write_index(
                tmpdir,
                {
                    "schema_version": "octoclaw.artifact_index/v1",
                    "updated_at": "2026-04-02T00:00:00+00:00",
                    "artifacts": {
                        "a-1": {"artifact_id": "a-1", "task_id": "task-1", "kind": "report", "updated_at": "2026-04-02T00:01:00+00:00"},
                        "a-2": {"artifact_id": "a-2", "task_id": "task-1", "kind": "report", "updated_at": "2026-04-02T00:02:00+00:00"},
                        "a-3": {"artifact_id": "a-3", "task_id": "task-1", "kind": "report", "updated_at": "2026-04-02T00:03:00+00:00"},
                        "b-1": {"artifact_id": "b-1", "task_id": "task-2", "kind": "code", "updated_at": "2026-04-02T00:01:00+00:00"},
                    },
                    "task_index": {
                        "task-1": ["a-1", "a-2", "a-3"],
                        "task-2": ["b-1"],
                    },
                    "thread_index": {
                        "thread-1": ["a-1", "a-2", "a-3", "b-1"],
                    },
                },
            )

            summary = prune_artifact_index(workspace=tmpdir, keep_per_task=2)
            pruned_index = json.loads((Path(tmpdir) / "tmp" / "octopus" / "artifact-index.json").read_text(encoding="utf-8"))

        self.assertEqual(summary["removed_artifact_count"], 1)
        self.assertEqual(pruned_index["task_index"]["task-1"], ["a-3", "a-2"])
        self.assertNotIn("a-1", pruned_index["artifacts"])
        self.assertEqual(pruned_index["thread_index"]["thread-1"], ["a-2", "a-3", "b-1"])

    def test_build_artifact_context_section_returns_markdown(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-artifact-section-") as tmpdir:
            _write_index(
                tmpdir,
                {
                    "artifacts": {
                        "a-1": {
                            "artifact_id": "a-1",
                            "task_id": "task-1",
                            "kind": "report",
                            "title": "Exec summary",
                            "content": "summary body",
                            "updated_at": "2026-04-02T00:00:00+00:00",
                        }
                    },
                    "task_index": {"task-1": ["a-1"]},
                    "thread_index": {},
                },
            )

            section = build_artifact_context_section(["task-1"], workspace=tmpdir, limit=5)

        self.assertIn("## Relevant artifacts", section)
        self.assertIn("[report] task-1: Exec summary", section)


if __name__ == "__main__":
    unittest.main()
