#!/usr/bin/env python3
import json
import os
import subprocess
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
STATUS_SURFACE_PATH = REPO_ROOT / "extensions" / "octoclaw-status-surface" / "src" / "index.ts"


def run_status_surface_expression(expression: str) -> dict:
    script = f"""
import * as mod from {json.dumps(str(STATUS_SURFACE_PATH))};
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


class OctoClawStatusSurfaceTests(unittest.TestCase):
    def test_status_surface_actions_are_substrate_first(self) -> None:
        payload = run_status_surface_expression(
            """(() => {
                const record = {
                  taskId: 'task-status-1',
                  flowId: 'flow-status-1',
                  runtime: 'openclaw-native',
                  syncMode: 'managed',
                  substrateState: 'running',
                  substrateRevision: 4,
                  ownership: { claimOwner: 'worker-alpha', claimToken: 'claim-1', controllerId: 'controller-1' },
                  scope: { readScope: [], writeScope: [], workspaceMode: 'shared_workspace', writeScopeSummary: 'workspace' },
                  truth: { taskId: 'task-status-1', flowId: 'flow-status-1', requestId: 'req-status-1' },
                  projection: { substrate_state: 'running', substrate_revision: 4 },
                };
                return {
                  status: mod.executeStatusSurfaceAction('status', record),
                  details: mod.executeStatusSurfaceAction('details', record),
                  queue: mod.executeStatusSurfaceAction('queue', record),
                  timeline: mod.executeStatusSurfaceAction('timeline', record),
                };
            })()"""
        )

        self.assertEqual(payload["status"]["taskId"], "task-status-1")
        self.assertEqual(payload["status"]["state"], "running")
        self.assertEqual(payload["details"]["substrateRevision"], 4)
        self.assertEqual(payload["queue"]["queuePosition"], 1)
        self.assertEqual(payload["timeline"]["available"], True)
        self.assertIn("timeline placeholder", payload["timeline"]["summary"])

    def test_status_read_model_surfaces_queue_lease_and_cost_fields(self) -> None:
        payload = run_status_surface_expression(
            """(() => {
                const record = {
                  taskId: 'task-status-2',
                  flowId: 'flow-status-2',
                  runtime: 'openclaw-native',
                  syncMode: 'managed',
                  substrateState: 'planned',
                  substrateRevision: 8,
                  ownership: { claimOwner: 'worker-beta', claimToken: 'claim-2', controllerId: 'controller-2' },
                  scope: { readScope: [], writeScope: [], workspaceMode: 'shared_workspace', writeScopeSummary: 'repo:src' },
                  truth: { taskId: 'task-status-2', flowId: 'flow-status-2', requestId: 'req-status-2' },
                  projection: { substrate_state: 'planned', substrate_revision: 8 },
                };
                return {
                  status: mod.buildStatusProjection({
                    record,
                    queuePosition: 3,
                    workerPool: 'octoclaw-code',
                    route: 'delegate.single',
                    modelSummary: 'code',
                    costEstimate: '$0.02',
                    leaseState: 'active',
                    isStale: false,
                    conflictQueued: true,
                    actionAvailability: ['status', 'details', 'queue', 'timeline'],
                  }),
                  details: mod.buildDetailsProjection({
                    record,
                    queuePosition: 3,
                    modelSummary: 'code',
                    costEstimate: '$0.02',
                    leaseState: 'active',
                    isStale: false,
                    conflictQueued: true,
                    actionAvailability: ['status', 'details', 'queue', 'timeline'],
                  }),
                  queue: mod.buildQueueProjection({
                    record,
                    queuePosition: 3,
                    workerPool: 'octoclaw-code',
                    leaseState: 'active',
                    isStale: false,
                    conflictQueued: true,
                  }),
                };
            })()"""
        )

        self.assertEqual(payload["status"]["workerPool"], "octoclaw-code")
        self.assertEqual(payload["status"]["queuePosition"], 3)
        self.assertEqual(payload["status"]["modelSummary"], "code")
        self.assertEqual(payload["status"]["costEstimate"], "$0.02")
        self.assertEqual(payload["status"]["leaseState"], "active")
        self.assertEqual(payload["details"]["queuePosition"], 3)
        self.assertEqual(payload["details"]["modelSummary"], "code")
        self.assertEqual(payload["details"]["costEstimate"], "$0.02")
        self.assertEqual(payload["details"]["leaseState"], "active")
        self.assertTrue(payload["queue"]["conflictQueued"])

    def test_status_surface_operator_renders_text_and_rich_without_guessing(self) -> None:
        payload = run_status_surface_expression(
            """(() => {
                const record = {
                  taskId: 'task-status-3',
                  flowId: 'flow-status-3',
                  runtime: 'openclaw-native',
                  syncMode: 'managed',
                  substrateState: 'running',
                  substrateRevision: 12,
                  ownership: { claimOwner: 'worker-gamma', claimToken: 'claim-3', controllerId: 'controller-3' },
                  scope: { readScope: [], writeScope: [], workspaceMode: 'shared_workspace', writeScopeSummary: 'repo:src' },
                  truth: { taskId: 'task-status-3', flowId: 'flow-status-3', requestId: 'req-status-3' },
                  projection: { substrate_state: 'running', substrate_revision: 12 },
                };
                return {
                  textStatus: mod.runStatusSurfaceOperator('status', record, 'text'),
                  richQueue: mod.runStatusSurfaceOperator('queue', record, 'rich'),
                  textTimeline: mod.runStatusSurfaceOperator('timeline', record, 'text'),
                };
            })()"""
        )

        self.assertIn('Status: task-status-3', payload['textStatus'])
        self.assertIn('state=running', payload['textStatus'])
        self.assertEqual(payload['richQueue']['kind'], 'queue_card')
        self.assertEqual(payload['richQueue']['taskId'], 'task-status-3')
        self.assertIn('Timeline: task-status-3', payload['textTimeline'])


if __name__ == "__main__":
    unittest.main()
