// ── OCTOCLAW_RUNTIME_LEDGER ──────────────────────────────────────────

export type RuntimeLedgerFlag = "off" | "shadow" | "enforce";

export function resolveRuntimeLedgerFlag(): RuntimeLedgerFlag {
  const v = String(process.env.OCTOCLAW_RUNTIME_LEDGER ?? "").trim().toLowerCase();
  if (v === "shadow") return "shadow";
  if (v === "enforce") return "enforce";
  if (v === "off") return "off";
  return "enforce";
}

export function isLedgerActive(flag?: RuntimeLedgerFlag): boolean {
  const resolved = flag ?? resolveRuntimeLedgerFlag();
  return resolved === "shadow" || resolved === "enforce";
}

// ── aggregator ───────────────────────────────────────────────────────

export interface RuntimeLedgerFeatureFlags {
  ledgerMode: RuntimeLedgerFlag;
  ledgerActive: boolean;
}

export function resolveAllFeatureFlags(): RuntimeLedgerFeatureFlags {
  const ledgerMode = resolveRuntimeLedgerFlag();
  return {
    ledgerMode,
    ledgerActive: isLedgerActive(ledgerMode),
  };
}
