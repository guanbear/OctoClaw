#!/usr/bin/env node
/**
 * Full pipeline E2E test — directly calls resolveStatelessPolicyDecision
 * to test the complete judge → validator → route decision chain.
 * This bypasses the gateway websocket but exercises all the same runtime code.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

process.env.OCTOCLAW_JUDGE_FAST = JSON.stringify({
  modelId: "qwen3-judge:0.6b-q4km",
  baseUrl: "http://127.0.0.1:11434/v1",
  apiKey: "ollama",
  enabled: true,
  shadowMode: false,
  timeoutMs: 10000,
  timeoutLocalMs: 5000,
  minConfidence: 0.6,
  local: true,
  judgeAckEnabled: true,
  ackReactionEmoji: "ok_hand",
});

process.env.OCTOCLAW_JUDGE_REMOTE = JSON.stringify({
  enabled: true,
  modelId: "gpt-5.4-mini",
  baseUrl: "http://localhost:8317/v1",
  apiKey: "sk-local-cliproxyapi",
  timeoutMs: 8000,
  shadowMode: true,
});

const require = createRequire(import.meta.url);
const policyResolver = require("/Users/guanbear/.openclaw/extensions/octoclaw-runtime/dist/resolve/policy-resolver.js");
const resolveDecision = policyResolver.resolveStatelessPolicyDecision;

const TEST_CASES = [
  { input: "你好", desc: "寒暄", expectContains: "reply" },
  { input: "查一下OpenClaw最新版本", desc: "需搜索委派", expectContains: "delegate" },
  { input: "TypeScript里interface和type有什么区别", desc: "知识问答", expectContains: "reply" },
  { input: "帮我写个Python脚本转换CSV到JSON", desc: "代码编写委派", expectContains: "delegate" },
  { input: "查看nginx错误日志并总结原因", desc: "日志分析委派", expectContains: "delegate" },
  { input: "检查本机磁盘使用率", desc: "本地状态检查", expectContains: "delegate" },
];

async function main() {
  console.log("=== OctoClaw Full Pipeline E2E Test ===\n");
  console.log("Testing: judge → validator → policy resolver → route decision\n");

  let pass = 0;
  let fail = 0;
  let error = 0;

  for (const tc of TEST_CASES) {
    process.stdout.write(`  [${tc.desc.padEnd(10)}] "${tc.input}" => `);

    try {
      const result = await resolveDecision(tc.input, {
        metadata: {
          session_key: "test:e2e:direct",
          channel: "test",
          _judgeFastConfig: JSON.parse(process.env.OCTOCLAW_JUDGE_FAST),
          _remoteJudgeConfig: JSON.parse(process.env.OCTOCLAW_JUDGE_REMOTE),
        },
      });

      const route = result?.route_decision?.route || result?.request?.metadata?.route || "unknown";
      const judgeRoute = result?.route_decision?.judge_route || result?._judge_shadow_log?.final_judge_route;
      const judgeShadowLog = result?._judge_shadow_log;
      const validatorOverride = judgeShadowLog?.validator_override;
      const systemPreferred = result?.route_decision?.system_preferred_route;

      const targetRoute = systemPreferred || route;
      const matched = targetRoute.includes(tc.expectContains);
      if (matched) {
        pass += 1;
        const extra = validatorOverride ? ` [validator: ${judgeShadowLog.validator_override_reasons?.join(", ")}]` : "";
        const judgeInfo = judgeRoute ? ` judge=${judgeRoute}` : "";
        console.log(`${targetRoute.padEnd(10)}${judgeInfo}${extra} ✅`);
      } else {
        fail += 1;
        console.log(`${targetRoute.padEnd(10)} ❌ (expected ${tc.expectContains})`);
        console.log(`       route_decision.route=${route} system_preferred=${systemPreferred}`);
        console.log(`       judge_route=${judgeRoute} _judge_route=${result?._judge_route}`);
        if (judgeShadowLog) {
          console.log(`       judge_conf=${judgeShadowLog.judge_confidence} judge_override=${judgeShadowLog.judge_override}`);
          console.log(`       judge_mode=${judgeShadowLog.judge_mode} judge_abstain=${judgeShadowLog.judge_abstain}`);
        }
      }
    } catch (err) {
      error += 1;
      console.log(`ERROR: ${err.message?.slice(0, 100)}`);
    }
  }

  console.log(`\n=== Results ===`);
  console.log(`  PASS: ${pass}/${TEST_CASES.length}`);
  console.log(`  FAIL: ${fail}/${TEST_CASES.length}`);
  console.log(`  ERROR: ${error}/${TEST_CASES.length}`);
  console.log(`\nOverall: ${fail === 0 && error === 0 ? "ALL PASSED ✅" : "HAS FAILURES ❌"}`);
  process.exit(fail > 0 || error > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(2);
});
