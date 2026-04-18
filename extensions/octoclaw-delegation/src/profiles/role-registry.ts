/**
 * Reserved interface for Phase 3 callable role registry.
 * Allows dynamic registration and lookup of delegation roles
 * beyond the static preset profiles.
 */

export interface DelegationRoleDefinition {
  role: string;
  modelProfile: string;
  allowedTools: string[];
  outputContract: string;
  workspaceMode: string;
  description: string;
  active: boolean;
}

export interface DelegationRoleRegistry {
  register(definition: DelegationRoleDefinition): void;
  resolve(role: string): DelegationRoleDefinition | null;
  listActive(): DelegationRoleDefinition[];
  deactivate(role: string): boolean;
}

/** Phase 1 static registry backed by existing DELEGATION_PROFILES */
export function createDelegationRoleRegistry(staticProfiles: Record<string, unknown>): DelegationRoleRegistry {
  const entries = new Map<string, DelegationRoleDefinition>();

  if (staticProfiles && typeof staticProfiles === "object") {
    for (const [key, value] of Object.entries(staticProfiles)) {
      if (value && typeof value === "object") {
        const profile = value as Record<string, unknown>;
        entries.set(key, {
          role: key,
          modelProfile: String(profile.modelProfile ?? ""),
          allowedTools: Array.isArray(profile.allowedTools) ? (profile.allowedTools as string[]) : [],
          outputContract: String(profile.outputContract ?? ""),
          workspaceMode: String(profile.workspaceMode ?? "shared_workspace"),
          description: String(profile.description ?? `Static preset: ${key}`),
          active: true,
        });
      }
    }
  }

  return {
    register: (definition) => {
      entries.set(definition.role, { ...definition, active: true });
    },
    resolve: (role) => entries.get(role) ?? null,
    listActive: () => [...entries.values()].filter((entry) => entry.active),
    deactivate: (role) => {
      const entry = entries.get(role);
      if (entry) {
        entry.active = false;
        return true;
      }
      return false;
    },
  };
}
