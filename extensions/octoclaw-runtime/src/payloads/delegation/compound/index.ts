export interface CompoundDelegationPlaceholder {
  schemaVersion: "octoclaw.delegation.compound/v1";
  availableInPhase1: false;
  reason: "ws4_compound_placeholder";
}

export function buildCompoundDelegationPlaceholder(): CompoundDelegationPlaceholder {
  return {
    schemaVersion: "octoclaw.delegation.compound/v1",
    availableInPhase1: false,
    reason: "ws4_compound_placeholder",
  };
}
