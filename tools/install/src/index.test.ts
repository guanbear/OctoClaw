import { describe, expect, it } from "vitest";
import {
  buildExtensionPaths,
  formatInstallSummary,
  resolveInstallConfig,
} from "./index.js";

describe("install tool", () => {
  it("resolveInstallConfig with HOME set", () => {
    const config = resolveInstallConfig({
      HOME: "/Users/tester",
      PWD: "/repo/octoclaw",
    });

    expect(config).toMatchObject({
      openclawHome: "/Users/tester/.openclaw",
      workspaceDir: "/repo/octoclaw",
      repoRoot: "/repo/octoclaw",
      extensionDir: "/repo/octoclaw/extensions/octoclaw-runtime",
      dryRun: false,
    });
  });

  it("resolveInstallConfig with OPENCLAW_HOME override", () => {
    const config = resolveInstallConfig({
      HOME: "/Users/tester",
      PWD: "/repo/octoclaw",
      OPENCLAW_HOME: "/custom/openclaw",
    });

    expect(config.openclawHome).toBe("/custom/openclaw");
  });

  it("buildExtensionPaths produces correct src and dest", () => {
    const paths = buildExtensionPaths({
      openclawHome: "/Users/tester/.openclaw",
      workspaceDir: "/repo/octoclaw",
      extensionDir: "/repo/octoclaw/extensions/octoclaw-runtime",
      repoRoot: "/repo/octoclaw",
    });

    expect(paths).toEqual({
      src: "/repo/octoclaw/extensions/octoclaw-runtime/dist",
      dest: "/Users/tester/.openclaw/extensions/octoclaw-runtime",
    });
  });

  it("formatInstallSummary output", () => {
    const summary = formatInstallSummary(
      {
        openclawHome: "/Users/tester/.openclaw",
        workspaceDir: "/repo/octoclaw",
        extensionDir: "/repo/octoclaw/extensions/octoclaw-runtime",
        repoRoot: "/repo/octoclaw",
        dryRun: true,
      },
      false,
    );

    expect(summary).toContain("OctoClaw install planned.");
    expect(summary).toContain("openclaw_home=/Users/tester/.openclaw");
    expect(summary).toContain("dest=/Users/tester/.openclaw/extensions/octoclaw-runtime");
    expect(summary).toContain("dry_run=true");
  });
});
