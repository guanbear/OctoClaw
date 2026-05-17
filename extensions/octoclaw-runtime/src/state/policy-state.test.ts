import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROUTE_SEAL_SCHEMA_VERSION, type RouteSeal } from "@octoclaw/contracts/route-seal";
import { POLICY_STATE_TTL_MS, PolicyStateStore } from "./policy-state.js";

const fs = fsSync as unknown as {
  existsSync(pathname: string): boolean;
  mkdtempSync(prefix: string): string;
  rmSync(pathname: string, options?: { recursive?: boolean; force?: boolean }): void;
  writeFileSync(pathname: string, data: string, encoding: string): void;
};
const osModule = os as unknown as { tmpdir(): string };

function seal(overrides: Partial<RouteSeal> = {}): RouteSeal {
  return {
    schemaVersion: ROUTE_SEAL_SCHEMA_VERSION,
    requestId: "req-1",
    turnId: "turn-1",
    threadBindingKey: "thread-1",
    route: "reply",
    source: "local_judge",
    reasonCodes: ["test"],
    createdAt: "2026-05-11T00:00:00.000Z",
    inputHash: "hash-1",
    stateGeneration: 1,
    ...overrides,
  };
}

describe("policyState 4.4 cache boundary", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses a five minute TTL", () => {
    expect(POLICY_STATE_TTL_MS).toBe(5 * 60 * 1000);
  });

  it("does not persist or restore cross-process state", () => {
    const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-policy-state-"));
    tempDirs.push(dir);
    const statePath = path.join(dir, "runtime-policy-state.json");

    const store = new PolicyStateStore({ sessionStateFile: statePath });
    store.set("session-1", { prompt: "delegate this", delegated: true });
    store.persist();

    expect(fs.existsSync(statePath)).toBe(false);

    fs.writeFileSync(statePath, JSON.stringify({ sessions: { "session-1": { prompt: "stale", delegated: true, updatedAt: Date.now() } } }), "utf-8");
    const restarted = new PolicyStateStore({ sessionStateFile: statePath });

    expect(restarted.get("session-1")).toBeUndefined();
  });

  it("keeps top-level route seal and WorkContract id aligned with the current decision", () => {
    const store = new PolicyStateStore();
    const key = "session-policy-state-current-decision";
    const oldReplySeal = seal({ route: "reply", requestId: "req-reply" });
    const currentDelegateSeal = seal({ route: "delegate", requestId: "req-delegate" });

    store.set(key, {
      prompt: "你再派gpt-5.5 修一下pr",
      routeSeal: oldReplySeal,
      workContractId: "wc-old-reply",
      work_contract_id: "wc-old-reply",
      decision: {
        request: { session_key: key },
        routeSeal: currentDelegateSeal,
        workContractId: "wc-current-delegate",
        work_contract: { workContractId: "wc-current-delegate", route: "delegate" },
        route_decision: { route: "delegate" },
      },
    });

    expect(store.get(key)).toMatchObject({
      routeSeal: { route: "delegate", requestId: "req-delegate" },
      workContractId: "wc-current-delegate",
      work_contract_id: "wc-current-delegate",
      decision: {
        route_decision: { route: "delegate" },
        workContractId: "wc-current-delegate",
      },
    });
  });

  it("does not fuzzy-rebind dispatch context to an arbitrary recent reply state", () => {
    const store = new PolicyStateStore();
    store.set("session-unrelated-reply", {
      prompt: "整理 OctoClaw 当前任务状态面板需要展示哪些字段，完成后给摘要。",
      decision: {
        request: { session_key: "session-unrelated-reply" },
        route_decision: { route: "reply" },
      },
    });

    const resolved = store.getDispatchPolicyContext(
      {},
      "调研 OctoClaw 当前任务状态面板需要展示哪些字段，完成后给摘要。",
    );

    expect(resolved).toEqual({ key: "", state: null });
  });
});
