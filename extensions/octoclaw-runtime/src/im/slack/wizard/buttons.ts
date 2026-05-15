import { createHmac } from "node:crypto";

export type RouterWizardStepNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface RouterWizardButtonAction {
  step: RouterWizardStepNumber;
  value: string;
}

export type DecodeWizardButtonResult =
  | { ok: true; action: RouterWizardButtonAction }
  | { ok: false; reason: "malformed" | "bad_tag" };

function hmacTag(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url").slice(0, 16);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

export function encodeWizardButtonId(step: RouterWizardStepNumber, value: string, secret?: string): string {
  const payload = `step:${step}:answer:${encodeURIComponent(value)}`;
  if (!secret) return payload;
  return `${payload}:tag:${hmacTag(payload, secret)}`;
}

export function decodeWizardButtonId(buttonId: string, options: { secret?: string } = {}): DecodeWizardButtonResult {
  const match = /^step:([1-7]):answer:([^:]+)(?::tag:([A-Za-z0-9_-]+))?$/u.exec(String(buttonId || ""));
  if (!match) return { ok: false, reason: "malformed" };
  const step = Number(match[1]) as RouterWizardStepNumber;
  const value = decodeURIComponent(match[2] ?? "");
  const payload = `step:${step}:answer:${encodeURIComponent(value)}`;
  if (options.secret) {
    const tag = match[3] ?? "";
    if (!tag || !safeEqual(tag, hmacTag(payload, options.secret))) {
      return { ok: false, reason: "bad_tag" };
    }
  }
  return { ok: true, action: { step, value } };
}
