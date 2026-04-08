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

    def test_build_source_status_prefers_last_good_when_primary_missing(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-model-intel-sync-") as tmpdir:
            last_good = Path(tmpdir) / "last-good.json"
            last_good.write_text(
                json.dumps({"generated_at": "2026-04-08T00:00:00.000Z", "records": [{"id": "openai/gpt-5.4"}]}),
                encoding="utf-8",
            )
            payload = run_node_expression(
                f"__modelIntelSyncTest.buildSourceStatus({{source:'openrouter_catalog', primaryFile:{json.dumps(str(Path(tmpdir) / 'primary.json'))}, lastGoodFile:{json.dumps(str(last_good))}}})"
            )
        self.assertFalse(payload["primary_present"])
        self.assertTrue(payload["last_good_present"])
        self.assertTrue(payload["using_last_good"])
        self.assertEqual(payload["freshness"], "fresh")
        self.assertEqual(payload["records"], 1)

    def test_render_cron_outputs_refresh_schedule_contract(self) -> None:
        payload = run_node_expression("__modelIntelSyncTest.renderCron({workspace:'/tmp/octoclaw', intervalHours:4})")
        self.assertEqual(payload["schema_version"], "octoclaw.model_intel.refresh_schedule/v1")
        self.assertEqual(payload["interval_hours"], 4)
        self.assertIn("model-intel-sync.mjs", payload["command"])
        self.assertIn(" refresh", payload["command"])
        self.assertIn("*/4", payload["cron"])

    def test_render_cron_cli_accepts_workspace_and_interval(self) -> None:
        result = subprocess.run(
            ["node", str(SYNC_SCRIPT), "render-cron", "--workspace", "/tmp/octoclaw-cli", "--interval-hours", "5"],
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
            env={**os.environ, "WORKSPACE": tempfile.gettempdir()},
            check=True,
        )
        payload = json.loads(result.stdout)
        self.assertEqual(payload["workspace"], "/tmp/octoclaw-cli")
        self.assertEqual(payload["interval_hours"], 5)
        self.assertIn("*/5", payload["cron"])


if __name__ == "__main__":
    unittest.main()
