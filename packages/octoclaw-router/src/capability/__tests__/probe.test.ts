import { describe, expect, it } from "vitest";

import { resolveProviderForModel } from "../openclaw-bridge.js";
import { probeModel, type ProbeFetch } from "../probe.js";

const providerConfig = {
  providerId: "openai",
  baseUrl: "https://api.example.test/v1",
  authHeader: { name: "authorization", value: "secret-token" },
  format: "openai_chat" as const,
};

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

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
      fetch: async () => {
        calls += 1;
        return response(200, {});
      },
    });

    expect(calls).toBe(0);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PROBE_BUDGET_EXCEEDED" },
    });
  });

  it("marks a 200 canary response as available and does not expose auth", async () => {
    const result = await probeModel({
      modelKey: "openai/gpt-5-mini",
      providerConfig,
      estimatedBlendedUsdPerMTok: 1,
      fetch: async (_url, init) => {
        expect(JSON.stringify(init)).toContain("secret-token");
        return response(200, { choices: [{ message: { content: "pong" } }] });
      },
    });

    expect(result).toMatchObject({
      ok: true,
      authOk: "yes",
      modelExists: "yes",
      toolUseOk: "unknown",
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("classifies 401 and 404 without leaking credentials", async () => {
    const unauthorized = await probeModel({
      modelKey: "openai/gpt-5-mini",
      providerConfig,
      fetch: async () => response(401, { error: { message: "bad key secret-token" } }),
    });
    const missing = await probeModel({
      modelKey: "openai/gpt-5-mini",
      providerConfig,
      fetch: async () => response(404, { error: { message: "missing model" } }),
    });

    expect(unauthorized).toMatchObject({ ok: false, authOk: "no", modelExists: "unknown" });
    expect(missing).toMatchObject({ ok: false, authOk: "yes", modelExists: "no" });
    expect(JSON.stringify(unauthorized)).not.toContain("secret-token");
  });

  it("returns timeout result for aborted probes", async () => {
    const timeoutFetch: ProbeFetch = async () => {
      throw new DOMException("operation timed out", "AbortError");
    };

    const result = await probeModel({
      modelKey: "openai/gpt-5-mini",
      providerConfig,
      fetch: timeoutFetch,
    });

    expect(result).toMatchObject({
      ok: false,
      authOk: "unknown",
      modelExists: "unknown",
      error: { code: "PROBE_TIMEOUT" },
    });
  });
});
