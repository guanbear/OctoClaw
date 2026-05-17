import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HERMES_CAPABILITY_MATRIX,
  hermesDryRunSpawn,
  hermesDryRunDeliver,
  resolveRuntimeHostMode,
  type HermesCapabilityMatrix,
} from "./hermes-capabilities.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CAPABILITY_KEYS: (keyof HermesCapabilityMatrix)[] = [
  "acp",
  "gatewayMessaging",
  "sessionStorage",
  "backgroundDelegation",
  "deliveryReceipts",
  "runtimeFallbacks",
];

describe("NTR-P4-006: Hermes capability matrix is explicit", () => {
  it("reports all six required capabilities", () => {
    for (const key of CAPABILITY_KEYS) {
      expect(HERMES_CAPABILITY_MATRIX[key]).toBeDefined();
      expect(["supported", "unknown"]).toContain(HERMES_CAPABILITY_MATRIX[key]);
    }
  });

  it("marks unknown capabilities as unknown, not assumed supported", () => {
    const unknowns = CAPABILITY_KEYS.filter(
      (k) => HERMES_CAPABILITY_MATRIX[k] === "unknown",
    );
    expect(unknowns.length).toBeGreaterThanOrEqual(1);
    for (const key of unknowns) {
      expect(HERMES_CAPABILITY_MATRIX[key]).toBe("unknown");
    }
  });

  it("includes notes explaining status", () => {
    expect(HERMES_CAPABILITY_MATRIX.notes.length).toBeGreaterThanOrEqual(6);
    for (const key of CAPABILITY_KEYS) {
      const label = key === "acp" ? "ACP"
        : key === "gatewayMessaging" ? "messaging"
        : key === "sessionStorage" ? "session"
        : key === "backgroundDelegation" ? "delegation"
        : key === "deliveryReceipts" ? "delivery"
        : "fallback";
      const hasNote = HERMES_CAPABILITY_MATRIX.notes.some((n) =>
        n.toLowerCase().includes(label.toLowerCase()),
      );
      expect(hasNote).toBe(true);
    }
  });
});

describe("NTR-P4-007: Hermes dry-run cannot spawn or deliver", () => {
  it("hermesDryRunSpawn fails closed", () => {
    const result = hermesDryRunSpawn({ task: "test" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("hermes_live_runtime_not_enabled");
    expect(result.detail).toContain("No child run was created");
  });

  it("hermesDryRunDeliver fails closed", () => {
    const result = hermesDryRunDeliver({ message: "test" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("hermes_live_runtime_not_enabled");
    expect(result.detail).toContain("No user-facing final was sent");
  });

  it("dry-run spawn does not return ok:true", () => {
    for (let i = 0; i < 10; i++) {
      expect(hermesDryRunSpawn({}).ok).toBe(false);
    }
  });

  it("dry-run deliver does not return ok:true", () => {
    for (let i = 0; i < 10; i++) {
      expect(hermesDryRunDeliver({}).ok).toBe(false);
    }
  });
});

describe("NTR-P4-008: OpenClaw live mode does not import Hermes runtime", () => {
  const hermesModulePath = path.join(
    __dirname,
    "hermes-capabilities.ts",
  );

  it("Hermes module contains no launcher/credential/migration/dependency strings", () => {
    const source = fs.readFileSync(hermesModulePath, "utf8");

    const forbidden = [
      "child_process",
      "spawn(",
      "exec(",
      "execSync(",
      "fork(",
      "credentials",
      "apiKey",
      "api_key",
      "token",
      "password",
      "secret",
      "migrate",
      "migration",
      "import(",
      "require(",
      "axios",
      "fetch(",
      "node-fetch",
      "got(",
      "request(",
    ];

    for (const pattern of forbidden) {
      expect(
        source.includes(pattern),
        `Hermes module should not contain "${pattern}"`,
      ).toBe(false);
    }
  });

  it("resolveRuntimeHostMode defaults to openclaw", () => {
    expect(resolveRuntimeHostMode({})).toBe("openclaw");
    expect(resolveRuntimeHostMode({ OCTOCLAW_RUNTIME_HOST_MODE: "openclaw" })).toBe("openclaw");
  });

  it("resolveRuntimeHostMode returns hermes_dry_run only when explicitly set", () => {
    expect(resolveRuntimeHostMode({ OCTOCLAW_RUNTIME_HOST_MODE: "hermes_dry_run" })).toBe("hermes_dry_run");
    expect(resolveRuntimeHostMode({ OCTOCLAW_RUNTIME_HOST_MODE: "unknown" })).toBe("openclaw");
  });
});
