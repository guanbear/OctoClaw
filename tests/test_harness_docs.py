#!/usr/bin/env python3
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
OWNERSHIP_DOC = REPO_ROOT / "docs" / "octoclaw-harness-ownership-map.md"
CONTRACT_DOC = REPO_ROOT / "docs" / "octoclaw-harness-contract-inventory.md"


class HarnessDocsTests(unittest.TestCase):
    def test_ownership_doc_lists_canonical_layers_and_files(self) -> None:
        text = OWNERSHIP_DOC.read_text(encoding="utf-8")
        self.assertIn("## Runtime Harness", text)
        self.assertIn("## Workflow Harness", text)
        self.assertIn("## Evaluation Harness", text)
        for relative in (
            "lib/octoclaw_route.py",
            "lib/octoclaw_policy.py",
            "lib/dispatch_task.py",
            "lib/context_pack.py",
            "lib/runtime_protocol.py",
            "lib/runner_playbooks.py",
            "lib/model_telemetry_report.py",
            "lib/eval_suite.py",
            "lib/replay_validation.py",
            "lib/reply_review_packet.py",
            "lib/nightly_reply_review.py",
            "lib/nightly_failure_summary.py",
            "extensions/octoclaw-runtime/index.js",
            "extensions/octoclaw-runtime/policy/route.js",
            "extensions/octoclaw-runtime/policy/decide.js",
        ):
            with self.subTest(relative=relative):
                self.assertIn(f"`{relative}`", text)
                self.assertTrue((REPO_ROOT / relative).exists())

    def test_contract_doc_lists_canonical_contracts_and_schemas(self) -> None:
        text = CONTRACT_DOC.read_text(encoding="utf-8")
        for item in (
            "`brief`",
            "`result`",
            "`artifact`",
            "`event`",
            "`eval outcome`",
            "octoclaw.brief/v1",
            "octoclaw.worker_result/v1",
            "octoclaw.reply_review_packet/v1",
            "schemas/runtime-brief-v1.schema.json",
            "schemas/worker-result-v1.schema.json",
        ):
            with self.subTest(item=item):
                self.assertIn(item, text)

    def test_contract_doc_references_existing_canonical_modules(self) -> None:
        text = CONTRACT_DOC.read_text(encoding="utf-8")
        for relative in (
            "lib/runtime_protocol.py",
            "lib/octoclaw_spawn.py",
            "lib/dispatch_task.py",
            "lib/runtime_task_record.py",
            "lib/task-state-update.py",
            "lib/patrol.py",
            "lib/replay_validation.py",
            "lib/replay_summary.py",
            "lib/reply_review_packet.py",
            "lib/nightly_reply_review.py",
            "lib/nightly_failure_summary.py",
        ):
            with self.subTest(relative=relative):
                self.assertIn(relative, text)
                self.assertTrue((REPO_ROOT / relative).exists())


if __name__ == "__main__":
    unittest.main()
