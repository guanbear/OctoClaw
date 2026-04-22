import { describe, expect, it } from "vitest";

import {
  buildConversationControlHintsFromIntent,
  buildConversationIntentPacket,
} from "./conversation-grounding.js";
import { buildDecision } from "./resolve/policy-resolver.js";

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
});
