import { describe, expect, it } from "vitest";
import {
  preHintAllowedTools,
  runnerWorkflowTools,
  workflowEnforcementRule,
} from "./replay-logger.js";

describe("WorkContract tool guard projection", () => {
  it("adds WorkContract allowed tools to guard allowlists", () => {
    const decision = {
      work_contract: {
        workContractId: "wc-tool-1",
        route: "delegate",
        allowedTools: ["octoclaw_status", "octoclaw_custom_status"],
      },
      tool_policy: {
        must_delegate_via: "octoclaw_dispatch",
        allowed_control_tools: ["octoclaw_task_action"],
      },
    };

    expect(preHintAllowedTools(decision, "octoclaw_route_hint").has("octoclaw_custom_status")).toBe(true);
    expect(runnerWorkflowTools(decision, "octoclaw_route_hint").has("octoclaw_custom_status")).toBe(true);
  });

  it("blocks tools forbidden by WorkContract projection", () => {
    const rule = workflowEnforcementRule(
      {
        work_contract: {
          workContractId: "wc-tool-2",
          route: "reply",
          forbiddenTools: ["octoclaw_dispatch"],
        },
        route_decision: { route: "reply" },
        tool_policy: { allowed_control_tools: ["octoclaw_dispatch"] },
      },
      "octoclaw_dispatch",
      "octoclaw_route_hint",
    );

    expect(rule.block).toBe(true);
  });
});
