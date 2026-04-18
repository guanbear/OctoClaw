import { describe, expect, it } from "vitest";
import {
  DEFAULT_REF,
  buildStatusOutput,
  formatStatusOutput,
  resolveManageConfig,
} from "./index.js";

describe("manage tool", () => {
  it("resolveManageConfig with defaults", () => {
    const config = resolveManageConfig({ HOME: "/Users/tester" }, ["status"]);

    expect(config).toEqual({
      repoUrl: "https://github.com/guanbear/OctoClaw.git",
      ref: "release/0.3.0-ts-rebuild",
      installDir: "/Users/tester/.openclaw/repos/octoclaw",
      openclawHome: "/Users/tester/.openclaw",
    });
  });

  it("buildStatusOutput", () => {
    const status = buildStatusOutput({
      repoUrl: "https://github.com/guanbear/OctoClaw.git",
      ref: "release/0.3.0-ts-rebuild",
      installDir: "/Users/tester/.openclaw/repos/octoclaw",
      openclawHome: "/Users/tester/.openclaw",
    });

    expect(status).toEqual({
      ref: "release/0.3.0-ts-rebuild",
      commit: "unknown",
      installed: true,
      extensionPresent: true,
    });
  });

  it("formatStatusOutput produces human-readable output", () => {
    const output = formatStatusOutput({
      ref: "release/0.3.0-ts-rebuild",
      commit: "unknown",
      installed: true,
      extensionPresent: true,
    });

    expect(output).toContain("OctoClaw managed deployment status");
    expect(output).toContain("ref=release/0.3.0-ts-rebuild");
    expect(output).toContain("installed=true");
  });

  it("DEFAULT_REF is release/0.3.0-ts-rebuild", () => {
    expect(DEFAULT_REF).toBe("release/0.3.0-ts-rebuild");
  });
});
