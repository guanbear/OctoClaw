type JsonRecord = Record<string, unknown>;

export interface ProviderConfig {
  providerId: string;
  baseUrl: string;
  authHeader: { name: string; value: string };
  format: "openai_chat" | "anthropic_messages" | "ollama";
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function providerModelIds(providerConfig: JsonRecord): string[] {
  const models = providerConfig.models;
  if (!Array.isArray(models)) return [];
  return models.map((entry) => {
    if (typeof entry === "string") return entry;
    return asString(asRecord(entry).id);
  }).filter(Boolean);
}

function isOpenAiFamilyModel(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return /^gpt-\d/u.test(normalized) || normalized.startsWith("chatgpt-") || /^o\d/u.test(normalized);
}

function gptMajor(modelId: string): string | undefined {
  return /^gpt-(\d+)/u.exec(modelId.toLowerCase())?.[1];
}

function canProbeUnconfiguredModel(providerId: string, modelId: string, configuredModelIds: string[]): boolean {
  if (!isOpenAiFamilyModel(modelId)) return false;
  if (providerId.toLowerCase() === "openai") return true;
  const requestedMajor = gptMajor(modelId);
  if (!requestedMajor) return false;
  return configuredModelIds.some((configuredModelId) => {
    const normalized = configuredModelId.includes("/")
      ? configuredModelId.slice(configuredModelId.indexOf("/") + 1)
      : configuredModelId;
    return gptMajor(normalized) === requestedMajor;
  });
}

function authHeaderFromProvider(providerConfig: JsonRecord): ProviderConfig["authHeader"] | null {
  const authHeader = asRecord(providerConfig.authHeader);
  const authHeaderName = asString(authHeader.name);
  const authHeaderValue = asString(authHeader.value);
  if (authHeaderName && authHeaderValue) return { name: authHeaderName, value: authHeaderValue };

  const apiKey = asString(providerConfig.apiKey ?? providerConfig.api_key ?? providerConfig.token);
  if (apiKey) return { name: "authorization", value: `Bearer ${apiKey}` };
  return null;
}

function formatFromProvider(providerId: string, providerConfig: JsonRecord): ProviderConfig["format"] {
  const format = asString(providerConfig.format).toLowerCase();
  if (format === "anthropic_messages") return "anthropic_messages";
  if (format === "ollama") return "ollama";
  return providerId.toLowerCase().includes("anthropic") ? "anthropic_messages" : "openai_chat";
}

export function resolveProviderForModel(modelKey: string, openclawConfig: unknown): ProviderConfig | null {
  const slash = modelKey.indexOf("/");
  if (slash <= 0) return null;
  const providerId = modelKey.slice(0, slash);
  const modelId = modelKey.slice(slash + 1);
  const providers = asRecord(asRecord(asRecord(openclawConfig).models).providers);
  const providerConfig = asRecord(providers[providerId]);
  if (!isRecord(providerConfig)) return null;

  const modelIds = providerModelIds(providerConfig);
  const configured = modelIds.includes(modelId) || modelIds.includes(modelKey);
  if (!configured && !canProbeUnconfiguredModel(providerId, modelId, modelIds)) return null;

  const baseUrl = asString(providerConfig.baseUrl ?? providerConfig.baseURL ?? providerConfig.apiBaseUrl ?? providerConfig.endpoint);
  const authHeader = authHeaderFromProvider(providerConfig);
  if (!baseUrl || !authHeader) return null;

  return {
    providerId,
    baseUrl,
    authHeader,
    format: formatFromProvider(providerId, providerConfig),
  };
}
