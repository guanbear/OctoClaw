function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}

function stripAcceptanceEnvelope(raw: string): string {
  return raw.replace(/^\[OCTOCLAW_ACCEPTANCE\][^\n]*(?:\n|$)/u, "").trim();
}

function stripLeadingSlackMentions(raw: string): string {
  let text = raw.trim();
  for (let index = 0; index < 8; index += 1) {
    const next = text.replace(/^<@[A-Z0-9]+>\s*/u, "").trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

export function normalizeSemanticPrompt(raw: unknown): string {
  let text = stringValue(raw);
  if (!text) return "";
  for (let index = 0; index < 4; index += 1) {
    const next = stripAcceptanceEnvelope(stripLeadingSlackMentions(text));
    if (next === text) return next;
    text = next;
  }
  return text;
}
