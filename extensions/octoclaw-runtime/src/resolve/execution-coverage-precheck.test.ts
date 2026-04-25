import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { JudgeExecutionLayer } from "@octoclaw/policy/judge";
import type { PolicyStateEntry } from "../state/policy-state.js";
import { policyState } from "../state/policy-state.js";
import { buildExecutionCoverageLayer } from "./execution-coverage-precheck.js";

const now = new Date("2026-04-25T12:00:00.000Z");

function clearPolicyState(): void {
  for (const { key } of policyState.entries()) {
    policyState.clear(key);
  }
}

function seedPolicyStateEntry(
  key: string,
  overrides: Partial<PolicyStateEntry> = {},
): void {
  policyState.set(key, {
    decision: {
      route_decision: { route: "reply" },
    },
    canonicalSessionKey: key,
    toolsUsed: ["web_fetch"],
    delegated: false,
    dispatchExecuted: false,
    ...overrides,
  });
}

function seedAt(
  key: string,
  completedAt: number,
  overrides: Partial<PolicyStateEntry> = {},
): void {
  vi.setSystemTime(completedAt);
  seedPolicyStateEntry(key, overrides);
  vi.setSystemTime(now);
}

function spawnGuardBlocks(decision: {
  _execution_coverage: Pick<JudgeExecutionLayer, "coverage" | "supports_provenance_reply">;
  request: { metadata: { conversation_control: { intent_class: string } } };
}): boolean {
  const hasSupportedExecutionReply = decision._execution_coverage.supports_provenance_reply === true;
  const executionTruthMissing = decision._execution_coverage.coverage === "none";
  const isExecutionFollowup = decision.request.metadata.conversation_control.intent_class === "execution_followup";
  return !hasSupportedExecutionReply && executionTruthMissing && isExecutionFollowup;
}

describe("buildExecutionCoverageLayer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    clearPolicyState();
  });

  afterEach(() => {
    clearPolicyState();
    vi.useRealTimers();
  });

  it("lets a thread follow-up see the root-turn receipt", () => {
    const rootKey = "slack:default:direct:U12345";
    seedAt(rootKey, Date.now() - 5_000, {
      createdAt: Date.now() - 10_000,
      session_binding_key: "slack:user:U12345",
    });

    const layer = buildExecutionCoverageLayer([
      "agent:main:slack:default:direct:U12345:thread:1234567890.123456",
    ]);

    expect(layer.coverage).not.toBe("none");
    expect(layer.supports_provenance_reply).toBe(true);
    expect(layer.tools_used).toContain("web_fetch");
  });

  it("resolves a thread follow-up through session_binding_key", () => {
    seedAt("receipt-key", Date.now() - 5_000, {
      canonicalSessionKey: "slack:default:direct:U12345",
      session_binding_key: "slack:user:U12345",
    });

    const layer = buildExecutionCoverageLayer([
      "agent:main:slack:default:direct:U12345:thread:ts",
    ]);

    expect(layer.coverage).not.toBe("none");
    expect(layer.supports_provenance_reply).toBe(true);
  });

  it("marks a 1-hour-old receipt as stale thread coverage", () => {
    const key = "stale-receipt";
    seedAt(key, Date.now() - 3_600_000, {
      createdAt: Date.now() - 3_601_000,
    });

    const dateNow = vi.spyOn(Date, "now");
    dateNow
      .mockReturnValueOnce(now.getTime())
      .mockReturnValueOnce(now.getTime() - 3_600_000 + 1);

    const layer = buildExecutionCoverageLayer([key]);
    dateNow.mockRestore();

    expect(layer.coverage).toBe("thread");
    expect(layer.freshness).toBe("stale");
  });

  it("marks a 2-minute-old receipt as recent_turn coverage", () => {
    const key = "recent-receipt";
    seedAt(key, Date.now() - 120_000);

    const layer = buildExecutionCoverageLayer([key]);

    expect(layer.coverage).toBe("recent_turn");
    expect(layer.freshness).toBe("recent");
  });

  it("marks a 5-second-old receipt as current_turn coverage", () => {
    const key = "current-receipt";
    seedAt(key, Date.now() - 5_000);

    const layer = buildExecutionCoverageLayer([key]);

    expect(layer.coverage).toBe("current_turn");
    expect(layer.freshness).toBe("current");
  });

  it("returns no coverage when no prior receipt exists", () => {
    const layer = buildExecutionCoverageLayer(["nonexistent-key"]);

    expect(layer.coverage).toBe("none");
    expect(layer.supports_provenance_reply).toBe(false);
    expect(layer.supports_status_reply).toBe(false);
    expect(layer.requires_control_plane_refresh).toBe(false);
    expect(layer.dispatch_executed).toBe(false);
    expect(layer.spawn_executed).toBe(false);
    expect(layer.result_materialized).toBe(false);
  });

  it("excludes the current turn ID when selecting prior receipts", () => {
    const key = "turn-filter-receipt";
    seedAt("turn-old-entry", Date.now() - 10_000, {
      canonicalSessionKey: key,
      turnId: "turn-old",
      toolsUsed: ["web_fetch"],
    });
    seedAt("turn-current-entry", Date.now() - 1_000, {
      canonicalSessionKey: key,
      turnId: "turn-current",
      toolsUsed: ["current_tool"],
    });

    const layer = buildExecutionCoverageLayer([key], "turn-current");

    expect(layer.coverage).toBe("current_turn");
    expect(layer.tools_used).toEqual(["web_fetch"]);
    expect(layer.evidence_summary).toContain("web_fetch");
    expect(layer.evidence_summary).not.toContain("current_tool");
  });
});

describe("structured intent spawn guard", () => {
  it("blocks execution_followup with missing coverage", () => {
    const decision = {
      _execution_coverage: { coverage: "none", supports_provenance_reply: false },
      request: { metadata: { conversation_control: { intent_class: "execution_followup" } } },
    } satisfies Parameters<typeof spawnGuardBlocks>[0];

    expect(spawnGuardBlocks(decision)).toBe(true);
  });

  it("does not block plain_chat with missing coverage", () => {
    const decision = {
      _execution_coverage: { coverage: "none", supports_provenance_reply: false },
      request: { metadata: { conversation_control: { intent_class: "plain_chat" } } },
    } satisfies Parameters<typeof spawnGuardBlocks>[0];

    expect(spawnGuardBlocks(decision)).toBe(false);
  });
});
