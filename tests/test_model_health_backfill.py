#!/usr/bin/env python3
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

SPEC = importlib.util.spec_from_file_location(
    "model_health_backfill_module",
    REPO_ROOT / "lib" / "model_health_backfill.py",
)
model_health_backfill = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(model_health_backfill)


class ModelHealthBackfillTests(unittest.TestCase):
    def test_load_fallback_events_extracts_structured_log_payloads(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-fallback-log-") as tmpdir:
            log_path = Path(tmpdir) / "openclaw.log"
            log_path.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "_meta": {"date": "2026-03-29T08:00:00Z"},
                                "1": {
                                    "event": "model_fallback_decision",
                                    "decision": "candidate_failed",
                                    "candidateProvider": "zhipu",
                                    "candidateModel": "GLM-5.1",
                                    "reason": "rate_limit",
                                    "status": 429,
                                },
                                "2": "model fallback decision",
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "_meta": {"date": "2026-03-29T08:01:00Z"},
                                "1": {
                                    "event": "model_fallback_decision",
                                    "decision": "candidate_succeeded",
                                    "candidateProvider": "openai",
                                    "candidateModel": "gpt-5.4",
                                },
                                "2": "model fallback decision",
                            },
                            ensure_ascii=False,
                        ),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            events, meta = model_health_backfill.load_fallback_events(log_file=str(log_path))
            self.assertFalse(meta["missing"])
            self.assertEqual(len(events), 2)
            self.assertEqual(events[0]["model_id"], "zhipu/GLM-5.1")
            self.assertEqual(events[1]["model_id"], "openai/gpt-5.4")

    def test_apply_backfill_overwrites_previous_backfill_managed_counts(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-health-backfill-") as tmpdir:
            health_path = Path(tmpdir) / "model-health.json"
            health_path.write_text(
                json.dumps(
                    {
                        "generated_at": "2026-03-28T00:00:00Z",
                        "models": {
                            "zhipu/GLM-5.1": {
                                "recent_429_count": 9,
                                "recent_failover_count": 5,
                                "fallback_log_backfill": {"updated_at": "2026-03-28T00:00:00Z"},
                            }
                        },
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            payload = model_health_backfill.apply_fallback_events_to_health(
                [
                    {
                        "time": "2026-03-29T08:00:00Z",
                        "decision": "candidate_failed",
                        "reason": "rate_limit",
                        "status": 429,
                        "code": "",
                        "model_id": "zhipu/GLM-5.1",
                    }
                ],
                output_path=str(health_path),
                source_meta={"files": ["test.log"]},
            )
            entry = payload["models"]["zhipu/GLM-5.1"]
            self.assertEqual(entry["recent_429_count"], 1)
            self.assertEqual(entry["recent_failover_count"], 0)
            self.assertEqual(entry["last_error_reason"], "rate_limit")


if __name__ == "__main__":
    unittest.main()
