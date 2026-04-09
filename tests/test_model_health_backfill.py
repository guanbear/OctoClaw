#!/usr/bin/env python3
import importlib.util
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
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

    def test_load_fallback_events_extracts_plaintext_gateway_lines(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-fallback-log-") as tmpdir:
            log_path = Path(tmpdir) / "gateway.err.log"
            log_path.write_text(
                "\n".join(
                    [
                        "2026-04-08T00:55:40.882+08:00 [model-fallback/decision] model fallback decision: decision=candidate_failed requested=omniroute/cx/gpt-5.4 candidate=minimax-portal/MiniMax-M2.7-highspeed reason=auth next=zhipu/GLM-5.1",
                        "2026-04-08T00:55:43.100+08:00 [model-fallback/decision] model fallback decision: decision=candidate_succeeded requested=omniroute/cx/gpt-5.4 candidate=zhipu/GLM-5.1 reason=unknown next=none",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            events, meta = model_health_backfill.load_fallback_events(log_file=str(log_path))
            self.assertFalse(meta["missing"])
            self.assertEqual(len(events), 2)
            self.assertEqual(events[0]["model_id"], "minimax-portal/MiniMax-M2.7-highspeed")
            self.assertEqual(events[0]["reason"], "auth")
            self.assertEqual(events[1]["model_id"], "zhipu/GLM-5.1")
            self.assertEqual(events[1]["decision"], "candidate_succeeded")

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

    def test_refresh_if_stale_runs_backfill_with_explicit_feedback_config(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-health-refresh-") as tmpdir:
            tmp_path = Path(tmpdir)
            log_path = tmp_path / "gateway.err.log"
            health_path = tmp_path / "model-health.json"
            recent_log_time = datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds")
            log_path.write_text(
                f"{recent_log_time} [model-fallback/decision] model fallback decision: decision=candidate_failed requested=omniroute/cx/gpt-5.4 candidate=minimax-portal/MiniMax-M2.7-highspeed reason=auth next=zhipu/GLM-5.1\n",
                encoding="utf-8",
            )
            result = model_health_backfill.refresh_model_health_feedback_if_stale(
                feedback_cfg={
                    "enabled": True,
                    "stale_after_seconds": 0,
                    "lookback_hours": 24,
                    "max_files": 7,
                    "log_dir": str(tmp_path),
                },
                health_file=str(health_path),
            )
            self.assertTrue(result["enabled"])
            self.assertTrue(result["refreshed"])
            self.assertEqual(result["result"]["event_count"], 1)

            second = model_health_backfill.refresh_model_health_feedback_if_stale(
                feedback_cfg={
                    "enabled": True,
                    "stale_after_seconds": 3600,
                    "lookback_hours": 24,
                    "max_files": 7,
                    "log_dir": str(tmp_path),
                },
                health_file=str(health_path),
            )
            self.assertFalse(second["refreshed"])
            self.assertEqual(second["reason"], "fresh")


if __name__ == "__main__":
    unittest.main()
