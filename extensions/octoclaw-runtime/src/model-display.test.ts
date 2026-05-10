import { describe, expect, it } from "vitest";
import { firstDisplayModel, isRuntimeProfileModelLabel } from "./model-display.js";

describe("display model labels", () => {
  it("treats runtime profiles as internal labels", () => {
    expect(isRuntimeProfileModelLabel("direct_main")).toBe(true);
    expect(isRuntimeProfileModelLabel("octoclaw-main")).toBe(true);
    expect(isRuntimeProfileModelLabel("worker_research")).toBe(true);
    expect(isRuntimeProfileModelLabel("cliproxyapi/gpt-5.5")).toBe(false);
  });

  it("prefers concrete models over runtime profile labels", () => {
    expect(firstDisplayModel("worker_unmapped_profile", "cliproxyapi/gpt-5.5")).toBe("cliproxyapi/gpt-5.5");
    expect(firstDisplayModel("worker_unmapped_profile", "zhipu/GLM-5.1")).toBe("zhipu/GLM-5.1");
  });

  it("resolves mapped runtime profiles before display", () => {
    const displayed = firstDisplayModel("direct_main");

    expect(displayed).not.toBe("direct_main");
    expect(displayed).not.toBe("unknown");
  });

  it("returns unknown when only internal runtime profiles are available", () => {
    expect(firstDisplayModel("worker_unmapped_profile", "worker_other_unmapped_profile")).toBe("unknown");
  });
});
