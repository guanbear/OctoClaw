#!/usr/bin/env python3
import json
import os
import subprocess
import unittest
from pathlib import Path
from typing import Optional


REPO_ROOT = Path(__file__).resolve().parents[1]
JUDGE_PATH = REPO_ROOT / "extensions" / "octoclaw-runtime" / "policy" / "judge.js"
TEST_ENV = {"OCTOCLAW_POLICY_JUDGE_DISABLE_NETWORK": "1"}


def run_judge_expression(expression: str, env: Optional[dict] = None) -> dict:
    script = f"""
import * as judge from {json.dumps(str(JUDGE_PATH))};
const value = await ({expression});
console.log(JSON.stringify(value));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        env={**os.environ, **TEST_ENV, **(env or {})},
        check=True,
    )
    return json.loads(result.stdout)


class PolicyJudgeAdapterTests(unittest.TestCase):
    def test_command_adapter_returns_normalized_policy_judge_result(self) -> None:
        command = (
            "python3 -c \"import sys, json; "
            "req=json.load(sys.stdin); "
            "print(json.dumps({"
            "'route':'runner',"
            "'request_kind':'fresh_external_lookup',"
            "'scope':'upstream_project',"
            "'target':'openclaw',"
            "'evidence_required':['web_lookup','execution_ledger'],"
            "'confidence':0.91,"
            "'reason_codes':['semantic_lookup']"
            "}))\""
        )
        payload = run_judge_expression(
            """judge.invokePolicyJudge({
                task: "你再看下 OpenClaw 有啥更新，尤其是 Memory 方向",
                metadata: { session_key: "agent:main:slack:direct:u1" },
                intentPacket: { intent_class: "undetermined", judge: { eligible: true } },
                runtimeCfg: {
                  features: { policy_judge_live: true },
                  policy_router: {
                    mode: "model_first",
                    timeout_ms: 1200,
                    candidates: {
                      main_grade_model: {
                        enabled: true,
                        provider: "stateless_ephemeral_judge",
                        model: "inherit_main_grade",
                        command: process.env.OCTOCLAW_POLICY_JUDGE_COMMAND,
                        tools: "none"
                      }
                    }
                  }
                }
            })""",
            env={"OCTOCLAW_POLICY_JUDGE_COMMAND": command},
        )

        self.assertTrue(payload["invoked"])
        self.assertEqual(payload["invocation_state"], "completed")
        self.assertEqual(payload["route"], "runner")
        self.assertEqual(payload["request_kind"], "fresh_external_lookup")
        self.assertEqual(payload["scope"], "upstream_project")
        self.assertEqual(payload["target"], "openclaw")
        self.assertEqual(payload["evidence_required"], ["web_lookup", "execution_ledger"])

    def test_openai_compatible_adapter_reports_unavailable_without_credentials(self) -> None:
        payload = run_judge_expression(
            """judge.invokePolicyJudge({
                task: "这个是不是要换个更稳的做法",
                metadata: { session_key: "agent:main:slack:direct:u2" },
                intentPacket: { intent_class: "undetermined", judge: { eligible: true } },
                runtimeCfg: {
                  features: { policy_judge_live: true, cheap_judge_live: true },
                  policy_router: {
                    mode: "model_first",
                    timeout_ms: 1200,
                    default_judge: "cheap_model",
                    candidates: {
                      cheap_model: {
                        enabled: true,
                        provider: "openai_compatible",
                        model: "cheap-router",
                        base_url: "",
                        tools: "none"
                      }
                    }
                  }
                }
            })"""
        )

        self.assertFalse(payload["invoked"])
        self.assertEqual(payload["invocation_state"], "openai_compatible_adapter_unavailable")

    def test_stateless_ephemeral_judge_uses_codex_native_bridge_when_openai_compatible_credentials_are_missing(self) -> None:
        payload = run_judge_expression(
            """(async () => {
                const calls = [];
                globalThis.fetch = async (url, init = {}) => {
                  calls.push({
                    url,
                    method: init.method || "GET",
                    auth: String(init.headers?.authorization || ""),
                    body: JSON.parse(String(init.body || "{}"))
                  });
                  const stream = new ReadableStream({
                    start(controller) {
                      const send = (obj) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(obj)}\\n\\n`));
                      send({ type: "response.created" });
                      send({ type: "response.output_text.delta", delta: "{\\"route\\":\\"direct\\",\\"request_kind\\":\\"chat_or_explain\\",\\"scope\\":\\"current_session\\",\\"target\\":\\"answer_now\\",\\"evidence_required\\":[\\"none\\"],\\"confidence\\":0.88,\\"reason_codes\\":[\\"semantic_chat\\"]}" });
                      send({ type: "response.completed", response: { output: [{ content: [{ type: "output_text", text: "{\\"route\\":\\"direct\\",\\"request_kind\\":\\"chat_or_explain\\",\\"scope\\":\\"current_session\\",\\"target\\":\\"answer_now\\",\\"evidence_required\\":[\\"none\\"],\\"confidence\\":0.88,\\"reason_codes\\":[\\"semantic_chat\\"]}" }] }] } });
                      controller.close();
                    }
                  });
                  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
                };
                const result = await judge.invokePolicyJudge({
                  task: "这个是不是要换个更稳的做法",
                  metadata: { session_key: "agent:main:slack:direct:u-codex" },
                  intentPacket: { intent_class: "undetermined", judge: { eligible: true } },
                  runtimeCfg: {
                    features: { policy_judge_live: true },
                    policy_router: {
                      mode: "model_first",
                      timeout_ms: 1200,
                      candidates: {
                        main_grade_model: {
                          enabled: true,
                          provider: "stateless_ephemeral_judge",
                          model: "openai/gpt-5.4",
                          tools: "none"
                        }
                      }
                    }
                  }
                });
                return { result, calls };
            })()""",
            env={
                "OCTOCLAW_POLICY_JUDGE_DISABLE_NETWORK": "0",
                "HOME": str(Path.home()),
            },
        )

        self.assertEqual(len(payload["calls"]), 1)
        self.assertEqual(payload["calls"][0]["url"], "https://chatgpt.com/backend-api/codex/responses")
        self.assertTrue(payload["calls"][0]["auth"].startswith("Bearer "))
        self.assertTrue(payload["calls"][0]["body"]["stream"])
        self.assertEqual(payload["calls"][0]["body"]["model"], "gpt-5.4")
        self.assertEqual(payload["result"]["invocation_state"], "completed")
        self.assertEqual(payload["result"]["route"], "direct")
        self.assertEqual(payload["result"]["request_kind"], "chat_or_explain")

    def test_stateless_ephemeral_judge_accepts_omniroute_wrapped_main_grade_model(self) -> None:
        payload = run_judge_expression(
            """(async () => {
                const calls = [];
                globalThis.fetch = async (url, init = {}) => {
                  calls.push(JSON.parse(String(init.body || "{}")));
                  const stream = new ReadableStream({
                    start(controller) {
                      const send = (obj) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(obj)}\\n\\n`));
                      send({ type: "response.output_text.delta", delta: "{\\"route\\":\\"direct\\",\\"request_kind\\":\\"ambiguous\\",\\"scope\\":\\"insufficient_context\\",\\"target\\":\\"none\\",\\"evidence_required\\":\\"none\\",\\"confidence\\":0.4,\\"reason_codes\\":[\\"ambiguous_referent\\"]}" });
                      send({ type: "response.completed", response: { output: [{ content: [{ type: "output_text", text: "{\\"route\\":\\"direct\\",\\"request_kind\\":\\"ambiguous\\",\\"scope\\":\\"insufficient_context\\",\\"target\\":\\"none\\",\\"evidence_required\\":\\"none\\",\\"confidence\\":0.4,\\"reason_codes\\":[\\"ambiguous_referent\\"]}" }] }] } });
                      controller.close();
                    }
                  });
                  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
                };
                const result = await judge.invokePolicyJudge({
                  task: "这个是不是要换个更稳的做法",
                  metadata: { session_key: "agent:main:slack:direct:u-codex-omni" },
                  intentPacket: { intent_class: "undetermined", judge: { eligible: true } },
                  runtimeCfg: {
                    features: { policy_judge_live: true },
                    policy_router: {
                      mode: "model_first",
                      timeout_ms: 1200,
                      candidates: {
                        main_grade_model: {
                          enabled: true,
                          provider: "stateless_ephemeral_judge",
                          model: "omniroute/cx/gpt-5.4",
                          tools: "none"
                        }
                      }
                    }
                  }
                });
                return { result, calls };
            })()""",
            env={
                "OCTOCLAW_POLICY_JUDGE_DISABLE_NETWORK": "0",
                "HOME": str(Path.home()),
            },
        )

        self.assertEqual(payload["calls"][0]["model"], "gpt-5.4")
        self.assertEqual(payload["result"]["invocation_state"], "completed")
        self.assertEqual(payload["result"]["evidence_required"], ["none"])

    def test_safe_mode_forces_main_grade_judge_selection(self) -> None:
        payload = run_judge_expression(
            """judge.selectPolicyJudge({
                features: {
                  policy_judge_live: true,
                  cheap_judge_live: true,
                  local_judge_live: true
                },
                policy_router: {
                  default_judge: "cheap_model",
                  candidates: {
                    main_grade_model: {
                      enabled: true,
                      provider: "stateless_ephemeral_judge",
                      model: "main-grade"
                    },
                    cheap_model: {
                      enabled: true,
                      provider: "openai_compatible",
                      model: "cheap-router"
                    }
                  }
                }
            })""",
            env={"OCTOCLAW_RUNTIME_SAFE_MODE": "1"},
        )

        self.assertEqual(payload["name"], "main_grade_model")
        self.assertEqual(payload["model"], "main-grade")


if __name__ == "__main__":
    unittest.main()
