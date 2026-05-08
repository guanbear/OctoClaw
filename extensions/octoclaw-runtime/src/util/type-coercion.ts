/**
 * Shared type-coercion utilities for OctoClaw runtime.
 *
 * These functions replace the 107+ duplicate local definitions that were
 * previously copy-pasted across 44 source files. Every function here preserves
 * the exact behavior of the most common local variant.
 *
 * @module util/type-coercion
 */

// ── Type aliases ──────────────────────────────────────────────────────

/** Convenience alias used throughout OctoClaw runtime. */
export type UnknownRecord = Record<string, unknown>;

// ── Type guards ───────────────────────────────────────────────────────

/**
 * Returns true when `value` is a non-null, non-array plain object.
 *
 * This is the canonical "is it a record?" check used across the runtime.
 * Equivalent to the former `isRecord` in 27+ files.
 */
export function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ── Record coercion ───────────────────────────────────────────────────

/**
 * Coerce to `UnknownRecord`, returning `{}` for non-objects.
 */
export function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

// ── String coercion ───────────────────────────────────────────────────

/**
 * Coerce to trimmed string. Returns `fallback` (default `""`) when the
 * trimmed result is empty.
 *
 * This is the superset of former Variant A (no fallback) and Variant B
 * (with fallback). Variant A callers pass zero args; behavior is identical
 * because `fallback` defaults to `""`.
 */
export function asString(value: unknown, fallback = ""): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

/**
 * Coerce to trimmed string, returning `null` when the result would be empty.
 *
 * Replaces the former `asString` variants that returned `string | null`.
 */
export function asStringOptional(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

// ── Boolean coercion ──────────────────────────────────────────────────

/**
 * Coerce to boolean using typeof check with optional fallback.
 *
 * Returns the value as-is when it's already boolean; otherwise `fallback`.
 */
export function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Strict boolean check — only `true` returns true.
 *
 * Replaces the former `asBoolean` variant that used `value === true`.
 * Useful for feature flags where only explicit `true` should activate.
 */
export function asBooleanStrict(value: unknown): boolean {
  return value === true;
}

// ── Number coercion ───────────────────────────────────────────────────

/**
 * Coerce to number with configurable fallback (default 0).
 *
 * Only accepts actual finite numbers; does NOT parse strings.
 */
export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Coerce to `number | undefined`. Returns `undefined` for non-numbers.
 *
 * Replaces the former `asNumber` variants that returned `number | undefined`.
 * Accepts actual numbers only — does NOT parse strings.
 */
export function asNumberOptional(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Coerce to `number | null`, including string-to-number parsing.
 *
 * Replaces the receipt.ts variant that parses numeric strings with a regex.
 * Returns `null` when the value is not a valid number or numeric string.
 */
export function asNumberNullable(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const text = String(value ?? "").trim();
  if (!text || !/^-?\d+(\.\d+)?$/.test(text)) {
    return null;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

// ── Array coercion ────────────────────────────────────────────────────

/**
 * Coerce to `string[]` by mapping each element through `asString`.
 * Returns `[]` for non-array values.
 */
export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => asString(item)).filter(Boolean)
    : [];
}

/**
 * Coerce to `string[] | undefined`. Returns `undefined` for non-arrays
 * or empty arrays (after trimming/filtering).
 */
export function asStringArrayOptional(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.map((item) => asString(item)).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}
