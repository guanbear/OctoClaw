import { describe, expect, test } from "vitest";

import { isOctoClawError, OctoClawError } from "./error.js";

describe("OctoClawError", () => {
  test("ERR-C-001: constructor creates instance with core fields", () => {
    const cause = new Error("root cause");
    const error = new OctoClawError({
      code: "TEST_CODE",
      userMessageZh: "中文错误",
      userMessageEn: "English error",
      actionableHint: "Try again",
      cause,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("OctoClawError");
    expect(error.code).toBe("TEST_CODE");
    expect(error.userMessageZh).toBe("中文错误");
    expect(error.userMessageEn).toBe("English error");
    expect(error.actionableHint).toBe("Try again");
    expect(error.cause).toBe(cause);
    expect(error.message).toBe("English error");
  });

  test("ERR-C-002: toUserString zh contains code and zh message", () => {
    const error = new OctoClawError({
      code: "TEST_CODE",
      userMessageZh: "中文错误",
      userMessageEn: "English error",
      actionableHint: "检查配置",
    });

    expect(error.toUserString("zh")).toContain("[TEST_CODE]");
    expect(error.toUserString("zh")).toContain("中文错误");
    expect(error.toUserString("zh")).toContain("→ 检查配置");
  });

  test("ERR-C-003: toUserString en contains code and en message without Chinese characters", () => {
    const error = new OctoClawError({
      code: "TEST_CODE",
      userMessageZh: "中文错误",
      userMessageEn: "English error",
      actionableHint: "Check config",
    });

    const rendered = error.toUserString("en");

    expect(rendered).toContain("[TEST_CODE]");
    expect(rendered).toContain("English error");
    expect(rendered).not.toMatch(/[\u4e00-\u9fff]/u);
  });

  test("ERR-C-004: toJSON serializes to valid JSON with required fields", () => {
    const error = new OctoClawError({
      code: "TEST_CODE",
      userMessageZh: "中文错误",
      userMessageEn: "English error",
    });

    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: "TEST_CODE",
      messageZh: "中文错误",
      messageEn: "English error",
      hint: null,
    });
  });

  test("ERR-C-005: isOctoClawError returns false for regular Error", () => {
    expect(isOctoClawError(new Error("nope"))).toBe(false);
  });
});
