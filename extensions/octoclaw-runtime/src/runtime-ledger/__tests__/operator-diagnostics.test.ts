import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { inspectLedgerHealth, listOrphanCompletions, releaseStaleLeases, operatorRebuildProjection } from "../operator-diagnostics.js";

const mockDb = (tables: Record<string, unknown[]>) => ({
  exec: vi.fn(),
  prepare: vi.fn((sql: string) => {
    const tableNameMatch = sql.match(/FROM\s+(\w+)/i);
    const table = tableNameMatch?.[1] ?? "";
    const rows = tables[table] ?? [];
    return {
      all: vi.fn((..._args: unknown[]) => rows),
      run: vi.fn(),
      get: vi.fn(() => rows[0] ?? null),
    };
  }),
  close: vi.fn(),
});

describe("operator-diagnostics", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("inspectLedgerHealth", () => {
    it("returns error report when ledger is unavailable", () => {
      const result = inspectLedgerHealth({ sqlite: null as any });
      expect(result.dbOpen).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("returns healthy report with counts", () => {
      const db = mockDb({
        schema_migrations: [{ v: 1 }],
        work_contracts: [{ c: 5 }],
        task_attempts: [{ c: 10 }],
        delegation_tickets: [{ c: 3 }],
        scheduler_queue: [{ c: 2 }],
        completion_bindings: [{ c: 7 }],
        runtime_events: [{ c: 20 }],
      });

      const sqlite = { DatabaseSync: vi.fn(() => db) } as any;
      const result = inspectLedgerHealth({ sqlite });

      expect(result.dbOpen).toBe(true);
      expect(result.schemaVersion).toBe(1);
      expect(result.workContractCount).toBe(5);
      expect(result.attemptCount).toBe(10);
      expect(result.ticketCount).toBe(3);
      expect(result.queueCount).toBe(2);
      expect(result.completionBindingCount).toBe(7);
      expect(result.runtimeEventCount).toBe(20);
    });

    it("counts orphaned completions", () => {
      const db = mockDb({
        schema_migrations: [{ v: 1 }],
        work_contracts: [{ c: 0 }],
        task_attempts: [{ c: 0 }],
        delegation_tickets: [{ c: 0 }],
        scheduler_queue: [{ c: 0 }],
        completion_bindings: [{ c: 3 }],
        runtime_events: [{ c: 0 }],
      });

      const sqlite = { DatabaseSync: vi.fn(() => db) } as any;
      const result = inspectLedgerHealth({ sqlite });
      expect(result.completionBindingCount).toBe(3);
    });
  });

  describe("listOrphanCompletions", () => {
    it("returns empty array when ledger unavailable", () => {
      const result = listOrphanCompletions({ sqlite: null as any });
      expect(result).toEqual([]);
    });

    it("returns orphan summaries from ledger", () => {
      const orphanRow = {
        completion_id: "comp-1",
        work_contract_id: "wc-1",
        attempt_id: "att-1",
        expected_path: "/path/to/completion.json",
        verdict: "completion_orphaned",
        created_at: "2026-05-01T00:00:00.000Z",
      };

      const db = mockDb({ completion_bindings: [orphanRow] });
      const sqlite = { DatabaseSync: vi.fn(() => db) } as any;

      const result = listOrphanCompletions({ sqlite });
      expect(result.length).toBe(1);
      expect(result[0].completionId).toBe("comp-1");
      expect(result[0].verdict).toBe("completion_orphaned");
      expect(result[0].expectedPath).toBe("/path/to/completion.json");
    });
  });

  describe("releaseStaleLeases", () => {
    it("delegates to requeueExpiredLeases", () => {
      const result = releaseStaleLeases({ sqlite: null as any });
      expect(typeof result.released).toBe("number");
    });
  });

  describe("operatorRebuildProjection", () => {
    it("returns disabled when flag is off", () => {
      delete process.env.OCTOCLAW_TASK_STATE_REBUILD;
      const result = operatorRebuildProjection({ sqlite: null as any });
      expect(result.enabled).toBe(false);
      expect(result.rebuilt).toBe(false);
    });

    it("attempts rebuild when flag is on", () => {
      process.env.OCTOCLAW_TASK_STATE_REBUILD = "1";
      const result = operatorRebuildProjection({ sqlite: null as any });
      expect(result.enabled).toBe(true);
    });
  });
});
