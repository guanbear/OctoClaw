#!/usr/bin/env python3
import importlib.util
import sys
import unittest
from unittest.mock import patch
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))
SPEC = importlib.util.spec_from_file_location("model_intel_module", REPO_ROOT / "lib" / "model-intel.py")
model_intel = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(model_intel)


class ModelIntelTests(unittest.TestCase):
    def test_collect_candidate_model_ids_falls_back_to_local_snapshots(self) -> None:
        model_ids = model_intel.collect_candidate_model_ids(
            [],
            {"vendor/model-a": {"ttft_ms": 1200}},
            {"vendor/model-b": {"pinchbench": 0.9}},
        )
        self.assertEqual(model_ids, ["vendor/model-a", "vendor/model-b"])

    def test_compute_policy_empty_catalog_uses_new_fields_only(self) -> None:
        with patch.object(model_intel, "save_json", return_value=True), patch.object(
            model_intel, "load_octopus_config", return_value={}
        ):
            policy = model_intel.compute_policy({"models": []}, mode="auto")
        self.assertEqual(policy["mode"], "auto")
        self.assertEqual(policy["main_model"], "")
        self.assertEqual(policy["profiles"], {})
        self.assertEqual(policy["worker_pools"], {})
        self.assertEqual(policy["worker_pool_phases"], {})
        self.assertIn("main_selection", policy)
        self.assertNotIn("labels", policy)
        self.assertNotIn("tiers", policy)

    def test_compute_policy_deprioritizes_cooldown_model_and_emits_health_block(self) -> None:
        catalog = {
            "models": [
                {
                    "id": "model/primary",
                    "available": True,
                    "pricing": {"input": 1.0, "output": 2.0},
                    "scores": {"coding": 0.95, "reasoning": 0.95, "openclaw": 0.95, "writing": 0.90, "reliability": 0.95},
                    "benchmark_scores": {},
                    "source_factors": {},
                    "speed": {"ttft_ms": 1500, "output_tps": 80},
                    "size_class": "strong",
                    "family": "test",
                    "preferred_use": [],
                    "upgrade_path": [],
                    "fallback_path": ["model/fallback"],
                    "source_refs": [],
                },
                {
                    "id": "model/fallback",
                    "available": True,
                    "pricing": {"input": 1.2, "output": 2.5},
                    "scores": {"coding": 0.85, "reasoning": 0.86, "openclaw": 0.86, "writing": 0.84, "reliability": 0.90},
                    "benchmark_scores": {},
                    "source_factors": {},
                    "speed": {"ttft_ms": 1800, "output_tps": 75},
                    "size_class": "base",
                    "family": "test",
                    "preferred_use": [],
                    "upgrade_path": [],
                    "fallback_path": [],
                    "source_refs": [],
                },
            ]
        }
        health_payload = {
            "generated_at": "2026-03-29T00:00:00Z",
            "models": {
                "model/primary": {
                    "recent_429_count": 3,
                }
            },
        }
        with patch.object(model_intel, "load_json", return_value=health_payload), patch.object(
            model_intel, "save_json", return_value=True
        ), patch.object(model_intel, "load_octopus_config", return_value={}):
            policy = model_intel.compute_policy(catalog, mode="auto")
        self.assertEqual(policy["main_model"], "model/fallback")
        self.assertEqual(policy["health"]["models"]["model/primary"]["state"], "cooldown")
        self.assertGreater(policy["health"]["selection_penalties"]["model/primary"]["main"], 0.5)

    def test_compute_policy_applies_main_capability_floor(self) -> None:
        catalog = {
            "models": [
                {
                    "id": "model/mid-balanced",
                    "available": True,
                    "pricing": {"input": 0.3, "output": 0.9},
                    "scores": {"coding": 0.83, "reasoning": 0.82, "openclaw": 0.81, "writing": 0.80, "reliability": 0.83},
                    "benchmark_scores": {},
                    "source_factors": {},
                    "speed": {"ttft_ms": 1200, "output_tps": 90},
                    "size_class": "base",
                    "family": "test",
                    "preferred_use": [],
                    "upgrade_path": [],
                    "fallback_path": [],
                    "source_refs": [],
                },
                {
                    "id": "model/strong-main",
                    "available": True,
                    "pricing": {"input": 4.0, "output": 16.0},
                    "scores": {"coding": 0.95, "reasoning": 0.95, "openclaw": 0.92, "writing": 0.87, "reliability": 0.91},
                    "benchmark_scores": {},
                    "source_factors": {},
                    "speed": {"ttft_ms": 5200, "output_tps": 52},
                    "size_class": "strong",
                    "family": "test",
                    "preferred_use": [],
                    "upgrade_path": [],
                    "fallback_path": [],
                    "source_refs": [],
                },
            ]
        }
        with patch.object(model_intel, "load_json", return_value={}), patch.object(
            model_intel, "save_json", return_value=True
        ), patch.object(
            model_intel,
            "load_octopus_config",
            return_value={"model_auto": {"main_selection": {"max_relax_rounds": 0}}},
        ):
            policy = model_intel.compute_policy(catalog, mode="auto")

        self.assertEqual(policy["main_model"], "model/strong-main")
        self.assertEqual(policy["worker_pools"]["octoclaw-main"], "model/strong-main")
        self.assertEqual(policy["main_selection"]["selected_model"], "model/strong-main")
        mid = {row["model"]: row for row in policy["main_selection"]["candidates"]}["model/mid-balanced"]
        self.assertFalse(mid["eligible"])
        self.assertIn("capability_score", mid["failed_checks"])


if __name__ == "__main__":
    unittest.main()
