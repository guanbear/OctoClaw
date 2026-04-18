#!/usr/bin/env python3
import json
import os
import subprocess
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
WEBHOOK_SURFACE_PATH = REPO_ROOT / "extensions" / "octoclaw-runtime" / "src" / "adapter" / "webhook-surface.ts"


def run_webhook_surface_expression(expression: str) -> dict:
    script = f"""
import * as mod from {json.dumps(str(WEBHOOK_SURFACE_PATH))};
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


class RuntimeWebhookSurfaceTests(unittest.TestCase):
    def test_webhook_surface_exposes_create_run_and_read_views(self) -> None:
        payload = run_webhook_surface_expression(
            """(() => {
                const helperInvoker = ({ action }) => action === 'create-managed-flow'
                  ? {
                      ok: true,
                      flow_id: 'flow-hook-1',
                      flow: { flowId: 'flow-hook-1', status: 'queued', revision: 1 },
                    }
                  : {
                      ok: true,
                      native_task_id: 'task-hook-1',
                      flow_id: 'flow-hook-1',
                      task: { taskId: 'task-hook-1', status: 'queued', syncMode: 'managed', state: 'running', revision: 2 },
                    };
                const surface = mod.createRuntimeWebhookSurface({ helperInvoker });
                const workflow = {
                  identity: {
                    requestId: 'req-hook-1',
                    taskId: 'task-hook-1',
                    flowId: 'flow-hook-1',
                    route: 'delegate.single',
                    authority: 'runtime_orchestrator',
                    backend: 'openclaw-native',
                    materializationIntent: 'spawn_single',
                  },
                  workflowOrchestration: 'running',
                  reconcileOrRecovery: 'idle',
                  lifecycle: { phase: 'running', deliveryState: 'not_started', checkpointState: 'none' },
                  checkpoints: { checkpointState: 'none', lastCheckpointAt: null, deliverableReady: false },
                  deadlines: {},
                  claim: {
                    claimOwner: 'owner-hook-1',
                    claimToken: 'claim-hook-1',
                    leaseDurationMs: 30000,
                    leaseExpiresAt: '2026-04-18T00:00:00.000Z'
                  },
                  outbox: {},
                  ackLedger: {},
                  scope: {
                    readScope: [],
                    writeScope: [],
                    workspaceMode: 'shared_workspace',
                    writeScopeSummary: 'workspace'
                  },
                  taskMaterialization: {
                    requestId: 'req-hook-1',
                    taskId: 'task-hook-1',
                    flowId: 'flow-hook-1',
                    requestIdempotencyKey: 'req-hook-1',
                    taskIdempotencyKey: 'task-hook-1',
                    flowIdempotencyKey: 'flow-hook-1',
                    route: 'delegate.single',
                    authority: 'runtime_orchestrator',
                    backend: 'openclaw-native',
                    materializationIntent: 'spawn_single',
                    claimOwner: 'owner-hook-1',
                    claimToken: 'claim-hook-1',
                    leaseExpiresAt: '2026-04-18T00:00:00.000Z',
                    taskPacketRef: 'flow-hook-1:task-hook-1'
                  }
                };
                const managed = surface.createManaged({ sessionKey: 'session-hook-1', workflow });
                const task = surface.runTask({ sessionKey: 'session-hook-1', workflow });
                const readManaged = surface.readManaged(managed);
                const readTask = surface.readTask(task);
                return {
                  managed,
                  task,
                  readManaged,
                  readTask,
                  config: surface.config,
                };
            })()"""
        )

        self.assertEqual(payload["managed"]["flowId"], "flow-hook-1")
        self.assertEqual(payload["task"]["taskId"], "task-hook-1")
        self.assertEqual(payload["readManaged"]["flowId"], "flow-hook-1")
        self.assertEqual(payload["readTask"]["taskId"], "task-hook-1")
        self.assertEqual(payload["readTask"]["runtime"], "openclaw-native")
        self.assertEqual(payload["readTask"]["substrateRevision"], 2)
        self.assertEqual(payload["config"]["defaultChannel"], "direct")
        self.assertIn("task-hook-1 on flow-hook-1 is running", payload["readTask"]["summary"])

    def test_webhook_surface_uses_native_cancel_flow_action(self) -> None:
        payload = run_webhook_surface_expression(
            """(() => {
                const helperCalls = [];
                const helperInvoker = (input) => {
                  helperCalls.push(input);
                  if (input.action === 'cancel-flow') {
                    return {
                      ok: true,
                      status: 'ok',
                      flow_id: input.args.flow_id,
                      found: true,
                      cancelled: true,
                      reason: '',
                    };
                  }
                  return {
                    ok: true,
                    native_task_id: 'task-hook-cancel',
                    flow_id: 'flow-hook-cancel',
                    task: { taskId: 'task-hook-cancel', status: 'queued', syncMode: 'managed', state: 'queued', revision: 1 },
                  };
                };
                const surface = mod.createRuntimeWebhookSurface({ helperInvoker });
                const cancelled = surface.cancelFlow({ sessionKey: 'session-hook-cancel', flowId: 'flow-hook-cancel' });
                return { cancelled, helperCalls };
            })()"""
        )

        self.assertEqual(payload["helperCalls"][0]["action"], "cancel-flow")
        self.assertEqual(payload["helperCalls"][0]["args"]["flow_id"], "flow-hook-cancel")
        self.assertTrue(payload["cancelled"]["ok"])
        self.assertTrue(payload["cancelled"]["cancelled"])
        self.assertEqual(payload["cancelled"]["flowId"], "flow-hook-cancel")

    def test_webhook_surface_reads_native_flow_state_via_read_flow_action(self) -> None:
        payload = run_webhook_surface_expression(
            """(() => {
                const helperCalls = [];
                const helperInvoker = (input) => {
                  helperCalls.push(input);
                  if (input.action === 'read-flow') {
                    return {
                      ok: true,
                      status: 'ok',
                      flow_id: input.args.flow_id,
                      found: true,
                      flow: {
                        flowId: input.args.flow_id,
                        status: 'running',
                        revision: 7,
                        currentStep: 'checking',
                      },
                    };
                  }
                  return {
                    ok: true,
                    flow_id: 'flow-hook-read',
                    flow: { flowId: 'flow-hook-read', status: 'queued', revision: 1 },
                  };
                };
                const surface = mod.createRuntimeWebhookSurface({ helperInvoker });
                const read = surface.readFlowState({ sessionKey: 'session-hook-read', flowId: 'flow-hook-read' });
                return { read, helperCalls };
            })()"""
        )

        self.assertEqual(payload["helperCalls"][0]["action"], "read-flow")
        self.assertEqual(payload["helperCalls"][0]["args"]["flow_id"], "flow-hook-read")
        self.assertTrue(payload["read"]["ok"])
        self.assertTrue(payload["read"]["found"])
        self.assertEqual(payload["read"]["flowId"], "flow-hook-read")
        self.assertEqual(payload["read"]["substrateState"], "running")
        self.assertEqual(payload["read"]["substrateRevision"], 7)
        self.assertIn("flow flow-hook-read is running", payload["read"]["summary"])

    def test_webhook_surface_reads_native_task_state_via_read_task_action(self) -> None:
        payload = run_webhook_surface_expression(
            """(() => {
                const helperCalls = [];
                const helperInvoker = (input) => {
                  helperCalls.push(input);
                  if (input.action === 'read-task') {
                    return {
                      ok: true,
                      status: 'ok',
                      flow_id: input.args.flow_id,
                      task_id: input.args.task_id,
                      found: true,
                      task: {
                        taskId: input.args.task_id,
                        status: 'running',
                        revision: 9,
                        syncMode: 'managed',
                        state: 'running',
                        progressSummary: 'checking',
                      },
                    };
                  }
                  return {
                    ok: true,
                    status: 'ok',
                    flow_id: 'flow-hook-read-task',
                    found: true,
                    flow: { flowId: 'flow-hook-read-task', status: 'running', revision: 4 },
                  };
                };
                const surface = mod.createRuntimeWebhookSurface({ helperInvoker });
                const read = surface.readTaskState({ sessionKey: 'session-hook-read-task', flowId: 'flow-hook-read-task', taskId: 'task-hook-read-task' });
                return { read, helperCalls };
            })()"""
        )

        self.assertEqual(payload["helperCalls"][0]["action"], "read-task")
        self.assertEqual(payload["helperCalls"][0]["args"]["task_id"], "task-hook-read-task")
        self.assertTrue(payload["read"]["ok"])
        self.assertTrue(payload["read"]["found"])
        self.assertEqual(payload["read"]["taskId"], "task-hook-read-task")
        self.assertEqual(payload["read"]["substrateState"], "running")
        self.assertEqual(payload["read"]["substrateRevision"], 9)
        self.assertEqual(payload["read"]["progressSummary"], "checking")
        self.assertIn("task task-hook-read-task on flow-hook-read-task is running", payload["read"]["summary"])

    def test_webhook_surface_builds_substrate_first_status_and_details_views(self) -> None:
        payload = run_webhook_surface_expression(
            """(() => {
                const helperInvoker = ({ action }) => action === 'create-managed-flow'
                  ? {
                      ok: true,
                      flow_id: 'flow-hook-view',
                      flow: { flowId: 'flow-hook-view', status: 'queued', revision: 1 },
                    }
                  : {
                      ok: true,
                      native_task_id: 'task-hook-view',
                      flow_id: 'flow-hook-view',
                      task: { taskId: 'task-hook-view', status: 'queued', syncMode: 'managed', state: 'running', revision: 5 },
                    };
                const surface = mod.createRuntimeWebhookSurface({ helperInvoker });
                const workflow = {
                  identity: {
                    requestId: 'req-hook-view',
                    taskId: 'task-hook-view',
                    flowId: 'flow-hook-view',
                    route: 'delegate.single',
                    authority: 'runtime_orchestrator',
                    backend: 'openclaw-native',
                    materializationIntent: 'spawn_single',
                  },
                  workflowOrchestration: 'running',
                  reconcileOrRecovery: 'idle',
                  lifecycle: { phase: 'running', deliveryState: 'not_started', checkpointState: 'none' },
                  checkpoints: { checkpointState: 'none', lastCheckpointAt: null, deliverableReady: false },
                  deadlines: {},
                  claim: {
                    claimOwner: 'owner-hook-view',
                    claimToken: 'claim-hook-view',
                    leaseDurationMs: 30000,
                    leaseExpiresAt: '2026-04-18T00:00:00.000Z'
                  },
                  outbox: {},
                  ackLedger: {},
                  scope: {
                    readScope: [],
                    writeScope: [],
                    workspaceMode: 'shared_workspace',
                    writeScopeSummary: 'workspace'
                  },
                  taskMaterialization: {
                    requestId: 'req-hook-view',
                    taskId: 'task-hook-view',
                    flowId: 'flow-hook-view',
                    requestIdempotencyKey: 'req-hook-view',
                    taskIdempotencyKey: 'task-hook-view',
                    flowIdempotencyKey: 'flow-hook-view',
                    route: 'delegate.single',
                    authority: 'runtime_orchestrator',
                    backend: 'openclaw-native',
                    materializationIntent: 'spawn_single',
                    claimOwner: 'owner-hook-view',
                    claimToken: 'claim-hook-view',
                    leaseExpiresAt: '2026-04-18T00:00:00.000Z',
                    taskPacketRef: 'flow-hook-view:task-hook-view'
                  }
                };
                const task = surface.runTask({ sessionKey: 'session-hook-view', workflow });
                return {
                  statusView: surface.readStatusView(task),
                  detailsView: surface.readDetailsView(task),
                };
            })()"""
        )

        self.assertEqual(payload["statusView"]["taskId"], "task-hook-view")
        self.assertEqual(payload["statusView"]["flowId"], "flow-hook-view")
        self.assertEqual(payload["statusView"]["state"], "running")
        self.assertEqual(payload["statusView"]["workerPool"], "octoclaw-worker")
        self.assertEqual(payload["statusView"]["claimOwner"], "owner-hook-view")
        self.assertEqual(payload["statusView"]["workspaceMode"], "shared_workspace")
        self.assertEqual(payload["detailsView"]["substrateRevision"], 5)
        self.assertEqual(payload["detailsView"]["runtime"], "openclaw-native")
        self.assertIn("openclaw-native managed running", payload["detailsView"]["summary"])


if __name__ == "__main__":
    unittest.main()
