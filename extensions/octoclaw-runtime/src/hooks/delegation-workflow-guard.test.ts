import { describe, expect, it } from "vitest";

import { evaluateDelegationWorkflowGuard } from "./delegation-workflow-guard.js";

describe("DelegationWorkflowGuard", () => {
  it("records advisory instead of blocking octoclaw_dispatch when WorkContract forbids it", () => {
    expect(evaluateDelegationWorkflowGuard({
      toolName: "octoclaw_dispatch",
      paramsText: "{}",
      decision: {
        route_decision: { route: "delegate" },
        work_contract: {
          route: "delegate",
          workContractId: "wc-1",
          forbiddenTools: ["octoclaw_dispatch"],
        },
      },
      toolPolicy: {},
      routeHintTool: "octoclaw_route_hint",
      delegationEnforcementEnabled: true,
      stateKey: "session-key",
      sessionId: "session-id",
    })).toMatchObject({
      kind: "observe",
      replayEvents: [expect.objectContaining({
        event: "work_contract_forbidden_dispatch_advisory",
      })],
    });
  });

  it("blocks manual delegation patterns on delegated routes", () => {
    expect(evaluateDelegationWorkflowGuard({
      toolName: "exec",
      paramsText: "sessions_spawn delegated work",
      decision: {
        route_decision: { route: "delegate" },
      },
      toolPolicy: {
        must_delegate_via: "octoclaw_dispatch",
        block_tool_patterns: ["sessions_spawn"],
      },
      routeHintTool: "octoclaw_route_hint",
      delegationEnforcementEnabled: true,
      stateKey: "session-key",
      sessionId: "session-id",
    })).toMatchObject({
      kind: "block",
      block: true,
      blockReason: "OctoClaw runtime policy blocked a manual delegation pattern. Use octoclaw_dispatch instead.",
      replayEvents: [expect.objectContaining({
        event: "tool_blocked_manual_delegation",
      })],
    });
  });

  it("marks delegate tool calls for orchestrator side effects", () => {
    expect(evaluateDelegationWorkflowGuard({
      toolName: "octoclaw_dispatch",
      paramsText: "{}",
      decision: {
        route_decision: { route: "delegate" },
        hook_interface: { before_tool_call: { delegate_required: true } },
        tool_policy: { must_delegate_via: "octoclaw_dispatch" },
      },
      toolPolicy: { must_delegate_via: "octoclaw_dispatch" },
      routeHintTool: "octoclaw_route_hint",
      delegationEnforcementEnabled: true,
      stateKey: "session-key",
      sessionId: "session-id",
    })).toMatchObject({
      kind: "delegate_tool",
      delegateTool: "octoclaw_dispatch",
    });
  });

  it("blocks ordinary tools when delegate workflow is required", () => {
    expect(evaluateDelegationWorkflowGuard({
      toolName: "edit",
      paramsText: "{}",
      decision: {
        route_decision: { route: "delegate" },
        hook_interface: { before_tool_call: { delegate_required: true } },
        tool_policy: { must_delegate_via: "octoclaw_dispatch" },
      },
      toolPolicy: { must_delegate_via: "octoclaw_dispatch" },
      routeHintTool: "octoclaw_route_hint",
      delegationEnforcementEnabled: true,
      stateKey: "session-key",
      sessionId: "session-id",
    })).toMatchObject({
      kind: "block",
      block: true,
      statePatch: { blockedTools: ["edit"] },
      replayEvents: [expect.objectContaining({
        event: "tool_blocked_delegation_policy",
      })],
    });
  });
});
