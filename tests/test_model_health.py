#!/usr/bin/env python3
import importlib.util
import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

SPEC = importlib.util.spec_from_file_location("model_health_module", REPO_ROOT / "lib" / "model_health.py")
model_health = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(model_health)


class ModelHealthTests(unittest.TestCase):
    def test_resolve_model_health_marks_cooldown_for_recent_failures(self) -> None:
        entry = model_health.resolve_model_health(
            "zhipu/GLM-5.1",
            state={
                "generated_at": "2026-03-29T00:00:00Z",
                "models": {
                    "zhipu/GLM-5.1": {
                        "recent_429_count": 3,
                    }
                },
            },
        )
        self.assertEqual(entry["state"], "cooldown")
        self.assertIn("rate_limit_recent", entry["reason_codes"])

    def test_selection_penalty_is_higher_for_interactive_role(self) -> None:
        entry = {
            "state": "degraded",
            "first_token_p95_ms": 5200,
            "quota_pressure": "high",
        }
        runner_penalty = model_health.selection_penalty_for_role(entry, "runner")
        writer_penalty = model_health.selection_penalty_for_role(entry, "writer")
        self.assertGreater(runner_penalty, writer_penalty)


if __name__ == "__main__":
    unittest.main()
