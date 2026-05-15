import { z } from "zod";

import {
  canonicalLeaderboardModelKey,
  normalizeLeaderboardScore,
  type LeaderboardSourceRecord,
} from "./types.js";

export const BFCL_LEADERBOARD_URL = "https://raw.githubusercontent.com/ShishirPatil/gorilla/main/berkeley-function-call-leaderboard/result/leaderboard.json";

const BfclRowSchema = z.object({
  model: z.string().min(1),
  overall_accuracy: z.coerce.number().optional(),
  accuracy: z.coerce.number().optional(),
  score: z.coerce.number().optional(),
  sample_count: z.coerce.number().optional(),
  total_count: z.coerce.number().optional(),
  last_updated: z.string().optional(),
  date: z.string().optional(),
});

const BfclSchema = z.union([
  z.object({ leaderboard: z.array(BfclRowSchema) }),
  z.object({ results: z.array(BfclRowSchema) }),
  z.array(BfclRowSchema),
]);

function rowsFromParsed(parsed: z.infer<typeof BfclSchema>): z.infer<typeof BfclRowSchema>[] {
  if (Array.isArray(parsed)) return parsed;
  if ("leaderboard" in parsed) return parsed.leaderboard;
  return parsed.results;
}

export function parseBfclLeaderboard(rawBytes: Uint8Array | string): LeaderboardSourceRecord[] {
  try {
    const text = typeof rawBytes === "string" ? rawBytes : new TextDecoder().decode(rawBytes);
    const parsedJson = JSON.parse(text) as unknown;
    const parsed = BfclSchema.safeParse(parsedJson);
    if (!parsed.success) return [];
    return rowsFromParsed(parsed.data).flatMap((row) => {
      const rawScore = row.overall_accuracy ?? row.accuracy ?? row.score;
      if (rawScore === undefined) return [];
      return [{
        source: "bfcl",
        modelKey: canonicalLeaderboardModelKey(row.model),
        scenario: "agentic",
        rawScore: normalizeLeaderboardScore(rawScore),
        ...(row.sample_count ?? row.total_count ? { sampleCount: row.sample_count ?? row.total_count } : {}),
        lastVerifiedAt: row.last_updated ?? row.date ?? new Date(0).toISOString(),
      }];
    });
  } catch {
    return [];
  }
}
