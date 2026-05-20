import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendJsonl } from "./replay.js";
import {
  preHintAllowedTools,
  runnerWorkflowTools,
  workflowEnforcementRule,
} from "./policy-utils.js";

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

  it("blocks non-arbiter tools forbidden by WorkContract projection", () => {
    const rule = workflowEnforcementRule(
      {
        work_contract: {
          workContractId: "wc-tool-2",
          route: "reply",
          forbiddenTools: ["sessions_spawn"],
        },
        route_decision: { route: "reply" },
        tool_policy: { allowed_control_tools: ["octoclaw_dispatch"] },
      },
      "sessions_spawn",
      "octoclaw_route_hint",
    );

    expect(rule.block).toBe(true);
  });

  it("allows dispatch when deterministic fallback changed route to delegate", () => {
    const rule = workflowEnforcementRule(
      {
        work_contract: {
          workContractId: "wc-tool-3",
          route: "reply",
          forbiddenTools: ["octoclaw_dispatch"],
        },
        route_decision: {
          route: "delegate",
          route_source: "fallback",
          fallback_reason: "deterministic_hard_boundary:explicit_delegate",
        },
        tool_policy: { must_delegate_via: "octoclaw_dispatch" },
      },
      "octoclaw_dispatch",
      "octoclaw_route_hint",
    );

    expect(rule.block).toBe(false);
  });

  it("does not block dispatch for reply route WorkContract projection", () => {
    const rule = workflowEnforcementRule(
      {
        work_contract: {
          workContractId: "wc-tool-4",
          route: "reply",
          forbiddenTools: ["octoclaw_dispatch"],
        },
        route_decision: { route: "reply", route_source: "rule" },
        tool_policy: { allowed_control_tools: ["octoclaw_dispatch"] },
      },
      "octoclaw_dispatch",
      "octoclaw_route_hint",
    );

    expect(rule.block).toBe(false);
  });

  it("allows direct tools when the sealed tool policy permits direct reply execution", () => {
    const rule = workflowEnforcementRule(
      {
        route_decision: { route: "delegate", route_source: "stale_alias" },
        tool_policy: { allow_direct_tools: true, must_delegate_via: "octoclaw_dispatch" },
      },
      "write",
      "octoclaw_route_hint",
    );

    expect(rule.block).toBe(false);
  });

  it("allows direct tools for sealed delegate WorkContract (coordinator prompt + delivery lock prevent conflicts)", () => {
    const rule = workflowEnforcementRule(
      {
        work_contract: { route: "delegate" },
        route_decision: { route: "delegate", route_source: "contract" },
        tool_policy: { allow_direct_tools: true, must_delegate_via: "octoclaw_dispatch" },
      },
      "write",
      "octoclaw_route_hint",
    );

    expect(rule.block).toBe(false);
  });

  it("blocks ordinary tools for sealed delegate WorkContract unless direct tools are explicitly allowed", () => {
    const rule = workflowEnforcementRule(
      {
        work_contract: { route: "delegate" },
        route_decision: { route: "delegate", route_source: "budgeted_main_escalation" },
        tool_policy: { allow_direct_tools: false, must_delegate_via: "octoclaw_dispatch" },
      },
      "exec",
      "octoclaw_route_hint",
    );

    expect(rule.block).toBe(true);
    expect(rule.delegateTool).toBe("octoclaw_dispatch");
    expect(rule.allowedTools).toContain("octoclaw_dispatch");
  });

  it("keeps session_status available before route hint", () => {
    const decision = {
      route_decision: { route: "reply" },
      tool_policy: {},
    };

    expect(preHintAllowedTools(decision, "octoclaw_route_hint").has("session_status")).toBe(true);
  });
});


describe("Replay persistence", () => {
  it("appends JSONL without requiring callback-based fs APIs", async () => {
    const osModule = os as unknown as { tmpdir(): string };
    const fsModule = fsSync as unknown as {
      mkdtempSync(pathname: string): string;
      readFileSync(pathname: string, encoding: string): string;
    };
    const dir = fsModule.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-replay-"));
    const replayPath = path.join(dir, "runtime-policy-replay.jsonl");

    await appendJsonl(replayPath, { event: "policy_resolved", route: "reply" });

    const content = fsModule.readFileSync(replayPath, "utf8");
    expect(content.trim()).toBe(JSON.stringify({ event: "policy_resolved", route: "reply" }));
  });
});

// ── WP-A target: workflowEnforcementRule must not block octoclaw_dispatch ──
// After convergence, workflowEnforcementRule should never return block=true for
// octoclaw_dispatch.  This test captures the target expectation so that WP-B
// can verify the behavioral change.  Currently the rule may block dispatch when
// a reply contract has forbiddenTools=["octoclaw_dispatch"]; after WP-B, the
// rule must allow dispatch through to DispatchAdmission.
describe("WP-A target: workflowEnforcementRule dispatch pass-through", () => {
  // WP-B convergence: workflowEnforcementRule must recognize route_source=budgeted_main_escalation
  // as a dispatch-allowing signal so octoclaw_dispatch is not blocked under budgeted-main escalation.
  it("[target-WP-B] workflowEnforcementRule does not block octoclaw_dispatch under budgeted-main escalated delegate route", () => {
    const rule = workflowEnforcementRule(
      {
        work_contract: {
          workContractId: "wc-wp-a-target",
          route: "reply",
          forbiddenTools: ["octoclaw_dispatch"],
        },
        route_decision: {
          route: "delegate",
          route_source: "budgeted_main_escalation",
          decision_bucket: "budgeted_main_then_delegate",
        },
        tool_policy: { must_delegate_via: "octoclaw_dispatch" },
      },
      "octoclaw_dispatch",
      "octoclaw_route_hint",
    );

    expect(rule.block).toBe(false);
  });

  it("[target] workflowEnforcementRule does not block octoclaw_dispatch with explicit forceRoute delegate evidence", () => {
    const rule = workflowEnforcementRule(
      {
        work_contract: {
          workContractId: "wc-wp-a-target-force",
          route: "reply",
          forbiddenTools: ["octoclaw_dispatch"],
        },
        route_decision: {
          route: "delegate",
          route_source: "fallback",
          fallback_reason: "deterministic_hard_boundary:explicit_delegate",
        },
        tool_policy: { must_delegate_via: "octoclaw_dispatch" },
      },
      "octoclaw_dispatch",
      "octoclaw_route_hint",
    );

    expect(rule.block).toBe(false);
  });

  it("still blocks forbidden sessions_spawn under budgeted-main escalation — only dispatch arbiter passes through", () => {
    const rule = workflowEnforcementRule(
      {
        work_contract: {
          workContractId: "wc-wp-b-regression",
          route: "reply",
          forbiddenTools: ["sessions_spawn"],
        },
        route_decision: {
          route: "delegate",
          route_source: "budgeted_main_escalation",
          decision_bucket: "budgeted_main_then_delegate",
        },
        tool_policy: { must_delegate_via: "octoclaw_dispatch" },
      },
      "sessions_spawn",
      "octoclaw_route_hint",
    );

    expect(rule.block).toBe(true);
  });
});
