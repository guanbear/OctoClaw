import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const runtimeSrc = path.join(process.cwd(), "extensions/octoclaw-runtime/src");
const repoRoot = process.cwd();

function readRuntimeFile(rel: string): string {
  return fs.readFileSync(path.join(runtimeSrc, rel), "utf8");
}

describe("NTR-P5-005: retired transitional flags are absent from live runtime code", () => {
  it("removes deliveryRelayMode user config after native delivery trust becomes default", () => {
    const deliveryRelayVerdict = readRuntimeFile("im/delivery-relay-verdict.ts");

    expect(deliveryRelayVerdict).not.toContain("OCTOCLAW_DELIVERY_RELAY_MODE");
    expect(deliveryRelayVerdict).not.toContain("resolveDeliveryRelayMode");
    expect(deliveryRelayVerdict).not.toContain("DeliveryRelayMode");
  });
});

describe("NTR-P5-006: live docs do not advertise removed relay paths", () => {
  it("keeps removed delivery relay switches out of user-facing docs", () => {
    const userDocs = [
      "README.md",
      "README.zh-CN.md",
      "docs/octoclaw-design-foundation.md",
      "docs/octoclaw-ts-rebuild-design-v2.md",
    ];

    for (const rel of userDocs) {
      const doc = fs.readFileSync(path.join(repoRoot, rel), "utf8");

      expect(doc, rel).not.toContain("OCTOCLAW_DELIVERY_RELAY_MODE");
      expect(doc, rel).not.toContain("deliveryRelayMode");
      expect(doc, rel).not.toMatch(/delivery relay\s+(is|as|->|primary|critical path|notifies|负责|发送|关键路径)/i);
    }
  });
});

describe("NTR-P5-002: migrated OpenClaw reads stay behind the runtime adapter", () => {
  it("keeps status and fallback direct reads out of live call sites", () => {
    const liveFiles = [
      "tools/runtime-status.ts",
      "tools/handlers/dispatch.ts",
      "resolve/native-announce.ts",
    ];

    for (const rel of liveFiles) {
      const src = readRuntimeFile(rel);

      expect(src, rel).not.toContain("projectNativeStatus(");
      expect(src, rel).not.toContain("readNativeAcpFallbackSnapshot(");
    }
  });
});

describe("NTR-P5-002: deleted legacy runtime heuristics stay out of new-task truth", () => {
  it("keeps assistant/transcript/session-label text out of hot runtime truth branches", () => {
    const runtimeTaskProjection = readRuntimeFile("tools/runtime-task-projection.ts");
    const sessionResolver = readRuntimeFile("resolve/session.ts");

    expect(runtimeTaskProjection).not.toMatch(/transcript[^;\n]*(spawn|materialized|delivered|delivery|result)/i);
    expect(runtimeTaskProjection).not.toMatch(/assistant[^;\n]*(spawn|materialized|delivered|delivery|result)/i);
    expect(sessionResolver).not.toContain("textMatchedSubagent");
    expect(sessionResolver).not.toMatch(/subagent-old-label/);
  });
});

describe("NTR-P5-003: deleted ACP retry branch stays delegated to native fallback", () => {
  it("keeps self-managed backend retry artifacts out of the dispatch live path", () => {
    const dispatch = readRuntimeFile("tools/handlers/dispatch.ts");

    expect(dispatch).not.toContain("legacy_outbox_queued");
    expect(dispatch).not.toContain("child_finalizer_scheduled");
    expect(dispatch).not.toContain("backend_unavailable_retry");
    expect(dispatch).toContain("nativeAcpFallbackMetadata");
    expect(dispatch).toContain("native_acp_fallback");
  });
});

describe("NTR-P5-004: deleted relay special branches stay collapsed into native delivery verdict", () => {
  it("keeps presentation-specific compensation branches out of delivery verdict logic", () => {
    const deliveryRelayVerdict = readRuntimeFile("im/delivery-relay-verdict.ts");

    expect(deliveryRelayVerdict).not.toMatch(/presentation\s*===\s*["']message_tool["']/);
    expect(deliveryRelayVerdict).not.toMatch(/presentation\s*===\s*["']rich["']/);
    expect(deliveryRelayVerdict).not.toContain("shouldSendRelayCompensation");
  });
});

describe("NTR-P5-001/HD-2: deleted task-state rebuild and crash recovery stay absent", () => {
  const deletedSymbols = [
    "rebuildTaskStateProjection",
    "writeRebuiltTaskState",
    "performCrashRecovery",
    "inspectLedgerHealth",
    "operatorRebuildProjection",
    "OCTOCLAW_TASK_STATE_REBUILD",
    "octoclaw_crash_recovery",
  ];

  const liveRuntimeFiles = [
    "tools/runtime-status.ts",
    "ack/ack-watchdog.ts",
    "tools/registration.ts",
    "runtime-ledger/index.ts",
    "runtime-ledger/feature-flags.ts",
  ];

  for (const symbol of deletedSymbols) {
    it(`keeps ${symbol} out of live runtime code`, () => {
      for (const rel of liveRuntimeFiles) {
        const src = readRuntimeFile(rel);
        expect(src, `${rel} should not contain ${symbol}`).not.toContain(symbol);
      }
    });
  }

  it("keeps deleted module files absent from runtime-ledger", () => {
    const deletedFiles = [
      "projection-rebuild.ts",
      "crash-recovery.ts",
      "operator-diagnostics.ts",
    ];

    for (const file of deletedFiles) {
      const fullPath = path.join(runtimeSrc, "runtime-ledger", file);
      expect(fs.existsSync(fullPath), `${file} should not exist`).toBe(false);
    }
  });
});

describe("NTR-P5-001/HD-3: unused experimental adapter layers stay deleted", () => {
  const deletedPaths = [
    "fast-delegate/draft.ts",
    "fast-delegate/probe.ts",
    "fast-delegate/draft.test.ts",
    "fast-delegate/probe.test.ts",
    "fast-delegate/no-double-judge.test.ts",
    "work-contract/native-taskflow-adapter.ts",
    "work-contract/native-taskflow-adapter.test.ts",
    "ports/openclaw-runtime-taskflow-port.ts",
    "core/im/adapter.ts",
    "core/im/index.ts",
  ];

  for (const rel of deletedPaths) {
    it(`keeps ${rel} absent`, () => {
      expect(fs.existsSync(path.join(runtimeSrc, rel)), `${rel} should not exist`).toBe(false);
    });
  }
});

describe("NTR-P5-001/HD-4: retired runtime-ledger diagnostic tails stay deleted", () => {
  const deletedPaths = [
    "runtime-ledger/shadow-diff.ts",
    "runtime-ledger/native-reconcile.ts",
    "runtime-ledger/__tests__/shadow-diff.test.ts",
    "runtime-ledger/__tests__/native-reconcile.test.ts",
  ];

  for (const rel of deletedPaths) {
    it(`keeps ${rel} absent`, () => {
      expect(fs.existsSync(path.join(runtimeSrc, rel)), `${rel} should not exist`).toBe(false);
    });
  }
});

describe("NTR-P5-001/HD-5: retired webhook/state surface exports stay deleted", () => {
  const deletedPaths = [
    "adapter/webhook-surface.ts",
    "adapter/webhook-surface.test.ts",
  ];

  for (const rel of deletedPaths) {
    it(`keeps ${rel} absent`, () => {
      expect(fs.existsSync(path.join(runtimeSrc, rel)), `${rel} should not exist`).toBe(false);
    });
  }
});

describe("NTR-P5-001/HD-6: retired TS runtime-core compatibility layer stays deleted", () => {
  const deletedPaths = [
    "plugin.ts",
    "plugin.test.ts",
    "adapter/runtime-taskflow.ts",
    "adapter/runtime-taskflow.test.ts",
    "core/workflow/index.ts",
    "core/workflow/index.test.mjs",
    "core/tasks/index.ts",
    "core/requests/index.ts",
    "core/telemetry/index.ts",
    "core/recovery/index.ts",
    "core/delegate/index.ts",
    "core/delegate/query.ts",
    "core/ack/index.ts",
  ];

  for (const rel of deletedPaths) {
    it(`keeps ${rel} absent`, () => {
      expect(fs.existsSync(path.join(runtimeSrc, rel)), `${rel} should not exist`).toBe(false);
    });
  }
});
