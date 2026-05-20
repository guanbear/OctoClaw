import { execFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { probeModel } from "../probe.js";

const providerConfig = {
  providerId: "openai",
  baseUrl: "https://api.example.test/v1",
  authHeader: { name: "authorization", value: "secret-token" },
  format: "openai_chat" as const,
};

describe("default OpenClaw probe runner", () => {
  it("does not treat spawn failures as successful probes", async () => {
    vi.mocked(execFile).mockImplementation((_command, _args, _options, callback) => {
      const error = Object.assign(new Error("spawn openclaw ENOENT"), { code: "ENOENT" });
      callback(error, "", "");
      return undefined as ReturnType<typeof execFile>;
    });

    const result = await probeModel({
      modelKey: "openai/gpt-5-mini",
      providerConfig,
    });

    expect(result).toMatchObject({
      ok: false,
      authOk: "unknown",
      modelExists: "unknown",
      error: { code: "PROBE_EXCEPTION" },
    });
  });
});
