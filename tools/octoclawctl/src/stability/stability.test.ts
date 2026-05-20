import { describe, expect, it } from "vitest";
import {
  buildCatalogCasePack,
  sanitizeStabilityArtifact,
  validateStabilityCasePack,
} from "./index.js";

describe("stability smoke v2 catalog", () => {
  it("SSV2-001: loads the post-deploy catalog with core blocker/major cases", () => {
    const pack = buildCatalogCasePack("post_deploy", { generatedAt: "2026-05-20T00:00:00.000Z" });

    expect(pack.schemaVersion).toBe("octoclaw.stability_smoke.case_pack/v2");
    expect(pack.runKind).toBe("post_deploy");
    expect(pack.cases.map((item) => item.id)).toEqual([
      "reply_core.simple_chat",
      "streaming_core.long_reply",
      "delegate_core.native_final",
      "footer_truth.current_model",
      "status_core.read_only",
    ]);
    expect(pack.cases.every((item) => item.severity === "blocker" || item.severity === "major")).toBe(true);
  });

  it("SSV2-002: rejects invalid AI case packs and leaves callers with catalog fallback", () => {
    const result = validateStabilityCasePack({
      schemaVersion: "octoclaw.stability_smoke.case_pack/v2",
      generatedAt: "2026-05-20T00:00:00.000Z",
      generatedBy: "glm-5.1",
      runKind: "nightly",
      cases: [
        {
          id: "bad.mode",
          mode: "made_up",
          severity: "major",
          tags: ["bad"],
          expect: {},
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("unknown mode");

    const fallback = buildCatalogCasePack("nightly", { generatedAt: "2026-05-20T00:00:00.000Z" });
    expect(fallback.cases.some((item) => item.id === "delegate_core.native_final")).toBe(true);
  });

  it("SSV2-003: enforces the live Slack case cap", () => {
    const cases = Array.from({ length: 12 }, (_, index) => ({
      id: `live.${index}`,
      mode: "live_slack",
      severity: "major",
      tags: ["generated"],
      prompt: `case ${index}`,
      maxRuntimeMs: 60_000,
      expect: {},
    }));

    const result = validateStabilityCasePack({
      schemaVersion: "octoclaw.stability_smoke.case_pack/v2",
      generatedAt: "2026-05-20T00:00:00.000Z",
      generatedBy: "glm-5.1",
      runKind: "nightly",
      cases,
    }, { maxLiveCases: 8 });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("live case cap exceeded");
  });

  it("requires live Slack cases to include prompt and max runtime", () => {
    const result = validateStabilityCasePack({
      schemaVersion: "octoclaw.stability_smoke.case_pack/v2",
      generatedAt: "2026-05-20T00:00:00.000Z",
      generatedBy: "manual",
      runKind: "manual",
      cases: [
        {
          id: "live.missing-contract",
          mode: "live_slack",
          severity: "major",
          tags: ["live"],
          expect: {},
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("live_slack requires prompt");
    expect(result.errors.join("\n")).toContain("live_slack requires positive maxRuntimeMs");
  });

  it("rejects live provider probes unless explicitly allowed", () => {
    const result = validateStabilityCasePack({
      schemaVersion: "octoclaw.stability_smoke.case_pack/v2",
      generatedAt: "2026-05-20T00:00:00.000Z",
      generatedBy: "manual",
      runKind: "manual",
      cases: [
        {
          id: "provider.live-probe",
          mode: "provider",
          severity: "major",
          tags: ["provider"],
          expect: { providerProbe: "live" },
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("live provider probe requires allowLiveProviderProbe=true");
  });

  it("SSV2-004: redacts secrets and strips transcript/prompt-like fields", () => {
    const sanitized = sanitizeStabilityArtifact({
      error: "failed with xoxb-1234567890-secret and sk-1234567890abcdefghijkl",
      apiKey: "sk-should-not-survive-1234567890",
      prompt: "please do a private thing",
      rawTranscript: "full transcript",
      nested: {
        authorization: "Bearer secret-token",
        fullResponse: "private model output",
      },
    }) as Record<string, unknown>;

    expect(JSON.stringify(sanitized)).not.toContain("xoxb-1234567890-secret");
    expect(JSON.stringify(sanitized)).not.toContain("sk-1234567890abcdefghijkl");
    expect(sanitized.apiKey).toBe("[REDACTED]");
    expect(sanitized.prompt).toMatch(/^\[STRIPPED:sha256:/u);
    expect(sanitized.rawTranscript).toBe("[STRIPPED]");
    expect(JSON.stringify(sanitized)).not.toContain("private model output");
  });
});
