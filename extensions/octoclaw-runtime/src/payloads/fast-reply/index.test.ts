import { describe, expect, it } from "vitest";
import * as fastReply from "./index.js";
import * as ack from "./ack/index.js";
import * as direct from "./direct/index.js";
import * as instrumentation from "./instrumentation/index.js";

describe("fast reply top-level exports", () => {
  it("re-exports ack direct and instrumentation modules", () => {
    expect(fastReply.buildFastReplyAck).toBe(ack.buildFastReplyAck);
    expect(fastReply.buildDirectReply).toBe(direct.buildDirectReply);
    expect(fastReply.buildDirectReplyContext).toBe(direct.buildDirectReplyContext);
    expect(fastReply.computeFastReplyMetrics).toBe(instrumentation.computeFastReplyMetrics);
  });
});
