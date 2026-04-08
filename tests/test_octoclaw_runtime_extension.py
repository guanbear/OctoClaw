#!/usr/bin/env python3
import json
import os
import subprocess
import unittest
from pathlib import Path
from typing import Optional


REPO_ROOT = Path(__file__).resolve().parents[1]
EXTENSION_PATH = REPO_ROOT / "extensions" / "octoclaw-runtime" / "index.js"
POLICY_CONFIG_PATH = REPO_ROOT / "extensions" / "octoclaw-runtime" / "policy" / "config.js"


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


def run_module_helper(module_path: Path, expression: str, env: Optional[dict] = None) -> dict:
    script = f"""
import * as mod from {json.dumps(str(module_path))};
const value = {expression};
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


class OctoClawRuntimeExtensionTests(unittest.TestCase):
    def test_runtime_paths_prefer_managed_openclaw_workspace_layout(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="octoclaw-runtime-home-") as tmpdir:
            home = Path(tmpdir)
            octoclaw_root = home / ".openclaw" / "workspace" / "openclaw" / "skills" / "octopus"
            workspace_root = home / ".openclaw" / "workspace"
            (octoclaw_root / "lib").mkdir(parents=True)
            (workspace_root / "tmp").mkdir(parents=True)
            payload = run_runtime_helper(
                """({
                    octoclawRoot: __octoclawTest.resolveOctoClawRoot(),
                    workspaceRoot: __octoclawTest.resolveWorkspaceRoot(),
                    pythonBin: __octoclawTest.resolvePythonBin()
                })""",
                env={
                    "HOME": str(home),
                    "OCTOCLAW_ROOT": "",
                    "WORKSPACE": "",
                    "OCTOCLAW_PYTHON_BIN": "",
                    "PATH": os.environ.get("PATH", ""),
                },
            )

            self.assertEqual(payload["octoclawRoot"], str(octoclaw_root))
            self.assertEqual(payload["workspaceRoot"], str(workspace_root))
            self.assertTrue(payload["pythonBin"].endswith("python3"))

    def test_policy_config_prefers_managed_openclaw_workspace_layout(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="octoclaw-policy-home-") as tmpdir:
            home = Path(tmpdir)
            workspace_root = home / ".openclaw" / "workspace"
            (workspace_root / "tmp").mkdir(parents=True)
            payload = run_module_helper(
                POLICY_CONFIG_PATH,
                "({ workspace: mod.resolveWorkspace(), configFile: mod.CONFIG_FILE, policyFile: mod.MODEL_POLICY_FILE })",
                env={
                    "HOME": str(home),
                    "WORKSPACE": "",
                    "OCTOCLAW_WORKSPACE": "",
                    "PATH": os.environ.get("PATH", ""),
                },
            )

            self.assertEqual(payload["workspace"], str(workspace_root))
            self.assertEqual(payload["configFile"], str(workspace_root / "tmp" / "octoclaw-config.json"))
            self.assertEqual(payload["policyFile"], str(workspace_root / "tmp" / "octopus" / "model-policy.json"))

    def test_extract_prompt_text_unwraps_busy_queue_wrapper(self) -> None:
        payload = run_runtime_helper(
            """__octoclawTest.extractPromptText({
                prompt: `[Queued messages while agent was busy]

---
Queued #1
System: [2026-04-01 00:16:27 GMT+8] Slack DM from U0AL9T5U89Z: 顺便看下 8083 端口有没有监听

Conversation info (untrusted metadata):
\`\`\`json
{"message_id":"m1"}
\`\`\``
            })"""
        )

        self.assertEqual(payload, "顺便看下 8083 端口有没有监听")

    def test_prefers_custom_im_session_key_over_generic_session_id(self) -> None:
        payload = run_runtime_helper(
            """__octoclawTest.resolvePolicyStateKeys({
                sessionId: "sess-generic-1",
                sessionKey: "agent:main:slack:channel:C123:thread:1712345.000100"
            })"""
        )

        self.assertEqual(payload[0], "agent:main:slack:channel:C123:thread:1712345.000100")
        self.assertEqual(payload[1], "sess-generic-1")

    def test_managed_context_accepts_prefixed_slack_main_session(self) -> None:
        payload = run_runtime_helper(
            """({
                managed: __octoclawTest.isManagedAgentContext({
                    sessionKey: "agent:main:slack:channel:C123:thread:1712345.000100",
                    agentId: "agent:main:main",
                    trigger: "message"
                }),
                metadata: __octoclawTest.buildPolicyMetadata({
                    sessionKey: "agent:main:slack:channel:C123:thread:1712345.000100",
                    sessionId: "sess-generic-1",
                    agentId: "agent:main:main",
                    channelId: "slack",
                    messageProvider: "slack",
                    trigger: "message"
                })
            })"""
        )

        self.assertTrue(payload["managed"])
        self.assertEqual(payload["metadata"]["session_key"], "agent:main:slack:channel:C123:thread:1712345.000100")
        self.assertEqual(payload["metadata"]["session_origin"], "slack")
        self.assertEqual(payload["metadata"]["session_target"], "channel:C123")
        self.assertEqual(payload["metadata"]["session_thread_id"], "1712345.000100")
        self.assertEqual(payload["metadata"]["session_thread_key"], "slack:channel:C123:1712345.000100")

    def test_managed_context_accepts_generic_webchat_session(self) -> None:
        payload = run_runtime_helper(
            """({
                managed: __octoclawTest.isManagedAgentContext({
                    sessionKey: "webchat:thread:alpha",
                    trigger: "message"
                }),
                metadata: __octoclawTest.buildPolicyMetadata({
                    sessionKey: "webchat:thread:alpha",
                    sessionId: "session-raw",
                    trigger: "message"
                })
            })"""
        )

        self.assertTrue(payload["managed"])
        self.assertEqual(payload["metadata"]["session_key"], "webchat:thread:alpha")
        self.assertEqual(payload["metadata"]["session_origin"], "webchat")
        self.assertEqual(payload["metadata"]["session_target"], "thread:alpha")
        self.assertEqual(payload["metadata"]["session_thread_key"], "webchat:thread:alpha:root")

    def test_non_im_custom_main_agent_stays_unmanaged(self) -> None:
        payload = run_runtime_helper(
            """__octoclawTest.isManagedAgentContext({
                sessionKey: "agent:main:custom-reviewer",
                agentId: "agent:main:custom-reviewer",
                trigger: "message"
            })"""
        )

        self.assertFalse(payload)

    def test_pre_hint_allows_octoclaw_control_tools_including_dispatch(self) -> None:
        payload = run_runtime_helper(
            """Array.from(__octoclawTest.preHintAllowedTools({
                tool_policy: {
                    must_delegate_via: "octoclaw_dispatch",
                    allowed_control_tools: [
                        "octoclaw_policy_decide",
                        "octoclaw_route_hint",
                        "octoclaw_dispatch",
                        "octoclaw_status",
                        "octoclaw_task_action"
                    ]
                }
            }, "octoclaw_route_hint")).sort()"""
        )

        self.assertIn("octoclaw_route_hint", payload)
        self.assertIn("octoclaw_dispatch", payload)
        self.assertIn("octoclaw_policy_decide", payload)
        self.assertIn("octoclaw_status", payload)
        self.assertIn("octoclaw_task_action", payload)

    def test_tool_context_can_recover_policy_state_by_prompt_when_ctx_has_no_session(self) -> None:
        payload = run_runtime_helper(
            """(() => {
                const ctx = {
                  sessionKey: "agent:main:slack:direct:u123",
                  sessionId: "sess-1",
                  agentId: "agent:main:main",
                  trigger: "message"
                };
                __octoclawTest.__resetPolicyState?.();
                const now = Date.now();
                const state = {
                  prompt: "检查 nginx error log 并总结问题",
                  decision: { request: { session_key: "agent:main:slack:direct:u123" } },
                  createdAt: now,
                  updatedAt: now
                };
                __octoclawTest.__setPolicyState?.(ctx, state);
                return __octoclawTest.resolveToolPolicyContext({}, "检查 nginx error log 并总结问题");
            })()"""
        )

        self.assertEqual(payload["key"], "agent:main:slack:direct:u123")
        self.assertEqual(payload["state"]["decision"]["request"]["session_key"], "agent:main:slack:direct:u123")

    def test_build_policy_metadata_can_use_recovered_state_key(self) -> None:
        payload = run_runtime_helper(
            """(() => {
                const ctx = {
                  sessionKey: "agent:main:slack:direct:u234",
                  sessionId: "sess-2",
                  trigger: "message"
                };
                __octoclawTest.__resetPolicyState?.();
                const now = Date.now();
                __octoclawTest.__setPolicyState?.(ctx, {
                  prompt: "检查 8080 端口",
                  decision: { request: { session_key: "agent:main:slack:direct:u234" } },
                  createdAt: now,
                  updatedAt: now
                });
                const recovered = __octoclawTest.resolveToolPolicyContext({}, "检查 8080 端口");
                return __octoclawTest.buildPolicyMetadata({}, { stateKey: recovered.key });
            })()"""
        )

        self.assertEqual(payload["session_key"], "agent:main:slack:direct:u234")
        self.assertEqual(payload["session_origin"], "slack")

    def test_tool_context_can_recover_recent_delegated_state_for_shell_like_followup(self) -> None:
        payload = run_runtime_helper(
            """(() => {
                const ctx = {
                  sessionKey: "agent:main:slack:direct:u345",
                  sessionId: "sess-3",
                  trigger: "message"
                };
                __octoclawTest.__resetPolicyState?.();
                const now = Date.now();
                __octoclawTest.__setPolicyState?.(ctx, {
                  prompt: "检查一下 nginx error log 最近 80 行，然后总结问题",
                  decision: { request: { session_key: "agent:main:slack:direct:u345" }, route_decision: { route: "spawn_single" } },
                  createdAt: now,
                  updatedAt: now
                });
                return __octoclawTest.resolveToolPolicyContext({}, "tail -80 /var/log/nginx/error.log");
            })()"""
        )

        self.assertEqual(payload["key"], "agent:main:slack:direct:u345")
        self.assertEqual(payload["state"]["decision"]["request"]["session_key"], "agent:main:slack:direct:u345")

    def test_tool_context_does_not_reuse_stale_session_state_for_different_prompt(self) -> None:
        payload = run_runtime_helper(
            """(() => {
                const ctx = {
                  sessionKey: "agent:main:slack:direct:u456",
                  sessionId: "sess-4",
                  trigger: "message"
                };
                __octoclawTest.__resetPolicyState?.();
                const now = Date.now();
                __octoclawTest.__setPolicyState?.(ctx, {
                  prompt: "帮我分析下 openclaw 2026.3.31 这个release",
                  decision: { request: { session_key: "agent:main:slack:direct:u456" }, route_decision: { route: "spawn_single" } },
                  createdAt: now,
                  updatedAt: now
                });
                return __octoclawTest.resolveToolPolicyContext(ctx, "我的cron都正常吗");
            })()"""
        )

        self.assertEqual(payload["key"], "")
        self.assertIsNone(payload["state"])

    def test_control_observer_tool_context_does_not_reuse_recent_delegated_state(self) -> None:
        payload = run_runtime_helper(
            """(() => {
                const ctx = {
                  sessionKey: "agent:main:slack:direct:u890",
                  sessionId: "sess-ctrl-1",
                  trigger: "message"
                };
                __octoclawTest.__resetPolicyState?.();
                const now = Date.now();
                __octoclawTest.__setPolicyState?.(ctx, {
                  prompt: "帮我分析下 openclaw 2026.3.31 这个release",
                  decision: {
                    request: { session_key: "agent:main:slack:direct:u890" },
                    route_decision: { route: "spawn_single" }
                  },
                  createdAt: now,
                  updatedAt: now,
                  delegated: true,
                  delegationTool: "octoclaw_dispatch"
                });
                return __octoclawTest.resolveToolPolicyContext(ctx, "八爪鱼状态");
            })()"""
        )

        self.assertEqual(payload["key"], "")
        self.assertIsNone(payload["state"])

    def test_control_observer_tool_set_excludes_exec_and_includes_status_actions(self) -> None:
        payload = run_runtime_helper(
            """(() => {
                const decision = __octoclawTest.buildDecision("八爪鱼状态");
                return {
                  controlOnly: __octoclawTest.isControlObserverDecision(decision),
                  tools: Array.from(__octoclawTest.observerControlTools(decision, "octoclaw_route_hint")).sort()
                };
            })()"""
        )

        self.assertTrue(payload["controlOnly"])
        self.assertIn("octoclaw_status", payload["tools"])
        self.assertIn("octoclaw_task_action", payload["tools"])
        self.assertNotIn("exec", payload["tools"])
        self.assertNotIn("octoclaw_dispatch", payload["tools"])

    def test_session_control_tool_context_does_not_reuse_recent_delegated_state(self) -> None:
        payload = run_runtime_helper(
            """(() => {
                const ctx = {
                  sessionKey: "agent:main:slack:direct:u999",
                  sessionId: "sess-session-ctrl-1",
                  trigger: "message"
                };
                __octoclawTest.__resetPolicyState?.();
                const now = Date.now();
                __octoclawTest.__setPolicyState?.(ctx, {
                  prompt: "帮我分析下 openclaw 2026.3.31 这个release",
                  decision: {
                    request: { session_key: "agent:main:slack:direct:u999" },
                    route_decision: { route: "spawn_single" }
                  },
                  createdAt: now,
                  updatedAt: now,
                  delegated: true,
                  delegationTool: "octoclaw_dispatch"
                });
                return __octoclawTest.resolveToolPolicyContext(ctx, "切换到 Mini Max M2.7");
            })()"""
        )

        self.assertEqual(payload["key"], "")
        self.assertIsNone(payload["state"])

    def test_session_control_tool_set_excludes_exec_and_includes_session_status(self) -> None:
        payload = run_runtime_helper(
            """(() => {
                const decision = __octoclawTest.buildDecision("切换到 Mini Max M2.7");
                return {
                  sessionControl: __octoclawTest.isSessionControlDecision(decision),
                  tools: Array.from(__octoclawTest.sessionControlTools(decision, "octoclaw_route_hint")).sort()
                };
            })()"""
        )

        self.assertTrue(payload["sessionControl"])
        self.assertIn("session_status", payload["tools"])
        self.assertIn("octoclaw_status", payload["tools"])
        self.assertNotIn("exec", payload["tools"])
        self.assertNotIn("octoclaw_dispatch", payload["tools"])

    def test_runner_workflow_tool_set_includes_dispatch_and_excludes_web_fetch(self) -> None:
        payload = run_runtime_helper(
            """(() => {
                const decision = __octoclawTest.buildDecision("帮我查下openclaw 又有新版本了吗 有啥新特性");
                return {
                  route: decision.route_decision.route,
                  workContract: decision.route_decision.work_contract,
                  tools: Array.from(__octoclawTest.runnerWorkflowTools(decision, "octoclaw_route_hint")).sort()
                };
            })()"""
        )

        self.assertEqual(payload["route"], "runner")
        self.assertEqual(payload["workContract"], "inspect_report")
        self.assertIn("octoclaw_dispatch", payload["tools"])
        self.assertNotIn("web_fetch", payload["tools"])

    def test_runner_workflow_enforcement_blocks_generic_external_tools(self) -> None:
        payload = run_runtime_helper(
            """(() => {
                const decision = __octoclawTest.buildDecision("帮我查下openclaw 又有新版本了吗 有啥新特性");
                return {
                  blocked: __octoclawTest.workflowEnforcementRule(decision, "web_fetch", "octoclaw_route_hint"),
                  allowed: __octoclawTest.workflowEnforcementRule(decision, "octoclaw_dispatch", "octoclaw_route_hint")
                };
            })()"""
        )

        self.assertTrue(payload["blocked"]["block"])
        self.assertEqual(payload["blocked"]["route"], "runner")
        self.assertIn("octoclaw_dispatch", payload["blocked"]["allowedTools"])
        self.assertFalse(payload["allowed"]["block"])

    def test_workflow_meta_question_stays_in_direct_control_lane(self) -> None:
        payload = run_runtime_helper(
            """(() => {
                const decision = __octoclawTest.buildDecision("你现在是啥模型");
                return {
                  route: decision.route_decision.route,
                  taskClass: decision.route_decision.task_class,
                  protectedLane: decision.route_decision.protected_lane,
                  workContract: decision.route_decision.work_contract,
                  reasonCodes: decision.route_decision.reason_codes,
                  recommendation: decision.route_recommendation,
                  ack: decision.pre_dispatch_ack,
                  shouldSend: __octoclawTest.shouldSendPreDispatchAck(decision, {}, { trigger: "message" }),
                  tools: Array.from(__octoclawTest.observerControlTools(decision, "octoclaw_route_hint")).sort()
                };
            })()"""
        )

        self.assertEqual(payload["route"], "direct")
        self.assertEqual(payload["taskClass"], "control_observer")
        self.assertEqual(payload["protectedLane"], "control_observer")
        self.assertEqual(payload["workContract"], "answer_now")
        self.assertIn("workflow_meta_control_contract", payload["reasonCodes"])
        self.assertFalse(payload["recommendation"]["arbitration"]["required"])
        self.assertTrue(payload["recommendation"]["bypass_delegated_optimization"])
        self.assertFalse(payload["ack"]["required"])
        self.assertFalse(payload["shouldSend"])
        self.assertNotIn("octoclaw_dispatch", payload["tools"])

    def test_session_control_question_stays_in_direct_protected_lane(self) -> None:
        payload = run_runtime_helper(
            """(() => {
                const decision = __octoclawTest.buildDecision("切换到 Mini Max M2.7");
                return {
                  route: decision.route_decision.route,
                  taskClass: decision.route_decision.task_class,
                  protectedLane: decision.route_decision.protected_lane,
                  workContract: decision.route_decision.work_contract,
                  reasonCodes: decision.route_decision.reason_codes,
                  recommendation: decision.route_recommendation,
                  ack: decision.pre_dispatch_ack,
                  shouldSend: __octoclawTest.shouldSendPreDispatchAck(decision, {}, { trigger: "message" }),
                  tools: Array.from(__octoclawTest.sessionControlTools(decision, "octoclaw_route_hint")).sort()
                };
            })()"""
        )

        self.assertEqual(payload["route"], "direct")
        self.assertEqual(payload["taskClass"], "session_control")
        self.assertEqual(payload["protectedLane"], "session_control")
        self.assertEqual(payload["workContract"], "answer_now")
        self.assertIn("session_control_direct_contract", payload["reasonCodes"])
        self.assertFalse(payload["recommendation"]["arbitration"]["required"])
        self.assertTrue(payload["recommendation"]["bypass_delegated_optimization"])
        self.assertFalse(payload["ack"]["required"])
        self.assertFalse(payload["shouldSend"])
        self.assertIn("session_status", payload["tools"])
        self.assertNotIn("octoclaw_dispatch", payload["tools"])

    def test_pre_dispatch_ack_policy_is_enabled_for_delegated_research(self) -> None:
        payload = run_runtime_helper(
            """(() => {
                const decision = __octoclawTest.buildDecision("查一下 OctoClaw 项目在 GitHub 上今天（2026-04-07）有更新吗");
                return {
                  route: decision.route_decision.route,
                  workerPool: decision.route_decision.worker_pool,
                  recommendation: decision.route_recommendation,
                  ack: decision.pre_dispatch_ack,
                  helperText: __octoclawTest.preDispatchAckText(decision),
                  shouldSend: __octoclawTest.shouldSendPreDispatchAck(decision, {}, { trigger: "message" })
                };
            })()"""
        )

        self.assertEqual(payload["route"], "spawn_single")
        self.assertEqual(payload["workerPool"], "octoclaw-research")
        self.assertTrue(payload["recommendation"]["arbitration"]["required"])
        self.assertEqual(payload["recommendation"]["arbitration"]["strategy"], "rule_fallback")
        self.assertTrue(payload["ack"]["required"])
        self.assertIn("查一下", payload["ack"]["text"])
        self.assertEqual(payload["helperText"], payload["ack"]["text"])
        self.assertTrue(payload["shouldSend"])

    def test_pre_dispatch_ack_helper_skips_direct_routes(self) -> None:
        payload = run_runtime_helper(
            """(() => {
                const decision = __octoclawTest.buildDecision("八爪鱼状态");
                return {
                  route: decision.route_decision.route,
                  ack: decision.pre_dispatch_ack,
                  shouldSend: __octoclawTest.shouldSendPreDispatchAck(decision, {}, { trigger: "message" })
                };
            })()"""
        )

        self.assertEqual(payload["route"], "direct")
        self.assertFalse(payload["ack"]["required"])
        self.assertFalse(payload["shouldSend"])

    def test_pre_dispatch_ack_falls_back_to_progress_update(self) -> None:
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
                return { result, updates };
            })()"""
        )

        self.assertTrue(payload["result"]["sent"])
        self.assertTrue(payload["result"]["fallback_used"])
        self.assertEqual(payload["result"]["channel_attempt"]["reason"], "missing_session_key")
        self.assertEqual(payload["result"]["reason"], "progress_update_sent")
        self.assertEqual(len(payload["updates"]), 1)

    def test_pre_dispatch_ack_dedupes_when_state_already_sent(self) -> None:
        payload = run_runtime_helper(
            """(() => {
                const decision = __octoclawTest.buildDecision("调研三个兼容方案并写一版简短建议");
                return {
                  shouldSend: __octoclawTest.shouldSendPreDispatchAck(
                    decision,
                    { preDispatchAckSent: true },
                    { trigger: "message" }
                  )
                };
            })()"""
        )

        self.assertFalse(payload["shouldSend"])

    def test_retain_policy_state_when_delegated_route_ended_without_dispatch(self) -> None:
        payload = run_runtime_helper(
            """__octoclawTest.shouldRetainPolicyStateOnAgentEnd({
                decision: { route_decision: { route: "spawn_single" } },
                delegated: false
            })"""
        )

        self.assertTrue(payload)

    def test_clear_policy_state_after_successful_delegation(self) -> None:
        payload = run_runtime_helper(
            """__octoclawTest.shouldRetainPolicyStateOnAgentEnd({
                decision: { route_decision: { route: "spawn_single" } },
                delegated: true
            })"""
        )

        self.assertFalse(payload)

    def test_new_prompt_resets_ephemeral_policy_state(self) -> None:
        payload = run_runtime_helper(
            """(async () => {
                const ctx = {
                  sessionKey: "agent:main:slack:direct:u567",
                  sessionId: "sess-5",
                  trigger: "message",
                  agentId: "agent:main:main"
                };
                __octoclawTest.__resetPolicyState?.();
                const now = Date.now();
                __octoclawTest.__setPolicyState?.(ctx, {
                  prompt: "检查一下 nginx error log 最近 80 行，然后总结问题",
                  decision: {
                    request: { session_key: "agent:main:slack:direct:u567" },
                    route_decision: { route: "spawn_single" }
                  },
                  createdAt: now,
                  updatedAt: now,
                  delegated: true,
                  delegationTool: "octoclaw_dispatch",
                  routeHintSubmitted: true,
                  routeHintPayload: { route_hint: "spawn_single" },
                  blockedTools: ["exec"]
                });
                const resolved = await __octoclawTest.resolvePolicyDecisionForContext(
                  "八爪鱼状态",
                  ctx,
                  process.cwd(),
                  null
                );
                return {
                  delegated: resolved?.state?.delegated,
                  delegationTool: resolved?.state?.delegationTool || "",
                  routeHintSubmitted: resolved?.state?.routeHintSubmitted,
                  blockedTools: resolved?.state?.blockedTools || [],
                  taskClass: resolved?.decision?.route_decision?.task_class || "",
                  route: resolved?.decision?.route_decision?.route || ""
                };
            })()"""
        )

        self.assertFalse(payload["delegated"])
        self.assertEqual(payload["delegationTool"], "")
        self.assertFalse(payload["routeHintSubmitted"])
        self.assertEqual(payload["blockedTools"], [])
        self.assertEqual(payload["taskClass"], "control_observer")
        self.assertEqual(payload["route"], "direct")


if __name__ == "__main__":
    unittest.main()
