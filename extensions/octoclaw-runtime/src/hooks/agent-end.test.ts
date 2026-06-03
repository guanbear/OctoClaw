import { afterEach, describe, expect, it } from "vitest";
import { policyState } from "../state/policy-state.js";
import { makeAgentEndHook } from "./agent-end.js";

describe("agent_end delivery target retention", () => {
  afterEach(() => {
    for (const { key } of policyState.entries()) {
      policyState.clear(key);
    }
  });

  it("prefers the current inbound thread when shared DM state has an older delivery target", async () => {
    const sessionKey = "agent:main:slack:default:direct:u0al9t5u89z";
    const anchorA = "1780448835.444189";
    const anchorB = "1780448868.603299";
    policyState.setState(sessionKey, {
      decision: {
        request: { session_key: sessionKey },
        route_decision: {
          route: "reply",
          system_preferred_route: "reply",
          worker_pool: "octoclaw-main",
          task_class: "main_direct",
        },
      },
      deliveryTarget: {
        sessionKey,
        replyToMessageId: anchorA,
        threadTs: anchorA,
        immutable: true,
      },
      inboundMessageTs: anchorA,
      replyToMessageId: anchorA,
      dispatchExecuted: false,
      spawnExecuted: false,
      resultMaterialized: false,
      createdAt: Date.now() - 1000,
      updatedAt: Date.now() - 500,
    });

    const hook = makeAgentEndHook({ pi: { logger: {} } });

    await hook(
      { outcome: "completed" },
      {
        sessionKey,
        sessionId: "session-weather-reply",
        agentId: "main",
        inboundMessageTs: anchorB,
        messageId: anchorB,
      },
    );

    expect(policyState.get(sessionKey)).toMatchObject({
      inboundMessageTs: anchorB,
      replyToMessageId: anchorB,
      deliveryTarget: expect.objectContaining({
        replyToMessageId: anchorB,
        immutable: true,
      }),
    });
  });
});
