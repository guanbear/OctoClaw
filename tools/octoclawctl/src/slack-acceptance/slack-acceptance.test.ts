import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  SlackAcceptanceClient,
  SlackAcceptanceConfig,
  SlackMessageRecord,
  SlackPostMessageResult,
} from "./types.js";
import {
  parseSlackAcceptanceConfig,
  auditSlackTools,
  runSlackAcceptanceHarness,
} from "./harness.js";
import { redactSecret, sanitizeForArtifact } from "./sanitize.js";
import { renderSlackAcceptanceMarkdown } from "./report.js";
import { SlackWebApiAcceptanceClient } from "./client.js";

function validConfig(overrides: Partial<SlackAcceptanceConfig> = {}): SlackAcceptanceConfig {
  return {
    botTokenEnv: "SLACK_BOT_TOKEN",
    sessionKey: "slack:channel:C_ACC_TEST:thread:123",
    target: { channel: "C_ACC_TEST" },
    ...overrides,
  } as SlackAcceptanceConfig;
}

function validEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    SLACK_BOT_TOKEN: "xoxb-test-token-12345",
    ...overrides,
  };
}

function createMockClient(replies: SlackMessageRecord[] = []): SlackAcceptanceClient {
  return {
    async postMessage(params: { channel: string; text: string; threadTs?: string }): Promise<SlackPostMessageResult> {
      return {
        ok: true,
        ts: "1234567890.000001",
        threadTs: params.threadTs || "1234567890.000001",
        channel: params.channel,
      };
    },
    async fetchReplies(): Promise<SlackMessageRecord[]> {
      return replies;
    },
  };
}

function createMockClientWithPostError(error: string): SlackAcceptanceClient {
  return {
    async postMessage(): Promise<SlackPostMessageResult> {
      return { ok: false, ts: "", channel: "C_ACC_TEST", error };
    },
    async fetchReplies(): Promise<SlackMessageRecord[]> {
      return [];
    },
  };
}

function createMockClientSequence(replyBatches: SlackMessageRecord[][]): SlackAcceptanceClient {
  let fetchCount = 0;
  return {
    async postMessage(params: { channel: string; text: string; threadTs?: string }): Promise<SlackPostMessageResult> {
      return {
        ok: true,
        ts: "1234567890.000001",
        threadTs: params.threadTs || "1234567890.000001",
        channel: params.channel,
      };
    },
    async fetchReplies(): Promise<SlackMessageRecord[]> {
      const batch = replyBatches[Math.min(fetchCount, replyBatches.length - 1)] ?? [];
      fetchCount += 1;
      return batch;
    },
  };
}


describe("parseSlackAcceptanceConfig — fail closed", () => {
  it("requires botTokenEnv", () => {
    expect(() => parseSlackAcceptanceConfig({ sessionKey: "s", target: { channel: "C" } }, validEnv())).toThrow("botTokenEnv");
  });

  it("rejects inline tokens (botTokenEnv must resolve from env)", () => {
    expect(() => parseSlackAcceptanceConfig(validConfig(), {})).toThrow("token env is not set");
  });

  it("rejects userTokenEnv unless acceptance isolation explicitly allows it", () => {
    expect(() => parseSlackAcceptanceConfig(validConfig({
      userTokenEnv: "SLACK_USER_TOKEN",
    }), validEnv({ SLACK_USER_TOKEN: "xoxp-test-token-12345" }))).toThrow("allowUserToken");
  });

  it("accepts userTokenEnv only for explicit isolated test identity runs", () => {
    const config = parseSlackAcceptanceConfig(validConfig({
      userTokenEnv: "SLACK_USER_TOKEN",
      isolation: { allowUserToken: true, runId: "run-user-token-test" },
    }), validEnv({ SLACK_USER_TOKEN: "xoxp-test-token-12345" }));
    expect(config.botTokenEnv).toBe("SLACK_BOT_TOKEN");
    expect(config.userTokenEnv).toBe("SLACK_USER_TOKEN");
    expect(config.userToken).toBe("xoxp-test-token-12345");
    expect(config.acceptanceRunId).toBe("run-user-token-test");
  });

  it("requires configured userTokenEnv to resolve from env", () => {
    expect(() => parseSlackAcceptanceConfig(validConfig({
      userTokenEnv: "SLACK_USER_TOKEN",
      isolation: { allowUserToken: true },
    }), validEnv())).toThrow("user token env is not set");
  });

  it("requires sessionKey", () => {
    expect(() => parseSlackAcceptanceConfig({ botTokenEnv: "SLACK_BOT_TOKEN", target: { channel: "C" } }, validEnv())).toThrow("sessionKey");
  });

  it("requires target.channel", () => {
    expect(() => parseSlackAcceptanceConfig(validConfig({ target: {} }), validEnv())).toThrow("target.channel");
  });

  it("rejects DM target without allowDm=true", () => {
    expect(() => parseSlackAcceptanceConfig(validConfig({
      sessionKey: "slack:dm:U123",
      target: { channel: "D_DIRECT", user: "U123" },
    }), validEnv())).toThrow("allowDm");
  });

  it("accepts DM target with allowDm=true", () => {
    const config = parseSlackAcceptanceConfig(validConfig({
      sessionKey: "slack:dm:U123",
      target: { channel: "D_DIRECT", user: "U123", allowDm: true },
    }), validEnv());
    expect(config.target.channel).toBe("D_DIRECT");
  });

  it("rejects production-labeled target without allowProductionTarget", () => {
    expect(() => parseSlackAcceptanceConfig(validConfig({
      outputLabel: "prod-acceptance",
    }), validEnv())).toThrow("allowProductionTarget");
  });

  it("accepts production target with allowProductionTarget=true", () => {
    const config = parseSlackAcceptanceConfig(validConfig({
      outputLabel: "prod-acceptance",
      target: { channel: "C_PROD", allowProductionTarget: true },
    }), validEnv());
    expect(config.outputLabel).toBe("prod-acceptance");
  });

  it("rejects non-object config", () => {
    expect(() => parseSlackAcceptanceConfig("bad", validEnv())).toThrow("JSON object");
  });

  it("rejects unknown case kind", () => {
    const badConfig = {
      botTokenEnv: "SLACK_BOT_TOKEN",
      sessionKey: "slack:channel:C_ACC_TEST:thread:123",
      target: { channel: "C_ACC_TEST" },
      cases: [{ kind: "unknown_kind" }],
    };
    expect(() => parseSlackAcceptanceConfig(badConfig, validEnv())).toThrow("unknown case kind");
  });

  it("fills defaults for timeout/poll/max", () => {
    const config = parseSlackAcceptanceConfig(validConfig(), validEnv());
    expect(config.ackTimeoutMs).toBe(30_000);
    expect(config.neutralAckTimeoutMs).toBe(5_000);
    expect(config.finalTimeoutMs).toBe(180_000);
    expect(config.pollIntervalMs).toBe(2_000);
    expect(config.maxTranscriptMessages).toBe(50);
  });

  it("gives default delegated_work smoke enough time for native subagent run timeout plus delivery", () => {
    const config = parseSlackAcceptanceConfig(validConfig(), validEnv());
    const delegated = config.cases.find((item) => item.kind === "delegated_work");
    expect(delegated?.ackTimeoutMs).toBe(180_000);
    expect(delegated?.finalTimeoutMs).toBe(360_000);
    expect(delegated?.expectFinalAll).toContain("via=native_announce");
  });

  it("uses provided cases when specified", () => {
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{ kind: "plain_chat", prompt: "custom" }],
    }), validEnv());
    expect(config.cases).toHaveLength(1);
    expect(config.cases[0].prompt).toBe("custom");
  });

  it("uses default 8 cases when no cases specified", () => {
    const config = parseSlackAcceptanceConfig(validConfig(), validEnv());
    expect(config.cases).toHaveLength(8);
  });

  it("defaults to isolated acceptance run metadata", () => {
    const config = parseSlackAcceptanceConfig(validConfig({ outputLabel: "octoclaw-acceptance-test" }), validEnv());
    expect(config.acceptanceRunId).toMatch(/^octoclaw-acceptance-test-/u);
    expect(config.isolation.enabled).toBe(true);
    expect(config.isolation.markerPrefix).toBe("[OCTOCLAW_ACCEPTANCE]");
    expect(config.isolation.allowUserToken).toBe(false);
  });
});


describe("auditSlackTools", () => {
  it("passes for safe tools only", () => {
    const result = auditSlackTools(["message.send", "message.update", "message.react", "message.typing"]);
    expect(result.status).toBe("pass");
    expect(result.blockedTools).toEqual([]);
  });

  it("fails for unsafe tools", () => {
    const result = auditSlackTools(["message.send", "files.upload", "admin.conversations.delete"]);
    expect(result.status).toBe("fail");
    expect(result.blockedTools).toContain("files.upload");
    expect(result.blockedTools).toContain("admin.conversations.delete");
  });

  it("passes for empty tool list", () => {
    const result = auditSlackTools([]);
    expect(result.status).toBe("pass");
  });
});


describe("secret redaction", () => {
  it("redacts short secrets completely", () => {
    expect(redactSecret("abc")).toBe("[REDACTED]");
  });

  it("redacts long secrets with first/last 3 chars", () => {
    expect(redactSecret("xoxb-1234567890-abcdef")).toBe("xox…def");
  });

  it("handles empty string", () => {
    expect(redactSecret("")).toBe("");
  });
});


describe("sanitizeForArtifact", () => {
  it("strips secret keys", () => {
    const result = sanitizeForArtifact({ token: "xoxb-secret", data: "keep" }) as Record<string, unknown>;
    expect(result.token).toBe("[REDACTED]");
    expect(result.data).toBe("keep");
  });

  it("strips transcript keys", () => {
    const result = sanitizeForArtifact({ rawTranscript: "leaked", workerChainOfThought: "leaked", ok: true }) as Record<string, unknown>;
    expect(result.rawTranscript).toBe("[STRIPPED]");
    expect(result.workerChainOfThought).toBe("[STRIPPED]");
    expect(result.ok).toBe(true);
  });

  it("recursively sanitizes nested objects", () => {
    const result = sanitizeForArtifact({
      level1: {
        token: "secret-in-nested",
        childTranscript: "leaked",
        value: 42,
      },
    }) as Record<string, unknown>;
    const nested = result.level1 as Record<string, unknown>;
    expect(nested.token).toBe("[REDACTED]");
    expect(nested.childTranscript).toBe("[STRIPPED]");
    expect(nested.value).toBe(42);
  });

  it("sanitizes arrays", () => {
    const result = sanitizeForArtifact([{ token: "s1" }, { token: "s2" }]) as Record<string, unknown>[];
    expect(result[0].token).toBe("[REDACTED]");
    expect(result[1].token).toBe("[REDACTED]");
  });

  it("strips keys containing 'token' or 'secret' case-insensitively", () => {
    const result = sanitizeForArtifact({ BotToken: "t", MySecretKey: "s", safe: "ok" }) as Record<string, unknown>;
    expect(result.BotToken).toBe("[REDACTED]");
    expect(result.MySecretKey).toBe("[REDACTED]");
    expect(result.safe).toBe("ok");
  });
});


describe("content assertions via runSlackAcceptanceHarness", () => {
  it("prefixes real Slack prompts with acceptance run marker while keeping plain prompt in report", async () => {
    let postedText = "";
    const client: SlackAcceptanceClient = {
      async postMessage(params: { channel: string; text: string; threadTs?: string }): Promise<SlackPostMessageResult> {
        postedText = params.text;
        return { ok: true, ts: "1234567890.000001", threadTs: params.threadTs || "1234567890.000001", channel: params.channel };
      },
      async fetchReplies(): Promise<SlackMessageRecord[]> {
        return [{ ts: "1234567890.000002", text: "在的" }];
      },
    };
    const config = parseSlackAcceptanceConfig(validConfig({
      isolation: { runId: "run-isolated-1" },
      cases: [{ kind: "plain_chat", prompt: "在吗", finalRequired: true, expectFinal: ["在"] }],
    }), validEnv());
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 10;
    const report = await runSlackAcceptanceHarness(client, config);
    expect(postedText).toContain("[OCTOCLAW_ACCEPTANCE] run=run-isolated-1 case=plain_chat-1 acceptance=true");
    expect(postedText).toContain("在吗");
    expect(report.acceptanceRunId).toBe("run-isolated-1");
    expect(report.cases[0].prompt).toBe("在吗");
    expect(report.cases[0].sentPrompt).toBe(postedText);
  });

  it("passes plain_chat when non-empty reply observed", async () => {
    const client = createMockClient([
      { ts: "1234567890.000002", text: "在的，状态正常" },
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{ kind: "plain_chat", prompt: "在吗", finalRequired: true, noSpawnExpected: true, expectFinal: ["在", "状态"] }],
    }), validEnv());
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 10;
    const report = await runSlackAcceptanceHarness(client, config);
    const plainCase = report.cases.find((c) => c.kind === "plain_chat")!;
    expect(plainCase.final.status).toBe("pass");
    expect(plainCase.ackMs).toBeDefined();
    expect(plainCase.finalMs).toBeDefined();
  });

  it("waits for final content instead of judging the first ACK as final", async () => {
    const client = createMockClientSequence([
      [{ ts: "1234567890.000002", text: "收到，开始查" }],
      [{ ts: "1234567890.000002", text: "收到，开始查" }],
      [{ ts: "1234567890.000002", text: "收到，开始查" }, { ts: "1234567890.000003", text: "OpenClaw 4.21 摘要" }],
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{ kind: "fresh_lookup", prompt: "test", ackRequired: true, finalRequired: true, expectAck: ["开始"], expectFinal: ["OpenClaw", "4.21"] }],
    }), validEnv());
    config.ackTimeoutMs = 100;
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 1;
    const report = await runSlackAcceptanceHarness(client, config);
    const lookupCase = report.cases.find((c) => c.kind === "fresh_lookup")!;
    expect(lookupCase.ack.status).toBe("pass");
    expect(lookupCase.final.status).toBe("pass");
    expect(lookupCase.transcript).toHaveLength(2);
  });

  it("does not treat a trailing footer pipe reject pattern as a wildcard", async () => {
    const client = createMockClientSequence([
      [{ ts: "1234567890.000002", text: "任务已启动。" }],
      [
        { ts: "1234567890.000002", text: "任务已启动。" },
        { ts: "1234567890.000003", text: "OpenClaw 总结\ncompletion_file_timeout=0\n\n• route=delegate | model=gpt-5.5 · thread | via=native_announce" },
      ],
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{
        kind: "delegated_work",
        prompt: "test",
        ackRequired: true,
        finalRequired: true,
        expectAck: ["启动"],
        expectFinalAll: ["OpenClaw", "via=native_announce"],
        rejectFinal: ["任务超时", "completion_file_timeout", "route=reply |", "via=policy"],
      }],
    }), validEnv());
    config.ackTimeoutMs = 100;
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 1;

    const report = await runSlackAcceptanceHarness(client, config);
    const delegatedCase = report.cases.find((c) => c.kind === "delegated_work")!;

    expect(delegatedCase.ack.status).toBe("pass");
    expect(delegatedCase.final.status).toBe("pass");
    expect(delegatedCase.status).toBe("pass");
  });

  it("records neutral reaction ACK separately from accepted ACK", async () => {
    const client: SlackAcceptanceClient = {
      async postMessage(params: { channel: string; text: string; threadTs?: string }): Promise<SlackPostMessageResult> {
        return {
          ok: true,
          ts: "1234567890.000001",
          threadTs: params.threadTs || "1234567890.000001",
          channel: params.channel,
        };
      },
      async fetchMessage(): Promise<SlackMessageRecord | null> {
        return {
          ts: "1234567890.000001",
          text: "prompt",
          reactions: [{ name: "eyes", count: 1 }],
        };
      },
      async fetchReplies(): Promise<SlackMessageRecord[]> {
        return [
          { ts: "1234567890.090001", text: "任务已启动。" },
          { ts: "1234567890.150001", text: "OpenClaw 总结\n\n• route=delegate | via=native_announce" },
        ];
      },
    };
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{
        kind: "delegated_work",
        prompt: "test",
        neutralAckRequired: true,
        expectNeutralReaction: ["eyes"],
        ackRequired: true,
        finalRequired: true,
        expectAck: ["启动"],
        expectFinalAll: ["OpenClaw", "via=native_announce"],
      }],
    }), validEnv());
    config.neutralAckTimeoutMs = 100;
    config.ackTimeoutMs = 100;
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 1;

    const report = await runSlackAcceptanceHarness(client, config);
    const delegatedCase = report.cases.find((c) => c.kind === "delegated_work")!;

    expect(delegatedCase.neutralAck?.status).toBe("pass");
    expect(delegatedCase.ack.status).toBe("pass");
    expect(delegatedCase.neutralAckMs).toBeDefined();
    expect(delegatedCase.acceptedAckMs).toBe(90);
    expect(delegatedCase.ackMs).toBe(90);
  });

  it("does not count neutral text ACK as accepted delegate ACK", async () => {
    const client = createMockClientSequence([
      [{ ts: "1234567890.010001", text: "收到，正在判断并准备处理。" }],
      [{ ts: "1234567890.010001", text: "收到，正在判断并准备处理。" }],
      [
        { ts: "1234567890.010001", text: "收到，正在判断并准备处理。" },
        { ts: "1234567890.090001", text: "任务已启动。" },
      ],
      [
        { ts: "1234567890.010001", text: "收到，正在判断并准备处理。" },
        { ts: "1234567890.090001", text: "任务已启动。" },
        { ts: "1234567890.150001", text: "OpenClaw 总结\n\n• route=delegate | via=native_announce" },
      ],
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{
        kind: "delegated_work",
        prompt: "test",
        neutralAckRequired: true,
        expectNeutralAck: ["正在判断"],
        ackRequired: true,
        finalRequired: true,
        expectAck: ["任务已启动"],
        expectFinalAll: ["OpenClaw", "via=native_announce"],
      }],
    }), validEnv());
    config.neutralAckTimeoutMs = 100;
    config.ackTimeoutMs = 100;
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 1;

    const report = await runSlackAcceptanceHarness(client, config);
    const delegatedCase = report.cases.find((c) => c.kind === "delegated_work")!;

    expect(delegatedCase.neutralAck?.status).toBe("pass");
    expect(delegatedCase.ack.status).toBe("pass");
    expect(delegatedCase.neutralAckMs).toBe(10);
    expect(delegatedCase.acceptedAckMs).toBe(90);
  });


  it("does not let a fast final satisfy required ACK unless configured", async () => {
    const client = createMockClient([
      { ts: "1234567890.020001", text: "OpenClaw 4.21 摘要" },
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{ kind: "fresh_lookup", prompt: "test", ackRequired: true, finalRequired: true, expectAck: ["开始"], expectFinal: ["OpenClaw", "4.21"] }],
    }), validEnv());
    config.ackTimeoutMs = 100;
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 10;
    const report = await runSlackAcceptanceHarness(client, config);
    const lookupCase = report.cases.find((c) => c.kind === "fresh_lookup")!;
    expect(lookupCase.ack.status).toBe("fail");
    expect(lookupCase.final.status).toBe("pass");
    expect(lookupCase.status).toBe("fail");
  });

  it("allows a fast final reply to satisfy required ACK when configured", async () => {
    const client = createMockClient([
      { ts: "1234567890.020001", text: "OpenClaw 4.21 摘要" },
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{ kind: "fresh_lookup", prompt: "test", ackRequired: true, allowFastFinalAck: true, finalRequired: true, expectAck: ["开始"], expectFinal: ["OpenClaw", "4.21"] }],
    }), validEnv());
    config.ackTimeoutMs = 100;
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 10;
    const report = await runSlackAcceptanceHarness(client, config);
    const lookupCase = report.cases.find((c) => c.kind === "fresh_lookup")!;
    expect(lookupCase.ack.status).toBe("pass");
    expect(lookupCase.ack.reason).toContain("fast final");
    expect(lookupCase.final.status).toBe("pass");
    expect(lookupCase.status).toBe("pass");
  });

  it("fails when required expected content is missing", async () => {
    const client = createMockClient([
      { ts: "1234567890.000002", text: "unrelated reply" },
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{ kind: "fresh_lookup", prompt: "test", ackRequired: true, finalRequired: true, expectAck: ["查"], expectFinal: ["OpenClaw", "4.21"] }],
    }), validEnv());
    config.ackTimeoutMs = 100;
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 10;
    const report = await runSlackAcceptanceHarness(client, config);
    const lookupCase = report.cases.find((c) => c.kind === "fresh_lookup")!;
    expect(lookupCase.final.status).toBe("fail");
  });

  it("fails when rejected content appears in reply", async () => {
    const client = createMockClient([
      { ts: "1234567890.000002", text: "任务正在运行中" },
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{ kind: "no_lie_materialized_no_spawn", prompt: "test", finalRequired: true, noSpawnExpected: true, requiresFixture: true, fixtureKey: "materializedNoSpawn", expectFinal: ["queued"], rejectFinal: ["正在运行"] }],
      fixtures: { materializedNoSpawn: true },
    }), validEnv());
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 10;
    const report = await runSlackAcceptanceHarness(client, config);
    const noLieCase = report.cases.find((c) => c.kind === "no_lie_materialized_no_spawn")!;
    expect(noLieCase.final.status).toBe("fail");
    expect(noLieCase.final.reason).toContain("rejected");
  });

  it("fails case when postMessage fails", async () => {
    const client = createMockClientWithPostError("channel_not_found");
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{ kind: "plain_chat", prompt: "test", finalRequired: true }],
    }), validEnv());
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 10;
    const report = await runSlackAcceptanceHarness(client, config);
    expect(report.cases[0].status).toBe("fail");
    expect(report.cases[0].errors).toContain("channel_not_found");
  });

  it("skips disabled cases", async () => {
    const client = createMockClient();
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{ kind: "plain_chat", prompt: "test", enabled: false }],
    }), validEnv());
    const report = await runSlackAcceptanceHarness(client, config);
    expect(report.cases[0].status).toBe("unknown");
    expect(report.cases[0].ack.status).toBe("skipped");
  });

  it("skips fixture-required case when fixture missing", async () => {
    const client = createMockClient();
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{ kind: "no_lie_materialized_no_spawn", prompt: "test", requiresFixture: true, fixtureKey: "materializedNoSpawn" }],
    }), validEnv());
    const report = await runSlackAcceptanceHarness(client, config);
    expect(report.cases[0].status).toBe("unknown");
    expect(report.cases[0].ack.status).toBe("skipped");
  });

  it("passes fixture-required case when fixture present", async () => {
    const client = createMockClient([
      { ts: "1234567890.000002", text: "状态为 queued，materialized 尚未实际执行" },
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{ kind: "no_lie_materialized_no_spawn", prompt: "test", requiresFixture: true, fixtureKey: "materializedNoSpawn", finalRequired: true, expectFinal: ["queued", "materialized"] }],
      fixtures: { materializedNoSpawn: true },
    }), validEnv());
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 10;
    const report = await runSlackAcceptanceHarness(client, config);
    expect(report.cases[0].final.status).toBe("pass");
  });
});


describe("no-spawn replay assertion", () => {
  let tmpDir: string;

  beforeEach(async () => {
    const base = path.join(os.homedir(), ".octoclawctl-nospawn-test");
    tmpDir = path.join(base, `test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("passes when replay shows no spawn after prompt", async () => {
    const replayPath = path.join(tmpDir, "replay.jsonl");
    const event = { at: "2020-01-01T00:00:00.000Z", event: "policy_resolved", route: "reply", sessionKey: "slack:channel:C_ACC_TEST:thread:123" };
    await fs.writeFile(replayPath, JSON.stringify(event), "utf8");

    const client = createMockClient([
      { ts: "1234567890.000002", text: "状态正常" },
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{ kind: "plain_chat", prompt: "在吗", finalRequired: true, noSpawnExpected: true }],
      replayPath,
    }), validEnv());
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 10;
    const report = await runSlackAcceptanceHarness(client, config);
    const plainCase = report.cases.find((c) => c.kind === "plain_chat")!;
    expect(plainCase.noSpawn.status).toBe("pass");
  });

  it("fails when replay shows spawn after prompt", async () => {
    const replayPath = path.join(tmpDir, "replay.jsonl");
    const noSpawnEvent = { at: "2020-01-01T00:00:00.000Z", event: "policy_resolved", route: "reply" };
    const spawnEvent = { at: "2099-12-31T23:59:59.000Z", event: "execution_transition", transitionKind: "spawn_started", sessionKey: "slack:channel:C_ACC_TEST:thread:123" };
    await fs.writeFile(replayPath, `${JSON.stringify(noSpawnEvent)}\n${JSON.stringify(spawnEvent)}\n`, "utf8");

    const client = createMockClient([
      { ts: "1234567890.000002", text: "在的" },
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{ kind: "plain_chat", prompt: "在吗", finalRequired: true, noSpawnExpected: true }],
      replayPath,
    }), validEnv());
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 10;
    const report = await runSlackAcceptanceHarness(client, config);
    const plainCase = report.cases.find((c) => c.kind === "plain_chat")!;
    expect(plainCase.noSpawn.status).toBe("fail");
    expect(plainCase.noSpawn.reason).toContain("spawn evidence");
  });

  it("returns unknown when replayPath not configured", async () => {
    const client = createMockClient([
      { ts: "1234567890.000002", text: "在的" },
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{ kind: "plain_chat", prompt: "在吗", finalRequired: true, noSpawnExpected: true }],
    }), validEnv());
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 10;
    const report = await runSlackAcceptanceHarness(client, config);
    const plainCase = report.cases.find((c) => c.kind === "plain_chat")!;
    expect(plainCase.noSpawn.status).toBe("unknown");
  });

  it("treats malformed JSONL lines in replay as unknown, not pass", async () => {
    const replayPath = path.join(tmpDir, "replay.jsonl");
    await fs.writeFile(replayPath, "not json\n{bad\n", "utf8");

    const client = createMockClient([
      { ts: "1234567890.000002", text: "在的" },
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{ kind: "plain_chat", prompt: "在吗", finalRequired: true, noSpawnExpected: true }],
      replayPath,
    }), validEnv());
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 10;
    const report = await runSlackAcceptanceHarness(client, config);
    const plainCase = report.cases.find((c) => c.kind === "plain_chat")!;
    expect(plainCase.noSpawn.status).toBe("unknown");
    expect(plainCase.noSpawn.reason).toContain("malformed replay JSONL");
  });

  it("attaches replay stage timing and native planner ids to case evidence", async () => {
    const replayPath = path.join(tmpDir, "replay.jsonl");
    const threadTs = "1234567890.000001";
    const replayEvents = [
      { at: "2099-12-31T23:59:49.000Z", event: "message_received_observed", sessionKey: `slack:channel:C_ACC_TEST:thread:${threadTs}`, inboundMessageTs: threadTs, anchor_source: "event" },
      { at: "2099-12-31T23:59:50.000Z", event: "before_dispatch_observed", sessionKey: `slack:channel:C_ACC_TEST:thread:${threadTs}`, inboundMessageTs: threadTs, anchor_source: "event" },
      { at: "2099-12-31T23:59:51.000Z", event: "neutral_inbound_ack", sessionKey: `slack:channel:C_ACC_TEST:thread:${threadTs}`, replyToMessageId: threadTs, anchor_source: "event", fallback_used: false, sent: true },
      { at: "2099-12-31T23:59:51.500Z", event: "completion_file_timeout", sessionKey: "slack:channel:C_ACC_TEST:thread:123", parentSessionKey: "slack:channel:C_ACC_TEST:thread:123", workContractId: "wc-unrelated" },
      { at: "2099-12-31T23:59:51.600Z", event: "before_model_resolve_observed", sessionKey: `slack:channel:C_ACC_TEST:thread:${threadTs}`, stateKey: `slack:channel:C_ACC_TEST:thread:${threadTs}` },
      { at: "2099-12-31T23:59:51.700Z", event: "before_model_policy_resolve_started", sessionKey: `slack:channel:C_ACC_TEST:thread:${threadTs}`, stateKey: `slack:channel:C_ACC_TEST:thread:${threadTs}` },
      { at: "2099-12-31T23:59:51.900Z", event: "before_model_policy_resolve_completed", sessionKey: `slack:channel:C_ACC_TEST:thread:${threadTs}`, stateKey: `slack:channel:C_ACC_TEST:thread:${threadTs}`, decision_bucket: "budgeted_main_then_delegate", usedCachedPolicy: false },
      { at: "2099-12-31T23:59:51.950Z", event: "before_prompt_build_started", sessionKey: `slack:channel:C_ACC_TEST:thread:${threadTs}`, stateKey: `slack:channel:C_ACC_TEST:thread:${threadTs}` },
      { at: "2099-12-31T23:59:52.000Z", event: "before_prompt_build_observed", sessionKey: `slack:channel:C_ACC_TEST:thread:${threadTs}`, inboundMessageTs: threadTs, anchor_source: "event" },
      { at: "2099-12-31T23:59:52.300Z", event: "policy_resolve_started", sessionKey: `slack:channel:C_ACC_TEST:thread:${threadTs}`, stateKey: `slack:channel:C_ACC_TEST:thread:${threadTs}` },
      { at: "2099-12-31T23:59:52.800Z", event: "policy_resolve_completed", sessionKey: `slack:channel:C_ACC_TEST:thread:${threadTs}`, stateKey: `slack:channel:C_ACC_TEST:thread:${threadTs}`, decision_bucket: "budgeted_main_then_delegate", usedCachedPolicy: true },
      { at: "2099-12-31T23:59:53.000Z", event: "policy_resolved", sessionKey: `slack:channel:C_ACC_TEST:thread:${threadTs}`, workContractId: "wc-policy", decision_bucket: "budgeted_main_then_delegate", visibleElapsedMs: 3000 },
      { at: "2099-12-31T23:59:53.200Z", event: "prompt_projection_built", sessionKey: `slack:channel:C_ACC_TEST:thread:${threadTs}`, stateKey: `slack:channel:C_ACC_TEST:thread:${threadTs}`, decision_bucket: "budgeted_main_then_delegate" },
      { at: "2099-12-31T23:59:53.500Z", event: "budgeted_main_escalated", sessionKey: `slack:channel:C_ACC_TEST:thread:${threadTs}`, workContractId: "wc-stage", decision_bucket: "budgeted_main_then_delegate", budgetElapsedMs: 30001, budgetEscalationReason: "wall_time_over_budget", visibleElapsedMs: 33000 },
      { at: "2099-12-31T23:59:53.800Z", event: "dispatch_tool_started", sessionKey: `slack:channel:C_ACC_TEST:thread:${threadTs}`, stateKey: `slack:channel:C_ACC_TEST:thread:${threadTs}`, work_contract_id: "wc-stage" },
      { at: "2099-12-31T23:59:54.000Z", event: "dispatch_planner_intent_created", sessionKey: `slack:channel:C_ACC_TEST:thread:${threadTs}`, work_contract_id: "wc-stage", spawn_intent_id: "nsp-stage" },
      { at: "2099-12-31T23:59:55.000Z", event: "sessions_spawn_intent_allowed", sessionKey: `slack:channel:C_ACC_TEST:thread:${threadTs}`, work_contract_id: "wc-stage", spawn_intent_id: "nsp-stage" },
      { at: "2099-12-31T23:59:56.000Z", event: "execution_transition", transitionKind: "spawn_started", sessionKey: `slack:channel:C_ACC_TEST:thread:${threadTs}`, workContractId: "wc-stage", compactParentPacket: { runId: "run-stage", childSessionKey: "agent:main:subagent:stage" } },
      { at: "2099-12-31T23:59:57.000Z", event: "dispatch_confirm_completed", sessionKey: `slack:channel:C_ACC_TEST:thread:${threadTs}`, work_contract_id: "wc-stage", spawn_intent_id: "nsp-stage", run_id: "run-stage", child_session_key: "agent:main:subagent:stage", ok: true },
      { at: "2099-12-31T23:59:58.000Z", event: "native_announce_final_delivered", sessionKey: `slack:channel:C_ACC_TEST:thread:${threadTs}`, workContractId: "wc-stage", footer_via: "native_announce", delivery_transport: "slack_api", target_source: "inbound_anchor", footer_source: "envelope", duplicate_final_count: 0 },
    ];
    await fs.writeFile(replayPath, replayEvents.map((event) => JSON.stringify(event)).join("\n"), "utf8");

    const client = createMockClient([
      { ts: "1234567890.090001", text: "任务已启动。" },
      { ts: "1234567890.150001", text: "OpenClaw 总结\n\n• route=delegate | via=native_announce" },
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{
        kind: "delegated_work",
        prompt: "test",
        ackRequired: true,
        finalRequired: true,
        expectAck: ["任务已启动"],
        expectFinalAll: ["OpenClaw", "via=native_announce"],
      }],
      replayPath,
    }), validEnv());
    config.ackTimeoutMs = 100;
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 1;
    const report = await runSlackAcceptanceHarness(client, config);
    const delegatedCase = report.cases.find((c) => c.kind === "delegated_work")!;

    expect(delegatedCase.replayEvidence).toMatchObject({
      status: "pass",
      anchorSource: "event",
      fallbackUsed: false,
      workContractId: "wc-stage",
      spawnIntentId: "nsp-stage",
      runId: "run-stage",
      childSessionKey: "agent:main:subagent:stage",
      completionFileTimeoutCount: 0,
      decisionBucket: "budgeted_main_then_delegate",
      budgetEvent: "budgeted_main_escalated",
      budgetElapsedMs: 30001,
      budgetEscalationReason: "wall_time_over_budget",
      visibleElapsedMs: 3000,
      footerVia: "native_announce",
      deliveryTransport: "slack_api",
      targetSource: "inbound_anchor",
      footerSource: "envelope",
      duplicateFinalCount: 0,
      parentEchoAfterNativeAnnounceCount: 0,
    });
    expect(delegatedCase.replayEvidence?.stageMs).toEqual(expect.objectContaining({
      message_received: expect.any(Number),
      before_dispatch: expect.any(Number),
      before_model_resolve: expect.any(Number),
      before_model_policy_resolve_started: expect.any(Number),
      before_model_policy_resolve_completed: expect.any(Number),
      before_prompt_build_started: expect.any(Number),
      before_prompt_build: expect.any(Number),
      policy_resolve_started: expect.any(Number),
      policy_resolve_completed: expect.any(Number),
      judge_resolved: expect.any(Number),
      prompt_projection_built: expect.any(Number),
      dispatch_tool_started: expect.any(Number),
      octoclaw_dispatch: expect.any(Number),
      sessions_spawn_intent_allowed: expect.any(Number),
      sessions_spawn_accepted: expect.any(Number),
      dispatch_confirm: expect.any(Number),
      native_child_final: expect.any(Number),
    }));
    expect(delegatedCase.final.matchedText).toBe("OpenClaw 总结\n\n• route=delegate | via=native_announce");
    expect(renderSlackAcceptanceMarkdown(report)).toContain("stageMs:");
    expect(renderSlackAcceptanceMarkdown(report)).toContain("decision_bucket=budgeted_main_then_delegate");
    expect(renderSlackAcceptanceMarkdown(report)).toContain("footerVia=native_announce");
    expect(renderSlackAcceptanceMarkdown(report)).toContain("delivery_transport=slack_api");
    expect(renderSlackAcceptanceMarkdown(report)).toContain("parentEchoAfterNativeAnnounce=0");
  });

  it("fails when replay shows uncanceled parent echo after native announce delivery", async () => {
    const replayPath = path.join(tmpDir, "replay-parent-echo.jsonl");
    const threadTs = "1234567890.000001";
    const sessionKey = `slack:channel:C_ACC_TEST:thread:${threadTs}`;
    const replayEvents = [
      { at: "2099-12-31T23:59:49.000Z", event: "message_received_observed", sessionKey, inboundMessageTs: threadTs },
      { at: "2099-12-31T23:59:58.000Z", event: "native_announce_final_delivered", sessionKey, stateKey: sessionKey, workContractId: "wc-echo" },
      { at: "2099-12-31T23:59:59.000Z", event: "outbound_message_sending_guard", sessionKey, stateKey: sessionKey, workContractId: "wc-echo", target: "C_ACC_TEST", cancel: false, returned: true },
    ];
    await fs.writeFile(replayPath, replayEvents.map((event) => JSON.stringify(event)).join("\n"), "utf8");

    const client = createMockClient([
      { ts: "1234567890.150001", text: "OpenClaw 总结" },
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{
        kind: "delegated_work",
        prompt: "test",
        ackRequired: false,
        finalRequired: true,
        expectFinal: ["OpenClaw"],
      }],
      replayPath,
    }), validEnv());
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 1;

    const report = await runSlackAcceptanceHarness(client, config);
    const delegatedCase = report.cases.find((c) => c.kind === "delegated_work")!;

    expect(delegatedCase.status).toBe("fail");
    expect(report.overallGate).toBe("fail");
    expect(delegatedCase.errors.join("\n")).toContain("parent_echo_after_native_announce:1");
    expect(delegatedCase.replayEvidence?.parentEchoAfterNativeAnnounceCount).toBe(1);
  });

  it("does not fail when replay shows native announce duplicate guard cancellation", async () => {
    const replayPath = path.join(tmpDir, "replay-parent-echo-cancelled.jsonl");
    const threadTs = "1234567890.000001";
    const sessionKey = `slack:channel:C_ACC_TEST:thread:${threadTs}`;
    const replayEvents = [
      { at: "2099-12-31T23:59:49.000Z", event: "message_received_observed", sessionKey, inboundMessageTs: threadTs },
      { at: "2099-12-31T23:59:58.000Z", event: "native_announce_final_delivered", sessionKey, stateKey: sessionKey, workContractId: "wc-echo-cancelled" },
      { at: "2099-12-31T23:59:59.000Z", event: "outbound_message_sending_guard", sessionKey, stateKey: sessionKey, workContractId: "wc-echo-cancelled", target: "C_ACC_TEST", cancel: true, returned: true },
    ];
    await fs.writeFile(replayPath, replayEvents.map((event) => JSON.stringify(event)).join("\n"), "utf8");

    const client = createMockClient([
      { ts: "1234567890.150001", text: "OpenClaw 总结" },
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{
        kind: "delegated_work",
        prompt: "test",
        ackRequired: false,
        finalRequired: true,
        expectFinal: ["OpenClaw"],
      }],
      replayPath,
    }), validEnv());
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 1;

    const report = await runSlackAcceptanceHarness(client, config);
    const delegatedCase = report.cases.find((c) => c.kind === "delegated_work")!;

    expect(delegatedCase.status).toBe("pass");
    expect(report.overallGate).toBe("pass");
    expect(delegatedCase.replayEvidence?.parentEchoAfterNativeAnnounceCount).toBe(0);
  });

  it("SSV2-012: fails delegated final when native announce via evidence is missing", async () => {
    const replayPath = path.join(tmpDir, "replay-wrong-via.jsonl");
    const threadTs = "1234567890.000001";
    const sessionKey = `slack:channel:C_ACC_TEST:thread:${threadTs}`;
    const replayEvents = [
      { at: "2099-12-31T23:59:49.000Z", event: "message_received_observed", sessionKey, inboundMessageTs: threadTs },
      { at: "2099-12-31T23:59:58.000Z", event: "native_announce_final_delivered", sessionKey, workContractId: "wc-via", spawn_intent_id: "nsp-via", run_id: "run-via", child_session_key: "agent:child", footer_via: "policy" },
    ];
    await fs.writeFile(replayPath, replayEvents.map((event) => JSON.stringify(event)).join("\n"), "utf8");

    const client = createMockClient([
      { ts: "1234567890.090001", text: "任务已启动。" },
      { ts: "1234567890.150001", text: "OpenClaw 总结\n\n• route=delegate | via=policy" },
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{
        kind: "delegated_work",
        prompt: "test",
        ackRequired: true,
        finalRequired: true,
        expectAck: ["启动"],
        expectFinal: ["OpenClaw"],
        expectReplay: {
          footerVia: "native_announce",
          deliveryTransport: "slack_api",
          requireWorkContract: true,
          requireSpawnIntent: true,
          requireRunId: true,
          requireChildSession: true,
        },
      }],
      replayPath,
    }), validEnv());
    config.ackTimeoutMs = 100;
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 1;

    const report = await runSlackAcceptanceHarness(client, config);
    const delegatedCase = report.cases.find((c) => c.kind === "delegated_work")!;

    expect(delegatedCase.status).toBe("fail");
    expect(delegatedCase.errors.join("\n")).toContain("replay_footer_via_mismatch");
    expect(delegatedCase.errors.join("\n")).toContain("replay_delivery_transport_mismatch");
  });

  it("SSV2-013: fails delegate footer without native spawn evidence", async () => {
    const replayPath = path.join(tmpDir, "replay-footer-without-spawn.jsonl");
    const threadTs = "1234567890.000001";
    const sessionKey = `slack:channel:C_ACC_TEST:thread:${threadTs}`;
    const replayEvents = [
      { at: "2099-12-31T23:59:49.000Z", event: "message_received_observed", sessionKey, inboundMessageTs: threadTs },
      { at: "2099-12-31T23:59:50.000Z", event: "policy_resolved", sessionKey, route: "reply" },
    ];
    await fs.writeFile(replayPath, replayEvents.map((event) => JSON.stringify(event)).join("\n"), "utf8");

    const client = createMockClient([
      { ts: "1234567890.150001", text: "OpenClaw 总结\n\n• route=delegate | model=zhipu/GLM-5.1 · thread | via=rule" },
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{
        kind: "plain_chat",
        prompt: "test",
        finalRequired: true,
        expectFinal: ["OpenClaw"],
        expectFooter: { route: "delegate", model: "zhipu/GLM-5.1", via: "rule" },
      }],
      replayPath,
    }), validEnv());
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 1;

    const report = await runSlackAcceptanceHarness(client, config);
    const plainCase = report.cases.find((c) => c.kind === "plain_chat")!;

    expect(plainCase.status).toBe("fail");
    expect(plainCase.errors.join("\n")).toContain("delegate_footer_without_spawn");
  });

  it("SSV2-015: fails footer model mismatch against expected footer truth", async () => {
    const client = createMockClient([
      { ts: "1234567890.150001", text: "OpenClaw 总结\n\n• route=reply | model=cliproxyapi/gpt-5.5 · thread | via=rule" },
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{
        kind: "plain_chat",
        prompt: "test",
        finalRequired: true,
        expectFinal: ["OpenClaw"],
        expectFooter: { route: "reply", model: "zhipu/GLM-5.1", via: "rule" },
      }],
    }), validEnv());
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 1;

    const report = await runSlackAcceptanceHarness(client, config);
    const plainCase = report.cases.find((c) => c.kind === "plain_chat")!;

    expect(plainCase.status).toBe("fail");
    expect(plainCase.errors.join("\n")).toContain("footer_model_mismatch");
  });

  it("SSV2-011: maps misleading streaming ACK text to a stable failure code", async () => {
    const client = createMockClient([
      { ts: "1234567890.020001", text: "还没好，再等等" },
      { ts: "1234567890.120001", text: "最终回复" },
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{
        kind: "plain_chat",
        prompt: "test",
        ackRequired: false,
        finalRequired: true,
        expectFinal: ["最终回复"],
        rejectAck: ["还没好，再等等", "任务已启动。"],
      }],
    }), validEnv());
    config.ackTimeoutMs = 100;
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 1;

    const report = await runSlackAcceptanceHarness(client, config);
    const plainCase = report.cases.find((c) => c.kind === "plain_chat")!;

    expect(plainCase.status).toBe("fail");
    expect(plainCase.errors.join("\n")).toContain("ack_misleading_text");
  });
});


describe("overall gate", () => {
  it("returns fail when any case fails", async () => {
    const client = createMockClientWithPostError("fail");
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{ kind: "plain_chat", prompt: "test", finalRequired: true }],
    }), validEnv());
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 10;
    const report = await runSlackAcceptanceHarness(client, config);
    expect(report.overallGate).toBe("fail");
  });

  it("returns fail when tool audit fails", async () => {
    const client = createMockClient([
      { ts: "1234567890.000002", text: "reply" },
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{ kind: "plain_chat", prompt: "test", finalRequired: true }],
      exposedTools: ["message.send", "files.upload"],
    }), validEnv());
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 10;
    const report = await runSlackAcceptanceHarness(client, config);
    expect(report.overallGate).toBe("fail");
    expect(report.toolExposureAudit.blockedTools).toContain("files.upload");
  });

  it("returns pass when all cases pass and tools are safe", async () => {
    const client = createMockClient([
      { ts: "1234567890.000002", text: "在的，状态正常" },
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{ kind: "plain_chat", prompt: "在吗", finalRequired: true, expectFinal: ["在"] }],
      exposedTools: ["message.send"],
    }), validEnv());
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 10;
    const report = await runSlackAcceptanceHarness(client, config);
    expect(report.overallGate).toBe("pass");
    expect(report.pass).toBe(1);
    expect(report.fail).toBe(0);
  });
});


describe("report rendering", () => {
  it("renders valid markdown report", async () => {
    const client = createMockClient([
      { ts: "1234567890.000002", text: "在的" },
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{ kind: "plain_chat", prompt: "在吗", finalRequired: true }],
    }), validEnv());
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 10;
    const report = await runSlackAcceptanceHarness(client, config);
    const md = renderSlackAcceptanceMarkdown(report);
    expect(md).toContain("# Slack Acceptance Report");
    expect(md).toContain("plain_chat");
    expect(md).toContain("Tool Exposure");
    expect(md).toContain(report.reportId);
  });

  it("report is JSON-serializable after sanitization", async () => {
    const client = createMockClient([
      { ts: "1234567890.000002", text: "在的" },
    ]);
    const config = parseSlackAcceptanceConfig(validConfig({
      cases: [{ kind: "plain_chat", prompt: "在吗", finalRequired: true }],
    }), validEnv());
    config.finalTimeoutMs = 100;
    config.pollIntervalMs = 10;
    const report = await runSlackAcceptanceHarness(client, config);
    const serialized = JSON.parse(JSON.stringify(report));
    expect(serialized.schemaVersion).toBe("octoclaw.slack_acceptance.report/v1");
    expect(serialized.cases).toHaveLength(1);
  });
});


describe("SlackWebApiAcceptanceClient", () => {
  it("has postMessage and fetchReplies methods", () => {
    const client = new SlackWebApiAcceptanceClient("xoxb-test");
    expect(typeof client.postMessage).toBe("function");
    expect(typeof client.fetchReplies).toBe("function");
  });

  it("uses the optional post token only for posting", async () => {
    const originalFetch = globalThis.fetch;
    const authorizations: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      authorizations.push(headers?.authorization || "");
      const url = String(input);
      if (url.includes("chat.postMessage")) {
        return new Response(JSON.stringify({ ok: true, channel: "C", ts: "1.000001" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, messages: [{ ts: "1.000002", text: "ok" }] }), { status: 200 });
    }) as typeof fetch;

    try {
      const client = new SlackWebApiAcceptanceClient("xoxb-read", { postToken: "xoxp-post" });
      await client.postMessage({ channel: "C", text: "hello" });
      await client.fetchReplies({ channel: "C", threadTs: "1.000001" });
      expect(authorizations).toEqual(["Bearer xoxp-post", "Bearer xoxb-read"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});


describe("loadSlackAcceptanceConfig file errors", () => {
  it("throws on missing file", async () => {
    await expect(
      (await import("./harness.js")).loadSlackAcceptanceConfig("/nonexistent/path.json", validEnv()),
    ).rejects.toThrow("not found");
  });
});

describe("timeout and progress diagnostics", () => {
  it("fills bounded request and total timeout defaults", () => {
    const config = parseSlackAcceptanceConfig(validConfig(), validEnv());
    expect(config.requestTimeoutMs).toBe(15_000);
    expect(config.totalTimeoutMs).toBe(600_000);
  });

  it("fails closed when postMessage never resolves", async () => {
    const client: SlackAcceptanceClient = {
      postMessage: async () => new Promise<SlackPostMessageResult>(() => {}),
      fetchReplies: async () => [],
    };
    const config = parseSlackAcceptanceConfig(validConfig({
      requestTimeoutMs: 20,
      totalTimeoutMs: 200,
      cases: [{ kind: "plain_chat", prompt: "test", finalRequired: true }],
    }), validEnv());

    const report = await runSlackAcceptanceHarness(client, config);

    expect(report.overallGate).toBe("fail");
    expect(report.cases[0].status).toBe("fail");
    expect(report.cases[0].errors.join("\n")).toContain("post_message_timeout");
    expect(report.cases[0].progress?.some((event) => event.event === "prompt_send_failed")).toBe(true);
  });

  it("records fetch timeout progress without treating unknown evidence as pass", async () => {
    const client: SlackAcceptanceClient = {
      postMessage: async (params) => ({ ok: true, ts: "1234567890.000001", threadTs: params.threadTs || "1234567890.000001", channel: params.channel }),
      fetchReplies: async () => new Promise<SlackMessageRecord[]>(() => {}),
    };
    const config = parseSlackAcceptanceConfig(validConfig({
      requestTimeoutMs: 20,
      totalTimeoutMs: 300,
      cases: [{ kind: "plain_chat", prompt: "test", ackRequired: false, finalRequired: true }],
    }), validEnv());

    const report = await runSlackAcceptanceHarness(client, config);

    expect(report.overallGate).toBe("fail");
    expect(report.cases[0].final.status).toBe("fail");
    expect(report.cases[0].progress?.some((event) => event.event === "final_fetch_failed")).toBe(true);
  });
});
