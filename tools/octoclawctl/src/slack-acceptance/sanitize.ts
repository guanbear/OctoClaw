const SECRET_KEYS = new Set(["token", "authorization", "botToken", "bot_token", "apiKey", "secret", "password"]);
const TRANSCRIPT_KEYS = new Set(["rawTranscript", "childTranscript", "workerChainOfThought", "executionLog"]);

export function redactSecret(value: string): string {
  if (!value) return value;
  if (value.length <= 8) return "[REDACTED]";
  return `${value.slice(0, 3)}…${value.slice(-3)}`;
}

export function sanitizeForArtifact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForArtifact(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (SECRET_KEYS.has(key) || lower.includes("token") || lower.includes("secret")) {
      output[key] = "[REDACTED]";
      continue;
    }
    if (TRANSCRIPT_KEYS.has(key)) {
      output[key] = "[STRIPPED]";
      continue;
    }
    output[key] = sanitizeForArtifact(entry);
  }
  return output;
}
