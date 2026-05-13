export const COST_SQLITE_PATH = "~/.openclaw/octoclaw/cost.sqlite";

export const COST_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS cost_events (
  ts TEXT NOT NULL,
  session_key TEXT,
  turn_id TEXT,
  model TEXT NOT NULL,
  provider TEXT,
  complexity TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cost_usd REAL,
  route TEXT,
  outcome TEXT,
  is_plan_call INTEGER,
  latency_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cost_ts ON cost_events(ts);
CREATE INDEX IF NOT EXISTS idx_cost_model ON cost_events(model);
`.trim();

export interface CostEvent {
  ts: string;
  sessionKey?: string;
  turnId?: string;
  model: string;
  provider?: string;
  complexity?: "simple" | "normal" | "complex" | "deep";
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  route?: "reply" | "delegate";
  outcome?: "success" | "failure" | "timeout";
  isPlanCall?: boolean;
  latencyMs?: number;
}

export class InMemoryCostEventStore {
  private readonly events: CostEvent[] = [];

  record(event: CostEvent): void {
    this.events.push(event);
  }

  list(): CostEvent[] {
    return [...this.events];
  }
}
