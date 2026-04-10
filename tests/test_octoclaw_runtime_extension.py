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
            r"""__octoclawTest.extractPromptText({
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

    def test_extract_prompt_text_unwraps_im_relay_wrapper(self) -> None:
        payload = run_runtime_helper(
            r"""__octoclawTest.extractPromptText({
                prompt: `System: [2026-04-09 22:55:55 GMT+8] Slack DM from guanbear: 你是怎么查的

Conversation info (untrusted metadata):
\`\`\`json
{"message_id":"1775746554.447479"}
\`\`\`

Sender (untrusted metadata):
\`\`\`json
{"label":"guanbear"}
\`\`\`

你是怎么查的`
            })"""
        )

        self.assertEqual(payload, "你是怎么查的")

    def test_prefers_custom_im_session_key_over_generic_session_id(self) -> None:
        payload = run_runtime_helper(
            """__octoclawTest.resolvePolicyStateKeys({
                sessionId: "sess-generic-1",
                sessionKey: "agent:main:slack:channel:C123:thread:1712345.000100"
            })"""
        )

        self.assertEqual(payload[0], "agent:main:slack:channel:C123:thread:1712345.000100")
        self.assertEqual(payload[1], "sess-generic-1")

    def test_detect_session_boundary_prefers_canonical_user_session(self) -> None:
        payload = run_runtime_helper(
            """__octoclawTest.detectSessionBoundary({
                sessionKey: "slack:direct:U123",
                sessionId: "octoclaw-subagent-research-1",
                agentId: "octoclaw-subagent-research-1"
            })"""
        )

        self.assertEqual(payload["status"], "contaminated_subagent_identity")
        self.assertEqual(payload["canonicalSessionKey"], "slack:direct:U123")

    def test_policy_state_persists_to_workspace_ledger(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="octoclaw-policy-ledger-") as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "tmp").mkdir(parents=True)
            payload = run_runtime_helper(
                """(async () => {
                    const fs = await import("node:fs");
                    __octoclawTest.__resetPolicyState();
                    __octoclawTest.__setPolicyState(
                      { sessionKey: "slack:direct:U999", sessionId: "octoclaw-subagent-1" },
                      {
                        prompt: "帮我查下 openclaw 新版本",
                        decision: { route_decision: { route: "runner" } },
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                      }
                    );
                    const ledgerPath = __octoclawTest.resolvePolicyStateLedgerPath();
                    const raw = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
                    return {
                      exists: fs.existsSync(ledgerPath),
                      keys: Object.keys(raw.sessions || {})
                    };
                })()""",
                env={
                    "WORKSPACE": str(workspace),
                    "HOME": str(workspace),
                },
            )

            self.assertTrue(payload["exists"])
            self.assertIn("slack:direct:U999", payload["keys"])

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

    def test_ack_delivery_session_key_prefers_user_facing_thread_from_session_registry(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="octoclaw-ack-ledger-") as tmpdir:
            home = Path(tmpdir)
            root_sessions = home / ".openclaw" / "sessions.json"
            root_sessions.parent.mkdir(parents=True, exist_ok=True)
            root_sessions.write_text(
                json.dumps(
                    {
                        "octoclaw-subagent-research-1": {
                            "channelSessionKey": "agent:main:slack:channel:C123:thread:1712345.000100",
                            "updatedAt": "2026-04-09T20:58:00Z",
                        },
                        "agent:main:slack:channel:C123:thread:1712345.000100": {
                            "updatedAt": "2026-04-09T20:58:01Z",
                        },
                    }
                ),
                encoding="utf-8",
            )
            payload = run_runtime_helper(
                """__octoclawTest.resolveAckDeliverySessionKey(
                    {
                      session_thread_key: "slack:channel:C123:1712345.000100",
                      session_origin: "slack"
                    },
                    "octoclaw-subagent-research-1",
                    {},
                    {}
                )""",
                env={"HOME": str(home), "WORKSPACE": str(home)},
            )

        self.assertEqual(payload, "agent:main:slack:channel:C123:thread:1712345.000100")

    def test_ack_delivery_session_key_does_not_guess_without_binding_hints(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="octoclaw-ack-ledger-") as tmpdir:
            home = Path(tmpdir)
            root_sessions = home / ".openclaw" / "sessions.json"
            root_sessions.parent.mkdir(parents=True, exist_ok=True)
            root_sessions.write_text(
                json.dumps(
                    {
                        "agent:main:slack:channel:C123:thread:1712345.000100": {
                            "updatedAt": "2026-04-09T20:58:01Z",
                        },
                    }
                ),
                encoding="utf-8",
            )
            payload = run_runtime_helper(
                """__octoclawTest.resolveAckDeliverySessionKey(
                    {},
                    "",
                    {},
                    {}
                )""",
                env={"HOME": str(home), "WORKSPACE": str(home)},
            )

        self.assertEqual(payload, "")

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

    def test_conversation_grounding_recovers_direct_lookup_provenance_from_replay(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="octoclaw-grounding-direct-") as tmpdir:
            workspace = Path(tmpdir)
            replay_path = workspace / "tmp" / "octopus" / "runtime-policy-replay.jsonl"
            replay_path.parent.mkdir(parents=True, exist_ok=True)
            replay_path.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                                "event": "policy_resolved",
                                "at": "2026-04-09T12:54:00Z",
                                "sessionKey": "agent:main:slack:direct:u555",
                                "sessionId": "sess-u555",
                                "prompt": "你再看下 OpenClaw有啥更新 尤其是Memory方向",
                                "route": "direct",
                                "systemPreferredRoute": "direct",
                                "workerPool": "octoclaw-main",
                                "taskClass": "simple_lookup",
                                "protectedLane": "",
                                "routeHintRequired": False,
                                "routeHintSubmitted": False,
                                "stateGroundingRequired": False,
                                "latencyAckRequired": True,
                            }
                        ),
                        json.dumps(
                            {
                                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                                "event": "direct_tool_called",
                                "at": "2026-04-09T12:54:01Z",
                                "sessionKey": "agent:main:slack:direct:u555",
                                "sessionId": "sess-u555",
                                "route": "direct",
                                "taskClass": "simple_lookup",
                                "protectedLane": "",
                                "toolName": "web_fetch",
                                "latencyAckRequired": True,
                                "latencyAckSent": True,
                                "latencyAckReason": "channel_message_sent",
                            }
                        ),
                    ]
                ) + "\n",
                encoding="utf-8",
            )
            payload = run_runtime_helper(
                f"""__octoclawTest.buildConversationGrounding({{
                    prompt: "你是怎么查的",
                    replayLogPath: {json.dumps(str(replay_path))},
                    taskStatePath: {json.dumps(str(workspace / "tmp" / "octopus" / "task-state.json"))},
                    sessionKeys: ["agent:main:slack:direct:u555"]
                }})"""
            )

        self.assertTrue(payload["available"])
        self.assertEqual(payload["route"], "direct")
        self.assertEqual(payload["taskClass"], "simple_lookup")
        self.assertIn("Direct tools used: web_fetch", payload["context"])

    def test_conversation_grounding_recovers_direct_tools_from_agent_end_snapshot(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="octoclaw-grounding-agent-end-") as tmpdir:
            workspace = Path(tmpdir)
            replay_path = workspace / "tmp" / "octopus" / "runtime-policy-replay.jsonl"
            replay_path.parent.mkdir(parents=True, exist_ok=True)
            replay_path.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                                "event": "policy_resolved",
                                "at": "2026-04-09T12:54:00Z",
                                "turnId": "turn-direct-snapshot",
                                "sessionKey": "agent:main:slack:direct:u556",
                                "sessionId": "sess-u556",
                                "prompt": "查一下 OpenClaw 最新发版",
                                "route": "direct",
                                "systemPreferredRoute": "direct",
                                "workerPool": "octoclaw-main",
                                "taskClass": "simple_lookup",
                                "protectedLane": "",
                            }
                        ),
                        json.dumps(
                            {
                                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                                "event": "agent_end",
                                "at": "2026-04-09T12:54:30Z",
                                "turnId": "turn-direct-snapshot",
                                "sessionKey": "agent:main:slack:direct:u556",
                                "sessionId": "sess-u556",
                                "route": "direct",
                                "taskClass": "simple_lookup",
                                "directToolsSeen": ["web_fetch"],
                            }
                        ),
                    ]
                ) + "\n",
                encoding="utf-8",
            )
            payload = run_runtime_helper(
                f"""__octoclawTest.buildConversationGrounding({{
                    prompt: "怎么查的",
                    replayLogPath: {json.dumps(str(replay_path))},
                    taskStatePath: {json.dumps(str(workspace / "tmp" / "octopus" / "task-state.json"))},
                    sessionKeys: ["agent:main:slack:direct:u556"]
                }})"""
            )

        self.assertTrue(payload["available"])
        self.assertIn("Direct tools used: web_fetch", payload["context"])

    def test_conversation_grounding_surfaces_policy_judge_validation_cache_and_ack_facts(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="octoclaw-grounding-policy-facts-") as tmpdir:
            workspace = Path(tmpdir)
            replay_path = workspace / "tmp" / "octopus" / "runtime-policy-replay.jsonl"
            replay_path.parent.mkdir(parents=True, exist_ok=True)
            replay_path.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                                "event": "policy_resolved",
                                "at": "2026-04-10T08:00:00Z",
                                "sessionKey": "agent:main:slack:direct:u-policy-facts",
                                "sessionId": "sess-policy-facts",
                                "prompt": "你再看下 OpenClaw 有啥更新，尤其是 Memory 方向",
                                "route": "runner",
                                "systemPreferredRoute": "runner",
                                "workerPool": "octoclaw-runner",
                                "taskClass": "fast_tool_check",
                                "protectedLane": "",
                                "decisionCacheState": "miss",
                            }
                        ),
                        json.dumps(
                            {
                                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                                "event": "decision_cache_miss",
                                "at": "2026-04-10T08:00:00.100Z",
                                "sessionKey": "agent:main:slack:direct:u-policy-facts",
                                "sessionId": "sess-policy-facts",
                                "route": "runner",
                                "taskClass": "fast_tool_check",
                                "decisionCacheState": "miss",
                                "usedCachedPolicy": False,
                                "reason": "no_existing_state",
                            }
                        ),
                        json.dumps(
                            {
                                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                                "event": "policy_judged",
                                "at": "2026-04-10T08:00:00.200Z",
                                "sessionKey": "agent:main:slack:direct:u-policy-facts",
                                "sessionId": "sess-policy-facts",
                                "route": "runner",
                                "taskClass": "fast_tool_check",
                                "policyJudgeSelected": "main_grade_model",
                                "policyJudgeInvoked": True,
                                "policyJudgeApplied": True,
                                "policyJudgeInvocationState": "completed_fixture",
                                "policyJudgeRoute": "runner",
                                "policyJudgeConfidence": 0.88,
                                "policyJudgeValidationProblems": [],
                                "policyJudgePromptVersion": "v1",
                                "policyJudgeSchemaVersion": "octoclaw.policy_judge_result/v1",
                                "validationOutcome": "passed",
                            }
                        ),
                        json.dumps(
                            {
                                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                                "event": "route_validated",
                                "at": "2026-04-10T08:00:00.300Z",
                                "sessionKey": "agent:main:slack:direct:u-policy-facts",
                                "sessionId": "sess-policy-facts",
                                "route": "runner",
                                "systemPreferredRoute": "runner",
                                "workerPool": "octoclaw-runner",
                                "taskClass": "fast_tool_check",
                                "protectedLane": "",
                                "routerRequestKind": "fresh_external_lookup",
                                "routerScope": "remote_upstream",
                                "routerTarget": "upstream_service",
                                "routerEvidenceRequired": ["web_lookup"],
                                "routerDecisionSource": "policy_judge",
                                "routerDecisionValid": True,
                                "validationOutcome": "passed",
                                "reason": "",
                            }
                        ),
                        json.dumps(
                            {
                                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                                "event": "ack_sent",
                                "at": "2026-04-10T08:00:00.400Z",
                                "sessionKey": "agent:main:slack:direct:u-policy-facts",
                                "sessionId": "sess-policy-facts",
                                "route": "runner",
                                "taskClass": "fast_tool_check",
                                "ackKind": "pre_dispatch",
                                "ackMode": "channel_message",
                                "ackSent": True,
                                "reason": "channel_message_sent",
                                "ackMessage": "好的，我去查一下。",
                            }
                        ),
                        json.dumps(
                            {
                                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                                "event": "tool_used",
                                "at": "2026-04-10T08:00:01Z",
                                "sessionKey": "agent:main:slack:direct:u-policy-facts",
                                "sessionId": "sess-policy-facts",
                                "route": "runner",
                                "taskClass": "fast_tool_check",
                                "toolName": "web_fetch",
                            }
                        ),
                    ]
                ) + "\n",
                encoding="utf-8",
            )
            payload = run_runtime_helper(
                f"""__octoclawTest.buildConversationGrounding({{
                    prompt: "你是怎么查的",
                    replayLogPath: {json.dumps(str(replay_path))},
                    taskStatePath: {json.dumps(str(workspace / "tmp" / "octopus" / "task-state.json"))},
                    sessionKeys: ["agent:main:slack:direct:u-policy-facts"]
                }})"""
            )

        self.assertTrue(payload["available"])
        self.assertIn("Decision cache: miss", payload["context"])
        self.assertIn("Policy judge: main_grade_model · completed_fixture · 0.88 · applied", payload["context"])
        self.assertIn("Route validation: passed · policy_judge", payload["context"])
        self.assertIn("Ack: pre_dispatch · channel_message · sent", payload["context"])
        self.assertIn("Direct tools used: web_fetch", payload["context"])

    def test_conversation_grounding_recovers_runner_lookup_provenance_from_task_state(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="octoclaw-grounding-runner-") as tmpdir:
            workspace = Path(tmpdir)
            octopus_dir = workspace / "tmp" / "octopus"
            octopus_dir.mkdir(parents=True, exist_ok=True)
            replay_path = octopus_dir / "runtime-policy-replay.jsonl"
            task_state_path = octopus_dir / "task-state.json"
            replay_path.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                                "event": "policy_resolved",
                                "at": "2026-04-09T23:01:05Z",
                                "sessionKey": "agent:main:slack:direct:u-runner",
                                "sessionId": "sess-u-runner",
                                "prompt": "再查下openclaw 有没有新的发版",
                                "route": "runner",
                                "systemPreferredRoute": "runner",
                                "workerPool": "octoclaw-runner",
                                "taskClass": "fast_tool_check",
                                "protectedLane": "",
                                "routeHintRequired": False,
                                "routeHintSubmitted": False,
                                "stateGroundingRequired": False,
                                "latencyAckRequired": False,
                            }
                        ),
                        json.dumps(
                            {
                                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                                "event": "dispatch_called",
                                "at": "2026-04-09T23:01:06Z",
                                "sessionKey": "agent:main:slack:direct:u-runner",
                                "sessionId": "sess-u-runner",
                                "route": "runner",
                                "taskClass": "fast_tool_check",
                                "executed": True,
                                "runnerJobId": "runner-123",
                                "materialization": {
                                    "status": "materialized",
                                    "kind": "runner_playbook",
                                    "runner_job_id": "runner-123",
                                },
                            }
                        ),
                    ]
                ) + "\n",
                encoding="utf-8",
            )
            task_state_path.write_text(
                json.dumps(
                    {
                        "tasks": [
                            {
                                "id": "runner-123",
                                "status": "done",
                                "summary": "最新 release 仍是 v2026.4.9",
                                "executor": "runner",
                                "route": "runner",
                                "runtime": "runner",
                                "artifacts": {
                                    "runner_plan": {
                                        "kind": "upstream_release_lookup",
                                        "summary": "检查 openclaw 上游最新发版与最近更新",
                                        "probe_spec": {
                                            "kind": "upstream_release_lookup",
                                            "project": "openclaw",
                                            "focus": "latest_updates",
                                            "source": "github_api",
                                        },
                                    }
                                },
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            payload = run_runtime_helper(
                f"""__octoclawTest.buildConversationGrounding({{
                    prompt: "查了吗 怎么查的",
                    replayLogPath: {json.dumps(str(replay_path))},
                    taskStatePath: {json.dumps(str(task_state_path))},
                    sessionKeys: ["agent:main:slack:direct:u-runner"]
                }})"""
            )

        self.assertTrue(payload["available"])
        self.assertEqual(payload["route"], "runner")
        self.assertIn("Delegated workflow: upstream_release_lookup", payload["context"])
        self.assertIn("Delegated evidence source: github_api", payload["context"])
        self.assertIn("Delegated lookup project: openclaw", payload["context"])

    def test_conversation_grounding_includes_task_event_execution_facts(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="octoclaw-grounding-task-events-") as tmpdir:
            workspace = Path(tmpdir)
            octopus_dir = workspace / "tmp" / "octopus"
            octopus_dir.mkdir(parents=True, exist_ok=True)
            replay_path = octopus_dir / "runtime-policy-replay.jsonl"
            task_state_path = octopus_dir / "task-state.json"
            task_events_path = octopus_dir / "task-events.jsonl"
            replay_path.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                                "event": "policy_resolved",
                                "at": "2026-04-10T07:00:00Z",
                                "sessionKey": "agent:main:slack:direct:u-runner-events",
                                "sessionId": "sess-u-runner-events",
                                "prompt": "再查下openclaw 有没有新的发版",
                                "route": "runner",
                                "systemPreferredRoute": "runner",
                                "workerPool": "octoclaw-runner",
                                "taskClass": "fast_tool_check",
                            }
                        ),
                        json.dumps(
                            {
                                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                                "event": "dispatch_called",
                                "at": "2026-04-10T07:00:01Z",
                                "sessionKey": "agent:main:slack:direct:u-runner-events",
                                "sessionId": "sess-u-runner-events",
                                "route": "runner",
                                "taskClass": "fast_tool_check",
                                "executed": True,
                                "runner_execution_mode": "ondemand",
                                "runnerJobId": "runner-evt-1",
                                "materialization": {
                                    "status": "materialized",
                                    "kind": "runner_playbook",
                                    "runner_job_id": "runner-evt-1",
                                },
                                "routeOutcome": {
                                    "schema_version": "octoclaw.route_outcome/v1",
                                    "queue_pressure_band": "medium",
                                    "runner_health_snapshot": {
                                        "worker_id": "runner-a",
                                        "reason": "ok",
                                    },
                                },
                            }
                        ),
                    ]
                ) + "\n",
                encoding="utf-8",
            )
            task_state_path.write_text(
                json.dumps(
                    {
                        "tasks": [
                            {
                                "id": "runner-evt-1",
                                "status": "done",
                                "summary": "最新 release 仍是 v2026.4.9",
                                "executor": "runner",
                                "route": "runner",
                                "runtime": "runner",
                                "artifacts": {
                                    "goal_contract": {
                                        "schema_version": "octoclaw.runner_goal_contract/v1",
                                        "execution_contract": "inspect_report",
                                        "access_mode": "read_only",
                                        "native_task_binding": {
                                            "backend": "mirror",
                                        },
                                    }
                                },
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            task_events_path.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "schema_version": "octoclaw.task_event/v1",
                                "time": "2026-04-10T07:00:01Z",
                                "kind": "task_bound",
                                "task_id": "runner-evt-1",
                                "session_key": "agent:main:slack:direct:u-runner-events",
                                "goal_contract": {
                                    "execution_contract": "inspect_report",
                                    "access_mode": "read_only",
                                },
                                "taskflow_binding": {
                                    "backend": "mirror",
                                },
                                "message": "runner job bound to native taskflow",
                            }
                        ),
                        json.dumps(
                            {
                                "schema_version": "octoclaw.task_event/v1",
                                "time": "2026-04-10T07:00:02Z",
                                "kind": "runner_started",
                                "task_id": "runner-evt-1",
                                "session_key": "agent:main:slack:direct:u-runner-events",
                                "message": "runner started on worker-a",
                            }
                        ),
                        json.dumps(
                            {
                                "schema_version": "octoclaw.task_event/v1",
                                "time": "2026-04-10T07:00:05Z",
                                "kind": "delivery_sent",
                                "task_id": "runner-evt-1",
                                "session_key": "agent:main:slack:direct:u-runner-events",
                                "message": "已发送给用户",
                            }
                        ),
                    ]
                ) + "\n",
                encoding="utf-8",
            )
            payload = run_runtime_helper(
                f"""__octoclawTest.buildConversationGrounding({{
                    prompt: "刚才那个任务怎样了",
                    replayLogPath: {json.dumps(str(replay_path))},
                    taskStatePath: {json.dumps(str(task_state_path))},
                    sessionKeys: ["agent:main:slack:direct:u-runner-events"]
                }})"""
            )

        self.assertTrue(payload["available"])
        self.assertIn("Task bound: yes", payload["context"])
        self.assertIn("Runner started: yes", payload["context"])
        self.assertIn("Runner dispatch mode: ondemand", payload["context"])
        self.assertIn("Goal contract: inspect_report · read_only", payload["context"])
        self.assertIn("Native task binding: mirror", payload["context"])
        self.assertIn("Runner queue pressure: medium", payload["context"])
        self.assertIn("Runner health: runner-a · ok", payload["context"])
        self.assertIn("Delivery state: delivery_sent", payload["context"])

    def test_conversation_grounding_includes_job_disposition_and_final_delivery_facts(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="octoclaw-grounding-disposition-") as tmpdir:
            workspace = Path(tmpdir)
            octopus_dir = workspace / "tmp" / "octopus"
            octopus_dir.mkdir(parents=True, exist_ok=True)
            replay_path = octopus_dir / "runtime-policy-replay.jsonl"
            task_state_path = octopus_dir / "task-state.json"
            task_events_path = octopus_dir / "task-events.jsonl"
            relay_path = octopus_dir / "delivery-relay.jsonl"
            replay_path.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                                "event": "policy_resolved",
                                "at": "2026-04-10T09:00:00Z",
                                "sessionKey": "agent:main:slack:direct:u-disposition",
                                "sessionId": "sess-u-disposition",
                                "prompt": "调研 OpenClaw 最近 release 和 Memory 改动，给我 5 句话总结",
                                "route": "spawn_single",
                                "systemPreferredRoute": "spawn_single",
                                "workerPool": "octoclaw-research",
                                "taskClass": "focused_research",
                            }
                        ),
                        json.dumps(
                            {
                                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                                "event": "dispatch_called",
                                "at": "2026-04-10T09:00:01Z",
                                "sessionKey": "agent:main:slack:direct:u-disposition",
                                "sessionId": "sess-u-disposition",
                                "route": "spawn_single",
                                "taskClass": "focused_research",
                                "executed": True,
                                "taskId": "research-disposition-1",
                                "materialization": {
                                    "status": "materialized",
                                    "kind": "spawn_child_task",
                                    "task_id": "research-disposition-1",
                                },
                            }
                        ),
                    ]
                ) + "\n",
                encoding="utf-8",
            )
            task_state_path.write_text(
                json.dumps(
                    {
                        "tasks": [
                            {
                                "id": "research-disposition-1",
                                "status": "deferred",
                                "summary": "Manual retry requested by operator",
                                "executor": "spawn_single",
                                "route": "spawn_single",
                                "runtime": "openclaw_task",
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            task_events_path.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "schema_version": "octoclaw.task_event/v1",
                                "time": "2026-04-10T09:00:02Z",
                                "kind": "job_superseded",
                                "task_id": "research-disposition-1",
                                "session_key": "agent:main:slack:direct:u-disposition",
                                "message": "manual retry superseded previous run",
                            }
                        ),
                        json.dumps(
                            {
                                "schema_version": "octoclaw.task_event/v1",
                                "time": "2026-04-10T09:00:03Z",
                                "kind": "completion_relay_sent",
                                "task_id": "research-disposition-1",
                                "session_key": "agent:main:slack:direct:u-disposition",
                                "message": "结果已发送",
                            }
                        ),
                        json.dumps(
                            {
                                "schema_version": "octoclaw.task_event/v1",
                                "time": "2026-04-10T09:00:04Z",
                                "kind": "user_notified",
                                "task_id": "research-disposition-1",
                                "session_key": "agent:main:slack:direct:u-disposition",
                                "message": "notification delivered",
                            }
                        ),
                    ]
                ) + "\n",
                encoding="utf-8",
            )
            relay_path.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "schema_version": "octoclaw.delivery_relay.event/v1",
                                "event": "delivery_observed",
                                "at": "2026-04-10T09:00:05Z",
                                "deliveryId": "delivery-disposition-1",
                                "sessionKey": "agent:main:slack:direct:u-disposition",
                                "taskId": "research-disposition-1",
                                "state": "observed_assistant_final",
                            }
                        )
                    ]
                ) + "\n",
                encoding="utf-8",
            )
            payload = run_runtime_helper(
                f"""__octoclawTest.buildConversationGrounding({{
                    prompt: "刚才那个任务怎样了",
                    replayLogPath: {json.dumps(str(replay_path))},
                    taskStatePath: {json.dumps(str(task_state_path))},
                    sessionKeys: ["agent:main:slack:direct:u-disposition"]
                }})"""
            )

        self.assertTrue(payload["available"])
        self.assertIn("Job disposition: job_superseded · manual retry superseded previous run", payload["context"])
        self.assertIn("Delivery state: user_notified", payload["context"])
        self.assertIn("Final delivery: delivery_observed · observed_assistant_final", payload["context"])

    def test_conversation_grounding_recovers_task_progress_from_task_state(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="octoclaw-grounding-task-") as tmpdir:
            workspace = Path(tmpdir)
            octopus_dir = workspace / "tmp" / "octopus"
            octopus_dir.mkdir(parents=True, exist_ok=True)
            replay_path = octopus_dir / "runtime-policy-replay.jsonl"
            task_state_path = octopus_dir / "task-state.json"
            replay_path.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                                "event": "policy_resolved",
                                "at": "2026-04-09T12:54:00Z",
                                "sessionKey": "agent:main:slack:direct:u777",
                                "sessionId": "sess-u777",
                                "prompt": "调研一下 OpenClaw Memory 最新改动",
                                "route": "spawn_single",
                                "systemPreferredRoute": "spawn_single",
                                "workerPool": "octoclaw-research",
                                "taskClass": "focused_research",
                                "protectedLane": "",
                                "routeHintRequired": False,
                                "routeHintSubmitted": False,
                                "stateGroundingRequired": False,
                                "latencyAckRequired": False,
                            }
                        ),
                        json.dumps(
                            {
                                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                                "event": "dispatch_called",
                                "at": "2026-04-09T12:54:02Z",
                                "sessionKey": "agent:main:slack:direct:u777",
                                "sessionId": "sess-u777",
                                "route": "spawn_single",
                                "systemPreferredRoute": "spawn_single",
                                "workerPool": "octoclaw-research",
                                "taskClass": "focused_research",
                                "protectedLane": "",
                                "executed": True,
                                "usedCachedPolicy": False,
                                "stickyPersisted": False,
                                "materialization": {
                                    "status": "materialized",
                                    "kind": "spawn_child_task",
                                    "task_id": "research-123"
                                }
                            }
                        ),
                    ]
                ) + "\n",
                encoding="utf-8",
            )
            task_state_path.write_text(
                json.dumps(
                    {
                        "tasks": [
                            {
                                "id": "research-123",
                                "status": "completed",
                                "summary": "Memory update summary ready",
                                "executor": "spawn_single",
                                "route": "spawn_single",
                                "runtime": "openclaw_task"
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            payload = run_runtime_helper(
                f"""__octoclawTest.buildConversationGrounding({{
                    prompt: "不是 刚才single成功了吗",
                    replayLogPath: {json.dumps(str(replay_path))},
                    taskStatePath: {json.dumps(str(task_state_path))},
                    sessionKeys: ["agent:main:slack:direct:u777"]
                }})"""
            )

        self.assertTrue(payload["available"])
        self.assertEqual(payload["route"], "spawn_single")
        self.assertEqual(payload["facts"]["taskId"], "research-123")
        self.assertEqual(payload["facts"]["currentTaskStatus"], "completed")
        self.assertIn("Current task status: completed", payload["context"])

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
        self.assertIn("session_status", payload["tools"])
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
                const decision = __octoclawTest.buildDecision("看下 8080 端口开了没");
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
                const decision = __octoclawTest.buildDecision("看下 8080 端口开了没");
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

    def test_wrapped_workflow_meta_question_stays_in_direct_control_lane(self) -> None:
        payload = run_runtime_helper(
            r"""(() => {
                const prompt = __octoclawTest.extractPromptText({
                  prompt: `System: [2026-04-09 22:55:26 GMT+8] Slack DM from guanbear: 刚才那个任务判定是啥

Conversation info (untrusted metadata):
\`\`\`json
{"message_id":"1775746525.471159"}
\`\`\`

Sender (untrusted metadata):
\`\`\`json
{"label":"guanbear"}
\`\`\`

刚才那个任务判定是啥`
                });
                const decision = __octoclawTest.buildDecision(prompt);
                return {
                  extracted: prompt,
                  route: decision.route_decision.route,
                  taskClass: decision.route_decision.task_class,
                  protectedLane: decision.route_decision.protected_lane
                };
            })()"""
        )

        self.assertEqual(payload["extracted"], "刚才那个任务判定是啥")
        self.assertEqual(payload["route"], "direct")
        self.assertEqual(payload["taskClass"], "control_observer")
        self.assertEqual(payload["protectedLane"], "control_observer")

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
                const decision = __octoclawTest.buildDecision("你帮我查下 octoclaw项目 今天都有啥提交 改了啥");
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
        self.assertFalse(payload["recommendation"]["bypass_delegated_optimization"])
        self.assertTrue(payload["ack"]["required"])
        self.assertIn("我先查一下", payload["ack"]["text"])
        self.assertEqual(payload["helperText"], payload["ack"]["text"])
        self.assertTrue(payload["shouldSend"])

    def test_bounded_github_update_lookup_prefers_runner_pre_dispatch_ack(self) -> None:
        payload = run_runtime_helper(
            """(() => {
                const decision = __octoclawTest.buildDecision("查一下 OctoClaw 项目在 GitHub 上今天（2026-04-07）有更新吗");
                return {
                  route: decision.route_decision.route,
                  taskClass: decision.route_decision.task_class,
                  workContract: decision.route_decision.work_contract,
                  ack: decision.pre_dispatch_ack,
                  latencyAck: decision.latency_ack,
                  shouldSendLatencyAck: __octoclawTest.shouldSendLatencyAck(decision, {}, { trigger: "message" }, "web_fetch")
                };
            })()"""
        )

        self.assertEqual(payload["route"], "runner")
        self.assertEqual(payload["taskClass"], "fast_tool_check")
        self.assertEqual(payload["workContract"], "inspect_report")
        self.assertTrue(payload["ack"]["required"])
        self.assertIn("最新更新", payload["ack"]["text"])
        self.assertFalse(payload["latencyAck"]["required"])
        self.assertFalse(payload["shouldSendLatencyAck"])

    def test_bounded_openclaw_update_lookup_uses_runner_pre_dispatch_ack(self) -> None:
        payload = run_runtime_helper(
            """(() => {
                const decision = __octoclawTest.buildDecision("你再看下 OpenClaw有啥更新 尤其是Memory方向");
                return {
                  route: decision.route_decision.route,
                  taskClass: decision.route_decision.task_class,
                  workContract: decision.route_decision.work_contract,
                  ack: decision.pre_dispatch_ack,
                  shouldSend: __octoclawTest.shouldSendPreDispatchAck(decision, {}, { trigger: "message" })
                };
            })()"""
        )

        self.assertEqual(payload["route"], "runner")
        self.assertEqual(payload["taskClass"], "fast_tool_check")
        self.assertEqual(payload["workContract"], "inspect_report")
        self.assertTrue(payload["ack"]["required"])
        self.assertTrue(payload["shouldSend"])

    def test_wrapped_bounded_openclaw_update_lookup_keeps_runner_pre_dispatch_ack(self) -> None:
        payload = run_runtime_helper(
            r"""(() => {
                const prompt = __octoclawTest.extractPromptText({
                  prompt: `System: [2026-04-09 22:54:32 GMT+8] Slack DM from guanbear: 你再看下 OpenClaw 有啥更新，尤其是 Memory 方向

Conversation info (untrusted metadata):
\`\`\`json
{"message_id":"1775746472.073449"}
\`\`\`

Sender (untrusted metadata):
\`\`\`json
{"label":"guanbear"}
\`\`\`

你再看下 OpenClaw 有啥更新，尤其是 Memory 方向`
                });
                const decision = __octoclawTest.buildDecision(prompt);
                return {
                  extracted: prompt,
                  route: decision.route_decision.route,
                  taskClass: decision.route_decision.task_class,
                  ack: decision.pre_dispatch_ack
                };
            })()"""
        )

        self.assertEqual(payload["extracted"], "你再看下 OpenClaw 有啥更新，尤其是 Memory 方向")
        self.assertEqual(payload["route"], "runner")
        self.assertEqual(payload["taskClass"], "fast_tool_check")
        self.assertTrue(payload["ack"]["required"])

    def test_wrapped_controlui_prompt_does_not_accidentally_delegate(self) -> None:
        payload = run_runtime_helper(
            r"""(async () => {
                const prompt = __octoclawTest.extractPromptText({
                  prompt: `System: [2026-04-09 22:57:03 GMT+8] Slack DM from guanbear: 你的controlui的访问地址是啥

Conversation info (untrusted metadata):
\`\`\`json
{"message_id":"1775746622.693989"}
\`\`\`

Sender (untrusted metadata):
\`\`\`json
{"label":"guanbear"}
\`\`\`

你的controlui的访问地址是啥`
                });
                const resolved = await __octoclawTest.resolvePolicyDecisionForContext(
                  prompt,
                  {
                    sessionKey: "agent:main:slack:direct:u-control",
                    sessionId: "sess-control",
                    trigger: "message",
                    agentId: "agent:main:main"
                  },
                  process.cwd(),
                  null
                );
                const decision = resolved?.decision || {};
                return {
                  extracted: prompt,
                  route: decision.route_decision.route,
                  taskClass: decision.route_decision.task_class,
                  allowDirectTools: decision.tool_policy.allow_direct_tools,
                  mustDelegateVia: decision.tool_policy.must_delegate_via
                };
            })()"""
        )

        self.assertEqual(payload["extracted"], "你的controlui的访问地址是啥")
        self.assertEqual(payload["route"], "runner")
        self.assertEqual(payload["taskClass"], "fast_local_check")
        self.assertFalse(payload["allowDirectTools"])
        self.assertEqual(payload["mustDelegateVia"], "octoclaw_dispatch")

    def test_short_single_followup_uses_recent_execution_facts(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="octoclaw-followup-") as tmpdir:
            workspace = Path(tmpdir)
            replay_dir = workspace / "tmp" / "octopus"
            replay_dir.mkdir(parents=True)
            (replay_dir / "task-state.json").write_text(
                json.dumps(
                    {
                        "tasks": [
                            {
                                "id": "research-20260409121206076161",
                                "status": "completed",
                                "summary": "调研已完成",
                                "route": "spawn_single",
                                "worker_pool": "octoclaw-research",
                                "runtime": "openclaw_task",
                                "model": "zhipu/GLM-5.1",
                                "report_path": "/tmp/report.md",
                                "latest_event_kind": "done",
                                "latest_event_at": "2026-04-09T14:55:10Z",
                            }
                        ]
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            (replay_dir / "runtime-policy-replay.jsonl").write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                                "event": "policy_resolved",
                                "at": "2026-04-09T14:55:02.606Z",
                                "sessionKey": "agent:main:slack:direct:u-followup",
                                "sessionId": "sess-followup",
                                "trigger": "user",
                                "route": "spawn_single",
                                "taskClass": "focused_subtask",
                                "protectedLane": "",
                                "prompt": "调研 OpenClaw 最近 release 和 Memory 改动，给我 5 句话总结",
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                                "event": "dispatch_called",
                                "at": "2026-04-09T14:55:03.100Z",
                                "sessionKey": "agent:main:slack:direct:u-followup",
                                "sessionId": "sess-followup",
                                "route": "spawn_single",
                                "executed": True,
                                "taskId": "research-20260409121206076161",
                                "materialization": {
                                    "status": "materialized",
                                    "kind": "spawn_child_task",
                                    "task_id": "research-20260409121206076161",
                                },
                            },
                            ensure_ascii=False,
                        ),
                    ]
                ),
                encoding="utf-8",
            )

            payload = run_runtime_helper(
                """(async () => {
                    const hints = __octoclawTest.__conversationControlTest.buildConversationControlHints({
                      prompt: "single 成功了吗",
                      replayLogPath: __octoclawTest.resolveReplayLogPath(),
                      taskStatePath: __octoclawTest.resolveTaskStatePath(),
                      sessionKeys: ["agent:main:slack:direct:u-followup"]
                    });
                    const resolved = await __octoclawTest.resolvePolicyDecisionForContext(
                      "single 成功了吗",
                      {
                        sessionKey: "agent:main:slack:direct:u-followup",
                        sessionId: "sess-followup",
                        trigger: "message",
                        agentId: "agent:main:main"
                      },
                      process.cwd(),
                      null
                    );
                    return {
                      hints,
                      route: resolved?.decision?.route_decision?.route || "",
                      taskClass: resolved?.decision?.route_decision?.task_class || "",
                      protectedLane: resolved?.decision?.route_decision?.protected_lane || ""
                    };
                })()""",
                env={
                    "WORKSPACE": str(workspace),
                    "HOME": str(workspace),
                },
            )

            self.assertEqual(payload["hints"]["kind"], "execution_followup")
            self.assertEqual(payload["hints"]["intent_class"], "execution_followup")
            self.assertEqual(payload["hints"]["preferred_task_id"], "research-20260409121206076161")
            self.assertEqual(payload["route"], "direct")
            self.assertEqual(payload["taskClass"], "control_observer")
            self.assertEqual(payload["protectedLane"], "control_observer")

    def test_fresh_update_lookup_is_not_reclassified_as_task_followup(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="octoclaw-followup-boundary-") as tmpdir:
            workspace = Path(tmpdir)
            replay_path = workspace / "tmp" / "octopus" / "runtime-policy-replay.jsonl"
            replay_path.parent.mkdir(parents=True, exist_ok=True)
            replay_path.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                                "event": "policy_resolved",
                                "at": "2026-04-09T14:55:02.606Z",
                                "sessionKey": "agent:main:slack:direct:u-fresh",
                                "sessionId": "sess-fresh",
                                "trigger": "user",
                                "route": "spawn_single",
                                "taskClass": "focused_research",
                                "protectedLane": "",
                                "prompt": "调研 OpenClaw 最近 release 和 Memory 改动，给我 5 句话总结",
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                                "event": "dispatch_called",
                                "at": "2026-04-09T14:55:03.100Z",
                                "sessionKey": "agent:main:slack:direct:u-fresh",
                                "sessionId": "sess-fresh",
                                "route": "spawn_single",
                                "executed": True,
                                "taskId": "research-20260409121206076161",
                                "materialization": {
                                    "status": "materialized",
                                    "kind": "spawn_child_task",
                                    "task_id": "research-20260409121206076161",
                                },
                            },
                            ensure_ascii=False,
                        ),
                    ]
                ),
                encoding="utf-8",
            )

            payload = run_runtime_helper(
                """(async () => {
                    const intentPacket = __octoclawTest.__conversationControlTest.buildConversationIntentPacket({
                      prompt: "你再看下 OpenClaw 有啥更新，尤其是 Memory 方向",
                      replayLogPath: __octoclawTest.resolveReplayLogPath(),
                      taskStatePath: __octoclawTest.resolveTaskStatePath(),
                      sessionKeys: ["agent:main:slack:direct:u-fresh"]
                    });
                    const hints = __octoclawTest.__conversationControlTest.buildConversationControlHintsFromIntent(intentPacket);
                    const resolved = await __octoclawTest.resolvePolicyDecisionForContext(
                      "你再看下 OpenClaw 有啥更新，尤其是 Memory 方向",
                      {
                        sessionKey: "agent:main:slack:direct:u-fresh",
                        sessionId: "sess-fresh",
                        trigger: "message",
                        agentId: "agent:main:main"
                      },
                      process.cwd(),
                      null
                    );
                    return {
                      intentPacket,
                      hints,
                      route: resolved?.decision?.route_decision?.route || "",
                      taskClass: resolved?.decision?.route_decision?.task_class || "",
                      preDispatchAckRequired: Boolean(resolved?.decision?.pre_dispatch_ack?.required),
                      latencyAckRequired: Boolean(resolved?.decision?.latency_ack?.required),
                      routerRequestKind: resolved?.decision?.router_decision_v2?.request_kind || "",
                      routerEvidenceRequired: resolved?.decision?.router_decision_v2?.evidence_required || []
                    };
                })()""",
                env={
                    "WORKSPACE": str(workspace),
                    "HOME": str(workspace),
                },
            )

            self.assertFalse(payload["hints"]["available"])
            self.assertEqual(payload["intentPacket"]["intent_class"], "undetermined")
            self.assertEqual(payload["intentPacket"]["schema_version"], "octoclaw.intent_packet/v1")
            self.assertEqual(payload["intentPacket"]["signals"]["lookup_mentions"][0]["project"], "openclaw")
            self.assertTrue(payload["intentPacket"]["judge"]["eligible"])
            self.assertEqual(payload["route"], "runner")
            self.assertEqual(payload["taskClass"], "fast_tool_check")
            self.assertEqual(payload["routerRequestKind"], "fresh_external_lookup")
            self.assertIn("web_lookup", payload["routerEvidenceRequired"])
            self.assertTrue(payload["preDispatchAckRequired"])
            self.assertFalse(payload["latencyAckRequired"])

    def test_policy_decision_carries_signal_packet_and_stateless_judge_contract(self) -> None:
        payload = run_runtime_helper(
            """(() => {
                const decision = __octoclawTest.buildDecision("你再看下 OpenClaw 有啥更新，尤其是 Memory 方向");
                return {
                  intentClass: decision.intent_packet.intent_class,
                  packetSource: decision.intent_packet.source,
                  lookupProject: decision.intent_packet.signals.lookup_mentions[0]?.project || "",
                  route: decision.route_decision.route,
                  policyRouterMode: decision.policy_router.mode,
                  policyRouterSource: decision.policy_router.decision_source,
                  selectedJudge: decision.policy_router.judge.selected,
                  judgeInvoked: decision.policy_router.judge.invoked,
                  judgeTools: decision.policy_router.judge.tools,
                  routerSchema: decision.router_decision_v2.schema_version,
                  routerValid: decision.router_decision_v2.validation.passed,
                  turnId: decision.correlation.turn_id,
                  decisionId: decision.correlation.decision_id
                };
            })()"""
        )

        self.assertEqual(payload["intentClass"], "undetermined")
        self.assertEqual(payload["packetSource"], "deterministic_front_gate")
        self.assertEqual(payload["lookupProject"], "openclaw")
        self.assertEqual(payload["route"], "runner")
        self.assertEqual(payload["policyRouterMode"], "model_first")
        self.assertEqual(payload["policyRouterSource"], "legacy_planner_until_stateless_judge_live")
        self.assertEqual(payload["selectedJudge"], "main_grade_model")
        self.assertFalse(payload["judgeInvoked"])
        self.assertEqual(payload["judgeTools"], "none")
        self.assertEqual(payload["routerSchema"], "octoclaw.router_decision/v2")
        self.assertTrue(payload["routerValid"])
        self.assertTrue(payload["turnId"].startswith("turn-"))
        self.assertTrue(payload["decisionId"].startswith("decision-"))

    def test_ambiguous_prompt_is_policy_judge_eligible_without_keyword_route_claim(self) -> None:
        payload = run_runtime_helper(
            """(() => {
                const decision = __octoclawTest.buildDecision("这个是不是要换个更稳的做法");
                return {
                  intentClass: decision.intent_packet.intent_class,
                  judgeEligible: decision.policy_router.judge.eligible,
                  invocationState: decision.policy_router.judge.invocation_state,
                  route: decision.route_decision.route
                };
            })()"""
        )

        self.assertEqual(payload["intentClass"], "undetermined")
        self.assertTrue(payload["judgeEligible"])
        self.assertEqual(payload["invocationState"], "eligible_not_invoked_runtime_adapter_pending")
        self.assertIn(payload["route"], ["direct", "runner", "spawn_single", "spawn_multi"])

    def test_stateless_policy_judge_result_overrides_legacy_route_when_valid(self) -> None:
        fixture = {
            "route": "spawn_single",
            "request_kind": "work_request",
            "scope": "task_context",
            "target": "delegated_task",
            "evidence_required": ["taskflow_state", "execution_ledger"],
            "confidence": 0.93,
            "reason_codes": ["semantic_work_request"],
        }
        payload = run_runtime_helper(
            """(async () => {
                const ctx = {
                  sessionKey: "agent:main:slack:direct:u-judge",
                  sessionId: "sess-judge",
                  trigger: "message",
                  agentId: "agent:main:main"
                };
                __octoclawTest.__resetPolicyState?.();
                const resolved = await __octoclawTest.resolvePolicyDecisionForContext(
                  "这个是不是要换个更稳的做法",
                  ctx,
                  process.cwd(),
                  null
                );
                const decision = resolved?.decision || {};
                return {
                  route: decision.route_decision.route,
                  policyRouterSource: decision.policy_router.decision_source,
                  judgeInvoked: decision.policy_router.judge.invoked,
                  judgeApplied: decision.policy_router.judge.applied,
                  judgeInvocationState: decision.policy_router.judge.invocation_state,
                  routerRequestKind: decision.router_decision_v2.request_kind,
                  routerScope: decision.router_decision_v2.scope,
                  routerTarget: decision.router_decision_v2.target,
                  routerEvidenceRequired: decision.router_decision_v2.evidence_required,
                  routerValid: decision.router_decision_v2.validation.passed,
                  reasonCodes: decision.route_decision.reason_codes
                };
            })()""",
            env={"OCTOCLAW_POLICY_JUDGE_RESULT_JSON": json.dumps(fixture)},
        )

        self.assertEqual(payload["route"], "spawn_single")
        self.assertEqual(payload["policyRouterSource"], "policy_judge")
        self.assertTrue(payload["judgeInvoked"])
        self.assertTrue(payload["judgeApplied"])
        self.assertEqual(payload["judgeInvocationState"], "completed_fixture")
        self.assertEqual(payload["routerRequestKind"], "work_request")
        self.assertEqual(payload["routerScope"], "task_context")
        self.assertEqual(payload["routerTarget"], "delegated_task")
        self.assertEqual(payload["routerEvidenceRequired"], ["taskflow_state", "execution_ledger"])
        self.assertTrue(payload["routerValid"])
        self.assertIn("policy_judge_route_applied", payload["reasonCodes"])

    def test_stateless_policy_judge_low_confidence_falls_back_to_legacy_route(self) -> None:
        fixture = {
            "route": "direct",
            "request_kind": "chat_or_explain",
            "scope": "current_session",
            "target": "current_session",
            "evidence_required": ["none"],
            "confidence": 0.2,
            "reason_codes": ["weak_guess"],
        }
        payload = run_runtime_helper(
            """(async () => {
                const ctx = {
                  sessionKey: "agent:main:slack:direct:u-judge-low",
                  sessionId: "sess-judge-low",
                  trigger: "message",
                  agentId: "agent:main:main"
                };
                __octoclawTest.__resetPolicyState?.();
                const resolved = await __octoclawTest.resolvePolicyDecisionForContext(
                  "你现在啥版本",
                  ctx,
                  process.cwd(),
                  null
                );
                const decision = resolved?.decision || {};
                return {
                  route: decision.route_decision.route,
                  policyRouterSource: decision.policy_router.decision_source,
                  judgeInvoked: decision.policy_router.judge.invoked,
                  judgeApplied: decision.policy_router.judge.applied,
                  judgeValidationProblems: decision.policy_router.judge.validation?.problems || [],
                  routerRequestKind: decision.router_decision_v2.request_kind,
                  routerScope: decision.router_decision_v2.scope
                };
            })()""",
            env={"OCTOCLAW_POLICY_JUDGE_RESULT_JSON": json.dumps(fixture)},
        )

        self.assertEqual(payload["route"], "runner")
        self.assertEqual(payload["policyRouterSource"], "legacy_planner_until_stateless_judge_live")
        self.assertTrue(payload["judgeInvoked"])
        self.assertFalse(payload["judgeApplied"])
        self.assertIn("confidence_below_threshold", payload["judgeValidationProblems"])
        self.assertEqual(payload["routerRequestKind"], "surface_query")
        self.assertEqual(payload["routerScope"], "local_host")

    def test_resolve_policy_records_normalized_replay_events_and_cache_hit(self) -> None:
        import tempfile

        fixture = {
            "route": "spawn_single",
            "request_kind": "work_request",
            "scope": "task_context",
            "target": "delegated_task",
            "evidence_required": ["taskflow_state", "execution_ledger"],
            "confidence": 0.93,
            "reason_codes": ["semantic_work_request"],
        }
        with tempfile.TemporaryDirectory(prefix="octoclaw-replay-events-") as tmpdir:
            workspace = Path(tmpdir)
            payload = run_runtime_helper(
                """(async () => {
                    const fs = await import('node:fs/promises');
                    const ctx = {
                      sessionKey: "agent:main:slack:direct:u-replay-events",
                      sessionId: "sess-replay-events",
                      trigger: "message",
                      agentId: "agent:main:main"
                    };
                    __octoclawTest.__resetPolicyState?.();
                    await __octoclawTest.resolvePolicyDecisionForContext(
                      "这个是不是要换个更稳的做法",
                      ctx,
                      process.cwd(),
                      null
                    );
                    await __octoclawTest.resolvePolicyDecisionForContext(
                      "这个是不是要换个更稳的做法",
                      ctx,
                      process.cwd(),
                      null
                    );
                    const replayPath = __octoclawTest.resolveReplayLogPath();
                    const lines = (await fs.readFile(replayPath, 'utf8'))
                      .trim()
                      .split('\\n')
                      .filter(Boolean)
                      .map((line) => JSON.parse(line))
                      .filter((item) => item.sessionKey === "agent:main:slack:direct:u-replay-events");
                    return {
                      events: lines.map((item) => item.event),
                      firstResolved: lines.find((item) => item.event === "policy_resolved"),
                      resolvedEvents: lines.filter((item) => item.event === "policy_resolved"),
                      firstJudge: lines.find((item) => item.event === "policy_judged"),
                      firstValidated: lines.find((item) => item.event === "route_validated"),
                      firstMiss: lines.find((item) => item.event === "decision_cache_miss"),
                      firstHit: lines.find((item) => item.event === "decision_cache_hit"),
                    };
                })()""",
                env={
                    "WORKSPACE": str(workspace),
                    "HOME": str(workspace),
                    "OCTOCLAW_POLICY_JUDGE_RESULT_JSON": json.dumps(fixture),
                },
            )

        self.assertIn("policy_resolved", payload["events"])
        self.assertIn("policy_judged", payload["events"])
        self.assertIn("route_validated", payload["events"])
        self.assertIn("decision_cache_miss", payload["events"])
        self.assertIn("decision_cache_hit", payload["events"])
        self.assertGreaterEqual(len(payload["resolvedEvents"]), 2)
        self.assertEqual(payload["firstResolved"]["route"], "spawn_single")
        self.assertTrue(any(item["usedCachedPolicy"] is False for item in payload["resolvedEvents"]))
        self.assertTrue(any(item["usedCachedPolicy"] is True for item in payload["resolvedEvents"]))
        self.assertEqual(payload["firstResolved"]["rolloutFlags"]["contractVersion"], "octoclaw.runtime_flags/v1")
        self.assertTrue(payload["firstResolved"]["rolloutFlags"]["policyJudgeLiveEnabled"])
        self.assertEqual(payload["firstJudge"]["policyJudgeInvocationState"], "completed_fixture")
        self.assertEqual(payload["firstJudge"]["rolloutFlags"]["contractVersion"], "octoclaw.runtime_flags/v1")
        self.assertTrue(payload["firstValidated"]["routerDecisionValid"])
        self.assertIn("runnerPoolEnabled", payload["firstValidated"]["rolloutFlags"])
        self.assertEqual(payload["firstMiss"]["decisionCacheState"], "miss")
        self.assertEqual(payload["firstHit"]["decisionCacheState"], "hit")

    def test_current_version_prompt_prefers_local_surface_lookup(self) -> None:
        payload = run_runtime_helper(
            """(async () => {
                const resolved = await __octoclawTest.resolvePolicyDecisionForContext(
                  "你现在啥版本",
                  {
                    sessionKey: "agent:main:slack:direct:u-version",
                    sessionId: "sess-version",
                    trigger: "message",
                    agentId: "agent:main:main"
                  },
                  process.cwd(),
                  null
                );
                const decision = resolved?.decision || {};
                return {
                  route: decision.route_decision.route,
                  taskClass: decision.route_decision.task_class,
                  workContract: decision.route_decision.work_contract,
                  intentClass: decision.intent_packet?.intent_class || "",
                  surfaceMentions: decision.intent_packet?.signals?.surface_mentions || [],
                  conversationIntentClass: decision.request.metadata?.conversation_control?.intent_class || "",
                  conversationKind: decision.request.metadata?.conversation_control?.kind || "",
                  routerRequestKind: decision.router_decision_v2?.request_kind || "",
                  routerScope: decision.router_decision_v2?.scope || ""
                };
            })()"""
        )

        self.assertEqual(payload["route"], "runner")
        self.assertEqual(payload["taskClass"], "fast_local_check")
        self.assertEqual(payload["workContract"], "inspect_report")
        self.assertEqual(payload["intentClass"], "undetermined")
        self.assertIn("runtime_version", payload["surfaceMentions"])
        self.assertEqual(payload["conversationIntentClass"], "")
        self.assertEqual(payload["conversationKind"], "")
        self.assertEqual(payload["routerRequestKind"], "surface_query")

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

    def test_register_pending_delivery_writes_delivery_relay_event(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="octoclaw-delivery-pending-") as tmpdir:
            workspace = Path(tmpdir)
            payload = run_runtime_helper(
                """(async () => {
                    const fs = await import('node:fs/promises');
                    const ctx = {
                      sessionKey: "agent:main:slack:direct:u-delivery",
                      sessionId: "sess-delivery",
                      trigger: "message",
                      agentId: "agent:main:main"
                    };
                    __octoclawTest.__resetPolicyState?.();
                    const decision = __octoclawTest.buildDecision("调研三个兼容方案并写一版简短建议");
                    const now = Date.now();
                    __octoclawTest.__setPolicyState?.(ctx, {
                      prompt: "调研三个兼容方案并写一版简短建议",
                      decision,
                      createdAt: now,
                      updatedAt: now,
                      delegated: true
                    });
                    const result = await __octoclawTest.registerPendingDelivery({
                      decision,
                      payload: {
                        route: "spawn_single",
                        executed: true,
                        task_id: "task-123",
                        job: { id: "runner-123" },
                        materialization: { task_id: "task-123", status: "materialized" }
                      },
                      summary: "任务已创建，等待结果回传",
                      sessionKey: ctx.sessionKey,
                      stateKey: ctx.sessionKey,
                      logger: null
                    });
                    const relayPath = __octoclawTest.resolveDeliveryRelayPath();
                    const lines = (await fs.readFile(relayPath, 'utf8')).trim().split('\\n').filter(Boolean).map((line) => JSON.parse(line));
                    const state = __octoclawTest.resolveToolPolicyContext(ctx, "").state || {};
                    return {
                      result,
                      lastEvent: lines[lines.length - 1],
                      pendingDeliveryId: state.pendingDeliveryId || "",
                      pendingDeliveryTaskId: state.pendingDeliveryTaskId || ""
                    };
                })()""",
                env={
                    "WORKSPACE": str(workspace),
                    "HOME": str(workspace),
                },
            )

        self.assertTrue(payload["result"]["registered"])
        self.assertEqual(payload["lastEvent"]["event"], "delivery_pending")
        self.assertEqual(payload["lastEvent"]["state"], "pending_user_visible_final")
        self.assertEqual(payload["lastEvent"]["taskId"], "task-123")
        self.assertTrue(payload["pendingDeliveryId"].startswith("delivery-"))
        self.assertEqual(payload["pendingDeliveryTaskId"], "task-123")

    def test_register_pending_delivery_skips_materialization_failures(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="octoclaw-delivery-skip-") as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "tmp").mkdir(parents=True, exist_ok=True)
            payload = run_runtime_helper(
                """(async () => {
                    const fs = await import('node:fs/promises');
                    const ctx = {
                      sessionKey: "agent:main:slack:direct:u-delivery-skip",
                      sessionId: "sess-delivery-skip",
                      trigger: "message",
                      agentId: "agent:main:main"
                    };
                    __octoclawTest.__resetPolicyState?.();
                    const decision = __octoclawTest.buildDecision("查一下 runner 状态");
                    const result = await __octoclawTest.registerPendingDelivery({
                      decision,
                      payload: {
                        route: "runner",
                        executed: false,
                        materialization: {
                          task_id: "runner-blocked-1",
                          status: "materialization_failed",
                          capability_failure: { reason: "runner_queue_full" }
                        }
                      },
                      summary: "runner 没有真正派发成功",
                      sessionKey: ctx.sessionKey,
                      stateKey: ctx.sessionKey,
                      logger: null
                    });
                    const relayPath = __octoclawTest.resolveDeliveryRelayPath();
                    let lines = [];
                    try {
                      lines = (await fs.readFile(relayPath, 'utf8')).trim().split('\\n').filter(Boolean).map((line) => JSON.parse(line));
                    } catch {}
                    const state = __octoclawTest.resolveToolPolicyContext(ctx, "").state || {};
                    return { result, lineCount: lines.length, pendingDeliveryId: state.pendingDeliveryId || "" };
                })()""",
                env={
                    "WORKSPACE": str(workspace),
                    "HOME": str(workspace),
                },
            )

        self.assertFalse(payload["result"]["registered"])
        self.assertEqual(payload["result"]["reason"], "materialization_failed")
        self.assertEqual(payload["lineCount"], 0)
        self.assertEqual(payload["pendingDeliveryId"], "")

    def test_record_observed_delivery_writes_observed_event(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="octoclaw-delivery-observed-") as tmpdir:
            workspace = Path(tmpdir)
            payload = run_runtime_helper(
                """(async () => {
                    const fs = await import('node:fs/promises');
                    const ctx = {
                      sessionKey: "agent:main:slack:direct:u-delivery-2",
                      sessionId: "sess-delivery-2",
                      trigger: "message",
                      agentId: "agent:main:main"
                    };
                    __octoclawTest.__resetPolicyState?.();
                    const decision = __octoclawTest.buildDecision("调研三个兼容方案并写一版简短建议");
                    const now = Date.now();
                    __octoclawTest.__setPolicyState?.(ctx, {
                      prompt: "调研三个兼容方案并写一版简短建议",
                      decision,
                      createdAt: now,
                      updatedAt: now,
                      delegated: true
                    });
                    await __octoclawTest.registerPendingDelivery({
                      decision,
                      payload: {
                        route: "spawn_single",
                        executed: true,
                        task_id: "task-456",
                        job: { id: "runner-456" }
                      },
                      summary: "任务完成，结果如下",
                      sessionKey: ctx.sessionKey,
                      stateKey: ctx.sessionKey,
                      logger: null
                    });
                    const stateBefore = __octoclawTest.resolveToolPolicyContext(ctx, "").state || {};
                    const observed = await __octoclawTest.recordObservedDeliveryFromMessage(
                      { role: "assistant", content: "任务完成，结果如下：..." },
                      stateBefore,
                      ctx.sessionKey,
                      null
                    );
                    const stateAfter = __octoclawTest.resolveToolPolicyContext(ctx, "").state || {};
                    const relayPath = __octoclawTest.resolveDeliveryRelayPath();
                    const lines = (await fs.readFile(relayPath, 'utf8')).trim().split('\\n').filter(Boolean).map((line) => JSON.parse(line));
                    return {
                      observed,
                      stateAfter: {
                        deliveryObserved: Boolean(stateAfter.deliveryObserved),
                        pendingDeliveryId: stateAfter.pendingDeliveryId || ""
                      },
                      lastEvent: lines[lines.length - 1]
                    };
                })()""",
                env={
                    "WORKSPACE": str(workspace),
                    "HOME": str(workspace),
                },
            )

        self.assertTrue(payload["observed"]["recorded"])
        self.assertTrue(payload["stateAfter"]["deliveryObserved"])
        self.assertEqual(payload["lastEvent"]["event"], "delivery_observed")
        self.assertEqual(payload["lastEvent"]["state"], "observed_assistant_final")

    def test_resolve_policy_reconciles_pending_deliveries_via_relay_script(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="octoclaw-delivery-resolve-") as tmpdir:
            workspace = Path(tmpdir)
            payload = run_runtime_helper(
                """(async () => {
                    const fs = await import('node:fs/promises');
                    const ctx = {
                      sessionKey: "agent:main:slack:direct:u-relay",
                      sessionId: "sess-relay",
                      trigger: "message",
                      agentId: "agent:main:main"
                    };
                    __octoclawTest.__resetPolicyState?.();
                    const now = Date.now();
                    __octoclawTest.__setPolicyState?.(ctx, {
                      prompt: "调研三个兼容方案并写一版简短建议",
                      decision: __octoclawTest.buildDecision("调研三个兼容方案并写一版简短建议"),
                      createdAt: now,
                      updatedAt: now,
                      delegated: true,
                      pendingDeliveryId: "delivery-r1",
                      pendingDeliveryTaskId: "task-r1",
                      pendingDeliveryRunnerJobId: "runner-r1",
                      deliveryObserved: false
                    });
                    await __octoclawTest.resolvePolicyDecisionForContext(
                      "顺便再给我一句话总结",
                      ctx,
                      process.cwd(),
                      null
                    );
                    const relayPath = __octoclawTest.resolveDeliveryRelayPath();
                    const lines = (await fs.readFile(relayPath, 'utf8')).trim().split('\\n').filter(Boolean).map((line) => JSON.parse(line));
                    return {
                      lastEvent: lines[lines.length - 1],
                      eventNames: lines.map((item) => item.event)
                    };
                })()""",
                env={
                    "WORKSPACE": str(workspace),
                    "HOME": str(workspace),
                    "OCTOCLAW_DELIVERY_RELAY_RESULT_JSON": json.dumps({
                        "ok": True,
                        "session_key": "agent:main:slack:direct:u-relay",
                        "pending_count": 1,
                        "items": [
                            {
                                "deliveryId": "delivery-r1",
                                "status": "compensated",
                                "taskId": "task-r1",
                                "runnerJobId": "runner-r1",
                                "summary": "任务完成",
                                "messageId": "m-r1",
                            }
                        ],
                    }),
                },
            )

        self.assertIn("delivery_compensated", payload["eventNames"])
        self.assertEqual(payload["lastEvent"]["event"], "delivery_compensated")
        self.assertEqual(payload["lastEvent"]["deliveryId"], "delivery-r1")

    def test_resolve_policy_records_delivery_retry_deferred_event(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="octoclaw-delivery-deferred-") as tmpdir:
            workspace = Path(tmpdir)
            payload = run_runtime_helper(
                """(async () => {
                    const fs = await import('node:fs/promises');
                    const ctx = {
                      sessionKey: "agent:main:slack:direct:u-relay-deferred",
                      sessionId: "sess-relay-deferred",
                      trigger: "message",
                      agentId: "agent:main:main"
                    };
                    __octoclawTest.__resetPolicyState?.();
                    const now = Date.now();
                    __octoclawTest.__setPolicyState?.(ctx, {
                      prompt: "帮我查一下结果",
                      decision: __octoclawTest.buildDecision("帮我查一下结果"),
                      createdAt: now,
                      updatedAt: now,
                      delegated: true,
                      pendingDeliveryId: "delivery-r2",
                      pendingDeliveryTaskId: "task-r2",
                      pendingDeliveryRunnerJobId: "runner-r2",
                      deliveryObserved: false
                    });
                    await __octoclawTest.resolvePolicyDecisionForContext(
                      "再看一下",
                      ctx,
                      process.cwd(),
                      null
                    );
                    const relayPath = __octoclawTest.resolveDeliveryRelayPath();
                    const lines = (await fs.readFile(relayPath, 'utf8')).trim().split('\\n').filter(Boolean).map((line) => JSON.parse(line));
                    return {
                      lastEvent: lines[lines.length - 1],
                      eventNames: lines.map((item) => item.event)
                    };
                })()""",
                env={
                    "WORKSPACE": str(workspace),
                    "HOME": str(workspace),
                    "OCTOCLAW_DELIVERY_RELAY_RESULT_JSON": json.dumps({
                        "ok": True,
                        "session_key": "agent:main:slack:direct:u-relay-deferred",
                        "pending_count": 1,
                        "items": [
                            {
                                "deliveryId": "delivery-r2",
                                "status": "retry_deferred",
                                "taskId": "task-r2",
                                "runnerJobId": "runner-r2",
                                "failedAttempts": 1,
                                "retryAfter": "2026-04-10T08:00:00+08:00",
                            }
                        ],
                    }),
                },
            )

        self.assertIn("delivery_retry_deferred", payload["eventNames"])
        self.assertEqual(payload["lastEvent"]["event"], "delivery_retry_deferred")
        self.assertEqual(payload["lastEvent"]["deliveryId"], "delivery-r2")

    def test_guard_assistant_message_replaces_undelegated_runner_reply(self) -> None:
        payload = run_runtime_helper(
            """(() => __octoclawTest.guardAssistantMessageForPolicyState(
                { role: "assistant", content: "已派任务去查，有结果自动回来告诉你。" },
                {
                  decision: {
                    route_decision: { route: "runner", task_class: "fast_tool_check" },
                    request: { metadata: { conversation_control: { intent_class: "fresh_live_lookup" } } }
                  },
                  conversationIntentClass: "fresh_live_lookup",
                  delegated: false
                }
            ))()"""
        )

        self.assertEqual(payload["mode"], "replace")
        self.assertIn("还没真正派发到执行链", json.dumps(payload["message"], ensure_ascii=False))

    def test_guard_assistant_message_replaces_contaminated_control_observer_reply(self) -> None:
        payload = run_runtime_helper(
            """(() => __octoclawTest.guardAssistantMessageForPolicyState(
                { role: "assistant", content: "这次是 web_fetch 查的。" },
                {
                  decision: {
                    route_decision: { route: "direct", task_class: "control_observer" }
                  },
                  sessionBoundary: { status: "contaminated_subagent_identity" },
                  delegated: false
                }
            ))()"""
        )

        self.assertEqual(payload["mode"], "replace")
        self.assertIn("子任务污染", json.dumps(payload["message"], ensure_ascii=False))

    def test_guard_assistant_message_blocks_ungrounded_tool_provenance_claim(self) -> None:
        payload = run_runtime_helper(
            """(() => __octoclawTest.guardAssistantMessageForPolicyState(
                { role: "assistant", content: "查了。我实际用了 web_fetch 和 exec，结果是最新版本。" },
                {
                  decision: {
                    route_decision: { route: "direct", task_class: "direct_answer" },
                    router_decision_v2: { request_kind: "fresh_external_lookup" }
                  },
                  directToolsSeen: []
                }
            ))()"""
        )

        self.assertEqual(payload["mode"], "replace")
        self.assertEqual(payload["reason"], "ungrounded_tool_provenance_claim_blocked")
        self.assertIn("没有记录到可验证的 direct tool 调用", json.dumps(payload["message"], ensure_ascii=False))

    def test_guard_assistant_message_allows_recorded_tool_provenance_claim(self) -> None:
        payload = run_runtime_helper(
            """(() => __octoclawTest.guardAssistantMessageForPolicyState(
                { role: "assistant", content: "查了。我实际用了 web_fetch，结果是最新版本。" },
                {
                  decision: {
                    route_decision: { route: "direct", task_class: "direct_answer" },
                    router_decision_v2: { request_kind: "fresh_external_lookup" }
                  },
                  directToolsSeen: ["web_fetch"]
                }
            ))()"""
        )

        self.assertEqual(payload["mode"], "pass")

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
