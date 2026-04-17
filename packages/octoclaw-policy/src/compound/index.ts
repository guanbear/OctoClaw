export const COMPOUND_POLICY_SCHEMA_VERSION = "octoclaw.compound_policy/v1" as const;

export interface CompoundPolicyPlaceholder {
  schemaVersion: typeof COMPOUND_POLICY_SCHEMA_VERSION;
  availableInLivePath: false;
  reason: "phase1_compound_disabled";
  futureRouteAuthority: true;
}

export function buildCompoundPolicyPlaceholder(): CompoundPolicyPlaceholder {
  return {
    schemaVersion: COMPOUND_POLICY_SCHEMA_VERSION,
    availableInLivePath: false,
    reason: "phase1_compound_disabled",
    futureRouteAuthority: true,
  };
}
