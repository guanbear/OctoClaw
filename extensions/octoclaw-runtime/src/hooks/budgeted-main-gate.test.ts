import { describe, expect, it } from "vitest";

import { buildBudgetedMainState } from "../budgeted-main.js";
import {
  evaluateActiveBudgetedMainGate,
  evaluateEscalatedBudgetGate,
  evaluateReplyToolBudgetGate,
} from "./budgeted-main-gate.js";

describe("BudgetedMainGate", () => {
  it("passes native session tools through as control tools", () => {
    const budgetState = buildBudgetedMainState({
      now: 1000,
      decision: { route_decision: { decision_bucket: "budgeted_main_then_delegate" } },
      visibleStartAt: 1000,
      budgetStartSource: "test",
    });

    for (const toolName of ["sessions_spawn", "sessions_send", "sessions_yield", "session_status"]) {
      expect(evaluateActiveBudgetedMainGate({
        toolName,
        toolParams: {},
        budgetState,
        now: 2000,
      })).toEqual({ kind: "allow", budgetedMainHandledTool: false });
    }
  });

  it("converts octoclaw_dispatch into budget escalation evidence without blocking dispatch", () => {
    const budgetState = buildBudgetedMainState({
      now: 1000,
      decision: { route_decision: { decision_bucket: "budgeted_main_then_delegate" } },
      visibleStartAt: 1000,
      budgetStartSource: "test",
    });

    expect(evaluateActiveBudgetedMainGate({
      toolName: "octoclaw_dispatch",
      toolParams: { task: "continue" },
      budgetState,
      now: 40_000,
    })).toMatchObject({
      kind: "escalate_dispatch",
      reason: "wall_time_over_budget",
      block: false,
      budgetedMainHandledTool: false,
    });
  });

  it("blocks the ordinary tool that triggers active-budget risk escalation", () => {
    const budgetState = buildBudgetedMainState({
      now: 1000,
      decision: { route_decision: { decision_bucket: "budgeted_main_then_delegate" } },
      visibleStartAt: 1000,
      budgetStartSource: "test",
    });

    expect(evaluateActiveBudgetedMainGate({
      toolName: "edit",
      toolParams: { file: "src/app.ts" },
      budgetState,
      now: 2000,
    })).toMatchObject({
      kind: "block",
      reason: "write_tool_detected",
      block: true,
      budgetedMainHandledTool: true,
      statePatch: { blockedTools: ["edit"] },
    });
  });

  it("observes reply-route read-only tools and emits replay payload details", () => {
    const result = evaluateReplyToolBudgetGate({
      toolName: "exec",
      toolParams: { cmd: "rg NativeSpawnGate extensions/octoclaw-runtime/src" },
      state: {},
      decision: {
        route_decision: {
          route: "reply",
          decision_bucket: "budgeted_main_then_delegate",
        },
      },
      budgetedMainHandledTool: false,
      stateKey: "session-key",
      sessionId: "session-id",
      now: 2000,
    });

    expect(result).toMatchObject({
      kind: "observe",
      block: false,
      scheduleTimeout: true,
      replayEvents: [expect.objectContaining({
        event: "main_reply_tool_guard_observed",
        payload: expect.objectContaining({
          sessionKey: "session-key",
          sessionId: "session-id",
          route: "reply",
          toolName: "exec",
          toolCount: 1,
          readOnlyToolCount: 1,
        }),
      })],
    });
  });
});

describe("evaluateEscalatedBudgetGate", () => {
  function escalatedState() {
    const bs = buildBudgetedMainState({
      now: 1000,
      decision: { route_decision: { decision_bucket: "budgeted_main_then_delegate" } },
      visibleStartAt: 1000,
      budgetStartSource: "test",
    });
    return { ...bs, active: false, escalatedAt: 2000, reason: "multi_step_tool_chain" };
  }

  it("blocks ordinary tools after escalation when dispatch has not executed", () => {
    const result = evaluateEscalatedBudgetGate({
      toolName: "read",
      budgetState: escalatedState(),
      dispatchExecuted: false,
      spawnExecuted: false,
    });
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("block");
    expect(result?.blockReason).toContain("octoclaw_dispatch");
  });

  it("allows control tools (octoclaw_dispatch, sessions_spawn, etc.) after escalation", () => {
    for (const toolName of ["octoclaw_dispatch", "sessions_spawn", "sessions_send", "sessions_yield", "session_status"]) {
      const result = evaluateEscalatedBudgetGate({
        toolName,
        budgetState: escalatedState(),
        dispatchExecuted: false,
        spawnExecuted: false,
      });
      expect(result).toBeNull();
    }
  });

  it("stops blocking once dispatch has executed", () => {
    const result = evaluateEscalatedBudgetGate({
      toolName: "read",
      budgetState: escalatedState(),
      dispatchExecuted: true,
      spawnExecuted: false,
    });
    expect(result).toBeNull();
  });

  it("stops blocking once spawn has executed", () => {
    const result = evaluateEscalatedBudgetGate({
      toolName: "exec",
      budgetState: escalatedState(),
      dispatchExecuted: false,
      spawnExecuted: true,
    });
    expect(result).toBeNull();
  });

  it("does not block when budget has not escalated", () => {
    const bs = buildBudgetedMainState({
      now: 1000,
      decision: { route_decision: { decision_bucket: "budgeted_main_then_delegate" } },
      visibleStartAt: 1000,
      budgetStartSource: "test",
    });
    const result = evaluateEscalatedBudgetGate({
      toolName: "read",
      budgetState: bs,
      dispatchExecuted: false,
      spawnExecuted: false,
    });
    expect(result).toBeNull();
  });

  it("does not block when budget is completed", () => {
    const result = evaluateEscalatedBudgetGate({
      toolName: "read",
      budgetState: { ...escalatedState(), completedAt: 3000 },
      dispatchExecuted: false,
      spawnExecuted: false,
    });
    expect(result).toBeNull();
  });
});
