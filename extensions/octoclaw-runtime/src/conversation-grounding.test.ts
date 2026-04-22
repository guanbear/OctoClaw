import { describe, expect, it } from "vitest";

import {
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
});
