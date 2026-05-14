import { describe, expect, it } from "vitest";
import { statusToolResponse } from "./registration.js";

describe("statusToolResponse native IM cards", () => {
  it("returns native card metadata and unwrapped fallback text", () => {
    const interactiveBlocks = [
      {
        type: "discord_embed",
        embed: { title: "OctoClaw status" },
      },
    ];

    const response = statusToolResponse("OctoClaw status (anchors)", "anchors", "discord", interactiveBlocks);

    expect(response.text).toContain("Return it to the user as-is");
    expect(response.text).not.toContain("```text");
    expect(response.json).toMatchObject({
      format: "anchors",
      im_native_card: true,
      interactive_blocks: interactiveBlocks,
    });
  });
});
