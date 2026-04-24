// @ts-expect-error Vitest runs in Node, but this repo does not install Node type definitions.
import path from "node:path";
import { defineConfig } from "vitest/config";

const root = new URL(".", import.meta.url);
const sourcePath = (relativePath: string) => path.resolve(root.pathname, relativePath);

export default defineConfig({
  resolve: {
    alias: [
      { find: "@octoclaw/contracts/artifacts", replacement: sourcePath("packages/octoclaw-contracts/src/artifacts.ts") },
      { find: "@octoclaw/contracts/delegate", replacement: sourcePath("packages/octoclaw-contracts/src/delegate.ts") },
      { find: "@octoclaw/contracts/delegate-context", replacement: sourcePath("packages/octoclaw-contracts/src/delegate-context.ts") },
      { find: "@octoclaw/contracts/deliveries", replacement: sourcePath("packages/octoclaw-contracts/src/deliveries.ts") },
      { find: "@octoclaw/contracts/events", replacement: sourcePath("packages/octoclaw-contracts/src/events.ts") },
      { find: "@octoclaw/contracts/fixtures", replacement: sourcePath("packages/octoclaw-contracts/src/fixtures.ts") },
      { find: "@octoclaw/contracts/results", replacement: sourcePath("packages/octoclaw-contracts/src/results.ts") },
      { find: "@octoclaw/contracts/route-seal", replacement: sourcePath("packages/octoclaw-contracts/src/route-seal.ts") },
      { find: "@octoclaw/contracts/schemas", replacement: sourcePath("packages/octoclaw-contracts/src/schemas.ts") },
      { find: "@octoclaw/contracts/telemetry", replacement: sourcePath("packages/octoclaw-contracts/src/telemetry.ts") },
      { find: "@octoclaw/contracts/thread-binding", replacement: sourcePath("packages/octoclaw-contracts/src/thread-binding.ts") },
      { find: "@octoclaw/contracts", replacement: sourcePath("packages/octoclaw-contracts/src/schemas.ts") },
      { find: "@octoclaw/policy/admission", replacement: sourcePath("packages/octoclaw-policy/src/admission/index.ts") },
      { find: "@octoclaw/policy/caps", replacement: sourcePath("packages/octoclaw-policy/src/caps/index.ts") },
      { find: "@octoclaw/policy/intent", replacement: sourcePath("packages/octoclaw-policy/src/intent/index.ts") },
      { find: "@octoclaw/policy/judge", replacement: sourcePath("packages/octoclaw-policy/src/judge/index.ts") },
      { find: "@octoclaw/policy/judge-prompt", replacement: sourcePath("packages/octoclaw-policy/src/judge/judge-prompt.ts") },
      { find: "@octoclaw/policy/judge-schema", replacement: sourcePath("packages/octoclaw-policy/src/judge/judge-schema.ts") },
      { find: "@octoclaw/policy/model", replacement: sourcePath("packages/octoclaw-policy/src/model/index.ts") },
      { find: "@octoclaw/policy/roles", replacement: sourcePath("packages/octoclaw-policy/src/roles/index.ts") },
      { find: "@octoclaw/policy/route", replacement: sourcePath("packages/octoclaw-policy/src/route/index.ts") },
      { find: "@octoclaw/runtime-core/workflow", replacement: sourcePath("packages/octoclaw-runtime-core/src/workflow/index.ts") },
      { find: "@octoclaw/runtime-core/delegate", replacement: sourcePath("packages/octoclaw-runtime-core/src/delegate/index.ts") },
      { find: "@octoclaw/runtime-core/recovery", replacement: sourcePath("packages/octoclaw-runtime-core/src/recovery/index.ts") },
      { find: "@octoclaw/runtime-core/requests", replacement: sourcePath("packages/octoclaw-runtime-core/src/requests/index.ts") },
      { find: "@octoclaw/runtime-core", replacement: sourcePath("packages/octoclaw-runtime-core/src/index.ts") },
      { find: "@octoclaw/delegation", replacement: sourcePath("extensions/octoclaw-delegation/src/index.ts") },
      { find: "@octoclaw/fast-reply", replacement: sourcePath("extensions/octoclaw-fast-reply/src/index.ts") },
      { find: "@octoclaw/status-surface", replacement: sourcePath("extensions/octoclaw-status-surface/src/index.ts") },
    ],
  },
  test: {
    globals: true,
    include: [
      "packages/*/src/**/*.test.ts",
      "extensions/*/src/**/*.test.ts",
      "tools/*/src/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "extensions/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts"],
    },
  },
});
