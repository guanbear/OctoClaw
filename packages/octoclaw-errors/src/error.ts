export class OctoClawError extends Error {
  readonly code: string;
  readonly userMessageZh: string;
  readonly userMessageEn: string;
  readonly actionableHint?: string;
  // `cause` is intentionally NOT redeclared as a class field: a field declaration
  // would re-initialize the own property to `undefined` after super() and clobber
  // the native ES2022 Error.cause slot. The type is surfaced via Error.prototype.cause.

  constructor(opts: {
    code: string;
    userMessageZh: string;
    userMessageEn: string;
    actionableHint?: string;
    cause?: unknown;
  }) {
    // Pass cause through the native ES2022 Error options so standard tooling,
    // stack traces, and Error.prototype.cause consumers see it.
    super(opts.userMessageEn, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "OctoClawError";
    this.code = opts.code;
    this.userMessageZh = opts.userMessageZh;
    this.userMessageEn = opts.userMessageEn;
    this.actionableHint = opts.actionableHint;
  }

  toUserString(lang: "zh" | "en" = "zh"): string {
    const msg = lang === "zh" ? this.userMessageZh : this.userMessageEn;
    const hint = this.actionableHint ? `\n  → ${this.actionableHint}` : "";
    return `[${this.code}] ${msg}${hint}`;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      messageZh: this.userMessageZh,
      messageEn: this.userMessageEn,
      hint: this.actionableHint ?? null,
    };
  }
}

export function isOctoClawError(e: unknown): e is OctoClawError {
  return e instanceof OctoClawError;
}
