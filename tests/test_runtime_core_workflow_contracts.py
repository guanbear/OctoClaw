#!/usr/bin/env python3
import json
import os
import subprocess
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def run_module_expression(expression: str) -> dict:
    script = f"""
const workflow = await import('./packages/octoclaw-runtime-core/src/workflow/index.ts');
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


class RuntimeCoreWorkflowContractTests(unittest.TestCase):
    def test_runtime_workflow_contract_exposes_execution_authority_lifecycle_and_provenance(self) -> None:
        payload = run_module_expression(
            """(() => {
                const state = workflow.startRuntimeWorkflow({
                  requestId: 'req-exec-1',
                  taskId: 'task-exec-1',
                  flowId: 'flow-exec-1',
                  role: 'worker_research',
                  decisionRef: 'decision:req-exec-1',
                  claimOwner: 'runtime-core',
                  leaseDurationMs: 30000,
                  deadlineBudget: { queueMs: 1000, startMs: 2000, progressMs: 3000, runtimeMs: 4000, deliveryMs: 5000 },
                  scope: {
                    readScope: [{ resource: 'docs', access: 'read' }],
                    writeScope: [],
                    workspaceMode: 'read_only_workspace',
                    writeScopeSummary: 'none'
                  },
                  decision: {
                    route: 'delegate.single',
                    role: 'worker_research',
                    backend: 'openclaw-native',
                    workspaceMode: 'read_only_workspace',
                    modelProfile: 'worker_default',
                    admission: { admitted: true, reason: 'ok', queuePressureBand: 'low' },
                    decisionStack: ['route', 'role', 'backend', 'workspace_mode', 'model_profile'],
                  },
                });
                const running = workflow.advanceWorkflowToRunning(state, 'runtime-core');
                const checkpointed = workflow.markWorkflowCheckpointEmitted(running, '2026-04-17T00:00:00.000Z');
                const deliverable = workflow.markWorkflowDeliverableReady(checkpointed);
                return {
                  identity: state.identity,
                  execution: state.execution,
                  lifecycle: state.lifecycle,
                  checkpoints: deliverable.checkpoints,
                  taskMaterialization: state.taskMaterialization,
                  runningPhase: running.lifecycle.phase,
                };
            })()"""
        )

        self.assertEqual(payload["identity"]["route"], "delegate.single")
        self.assertEqual(payload["identity"]["authority"], "runtime_orchestrator")
        self.assertEqual(payload["identity"]["materializationIntent"], "spawn_single")
        self.assertEqual(payload["execution"]["source"], "runtime_orchestrator")
        self.assertEqual(payload["execution"]["decisionRef"], "decision:req-exec-1")
        self.assertEqual(payload["lifecycle"]["phase"], "materialization_pending")
        self.assertEqual(payload["taskMaterialization"]["backend"], "openclaw-native")
        self.assertEqual(payload["taskMaterialization"]["materializationIntent"], "spawn_single")
        self.assertEqual(payload["runningPhase"], "running")
        self.assertEqual(payload["checkpoints"]["checkpointState"], "emitted")
        self.assertTrue(payload["checkpoints"]["deliverableReady"])
