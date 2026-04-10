#!/usr/bin/env python3
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lib import octopus_config


class OctopusConfigFeatureFlagTests(unittest.TestCase):
    def test_resolve_runtime_feature_flags_safe_mode_disables_risky_live_capabilities(self) -> None:
        with patch.dict(os.environ, {"OCTOCLAW_RUNTIME_SAFE_MODE": "1"}, clear=False):
            payload = octopus_config.resolve_runtime_feature_flags(
                {
                    "runner_pool": {"enabled": True},
                    "features": {
                        "policy_judge_live": True,
                        "cheap_judge_live": True,
                        "local_judge_live": True,
                        "runner_pool_enabled": True,
                        "delivery_relay_enabled": True,
                        "legacy_runner_fallback": False,
                        "patrol_loop_enabled": True,
                    },
                }
            )

        self.assertTrue(payload["safe_mode_enabled"])
        self.assertFalse(payload["cheap_judge_live"])
        self.assertFalse(payload["local_judge_live"])
        self.assertFalse(payload["runner_pool_enabled"])
        self.assertTrue(payload["legacy_runner_fallback"])
        self.assertEqual(payload["judge_lock"], "main_grade_model")
        self.assertIn("env:OCTOCLAW_RUNTIME_SAFE_MODE", payload["override_sources"])

    def test_load_octopus_config_applies_env_feature_overrides(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-config-flags-") as tmpdir:
            workspace = Path(tmpdir)
            config_path = workspace / "tmp" / "octoclaw-config.json"
            config_path.parent.mkdir(parents=True, exist_ok=True)
            config_path.write_text(
                json.dumps(
                    {
                        "runtime_policy": {
                            "runner_pool": {"enabled": True},
                            "features": {
                                "runner_pool_enabled": True,
                                "delivery_relay_enabled": True,
                            },
                        }
                    }
                ),
                encoding="utf-8",
            )
            env = {
                "WORKSPACE": str(workspace),
                "OCTOCLAW_RUNNER_POOL_ENABLED": "0",
                "OCTOCLAW_DELIVERY_RELAY_ENABLED": "0",
            }
            with patch.dict(os.environ, env, clear=False):
                payload = octopus_config.load_octopus_config()

        features = payload["runtime_policy"]["features"]
        self.assertFalse(features["runner_pool_enabled"])
        self.assertFalse(features["delivery_relay_enabled"])
        self.assertIn("env:OCTOCLAW_RUNNER_POOL_ENABLED", features["override_sources"])
        self.assertIn("env:OCTOCLAW_DELIVERY_RELAY_ENABLED", features["override_sources"])


if __name__ == "__main__":
    unittest.main()
