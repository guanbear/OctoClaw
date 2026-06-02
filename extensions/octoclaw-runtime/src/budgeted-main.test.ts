import { afterEach, describe, expect, it } from "vitest";
import { classifyBudgetedMainTool, maybeStartBudgetedMain, readBudgetedMainState } from "./budgeted-main.js";
import { policyState } from "./state/policy-state.js";
import { type UnknownRecord } from "./util/type-coercion.js";

afterEach(() => {
  policyState.clear("session-mismatch-budget");
});

describe("classifyBudgetedMainTool", () => {
  it("treats structured OpenClaw gateway status with safe output truncation as read-only", () => {
    const classification = classifyBudgetedMainTool("exec", {
      command: "openclaw gateway status 2>&1 | head -30",
      timeout: 15,
    });

    expect(classification.readOnly).toBe(true);
    expect(classification.escalationReason).toBe("");
    expect(classification.multiStepToolDetected).toBe(false);
    expect(classification.longToolDetected).toBe(false);
    expect(classification.unknownToolRiskDetected).toBe(false);
  });

  it("does not mark OpenClaw mutating subcommands read-only just because the noun is known", () => {
    const classification = classifyBudgetedMainTool("exec", {
      command: "openclaw models fallbacks add zhipu/GLM-5.1",
    });

    expect(classification.readOnly).toBe(false);
    expect(classification.escalationReason).not.toBe("");
  });

  it("classifies Homebrew installs as mutating work instead of unknown shell risk", () => {
    const classification = classifyBudgetedMainTool("exec", {
      command: "brew install --cask docker",
      timeout: 120,
    });

    expect(classification.readOnly).toBe(false);
    expect(classification.writeToolDetected).toBe(true);
    expect(classification.unknownToolRiskDetected).toBe(false);
    expect(classification.escalationReason).toBe("write_tool_detected");
  });

  it("escalates unrecognized shell commands unless they are proven read-only", () => {
    const classification = classifyBudgetedMainTool("exec", {
      command: "some-new-installer provision docker-desktop",
      timeout: 120,
    });

    expect(classification.readOnly).toBe(false);
    expect(classification.counted).toBe(true);
    expect(classification.unknownToolRiskDetected).toBe(true);
    expect(classification.escalationReason).toBe("tool_risk_unknown");
  });

  describe("NFSV2-BUDGET-004: native session tools are not ordinary budgeted-main tools", () => {
    for (const toolName of ["sessions_spawn", "sessions_send", "sessions_yield", "session_status"]) {
      it(`does not count ${toolName} as an ordinary budgeted-main tool`, () => {
        const classification = classifyBudgetedMainTool(toolName, {});

        expect(classification.counted).toBe(false);
        expect(classification.escalationReason).toBe("");
        expect(classification.writeToolDetected).toBe(false);
        expect(classification.longToolDetected).toBe(false);
        expect(classification.multiStepToolDetected).toBe(false);
        expect(classification.unknownToolRiskDetected).toBe(false);
      });
    }
  });
});

describe("maybeStartBudgetedMain", () => {
  it("does not restart budgeted-main after native spawn args mismatch converged the turn", () => {
    const stateKey = "session-mismatch-budget";
    const state = {
      dispatchStatus: "native_spawn_args_mismatch_blocked",
      dispatch_status: "native_spawn_args_mismatch_blocked",
      nativeSpawnArgsMismatchBlocked: true,
      native_spawn_args_mismatch_blocked: true,
      spawnIntentId: "nsp_mismatch",
      workContractId: "wc_mismatch",
    };
    policyState.set(stateKey, state);

    maybeStartBudgetedMain({
      stateKey,
      ctx: { sessionKey: stateKey },
      state,
      decision: {
        route_decision: {
          route: "reply",
          decision_bucket: "budgeted_main_then_delegate",
        },
      },
    });

    expect(readBudgetedMainState((policyState.get(stateKey) ?? {}) as UnknownRecord)).toBeNull();
  });
});
