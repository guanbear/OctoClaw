#!/usr/bin/env node
/**
 * E2E judge routing test — sends prompts through the local judge and checks route decisions.
 * Tests the new canonical policy spec + prompt builder + validator default rules.
 *
 * Usage: node tools/e2e-judge-test.mjs
 */
import { buildLocalJudgeSystemPrompt, buildLocalJudgeUserPrompt } from "../packages/octoclaw-policy/dist/spec/prompt-builder.js";

const JUDGE_URL = "http://127.0.0.1:11434/api/chat";
const JUDGE_MODEL = "qwen3-judge:0.6b-q4km";
const TIMEOUT_MS = 10000;

async function callJudge(userMessage) {
  const systemPrompt = buildLocalJudgeSystemPrompt();
  const userPrompt = buildLocalJudgeUserPrompt(userMessage);

  const body = JSON.stringify({
    model: JUDGE_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    stream: false,
    think: false,
    format: "json",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(JUDGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown");
      return { error: `HTTP ${response.status}: ${text}` };
    }

    const json = await response.json();
    const content = json?.message?.content || "";
    if (!content.trim()) return { error: "empty response" };

    const parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] || content);
    return { result: parsed };
  } catch (err) {
    return { error: err.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function applyValidatorRules(judgeResult) {
  const route = judgeResult.route;
  const toolNeedHint = judgeResult.tool_need_hint;
  const durationHint = judgeResult.duration_hint;
  const scope = judgeResult.scope;
  const overrides = [];

  let finalRoute = route;

  if (toolNeedHint === "required" && route === "reply") {
    if (scope === "unknown") {
      finalRoute = "delegate";
      overrides.push("validator:tool_need_required+scope_unknown→delegate(clarify)");
    } else {
      finalRoute = "delegate";
      overrides.push("validator:tool_need_required→delegate");
    }
  } else if (durationHint === "long" && route === "reply") {
    finalRoute = "delegate";
    overrides.push("validator:duration_long→delegate");
  }

  return { finalRoute, overrides };
}

const TEST_CASES = [
  // ── Should DELEGATE (spec §8 iron laws + §9 anti-reply-bias) ──
  { id: 1, input: "查一下OpenClaw最新版本", expectedRoute: "delegate", category: "delegate" },
  { id: 2, input: "查看本机Redis端口状态", expectedRoute: "delegate", category: "delegate" },
  { id: 3, input: "帮我写个Python脚本转换CSV到JSON", expectedRoute: "delegate", category: "delegate" },
  { id: 4, input: "查看nginx错误日志并总结原因", expectedRoute: "delegate", category: "delegate" },
  { id: 5, input: "检查本机磁盘使用率和内存状态", expectedRoute: "delegate", category: "delegate" },
  { id: 6, input: "搜索一下React 19有哪些新特性", expectedRoute: "delegate", category: "delegate" },
  { id: 7, input: "帮我重构auth模块的代码", expectedRoute: "delegate", category: "delegate" },
  { id: 8, input: "对比一下v2和v3的API差异", expectedRoute: "delegate", category: "delegate" },
  { id: 9, input: "跑一下测试看看哪些失败了然后修一下", expectedRoute: "delegate", category: "delegate" },
  { id: 10, input: "查看OctoClaw的运行状态", expectedRoute: "delegate", category: "delegate" },

  // ── Should REPLY (genuine Q&A, no tooling needed) ──
  { id: 11, input: "你好，今天天气怎么样", expectedRoute: "reply", category: "reply" },
  { id: 12, input: "TypeScript里interface和type有什么区别", expectedRoute: "reply", category: "reply" },
  { id: 13, input: "解释一下什么是event loop", expectedRoute: "reply", category: "reply" },
  { id: 14, input: "谢谢，辛苦了", expectedRoute: "reply", category: "reply" },

  // ── Should REPLY (local quick commands — main agent has shell, can finish in seconds) ──
  { id: 15, input: "本机的Python版本是多少", expectedRoute: "reply", category: "reply" },
  { id: 16, input: "帮我看看服务健康状态", expectedRoute: "reply", category: "reply" },
  // ── Should DELEGATE (needs remote search, main agent can't do directly) ──
  { id: 17, input: "查一下当前部署的版本号", expectedRoute: "delegate", category: "delegate" },
];

async function runTests() {
  console.log("=== OctoClaw Judge E2E Routing Test ===\n");
  console.log(`Model: ${JUDGE_MODEL}`);
  console.log(`Test cases: ${TEST_CASES.length}\n`);

  let pass = 0;
  let fail = 0;
  let error = 0;
  const results = [];

  for (const tc of TEST_CASES) {
    process.stdout.write(`  #${String(tc.id).padStart(2)} [${tc.expectedRoute.padEnd(8)}] "${tc.input}" => `);

    const response = await callJudge(tc.input);

    if (response.error) {
      error += 1;
      console.log(`ERROR: ${response.error}`);
      results.push({ ...tc, status: "error", error: response.error });
      continue;
    }

    const judgeResult = response.result;
    const rawRoute = judgeResult.route;

    // Normalize route aliases
    const normalizedRoute = ["spawn_work", "spawn_single", "spawn_multi", "delegate.single", "observe"].includes(rawRoute)
      ? "delegate"
      : rawRoute;

    // Apply validator rules
    const { finalRoute, overrides } = applyValidatorRules(judgeResult);

    const effectiveRoute = finalRoute || normalizedRoute;
    const matched = effectiveRoute === tc.expectedRoute;

    if (matched) {
      pass += 1;
      console.log(`${effectiveRoute.padEnd(8)} conf=${(judgeResult.confidence ?? 0).toFixed(2)} ✅${overrides.length > 0 ? ` [${overrides.join(", ")}]` : ""}`);
    } else {
      fail += 1;
      console.log(`${effectiveRoute.padEnd(8)} conf=${(judgeResult.confidence ?? 0).toFixed(2)} ❌ (expected ${tc.expectedRoute})`);
    }

    results.push({
      ...tc,
      status: matched ? "pass" : "fail",
      rawRoute,
      effectiveRoute,
      confidence: judgeResult.confidence,
      toolNeedHint: judgeResult.tool_need_hint,
      durationHint: judgeResult.duration_hint,
      scope: judgeResult.scope,
      replyMode: judgeResult.reply_mode,
      validatorOverrides: overrides,
    });
  }

  console.log("\n=== Results ===");
  console.log(`  PASS: ${pass}/${TEST_CASES.length}`);
  console.log(`  FAIL: ${fail}/${TEST_CASES.length}`);
  console.log(`  ERROR: ${error}/${TEST_CASES.length}`);

  // Category breakdown
  const categories = {};
  for (const r of results) {
    if (!categories[r.category]) categories[r.category] = { pass: 0, fail: 0, error: 0 };
    categories[r.category][r.status] += 1;
  }
  console.log("\n  By category:");
  for (const [cat, counts] of Object.entries(categories)) {
    const total = counts.pass + counts.fail + counts.error;
    console.log(`    ${cat.padEnd(10)}: ${counts.pass}/${total} pass`);
  }

  // Show failures in detail
  const failures = results.filter((r) => r.status === "fail");
  if (failures.length > 0) {
    console.log("\n=== Failures ===");
    for (const f of failures) {
      console.log(`  #${f.id}: "${f.input}"`);
      console.log(`       expected=${f.expectedRoute} got=${f.effectiveRoute} (raw=${f.rawRoute})`);
      console.log(`       conf=${f.confidence} tool_need=${f.toolNeedHint} duration=${f.durationHint} scope=${f.scope} reply_mode=${f.replyMode}`);
      if (f.validatorOverrides.length > 0) {
        console.log(`       validator: ${f.validatorOverrides.join(", ")}`);
      }
    }
  }

  console.log(`\nOverall: ${fail === 0 && error === 0 ? "ALL PASSED ✅" : "HAS FAILURES ❌"}`);
  process.exit(fail > 0 || error > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
