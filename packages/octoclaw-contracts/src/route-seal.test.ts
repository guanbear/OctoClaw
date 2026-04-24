import { describe, expect, it } from "vitest";

import {
  ROUTE_SEAL_SCHEMA_VERSION,
  type LiveRoute,
  type RouteSeal,
} from "./route-seal.js";

describe("route-seal contract", () => {
  it("accepts a valid RouteSeal interface object", () => {
    const seal: RouteSeal = {
      schemaVersion: ROUTE_SEAL_SCHEMA_VERSION,
      requestId: "req-1",
      turnId: "turn-1",
      threadBindingKey: "thread-1",
      route: "delegate",
      delegateRole: "research",
      coordinationMode: "solo_worker",
      source: "local_judge",
      confidence: 0.87,
      reasonCodes: ["needs_research"],
      createdAt: new Date().toISOString(),
      inputHash: "hash-1",
      stateGeneration: 1,
    };

    expect(seal.route).toBe("delegate");
    expect(seal.reasonCodes).toContain("needs_research");
  });

  it("uses the route seal schema version", () => {
    expect(ROUTE_SEAL_SCHEMA_VERSION).toBe("octoclaw.route_seal.v1");
  });

  it("limits live routes to reply or delegate", () => {
    const routes: LiveRoute[] = ["reply", "delegate"];

    expect(routes).toEqual(["reply", "delegate"]);
    expect(routes).not.toContain("runner");
    expect(routes).not.toContain("direct");
  });
});
