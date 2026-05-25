import type { NativeStatusProjectorInput } from "../state/native-status-projector.js";
import { asString, type UnknownRecord } from "../util/type-coercion.js";

export interface TaskProjectionInputParts {
  native: Omit<NativeStatusProjectorInput, "cache">;
  cache: NonNullable<NativeStatusProjectorInput["cache"]>;
}

export function buildTaskProjectionInput(parts: TaskProjectionInputParts): NativeStatusProjectorInput {
  return {
    ...parts.native,
    cache: {
      status: asString(parts.cache.status),
      rawStatus: asString(parts.cache.rawStatus),
      summary: asString(parts.cache.summary),
      corrupt: parts.cache.corrupt,
      missing: parts.cache.missing,
    },
  };
}

export function projectionCacheFromRecord(record: UnknownRecord): NonNullable<NativeStatusProjectorInput["cache"]> {
  return {
    status: asString(record.status),
    rawStatus: asString(record.rawStatus || record.raw_status),
    summary: asString(record.summary),
  };
}
