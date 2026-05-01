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

  it("keeps blocking dispatch for reply route WorkContract projection", () => {
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

    expect(rule.block).toBe(true);
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
