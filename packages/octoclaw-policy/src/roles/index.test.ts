import { describe, expect, it } from "vitest";
import { decideRole } from "./index.js";

describe("roles", () => {
  it("maps reply to main_reply", () => {
    expect(decideRole("reply").role).toBe("main_reply");
  });

  it("maps observe to observer_probe", () => {
    expect(decideRole("observe").role).toBe("observer_probe");
  });

  it("maps delegate work to worker roles", () => {
    expect(decideRole("delegate.single", "research").role).toBe("worker_research");
    expect(decideRole("delegate.single", "code").role).toBe("worker_code");
    expect(decideRole("delegate.single", "review").role).toBe("worker_review");
  });
});
