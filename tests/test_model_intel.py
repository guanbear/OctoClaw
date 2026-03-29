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
        with patch.object(model_intel, "save_json", return_value=True):
            policy = model_intel.compute_policy({"models": []}, mode="auto")
        self.assertEqual(policy["mode"], "auto")
        self.assertEqual(policy["main_model"], "")
        self.assertEqual(policy["profiles"], {})
        self.assertEqual(policy["worker_pools"], {})
        self.assertEqual(policy["worker_pool_phases"], {})
        self.assertNotIn("labels", policy)
        self.assertNotIn("tiers", policy)


if __name__ == "__main__":
    unittest.main()
