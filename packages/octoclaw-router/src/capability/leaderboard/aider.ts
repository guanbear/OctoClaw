import { parse as parseYaml } from "yaml";
import { z } from "zod";

import {
  canonicalLeaderboardModelKey,
  normalizeLeaderboardScore,
  type LeaderboardSourceRecord,
} from "./types.js";

export const AIDER_EDIT_LEADERBOARD_URL = "https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/edit_leaderboard.yml";

const AiderRowSchema = z.object({
  model: z.string().min(1),
  pass_rate_2: z.coerce.number().optional(),
  pass_rate: z.coerce.number().optional(),
  score: z.coerce.number().optional(),
  exercises: z.coerce.number().optional(),
  sample_count: z.coerce.number().optional(),
  date: z.string().optional(),
  last_updated: z.string().optional(),
});

const AiderSchema = z.union([
  z.object({ results: z.array(AiderRowSchema) }),
  z.object({ leaderboard: z.array(AiderRowSchema) }),
  z.array(AiderRowSchema),
]);

function rowsFromParsed(parsed: z.infer<typeof AiderSchema>): z.infer<typeof AiderRowSchema>[] {
  if (Array.isArray(parsed)) return parsed;
  if ("results" in parsed) return parsed.results;
  return parsed.leaderboard;
}

export function parseAiderLeaderboard(rawBytes: Uint8Array | string): LeaderboardSourceRecord[] {
  try {
    const text = typeof rawBytes === "string" ? rawBytes : new TextDecoder().decode(rawBytes);
    const parsed = AiderSchema.safeParse(parseYaml(text));
    if (!parsed.success) return [];
    return rowsFromParsed(parsed.data).flatMap((row) => {
      const rawScore = row.pass_rate_2 ?? row.pass_rate ?? row.score;
      if (rawScore === undefined) return [];
      return [{
        source: "aider",
        modelKey: canonicalLeaderboardModelKey(row.model),
        scenario: "coding_worker",
        rawScore: normalizeLeaderboardScore(rawScore),
        ...(row.exercises ?? row.sample_count ? { sampleCount: row.exercises ?? row.sample_count } : {}),
        lastVerifiedAt: row.date ?? row.last_updated ?? new Date(0).toISOString(),
      }];
    });
  } catch {
    return [];
  }
}
