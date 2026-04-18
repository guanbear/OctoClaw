import { describe, expect, it } from "vitest";
import { DEFAULT_OCTOCLAW_RUNTIME_CONFIG, resolveRuntimeConfig } from "./index.js";

describe("runtime config", () => {
  it("loads and validates runtime policy settings", () => {
    const config = resolveRuntimeConfig({
      defaultChannel: "slack",
      defaultNotifyPolicy: "default",
      defaultRuntime: "subagent",
    });

    expect(config).toEqual({
      defaultChannel: "slack",
      defaultNotifyPolicy: "default",
      defaultRuntime: "subagent",
    });
  });

  it("uses correct default values", () => {
    expect(DEFAULT_OCTOCLAW_RUNTIME_CONFIG).toEqual({
      defaultChannel: "direct",
      defaultNotifyPolicy: "silent",
      defaultRuntime: "subagent",
    });
    expect(resolveRuntimeConfig()).toEqual(DEFAULT_OCTOCLAW_RUNTIME_CONFIG);
  });
});
