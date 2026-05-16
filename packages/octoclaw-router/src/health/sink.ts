import fs from "node:fs/promises";
import path from "node:path";
import { aggregateHealth, serializeHealthSnapshot, type AggregateHealthOptions, type RouterHealthSnapshot } from "./snapshot.js";
import { normalizeHealthEvent, parseHealthEvent, type HealthEvent, type HealthEventInput } from "./event.js";

export interface HealthEventSinkOptions {
  jsonlPath: string;
  snapshotPath?: string;
  now?: () => number;
  retentionMs?: number;
  aggregateOptions?: AggregateHealthOptions;
}

export interface HealthEventSink {
  recordCall(input: HealthEventInput): void;
  flush(): Promise<void>;
  aggregate(now?: number): Promise<RouterHealthSnapshot>;
}

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60_000;

export function createHealthEventSink(options: HealthEventSinkOptions): HealthEventSink {
  const now = options.now ?? (() => Date.now());
  const pending: HealthEvent[] = [];
  let writeChain = Promise.resolve();

  function scheduleWrite(): void {
    writeChain = writeChain.then(async () => {
      const events = pending.splice(0, pending.length);
      if (events.length === 0) return;
      await fs.mkdir(path.dirname(options.jsonlPath), { recursive: true });
      const handle = await fs.open(options.jsonlPath, "a");
      try {
        await handle.writeFile(events.map((event) => `${JSON.stringify(event)}\n`).join(""), "utf8");
        await handle.datasync();
      } finally {
        await handle.close();
      }
    }).catch(() => {
      pending.splice(0, pending.length);
    });
  }

  return {
    recordCall(input: HealthEventInput): void {
      try {
        pending.push(normalizeHealthEvent(input, now()));
        scheduleWrite();
      } catch {
        // Runtime hooks must never fail routing because health recording failed.
      }
    },

    async flush(): Promise<void> {
      await writeChain.catch(() => undefined);
    },

    async aggregate(aggregateNow = now()): Promise<RouterHealthSnapshot> {
      await this.flush();
      const retained = (await readHealthEventsFromJsonl(options.jsonlPath))
        .filter((event) => aggregateNow - event.ts <= (options.retentionMs ?? DEFAULT_RETENTION_MS))
        .sort((left, right) => left.ts - right.ts || left.modelKey.localeCompare(right.modelKey));
      await rewriteJsonl(options.jsonlPath, retained);
      const snapshot = aggregateHealth(retained, aggregateNow, options.aggregateOptions);
      if (options.snapshotPath) {
        await fs.mkdir(path.dirname(options.snapshotPath), { recursive: true });
        await fs.writeFile(options.snapshotPath, serializeHealthSnapshot(snapshot), "utf8");
      }
      return snapshot;
    },
  };
}

export async function readHealthEventsFromJsonl(jsonlPath: string): Promise<HealthEvent[]> {
  let content = "";
  try {
    content = await fs.readFile(jsonlPath, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }

  const events: HealthEvent[] = [];
  for (const line of content.split(/\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = parseHealthEvent(JSON.parse(line));
      if (parsed) events.push(parsed);
    } catch {
      // Corrupt historical lines are ignored so one bad write cannot break routing.
    }
  }
  return events;
}

async function rewriteJsonl(jsonlPath: string, events: HealthEvent[]): Promise<void> {
  await fs.mkdir(path.dirname(jsonlPath), { recursive: true });
  const tmpPath = `${jsonlPath}.tmp`;
  const handle = await fs.open(tmpPath, "w");
  try {
    await handle.writeFile(events.map((event) => `${JSON.stringify(event)}\n`).join(""), "utf8");
    await handle.datasync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmpPath, jsonlPath);
}
