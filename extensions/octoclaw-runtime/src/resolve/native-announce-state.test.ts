import { describe, expect, it } from "vitest";
import { isNativeAnnounceAlreadyDelivered } from "./native-announce-state.js";

describe("isNativeAnnounceAlreadyDelivered", () => {
  it("does not treat status-only delivered state as hard delivery evidence", () => {
    expect(isNativeAnnounceAlreadyDelivered({
      nativeAnnounceResultHash: "result-hash",
      deliveryStatus: "delivered",
    })).toBe(false);
  });

  it("accepts explicit native announce delivery evidence", () => {
    expect(isNativeAnnounceAlreadyDelivered({
      nativeAnnounceResultHash: "result-hash",
      nativeAnnounceDelivered: true,
      deliveryStatus: "delivered",
    })).toBe(true);
  });

  it("accepts a delivered status when a delivery message id is present", () => {
    expect(isNativeAnnounceAlreadyDelivered({
      nativeAnnounceResultHash: "result-hash",
      deliveryStatus: "delivered",
      deliveryMessageId: "1777368524.770690",
    })).toBe(true);
  });
});
