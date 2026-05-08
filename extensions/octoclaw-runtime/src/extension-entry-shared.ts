import { type UnknownRecord, asRecord } from "./util/type-coercion.js";

export type HookHandler = (event: UnknownRecord, ctx: UnknownRecord) => unknown;

export interface LoggerLike {
  debug?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
}

export interface PluginInterface {
  config?: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  logger?: LoggerLike;
  on?(event: string, handler: HookHandler, options?: Record<string, unknown>): void;
  registerHook?(event: string, handler: HookHandler, options?: Record<string, unknown>): void;
  registerTool?(definition: Record<string, unknown>): void;
  registerCommand?(definition: Record<string, unknown>): void;
  runtime?: {
    config?: { current?: () => unknown };
  };
}

export function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => stringValue(item)).filter(Boolean)
    : [];
}

export function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return "";
}

export function firstStringValue(...values: unknown[]): string {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return "";
}

export function parseJsonRecord(value: string): UnknownRecord {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

export function toolResultRecord(result: unknown): UnknownRecord {
  const record = asRecord(result);
  const details = asRecord(record.details);
  if (Object.keys(details).length > 0) return { ...record, ...details };
  const text = stringValue(record.text);
  if (text) return { ...record, ...parseJsonRecord(text) };
  const content = Array.isArray(record.content) ? record.content : [];
  for (const item of content) {
    const itemText = stringValue(asRecord(item).text);
    if (!itemText) continue;
    const parsed = parseJsonRecord(itemText);
    if (Object.keys(parsed).length > 0) return { ...record, ...parsed };
  }
  return record;
}
