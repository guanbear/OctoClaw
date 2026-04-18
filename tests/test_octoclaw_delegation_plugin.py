#!/usr/bin/env python3
import json
import os
import subprocess
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DELEGATION_PLUGIN_PATH = REPO_ROOT / "extensions" / "octoclaw-delegation" / "src" / "index.ts"


def run_delegation_expression(expression: str) -> dict:
    script = f"""
import * as mod from {json.dumps(str(DELEGATION_PLUGIN_PATH))};
const value = await ({expression});
console.log(JSON.stringify(value));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        env={**os.environ},
        check=True,
    )
    return json.loads(result.stdout)


class OctoClawDelegationPluginTests(unittest.TestCase):
    def test_materializer_binds_role_profile_backend_and_conflict_policy(self) -> None:
        payload = run_delegation_expression(
            """(() => {
                const materialized = mod.materializeDelegatedWork({
                  requestId: 'req-del-1',
                  taskId: 'task-del-1',
                  flowId: 'flow-del-1',
                  role: 'worker_code',
                  objective: 'Implement the targeted fix',
                  requestIdempotencyKey: 'idem-del-1',
                  deliveryId: 'delivery-del-1',
                  deliveryReceiptId: 'receipt-del-1',
                  claimOwner: 'worker-alpha',
                  leaseDurationMs: 30000,
                  queueBudget: 2,
                  inflightCount: 0,
                  capabilitySatisfied: true,
                  writeConflict: true,
                  readScope: [{ resource: 'repo:docs', access: 'read' }],
                  writeScope: [{ resource: 'repo:src', access: 'write' }],
                  workspaceMode: 'shared_workspace',
                });
                const placeholder = mod.buildCompoundDelegationPlaceholder();
                return { materialized, placeholder };
            })()"""
        )

        self.assertEqual(payload["materialized"]["backend"], "openclaw-native")
        self.assertEqual(payload["materialized"]["modelProfile"], "code")
        self.assertEqual(payload["materialized"]["outputContract"], "worker_result")
        self.assertIn("edit", payload["materialized"]["allowedTools"])
        self.assertEqual(payload["materialized"]["conflict"]["policy"], "serialize")
        self.assertEqual(payload["materialized"]["brief"]["modelProfile"], "code")
        self.assertEqual(payload["placeholder"]["reason"], "ws4_compound_placeholder")

    def test_profile_resolution_matches_role_defaults(self) -> None:
        payload = run_delegation_expression(
            """(() => ({
                review: mod.resolveDelegationProfile('worker_review'),
                backend: mod.selectDelegationBackend('worker_research'),
            }))()"""
        )

        self.assertEqual(payload["review"]["modelProfile"], "review")
        self.assertEqual(payload["review"]["outputContract"], "review_result")
        self.assertEqual(payload["backend"]["backend"], "openclaw-native")
        self.assertEqual(payload["backend"]["profile"]["id"], "worker_research")


if __name__ == "__main__":
    unittest.main()
