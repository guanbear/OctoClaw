import { describe, expect, it } from "vitest";

import { resolveProviderForModel } from "../openclaw-bridge.js";
import { probeModel, type ProbeCommandRunner } from "../probe.js";
import type { HealthEventInput } from "../../health/event.js";

const providerConfig = {
  providerId: "openai",
  baseUrl: "https://api.example.test/v1",
  authHeader: { name: "authorization", value: "secret-token" },
  format: "openai_chat" as const,
};

describe("resolveProviderForModel", () => {
  it("resolves configured provider blocks without mutating config", () => {
    const config = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.example.test/v1",
            authHeader: { name: "authorization", value: "secret-token" },
            models: [{ id: "gpt-5-mini" }],
          },
        },
      },
    };

    expect(resolveProviderForModel("openai/gpt-5-mini", config)).toEqual(providerConfig);
    expect(config.models.providers.openai.models).toEqual([{ id: "gpt-5-mini" }]);
  });

  it("resolves OpenAI-compatible proxy providers for same-provider proposal models not yet configured", () => {
    const config = {
      models: {
        providers: {
          cliproxyapi: {
            baseUrl: "https://clip.example.test/v1",
            apiKey: "clip-secret",
            models: [{ id: "gpt-5.5" }],
          },
        },
      },
    };

    expect(resolveProviderForModel("cliproxyapi/gpt-5-mini", config)).toEqual({
      providerId: "cliproxyapi",
      baseUrl: "https://clip.example.test/v1",
      authHeader: { name: "authorization", value: "Bearer clip-secret" },
      format: "openai_chat",
    });
    expect(config.models.providers.cliproxyapi.models).toEqual([{ id: "gpt-5.5" }]);
  });
});

describe("probeModel", () => {
  it("refuses before sending when estimated cost exceeds budget", async () => {
    let calls = 0;
    const result = await probeModel({
      modelKey: "openai/gpt-5-mini",
      providerConfig,
      budgetUsdMax: 0.000001,
      estimatedBlendedUsdPerMTok: 100,
      runOpenClaw: async () => {
        calls += 1;
        return { exitCode: 0, stdout: "{}" };
      },
    });

    expect(calls).toBe(0);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PROBE_BUDGET_EXCEEDED" },
    });
  });

  it("runs OpenClaw native infer canary and records probe success health", async () => {
    const calls: Array<{ args: string[]; timeoutMs: number }> = [];
    const healthEvents: HealthEventInput[] = [];
    const result = await probeModel({
      modelKey: "openai/gpt-5-mini",
      providerConfig,
      estimatedBlendedUsdPerMTok: 1,
      runOpenClaw: async (args, options) => {
        calls.push({ args, timeoutMs: options.timeoutMs });
        return { exitCode: 0, stdout: JSON.stringify({ output: "pong" }) };
      },
      recordHealthEvent: (event) => healthEvents.push(event),
    });

    expect(result).toMatchObject({
      ok: true,
      authOk: "yes",
      modelExists: "yes",
      toolUseOk: "unknown",
    });
    expect(calls).toEqual([{
      args: ["infer", "model", "run", "--model", "openai/gpt-5-mini", "--prompt", "Reply with exactly: pong", "--json"],
      timeoutMs: 15000,
    }]);
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(healthEvents).toHaveLength(1);
    expect(healthEvents[0]).toMatchObject({
      modelKey: "openai/gpt-5-mini",
      source: "probe",
      success: true,
    });
  });

  it("classifies OpenClaw failures without leaking credentials and records health failure", async () => {
    const healthEvents: HealthEventInput[] = [];
    const result = await probeModel({
      modelKey: "openai/gpt-5-mini",
      providerConfig,
      runOpenClaw: async () => ({ exitCode: 1, stdout: "", stderr: "bad key secret-token" }),
      recordHealthEvent: (event) => healthEvents.push(event),
    });

    expect(result).toMatchObject({ ok: false, authOk: "no", modelExists: "unknown" });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(healthEvents[0]).toMatchObject({
      modelKey: "openai/gpt-5-mini",
      source: "probe",
      success: false,
      errorCode: "PROBE_AUTH_FAILED",
    });
  });

  it("classifies no text output as reached model but unusable for routing", async () => {
    const result = await probeModel({
      modelKey: "openai/gpt-5-mini",
      providerConfig,
      runOpenClaw: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: 'Error: No text output returned for provider "openai" model "gpt-5-mini".',
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      authOk: "yes",
      modelExists: "yes",
      error: { code: "PROBE_NO_TEXT_OUTPUT" },
    });
  });

  it("returns timeout result for aborted probes", async () => {
    const timeoutRunner: ProbeCommandRunner = async () => {
      const error = new Error("operation timed out");
      error.name = "AbortError";
      throw error;
    };

    const result = await probeModel({
      modelKey: "openai/gpt-5-mini",
      providerConfig,
      runOpenClaw: timeoutRunner,
    });

    expect(result).toMatchObject({
      ok: false,
      authOk: "unknown",
      modelExists: "unknown",
      error: { code: "PROBE_TIMEOUT" },
    });
  });
});
