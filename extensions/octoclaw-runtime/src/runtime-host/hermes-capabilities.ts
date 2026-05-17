export type RuntimeHostMode = "openclaw" | "hermes_dry_run";

export interface HermesCapabilityMatrix {
  acp: "supported" | "unknown";
  gatewayMessaging: "supported" | "unknown";
  sessionStorage: "supported" | "unknown";
  backgroundDelegation: "supported" | "unknown";
  deliveryReceipts: "supported" | "unknown";
  runtimeFallbacks: "supported" | "unknown";
  notes: string[];
}

export const HERMES_CAPABILITY_MATRIX: HermesCapabilityMatrix = {
  acp: "supported",
  gatewayMessaging: "supported",
  sessionStorage: "supported",
  backgroundDelegation: "unknown",
  deliveryReceipts: "unknown",
  runtimeFallbacks: "unknown",
  notes: [
    "Hermes exposes ACP over stdio.",
    "Hermes has a messaging gateway and many platform adapters.",
    "Hermes documents SQLite-backed session storage.",
    "Background delegation must be verified against Hermes delegate/background semantics before live use.",
    "Messaging delivery exists, but receipt semantics need proof.",
    "Provider/runtime fallback mapping must be verified separately.",
  ],
};

export interface HermesDryRunRejection {
  ok: false;
  reason: "hermes_live_runtime_not_enabled";
  detail: string;
}

export function hermesDryRunSpawn(_input: unknown): HermesDryRunRejection {
  return {
    ok: false,
    reason: "hermes_live_runtime_not_enabled",
    detail: "Hermes spawn is not available in dry-run mode. No child run was created.",
  };
}

export function hermesDryRunDeliver(_input: unknown): HermesDryRunRejection {
  return {
    ok: false,
    reason: "hermes_live_runtime_not_enabled",
    detail: "Hermes deliver is not available in dry-run mode. No user-facing final was sent.",
  };
}

export function resolveRuntimeHostMode(env: Record<string, string | undefined> = process.env): RuntimeHostMode {
  const value = String(env.OCTOCLAW_RUNTIME_HOST_MODE ?? "").trim().toLowerCase();
  if (value === "hermes_dry_run") return "hermes_dry_run";
  return "openclaw";
}
