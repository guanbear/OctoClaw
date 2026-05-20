const SECRET_KEY_RE = /(?:api[-_]?key|authorization|auth|bearer|password|secret|token)/iu;
const STRIP_VALUE_KEYS = new Set([
  "prompt",
  "fullprompt",
  "response",
  "fullresponse",
  "rawtranscript",
  "transcript",
  "childtranscript",
  "workerchainofthought",
  "executionlog",
]);

const SECRET_PATTERNS: RegExp[] = [
  /xox[baprs]-[A-Za-z0-9-]+/gu,
  /sk-[A-Za-z0-9_-]{16,}/gu,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/giu,
];

export function sanitizeStabilityArtifact(value: unknown): unknown {
  return sanitizeValue(value, "");
}

function sanitizeValue(value: unknown, key: string): unknown {
  const normalizedKey = normalizeKey(key);

  if (SECRET_KEY_RE.test(key)) {
    return "[REDACTED]";
  }

  if (STRIP_VALUE_KEYS.has(normalizedKey)) {
    if (normalizedKey === "prompt" || normalizedKey === "fullprompt") {
      return `[STRIPPED:sha256:${hashString(String(value))}]`;
    }
    return "[STRIPPED]";
  }

  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, ""));
  }
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = sanitizeValue(childValue, childKey);
    }
    return output;
  }
  return value;
}

function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, "[REDACTED]"), value);
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeKey(key: string): string {
  return key.replace(/[-_\s]/gu, "").toLowerCase();
}
