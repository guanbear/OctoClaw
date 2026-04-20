import { describe, expect, it } from "vitest";
import { decideRole } from "./index.js";

describe("roles", () => {
  it("maps reply to main_reply", () => {
    expect(decideRole("reply").role).toBe("main_reply");
  });

  it("maps delegate work to worker roles", () => {
    expect(decideRole("delegate", "research").role).toBe("worker_research");
    expect(decideRole("delegate", "code").role).toBe("worker_code");
    expect(decideRole("delegate", "review").role).toBe("worker_review");
  });
});
