import fsSync from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getToolRegistrations } from "./registration.js";

describe("OpenClaw plugin manifest contracts", () => {
  it("declares every registered agent tool", () => {
    const manifestPath = fileURLToPath(new URL("../../openclaw.plugin.json", import.meta.url));
    const manifest = JSON.parse(fsSync.readFileSync(manifestPath, "utf8")) as {
      contracts?: {
        tools?: string[];
      };
    };

    const declared = [...(manifest.contracts?.tools ?? [])].sort();
    const registered = getToolRegistrations().map((tool) => tool.name).sort();

    expect(declared).toEqual(registered);
  });
});
