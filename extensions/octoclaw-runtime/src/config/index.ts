export interface OctoClawRuntimeConfig {
  defaultChannel: string;
  defaultNotifyPolicy: "silent" | "default";
  defaultRuntime: "subagent";
}

export const DEFAULT_OCTOCLAW_RUNTIME_CONFIG: OctoClawRuntimeConfig = {
  defaultChannel: "direct",
  defaultNotifyPolicy: "silent",
  defaultRuntime: "subagent",
};

export function resolveRuntimeConfig(
  overrides: Partial<OctoClawRuntimeConfig> = {},
): OctoClawRuntimeConfig {
  return {
    ...DEFAULT_OCTOCLAW_RUNTIME_CONFIG,
    ...overrides,
  };
}
