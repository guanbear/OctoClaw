#!/usr/bin/env python3
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))
SPEC = importlib.util.spec_from_file_location("model_pricing_module", REPO_ROOT / "lib" / "model_pricing.py")
model_pricing = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(model_pricing)


class ModelPricingTests(unittest.TestCase):
    def test_load_pricing_file_merges_openrouter_catalog_snapshot(self) -> None:
        local_payload = {
            "updated_at": "2026-04-08T00:00:00Z",
            "models": [
                {
                    "match_patterns": ["gpt-5\\.4"],
                    "model_key": "manual-gpt54",
                    "pricing_mode": "subscription_seat_plan",
                    "effective_cny_per_1m_tokens": 24.0,
                }
            ],
        }
        catalog_payload = {
            "generated_at": "2026-04-08T01:00:00Z",
            "records": [
                {
                    "id": "openai/gpt-5.4",
                    "canonical_slug": "openai/gpt-5.4",
                    "name": "GPT-5.4",
                    "prompt_cost_per_1m_usd": 4.0,
                    "completion_cost_per_1m_usd": 16.0,
                    "is_free": False,
                }
            ],
        }

        def fake_load_json(path: str):
            mapping = {
                model_pricing.MODEL_PRICING_FILE: json.loads(json.dumps(local_payload)),
                model_pricing.MODEL_INTEL_OPENROUTER_CATALOG_FILE: json.loads(json.dumps(catalog_payload)),
                model_pricing.MODEL_INTEL_OPENROUTER_CATALOG_LAST_GOOD_FILE: {},
            }
            return mapping.get(str(path), {})

        with patch.object(model_pricing, "load_json", side_effect=fake_load_json), patch.object(
            model_pricing, "save_json", return_value=True
        ):
            payload = model_pricing.load_pricing_file()
            entry = model_pricing.get_pricing_entry("openai/gpt-5.4")

        self.assertEqual(len(payload["models"]), 2)
        self.assertEqual(payload["external_sources"]["openrouter_catalog"]["record_count"], 1)
        self.assertEqual(entry["model_key"], "manual-gpt54")

    def test_get_pricing_entry_uses_external_snapshot_when_manual_missing(self) -> None:
        local_payload = {
            "updated_at": "2026-04-08T00:00:00Z",
            "models": [],
        }
        catalog_payload = {
            "generated_at": "2026-04-08T01:00:00Z",
            "records": [
                {
                    "id": "moonshot/kimi-k2",
                    "canonical_slug": "moonshot/kimi-k2",
                    "name": "Kimi K2",
                    "prompt_cost_per_1m_usd": 0.6,
                    "completion_cost_per_1m_usd": 2.4,
                    "is_free": False,
                }
            ],
        }

        def fake_load_json(path: str):
            mapping = {
                model_pricing.MODEL_PRICING_FILE: json.loads(json.dumps(local_payload)),
                model_pricing.MODEL_INTEL_OPENROUTER_CATALOG_FILE: json.loads(json.dumps(catalog_payload)),
                model_pricing.MODEL_INTEL_OPENROUTER_CATALOG_LAST_GOOD_FILE: {},
            }
            return mapping.get(str(path), {})

        with patch.object(model_pricing, "load_json", side_effect=fake_load_json), patch.object(
            model_pricing, "save_json", return_value=True
        ):
            entry = model_pricing.get_pricing_entry("moonshot/kimi-k2")

        self.assertIsNotNone(entry)
        assert entry is not None
        self.assertTrue(entry["is_external_sync"])
        self.assertEqual(entry["pricing_mode"], "provider_metered_token")


if __name__ == "__main__":
    unittest.main()
