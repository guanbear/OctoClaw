export interface NativeFallbackSuggestionModel {
  modelKey: string;
  tags?: string[];
  health?: {
    cooldown?: boolean;
    cooldownReason?: string;
    recentFailureRate?: number;
    sampleCount?: number;
  };
}

export interface NativeFallbackSuggestion {
  modelKey: string;
  currentNativePosition: string;
  cooldownReason: string;
  evidence: {
    recentFailureRate?: number;
    sampleCount?: number;
  };
  suggestedAction: {
    command: string;
    explanation: string;
  };
}

export function evaluateNativeFallbackSuggestions(
  models: NativeFallbackSuggestionModel[],
  nativeFallbackOrder: string[] = [],
): NativeFallbackSuggestion[] {
  return models.flatMap((model) => {
    if (model.health?.cooldown !== true) return [];
    const currentNativePosition = nativeFallbackPosition(model, nativeFallbackOrder);
    if (!currentNativePosition) return [];
    const cooldownReason = model.health.cooldownReason ?? "cooldown";
    return [{
      modelKey: model.modelKey,
      currentNativePosition,
      cooldownReason,
      evidence: {
        ...(model.health.recentFailureRate !== undefined ? { recentFailureRate: model.health.recentFailureRate } : {}),
        ...(model.health.sampleCount !== undefined ? { sampleCount: model.health.sampleCount } : {}),
      },
      suggestedAction: {
        command: `openclaw models fallbacks remove ${model.modelKey}`,
        explanation: "Cooldown observed; consider demoting this fallback while it stabilizes",
      },
    }];
  });
}

function nativeFallbackPosition(model: NativeFallbackSuggestionModel, nativeFallbackOrder: string[]): string | undefined {
  if (model.tags?.includes("default")) return "default";
  const explicitIndex = nativeFallbackOrder.findIndex((entry) => entry.toLowerCase() === model.modelKey.toLowerCase());
  if (explicitIndex >= 0) return `fallback#${explicitIndex + 1}`;
  return model.tags?.find((tag) => /^fallback#\d+$/iu.test(tag));
}
