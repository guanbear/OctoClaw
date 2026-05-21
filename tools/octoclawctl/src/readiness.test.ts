import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateReadinessReport } from "./readiness.js";

declare const process: { env: Record<string, string | undefined> };

describe("octoclaw readiness", () => {
  it("recognizes Slack credentials in OpenClaw native channel config", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `readiness-slack-native-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const openclawHome = path.join(tmpDir, ".openclaw");
    try {
      await fs.mkdir(openclawHome, { recursive: true });
      await fs.writeFile(path.join(openclawHome, "openclaw.json"), JSON.stringify({
        channels: { slack: { enabled: true, appToken: "xapp-native", botToken: "xoxb-native" } },
      }), "utf8");

      const report = await generateReadinessReport(openclawHome);

      expect(report.checks.find((item) => item.id === "im.slack")).toMatchObject({
        status: "pass",
        summary: "slack credentials configured",
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("recognizes Feishu credentials in OpenClaw native channel config", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `readiness-feishu-native-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const openclawHome = path.join(tmpDir, ".openclaw");
    try {
      await fs.mkdir(openclawHome, { recursive: true });
      await fs.writeFile(path.join(openclawHome, "openclaw.json"), JSON.stringify({
        channels: { feishu: { enabled: true, appId: "cli_native", appSecret: "secret" } },
      }), "utf8");

      const report = await generateReadinessReport(openclawHome);

      expect(report.checks.find((item) => item.id === "im.feishu")).toMatchObject({
        status: "pass",
        summary: "feishu credentials configured",
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("recognizes Slack credentials supplied by the service environment", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `readiness-slack-env-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const openclawHome = path.join(tmpDir, ".openclaw");
    const previous = process.env.SLACK_BOT_TOKEN;
    try {
      await fs.mkdir(openclawHome, { recursive: true });
      await fs.writeFile(path.join(openclawHome, "openclaw.json"), JSON.stringify({ channels: { slack: {} } }), "utf8");
      process.env.SLACK_BOT_TOKEN = "xoxb-service-token";

      const report = await generateReadinessReport(openclawHome);

      expect(report.checks.find((item) => item.id === "im.slack")).toMatchObject({
        status: "pass",
        summary: "slack credentials configured via environment",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.SLACK_BOT_TOKEN;
      } else {
        process.env.SLACK_BOT_TOKEN = previous;
      }
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("recognizes Feishu credentials supplied by the service environment", async () => {
    const tmpDir = path.join(os.homedir(), ".octoclawctl-test-tmp", `readiness-feishu-env-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const openclawHome = path.join(tmpDir, ".openclaw");
    const previousAppId = process.env.FEISHU_APP_ID;
    const previousAppSecret = process.env.FEISHU_APP_SECRET;
    try {
      await fs.mkdir(openclawHome, { recursive: true });
      await fs.writeFile(path.join(openclawHome, "openclaw.json"), JSON.stringify({ channels: { feishu: {} } }), "utf8");
      process.env.FEISHU_APP_ID = "cli_xxx";
      process.env.FEISHU_APP_SECRET = "secret";

      const report = await generateReadinessReport(openclawHome);

      expect(report.checks.find((item) => item.id === "im.feishu")).toMatchObject({
        status: "pass",
        summary: "feishu credentials configured via environment",
      });
    } finally {
      if (previousAppId === undefined) {
        delete process.env.FEISHU_APP_ID;
      } else {
        process.env.FEISHU_APP_ID = previousAppId;
      }
      if (previousAppSecret === undefined) {
        delete process.env.FEISHU_APP_SECRET;
      } else {
        process.env.FEISHU_APP_SECRET = previousAppSecret;
      }
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
