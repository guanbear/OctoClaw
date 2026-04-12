#!/usr/bin/env python3
import argparse
import importlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Optional
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
EXTENSION_PATH = REPO_ROOT / "extensions" / "octoclaw-runtime" / "index.js"
LIB_DIR = REPO_ROOT / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

dispatch_task = importlib.import_module("dispatch_task")


def run_runtime_helper(expression: str, env: Optional[dict] = None) -> dict:
    script = f"""
import {{ __octoclawTest }} from {json.dumps(str(EXTENSION_PATH))};
const value = await ({expression});
console.log(JSON.stringify(value));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        env={**os.environ, **(env or {})},
        check=True,
    )
    return json.loads(result.stdout)


class HarnessSyntheticTests(unittest.TestCase):
    def test_latency_ack_synthetic_sends_channel_ack_for_slow_direct_lookup(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-latency-ack-") as tmpdir:
            workspace = Path(tmpdir)
            fake_root = workspace / "fake-octoclaw"
            lib_dir = fake_root / "lib"
            lib_dir.mkdir(parents=True, exist_ok=True)
            (lib_dir / "send_pre_dispatch_ack.py").write_text(
                """#!/usr/bin/env python3
import json
print(json.dumps({"ok": True, "sent": True, "delivered": True, "message_id": "ack-1"}))
""",
                encoding="utf-8",
            )
            payload = run_runtime_helper(
                """(async () => {
                    const ctx = {
                      sessionKey: "agent:main:slack:direct:u-latency",
                      sessionId: "sess-latency-1",
                      trigger: "message",
                      cwd: process.cwd()
                    };
                    const decision = {
                      route_decision: {
                        route: "direct",
                        task_class: "simple_lookup"
                      },
                      latency_ack: {
                        required: true,
                        text: "我先查一下，马上给你结论。",
                        channel_timeout_ms: 900
                      }
                    };
                    __octoclawTest.__setPolicyState(ctx, {
                      createdAt: Date.now(),
                      updatedAt: Date.now(),
                      prompt: "你再看下 OpenClaw 有啥更新，尤其是 Memory 方向",
                      decision
                    });
                    const result = await __octoclawTest.maybeSendLatencyAck(
                      decision,
                      { session_key: ctx.sessionKey, channel: "slack" },
                      ctx.sessionKey,
                      {},
                      ctx,
                      null,
                      "web_fetch"
                    );
                    const fs = await import('node:fs/promises');
                    const ledgerPath = __octoclawTest.resolvePolicyStateLedgerPath();
                    const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
                    const state = ledger.sessions?.[ctx.sessionKey] || {};
                    return { result, state };
                })()""",
                env={
                    "WORKSPACE": str(workspace),
                    "HOME": str(workspace),
                    "OCTOCLAW_ROOT": str(fake_root),
                },
            )

        self.assertTrue(payload["result"]["attempted"])
        self.assertTrue(payload["result"]["sent"])
        self.assertEqual(payload["result"]["reason"], "channel_message_sent")
        self.assertTrue(payload["state"]["latencyAckSent"])
        self.assertEqual(payload["state"]["latencyAckMode"], "channel_message")

    def test_ack_synthetic_progress_fallback_produces_user_visible_update(self) -> None:
        payload = run_runtime_helper(
            """(async () => {
                const decision = __octoclawTest.buildDecision("调研三个兼容方案并写一版简短建议");
                const updates = [];
                const result = await __octoclawTest.ensurePreDispatchAck(
                  decision,
                  {},
                  "",
                  {},
                  { trigger: "message" },
                  async (payload) => { updates.push(payload); },
                  null
                );
                return {
                  route: decision.route_decision.route,
                  ackRequired: decision.pre_dispatch_ack.required,
                  result,
                  updates
                };
            })()"""
        )

        self.assertEqual(payload["route"], "spawn_single")
        self.assertTrue(payload["ackRequired"])
        self.assertTrue(payload["result"]["sent"])
        self.assertTrue(payload["result"]["fallback_used"])
        self.assertEqual(payload["result"]["reason"], "progress_update_sent")
        self.assertEqual(len(payload["updates"]), 1)

    def test_delivery_compensation_synthetic_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-delivery-idempotent-") as tmpdir:
            workspace = Path(tmpdir)
            payload = run_runtime_helper(
                """(async () => {
                    const fs = await import('node:fs/promises');
                    const result = {
                      ok: true,
                      session_key: "agent:main:slack:direct:u-synth",
                      pending_count: 1,
                      items: [{
                        deliveryId: "delivery-synth-1",
                        status: "compensated",
                        taskId: "task-synth-1",
                        runnerJobId: "runner-synth-1",
                        summary: "任务完成",
                        messageId: "msg-synth-1"
                      }]
                    };
                    await __octoclawTest.recordDeliveryReconcileResults(result, null);
                    await __octoclawTest.recordDeliveryReconcileResults(result, null);
                    const relayPath = __octoclawTest.resolveDeliveryRelayPath();
                    const lines = (await fs.readFile(relayPath, 'utf8')).trim().split('\\n').filter(Boolean).map((line) => JSON.parse(line));
                    return {
                      relayPath,
                      eventNames: lines.map((line) => line.event),
                      compensatedCount: lines.filter((line) => line.event === "delivery_compensated" && line.deliveryId === "delivery-synth-1").length
                    };
                })()""",
                env={
                    "WORKSPACE": str(workspace),
                    "HOME": str(workspace),
                },
            )

        self.assertIn("delivery_compensated", payload["eventNames"])
        self.assertEqual(payload["compensatedCount"], 1)

    def test_runner_backpressure_synthetic_returns_structured_gate_failure(self) -> None:
        decision = {
            "request": {"session_key": "agent:main:slack:direct:u-synth-runner", "metadata": {}},
            "route_decision": {"route": "runner"},
        }
        args = argparse.Namespace(
            task="检查 gateway 状态",
            command="openclaw status",
            cwd="/tmp",
            summary="check gateway status",
            timeout_seconds=30,
            id="runner-synth-backpressure",
            model_band="fast",
            wait=False,
            wait_timeout_seconds=12,
            _policy_decision=decision,
            _runner_playbook=None,
        )

        with patch.object(dispatch_task, "load_octopus_config", return_value={
            "runtime_policy": {
                "runner_pool": {"enabled": True, "max_queue_size": 1, "busy_strategy": "queue_or_progress"},
                "features": {"runner_pool_enabled": True, "legacy_runner_fallback": True},
            }
        }), patch.object(dispatch_task, "load_runner_queue_counts", return_value={"queued": 1, "running": 0, "done": 0, "failed": 0, "total": 1}), patch.object(
            dispatch_task,
            "load_runner_health",
            return_value={"present": True, "healthy": True, "reason": "ok", "worker_id": "runner-a", "age_seconds": 1, "health": {"worker_id": "runner-a"}},
        ), patch.object(dispatch_task.subprocess, "run") as run_mock:
            payload = dispatch_task.dispatch_runner(args)

        run_mock.assert_not_called()
        self.assertFalse(payload["executed"])
        self.assertEqual(payload["capability_failure"]["reason"], "runner_queue_full")
        self.assertEqual(payload["materialization"]["status"], "materialization_failed")
        self.assertEqual(payload["runner_runtime_resolution"]["queue_pressure_band"], "high")


if __name__ == "__main__":
    unittest.main()
