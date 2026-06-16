import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The mock factory is hoisted so it exists before native-helper is imported.
const { createTaskFlowBridge } = vi.hoisted(() => ({
  createTaskFlowBridge: vi.fn(),
}));

// Mock the sibling module the way native-helper imports it (`./taskflow-bridge.js`),
// resolved relative to this test file (both land on adapter/taskflow-bridge.js).
vi.mock("./taskflow-bridge.js", () => ({
  createTaskFlowBridge,
}));

// Load native-helper fresh per test inside an isolated module registry so that
// its top-level capture of createTaskFlowBridge picks up the active mock fn.
async function loadNativeHelper() {
  return await import("./native-helper.js");
}

describe("initNativeHelperBridge reject/retry", () => {
  beforeEach(() => {
    createTaskFlowBridge.mockReset();
  });
  afterEach(() => {
    createTaskFlowBridge.mockReset();
    vi.restoreAllMocks();
  });

  it("retries initialization after a rejection (does not cache the failed promise)", async () => {
    const { initNativeHelperBridge, __resetNativeHelperBridgeForTests } = await loadNativeHelper();
    __resetNativeHelperBridgeForTests();

    let attempt = 0;
    createTaskFlowBridge.mockImplementation(() => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.reject(new Error("boom: native runtime missing"));
      }
      return Promise.resolve({ ok: true, __stub: true });
    });

    await expect(initNativeHelperBridge()).rejects.toThrow("boom: native runtime missing");

    // Second attempt must actually call the factory again and succeed.
    await expect(initNativeHelperBridge()).resolves.toBeUndefined();

    expect(attempt).toBe(2);
  });

  it("caches the bridge after a successful init and does not reinitialize", async () => {
    const { initNativeHelperBridge, __resetNativeHelperBridgeForTests } = await loadNativeHelper();
    __resetNativeHelperBridgeForTests();

    let calls = 0;
    createTaskFlowBridge.mockImplementation(() => {
      calls += 1;
      return Promise.resolve({ ok: true });
    });

    await initNativeHelperBridge();
    await initNativeHelperBridge(); // cached, no new factory call

    expect(calls).toBe(1);
  });

  it("shares one in-flight failure across concurrent callers, then allows retry", async () => {
    const { initNativeHelperBridge, __resetNativeHelperBridgeForTests } = await loadNativeHelper();
    __resetNativeHelperBridgeForTests();

    let attempt = 0;
    createTaskFlowBridge.mockImplementation(() => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.reject(new Error("transient"));
      }
      return Promise.resolve({ ok: true });
    });

    // Two callers started in the same tick share the same in-flight failure.
    const first = initNativeHelperBridge();
    const second = initNativeHelperBridge();
    await expect(first).rejects.toThrow("transient");
    await expect(second).rejects.toThrow("transient");
    // Only one factory call serviced both concurrent failures.
    expect(attempt).toBe(1);

    // A subsequent fresh call retries and succeeds (the failed promise was cleared).
    await expect(initNativeHelperBridge()).resolves.toBeUndefined();
    expect(attempt).toBe(2);
  });
});



