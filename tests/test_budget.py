#!/usr/bin/env python3
import importlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

budget = importlib.import_module("budget")


class BudgetTests(unittest.TestCase):
    def test_sync_from_task_state_records_policy_first_cost_fields(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-budget-") as tmpdir:
            state_path = Path(tmpdir) / "task-state.json"
            log_path = Path(tmpdir) / "octoclaw-budget.json"
            config_path = Path(tmpdir) / "octoclaw-budget-config.json"
            state_path.write_text(
                json.dumps(
                    {
                        "tasks": [
                            {
                                "id": "task-1",
                                "status": "done",
                                "route": "spawn_single",
                                "worker_pool": "octoclaw-code",
                                "phase": "implement",
                                "protocol": "normal",
                                "model_band": "strong",
                                "model": "omniroute/cx/gpt-5.4",
                                "summary": "fixed login flow",
                            }
                        ]
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            config_path.write_text(json.dumps({"enabled": True}, ensure_ascii=False), encoding="utf-8")

            with (
                patch.object(budget, "TASK_STATE_FILE", str(state_path)),
                patch.object(budget, "BUDGET_LOG_FILE", str(log_path)),
                patch.object(budget, "BUDGET_CONFIG_FILE", str(config_path)),
            ):
                synced = budget.sync_from_task_state(state_path=str(state_path), log_path=str(log_path))

            self.assertEqual(synced, 1)
            log_payload = json.loads(log_path.read_text(encoding="utf-8"))
            entry = log_payload["tasks"][0]
            self.assertEqual(entry["model_band"], "strong")
            self.assertEqual(entry["worker_pool"], "octoclaw-code")
            self.assertEqual(entry["route"], "spawn_single")
            self.assertEqual(entry["phase"], "implement")
            self.assertGreater(entry["tokens_estimate"], 0)
            updated_state = json.loads(state_path.read_text(encoding="utf-8"))
            task = updated_state["tasks"][0]
            self.assertIn("$", task["cost_estimate"])
            self.assertEqual(task["artifacts"]["budget"]["worker_pool"], "octoclaw-code")

    def test_sync_from_task_state_counts_final_blocked_tasks(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-budget-") as tmpdir:
            state_path = Path(tmpdir) / "task-state.json"
            log_path = Path(tmpdir) / "octoclaw-budget.json"
            state_path.write_text(
                json.dumps(
                    {
                        "tasks": [
                            {
                                "id": "task-blocked",
                                "status": "blocked",
                                "route": "spawn_single",
                                "worker_pool": "octoclaw-research",
                                "phase": "report",
                                "protocol": "heavy",
                                "model_band": "normal",
                                "model": "zhipu/GLM-4.7",
                                "summary": "source inaccessible but blocked handoff ready",
                                "completed_at": "2026-03-31T10:00:00+00:00",
                                "artifacts": {
                                    "worker_result": {
                                        "status": "blocked",
                                        "summary": "blocked explanation ready",
                                    }
                                },
                            }
                        ]
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            with (
                patch.object(budget, "TASK_STATE_FILE", str(state_path)),
                patch.object(budget, "BUDGET_LOG_FILE", str(log_path)),
            ):
                synced = budget.sync_from_task_state(state_path=str(state_path), log_path=str(log_path))

            self.assertEqual(synced, 1)
            log_payload = json.loads(log_path.read_text(encoding="utf-8"))
            self.assertEqual(log_payload["tasks"][0]["status"], "blocked")

    def test_record_task_dedupes_existing_task_ids(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-budget-") as tmpdir:
            log_path = Path(tmpdir) / "octoclaw-budget.json"

            first = budget.record_task(
                "task-1",
                "minimax-portal/MiniMax-M2.7",
                model_band="fast",
                worker_pool="octoclaw-runner",
                route="runner",
                path=str(log_path),
            )
            second = budget.record_task(
                "task-1",
                "minimax-portal/MiniMax-M2.7",
                model_band="fast",
                worker_pool="octoclaw-runner",
                route="runner",
                path=str(log_path),
            )

            self.assertFalse(first["already_recorded"])
            self.assertTrue(second["already_recorded"])
            log_payload = json.loads(log_path.read_text(encoding="utf-8"))
            self.assertEqual(len(log_payload["tasks"]), 1)


if __name__ == "__main__":
    unittest.main()
