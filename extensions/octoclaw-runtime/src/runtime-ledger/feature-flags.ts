// ── OCTOCLAW_RUNTIME_LEDGER ──────────────────────────────────────────

export type RuntimeLedgerFlag = "off" | "shadow" | "enforce";

export function resolveRuntimeLedgerFlag(): RuntimeLedgerFlag {
  const v = String(process.env.OCTOCLAW_RUNTIME_LEDGER ?? "").trim().toLowerCase();
  if (v === "shadow") return "shadow";
  if (v === "enforce") return "enforce";
  return "off";
}

export function isLedgerActive(flag?: RuntimeLedgerFlag): boolean {
  const resolved = flag ?? resolveRuntimeLedgerFlag();
  return resolved === "shadow" || resolved === "enforce";
}

// ── OCTOCLAW_SCHEDULER_ENABLED ───────────────────────────────────────

export function isSchedulerEnabled(): boolean {
  const value = String(process.env.OCTOCLAW_SCHEDULER_ENABLED ?? "").trim().toLowerCase();
  return value === "1" || value === "true";
}

// ── OCTOCLAW_TASK_STATE_REBUILD ──────────────────────────────────────

export function isTaskStateRebuildEnabled(): boolean {
  return String(process.env.OCTOCLAW_TASK_STATE_REBUILD ?? "").trim() === "1";
}

// ── aggregator ───────────────────────────────────────────────────────

export interface RuntimeLedgerFeatureFlags {
  ledgerMode: RuntimeLedgerFlag;
  ledgerActive: boolean;
  schedulerEnabled: boolean;
  taskStateRebuildEnabled: boolean;
}

export function resolveAllFeatureFlags(): RuntimeLedgerFeatureFlags {
  const ledgerMode = resolveRuntimeLedgerFlag();
  return {
    ledgerMode,
    ledgerActive: isLedgerActive(ledgerMode),
    schedulerEnabled: isSchedulerEnabled(),
    taskStateRebuildEnabled: isTaskStateRebuildEnabled(),
  };
}
