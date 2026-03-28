#!/usr/bin/env python3
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

SPEC = importlib.util.spec_from_file_location("resolve_model_module", REPO_ROOT / "lib" / "resolve-model.py")
resolve_model = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(resolve_model)


class ResolveModelTests(unittest.TestCase):
    def test_auto_policy_prefers_profile_then_worker_pool_phase(self) -> None:
        policy = {
            "profiles": {
                "writer": "model/profile-writer",
            },
            "worker_pool_phases": {
                "octoclaw-research": {
                    "report": "model/research-report",
                }
            },
            "worker_pools": {
                "octoclaw-research": "model/research-default",
            },
            "labels": {
                "octopus-writer": "model/legacy-writer",
            },
            "tiers": {
                "normal": "model/tier-normal",
            },
        }
        with patch.object(resolve_model, "load_json", return_value=policy):
            result = resolve_model.resolve_auto_policy_model(
                "normal",
                "octopus-writer",
                worker_pool="octoclaw-research",
                phase="report",
                profile="writer",
            )
        self.assertEqual(result, "model/profile-writer")

    def test_auto_policy_worker_pool_phase_beats_pool_label_and_tier(self) -> None:
        policy = {
            "worker_pool_phases": {
                "octoclaw-code": {
                    "verify": "model/code-verify",
                }
            },
            "worker_pools": {
                "octoclaw-code": "model/code-default",
            },
            "labels": {
                "octopus-fix": "model/legacy-fix",
            },
            "tiers": {
                "normal": "model/tier-normal",
            },
        }
        with patch.object(resolve_model, "load_json", return_value=policy):
            result = resolve_model.resolve_auto_policy_model(
                "normal",
                "octopus-fix",
                worker_pool="octoclaw-code",
                phase="verify",
                profile="code",
            )
        self.assertEqual(result, "model/code-verify")

    def test_cache_key_is_selector_aware_for_worker_pool_phase_and_profile(self) -> None:
        key = resolve_model.cache_key(
            "normal",
            label="octopus-writer",
            worker_pool="octoclaw-research",
            phase="report",
            profile="writer",
            route="spawn_single",
        )
        self.assertIn("worker_pool=octoclaw-research", key)
        self.assertIn("phase=report", key)
        self.assertIn("profile=writer", key)
        self.assertTrue(key.endswith("::normal"))


if __name__ == "__main__":
    unittest.main()
