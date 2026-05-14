export class OctoClawError extends Error {
  readonly code: string;
  readonly userMessageZh: string;
  readonly userMessageEn: string;
  readonly actionableHint?: string;
  readonly cause?: unknown;

  constructor(opts: {
    code: string;
    userMessageZh: string;
    userMessageEn: string;
    actionableHint?: string;
    cause?: unknown;
  }) {
    super(opts.userMessageEn);
    this.name = "OctoClawError";
    this.code = opts.code;
    this.userMessageZh = opts.userMessageZh;
    this.userMessageEn = opts.userMessageEn;
    this.actionableHint = opts.actionableHint;
    this.cause = opts.cause;
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
