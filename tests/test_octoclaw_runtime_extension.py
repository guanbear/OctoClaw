#!/usr/bin/env python3
import json
import subprocess
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
EXTENSION_PATH = REPO_ROOT / "extensions" / "octoclaw-runtime" / "index.js"


def run_runtime_helper(expression: str) -> dict:
    script = f"""
import {{ __octoclawTest }} from {json.dumps(str(EXTENSION_PATH))};
const value = {expression};
console.log(JSON.stringify(value));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        check=True,
    )
    return json.loads(result.stdout)


class OctoClawRuntimeExtensionTests(unittest.TestCase):
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
                        "octoclaw_status"
                    ]
                }
            }, "octoclaw_route_hint")).sort()"""
        )

        self.assertIn("octoclaw_route_hint", payload)
        self.assertIn("octoclaw_dispatch", payload)
        self.assertIn("octoclaw_policy_decide", payload)
        self.assertIn("octoclaw_status", payload)

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


if __name__ == "__main__":
    unittest.main()
