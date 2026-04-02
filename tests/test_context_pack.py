#!/usr/bin/env python3
import json
import tempfile
import unittest
from pathlib import Path

from lib.context_pack import CONTEXT_PACK_SCHEMA_VERSION, build_context_pack


class ContextPackTests(unittest.TestCase):
    def test_build_context_pack_compacts_related_task_truth(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-context-pack-") as tmpdir:
            context_dir = Path(tmpdir) / "context"
            artifact_index_path = Path(tmpdir) / "tmp" / "octopus" / "artifact-index.json"
            artifact_index_path.parent.mkdir(parents=True, exist_ok=True)
            artifact_index_path.write_text(
                json.dumps(
                    {
                        "schema_version": "octoclaw.artifact_index/v1",
                        "updated_at": "2026-03-31T10:00:00+00:00",
                        "artifacts": {
                            "artifact-1": {
                                "artifact_id": "artifact-1",
                                "task_id": "research-1",
                                "kind": "report",
                                "title": "exec summary",
                                "content": "artifact summary",
                                "updated_at": "2026-03-31T10:00:00+00:00",
                            }
                        },
                        "task_index": {"research-1": ["artifact-1"]},
                        "thread_index": {},
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            task = {
                "id": "research-1",
                "worker_pool": "octoclaw-research",
                "route": "spawn_single",
                "status": "blocked",
                "summary": "source boundary reached but blocked handoff ready",
                "task_description": "Investigate provider pricing changes",
                "report_path": "/tmp/research-1.md",
                "updated_at": "2026-03-31T10:00:00+00:00",
                "completed_at": "2026-03-31T10:00:00+00:00",
                "task_events_preview": [
                    {
                        "time": "2026-03-31T09:58:00+00:00",
                        "kind": "checkpoint",
                        "message": "verified public sources and confirmed access boundary",
                        "importance": "normal",
                    }
                ],
                "checklist": {
                    "kind": "explicit",
                    "items": [
                        {"id": "collect", "title": "Collect sources", "state": "done"},
                        {"id": "write", "title": "Write summary", "state": "blocked"},
                    ],
                },
                "artifacts": {
                    "worker_result": {
                        "status": "blocked",
                        "summary": "blocked explanation ready",
                        "report": "/tmp/research-1.md",
                        "next_step": "ask for authenticated browser access",
                    }
                },
            }

            pack_bundle = build_context_pack(
                task_id="spawn-1",
                requested_task="Continue the pricing research and prepare a user-safe answer.",
                related_tasks=[task],
                context_dir=str(context_dir),
            )

            self.assertEqual(pack_bundle["context_pack"]["schema_version"], CONTEXT_PACK_SCHEMA_VERSION)
            self.assertEqual(pack_bundle["context_pack"]["related_task_count"], 1)
            self.assertTrue(pack_bundle["context_pack_path"])
            self.assertTrue(pack_bundle["context_path"])
            self.assertIn("ask for authenticated browser access", json.dumps(pack_bundle["context_pack"], ensure_ascii=False))
            self.assertIn("checklist", pack_bundle["context_pack"]["summary"])
            self.assertTrue(any(section.get("title") == "Relevant artifacts" for section in pack_bundle["context_pack"]["sections"]))
            payload = json.loads(Path(pack_bundle["context_pack_path"]).read_text(encoding="utf-8"))
            self.assertEqual(payload["schema_version"], CONTEXT_PACK_SCHEMA_VERSION)
            self.assertIn("## Relevant artifacts", Path(pack_bundle["context_path"]).read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
