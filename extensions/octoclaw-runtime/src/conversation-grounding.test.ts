import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildConversationGrounding,
  buildConversationControlHintsFromIntent,
  buildConversationIntentPacket,
} from "./conversation-grounding.js";
import { buildDecision, resolveStatelessPolicyDecision } from "./resolve/policy-resolver.js";
import { enrichConversationControlMetadata } from "./resolve/session.js";

describe("conversation grounding route projection", () => {
  it("projects runtime version lookup to delegated observer control", () => {
    const intent = buildConversationIntentPacket({
      prompt: "你现在啥版本",
      replayLogPath: "/tmp/does-not-matter.jsonl",
      taskStatePath: "/tmp/does-not-matter.json",
      sessionKeys: [],
    });

    expect(intent.intent_class).toBe("local_surface_lookup");
    expect(intent.surface_id).toBe("runtime_version");

    const control = buildConversationControlHintsFromIntent(intent);
    expect(control.route_hint).toBe("delegate");
    expect(control.lane_hint).toBe("observe");
    expect(control.require_fresh_lookup).toBe(true);
    expect(control.require_state_grounding).toBe(true);
  });

  it("renders sanitized DelegateStatusPacket facts without raw thread history", () => {
    const dir = path.join("/tmp", `octoclaw-grounding-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    const replayLogPath = path.join(dir, "runtime-policy-replay.jsonl");
    const taskStatePath = path.join(dir, "task-state.json");
    const taskEventsPath = path.join(dir, "task-events.jsonl");

    fs.writeFileSync(replayLogPath, [
      JSON.stringify({
        event: "policy_resolved",
        sessionKey: "session-grounding",
        sessionId: "session-grounding",
        at: "2026-04-22T10:00:00.000Z",
        prompt: "check release notes",
        route: "delegate",
        taskClass: "delegated_single",
        protectedLane: "worker_research",
      }),
      JSON.stringify({
        event: "dispatch_called",
        sessionKey: "session-grounding",
        sessionId: "session-grounding",
        at: "2026-04-22T10:00:01.000Z",
        executed: false,
        taskId: "task-grounding-1",
        materialization: {
          task_id: "task-grounding-1",
          status: "running",
        },
      }),
      JSON.stringify({
        event: "policy_resolved",
        sessionKey: "session-grounding",
        sessionId: "session-grounding",
        at: "2026-04-22T10:05:00.000Z",
        prompt: "task status",
        route: "reply",
      }),
    ].join("\n"));
    fs.writeFileSync(taskStatePath, JSON.stringify({
      tasks: [{
        id: "task-grounding-1",
        status: "running",
        summary: "User-visible: release lookup is still running. [Thread history - for context] secret transcript internal route rationale: hidden",
        worker_pool: "octoclaw-research",
        model: "worker_research",
        role: "worker_research",
        spawned_at: "2026-04-22T10:00:01.000Z",
        updated_at: "2026-04-22T10:01:00.000Z",
        openclaw_taskflow_substrate_state: "running",
        openclaw_taskflow_substrate_revision: 3,
      }],
    }));
    fs.writeFileSync(taskEventsPath, JSON.stringify({
      task_id: "task-grounding-1",
      kind: "delivery_sent",
      message: "progress delivered",
      at: "2026-04-22T10:01:30.000Z",
    }));

    const grounding = buildConversationGrounding({
      prompt: "task status",
      replayLogPath,
      taskStatePath,
      sessionKeys: ["session-grounding"],
    });

    expect(grounding.available).toBe(true);
    expect(grounding.context).toContain("schema: octoclaw.delegate_status.v1");
    expect(grounding.context).toContain("task_id: task-grounding-1");
    expect(grounding.context).toContain("status: running");
    expect(grounding.context).toContain("worker_pool: octoclaw-research");
    expect(grounding.context).toContain("model: worker_research");
    expect(grounding.context).toContain("progress: User-visible: release lookup is still running.");
    expect(grounding.context).not.toContain("internal route rationale");
    expect(grounding.context).not.toContain("secret transcript");
    expect(grounding.context).not.toContain("[Thread history]");
  });

  it("turns delegated follow-up control hints into delegate observer policy", () => {
    const decision = buildDecision("你是自己写的 还是子agent 写的", {
      metadata: {
        conversation_control: {
          available: true,
          intent_class: "execution_followup",
          route_hint: "delegate",
          lane_hint: "control_observer",
          require_state_grounding: true,
        },
      },
    });

    expect(decision.route).toBe("delegate");
    expect(decision.role).toBe("observer_probe");
    expect(decision.executionProfile).toBe("observer");
  });

  it("fills fresh live lookup control hints during session metadata enrichment", () => {
    const metadata = enrichConversationControlMetadata("openclaw 4.21 有啥新特性", {
      conversation_control: {
        available: true,
        source: "session_resolver_fallback",
        subject_prompt: "openclaw 4.21 有啥新特性",
      },
      intent_packet: {
        available: true,
        prompt: "openclaw 4.21 有啥新特性",
        intent_class: "fresh_live_lookup",
      },
    });

    expect(metadata.conversation_control).toMatchObject({
      available: true,
      intent_class: "fresh_live_lookup",
      route_hint: "delegate",
      lane_hint: "observe",
      require_fresh_lookup: true,
    });
  });

  it("does not let main-agent reply hints override fresh live lookup delegation", () => {
    const decision = buildDecision("openclaw 4.21 有啥新特性", {
      metadata: {
        route_hint: "reply",
        requested_route: "reply",
        conversation_control: {
          available: true,
          intent_class: "fresh_live_lookup",
          route_hint: "delegate",
          lane_hint: "observe",
          require_fresh_lookup: true,
        },
      },
    });

    expect(decision.route).toBe("delegate");
    expect(decision.role).toBe("observer_probe");
    expect(decision.executionProfile).toBe("observer");
  });

  it("keeps delegated route when route_hint tool prefers reply for fresh live lookup", async () => {
    const decision = await resolveStatelessPolicyDecision("openclaw 4.21 有啥新特性", {
      metadata: {
        conversation_control: {
          available: true,
          intent_class: "fresh_live_lookup",
          route_hint: "delegate",
          lane_hint: "observe",
          require_fresh_lookup: true,
        },
      },
      routeHint: {
        route_hint: "reply",
        requested_route: "reply",
        work_type: "research",
        confidence: 0.72,
      },
    });

    expect((decision.route_decision as { route: string }).route).toBe("delegate");
    expect((decision.request as { metadata: { requested_route: string } }).metadata.requested_route).toBe("delegate");
    expect((decision.request as { metadata: { route_hint: string } }).metadata.route_hint).toBe("reply");
  });

  it("allows explicit route objection to override default fresh live lookup delegation", async () => {
    const decision = await resolveStatelessPolicyDecision("openclaw 4.21 有啥新特性", {
      metadata: {
        conversation_control: {
          available: true,
          intent_class: "fresh_live_lookup",
          route_hint: "delegate",
          lane_hint: "observe",
          require_fresh_lookup: true,
        },
      },
      routeHint: {
        route_hint: "reply",
        route_objection: true,
        objection_reason: "I already have the verified release notes in current context and do not need a fresh fetch.",
        requested_route: "reply",
        work_type: "research",
        confidence: 0.82,
      },
    });

    expect((decision.route_decision as { route: string }).route).toBe("reply");
    expect((decision.route_hint_policy as { objection_submitted: boolean }).objection_submitted).toBe(true);
    expect((decision.route_hint_policy as { objection_accepted: boolean }).objection_accepted).toBe(true);
    expect((decision.request as { metadata: { requested_route: string } }).metadata.requested_route).toBe("reply");
    expect((decision.request as { metadata: { objection_requested_route: string } }).metadata.objection_requested_route).toBe("reply");
  });
});
