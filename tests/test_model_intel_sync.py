#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
SYNC_SCRIPT = REPO_ROOT / "lib" / "model-intel-sync.mjs"


def run_node_expression(expression: str) -> Any:
    script = f"""
import {{ __modelIntelSyncTest }} from {json.dumps(str(SYNC_SCRIPT))};
const value = ({expression});
console.log(JSON.stringify(value));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        env={**os.environ, "WORKSPACE": tempfile.gettempdir()},
        check=True,
    )
    return json.loads(result.stdout)


class ModelIntelSyncCompatibilityTests(unittest.TestCase):
    def test_normalize_openrouter_catalog_keeps_context_and_free_flags(self) -> None:
        payload = run_node_expression(
            "__modelIntelSyncTest.normalizeOpenRouterCatalog({data:[{id:'openai/gpt-5.4',name:'GPT-5.4',canonical_slug:'openai/gpt-5.4',context_length:256000,pricing:{prompt:'0.000004',completion:'0.000016'}},{id:'openai/gpt-5.4:free',name:'GPT-5.4 (free)',pricing:{prompt:'0',completion:'0'}}]})"
        )
        self.assertEqual(len(payload), 2)
        self.assertEqual(payload[0]["context_length"], 256000)
        self.assertFalse(payload[0]["is_free"])
        self.assertTrue(payload[1]["is_free"])

    def test_parse_openrouter_rankings_filters_free_models_and_emits_counts(self) -> None:
        html = """
        <html><body>
        <h1>LLM Leaderboard</h1>
        <div>1</div><div>.</div><div>GPT-5.4</div><div>9M</div><div>tokens</div>
        <div>2</div><div>.</div><div>GPT-5.4 (free)</div><div>8M</div><div>tokens</div>
        <div>Top Apps</div>
        </body></html>
        """
        catalog = [{"id": "openai/gpt-5.4", "name": "GPT-5.4", "provider": "openai", "is_free": False}]
        payload = run_node_expression(
            f"__modelIntelSyncTest.parseOpenRouterRankings({json.dumps(html)}, {json.dumps(catalog)})"
        )
        self.assertEqual(payload["counts"]["candidate_count"], 2)
        self.assertEqual(payload["counts"]["retained_count"], 1)
        self.assertEqual(payload["counts"]["skipped_free_count"], 1)
        self.assertEqual(len(payload["records"]), 1)
        self.assertEqual(payload["records"][0]["model_id"], "openai/gpt-5.4")


if __name__ == "__main__":
    unittest.main()
