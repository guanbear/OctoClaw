import { describe, it, expect, vi } from "vitest";
import { checkTaskflowCapability } from "./taskflow-port.js";

describe("taskflow capability preflight", () => {
  it("returns available=true when backend is healthy", async () => {
    const mockPort = {
      healthCheck: vi.fn().mockResolvedValue({ status: "ok" }),
    };
    const result = await checkTaskflowCapability(mockPort as any);
    expect(result.available).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns available=false when backend throws", async () => {
    const mockPort = {
      healthCheck: vi.fn().mockRejectedValue(new Error("connection refused")),
    };
    const result = await checkTaskflowCapability(mockPort as any);
    expect(result.available).toBe(false);
    expect(result.reason).toContain("connection refused");
  });

  it("returns available=false on timeout", async () => {
    const mockPort = {
      healthCheck: vi.fn(() => new Promise(() => {})),
    };
    const result = await checkTaskflowCapability(mockPort as any);
    expect(result.available).toBe(false);
    expect(result.reason).toContain("timeout");
  }, 10000);

  it("returns available=false when fallback get returns null", async () => {
    const mockPort = {
      bindSession: vi.fn(() => ({
        get: vi.fn().mockResolvedValue(null),
      })),
    };

    const result = await checkTaskflowCapability(mockPort as any);

    expect(result.available).toBe(false);
    expect(result.reason).toBe("preflight_no_taskflow_response");
  });

  it("returns available=true when fallback get returns a taskflow response", async () => {
    const mockPort = {
      bindSession: vi.fn(() => ({
        get: vi.fn().mockResolvedValue({ flowId: "octoclaw-preflight", status: "ok" }),
      })),
    };

    const result = await checkTaskflowCapability(mockPort as any);

    expect(result.available).toBe(true);
  });

  it("returns available=false when no capability probe exists", async () => {
    const result = await checkTaskflowCapability({} as any);

    expect(result.available).toBe(false);
    expect(result.reason).toBe("no_capability_probe_available");
  });
});
