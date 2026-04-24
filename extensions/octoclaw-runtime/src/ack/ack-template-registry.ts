export type AckTemplateStage = "ack0" | "tier1" | "tier2" | "tier3";
export type AckTemplateChannel = "chat" | "work" | "cli" | "unknown";
export type AckTemplateTone = "neutral" | "warm" | "terse";

export interface AckTemplateEntry {
  key: string;
  stage: AckTemplateStage;
  channel: AckTemplateChannel;
  tone: AckTemplateTone;
  text: string;
}

export interface AckTemplateRegistry {
  selectTemplate(input: {
    stage: AckTemplateStage;
    channel: AckTemplateChannel;
    tone: AckTemplateTone;
    threadBindingKey: string;
    turnId: string;
    recentKeys: string[];
  }): AckTemplateEntry;
  getAllForStage(stage: string): AckTemplateEntry[];
}

const ack0Templates: AckTemplateEntry[] = [
  { key: "ack0-chat-neutral-1", stage: "ack0", channel: "chat", tone: "neutral", text: "收到，我在处理。" },
  { key: "ack0-chat-neutral-2", stage: "ack0", channel: "chat", tone: "neutral", text: "收到，正在看。" },
  { key: "ack0-chat-neutral-3", stage: "ack0", channel: "chat", tone: "neutral", text: "我看一下，马上继续。" },
  { key: "ack0-chat-neutral-4", stage: "ack0", channel: "chat", tone: "neutral", text: "在处理了，稍等我一下。" },
  { key: "ack0-chat-neutral-5", stage: "ack0", channel: "chat", tone: "neutral", text: "收到，我这边继续推进。" },
  { key: "ack0-unknown-neutral-1", stage: "ack0", channel: "unknown", tone: "neutral", text: "收到，处理中。" },
];

const tierTemplates: AckTemplateEntry[] = [
  { key: "tier1-unknown-neutral-1", stage: "tier1", channel: "unknown", tone: "neutral", text: "还在处理，稍等一下。" },
  { key: "tier2-unknown-neutral-1", stage: "tier2", channel: "unknown", tone: "neutral", text: "还需要一点时间，我继续跟进。" },
  { key: "tier3-unknown-neutral-1", stage: "tier3", channel: "unknown", tone: "neutral", text: "处理时间较长，我整理一下当前进展。" },
];

const defaultTemplates: AckTemplateEntry[] = [...ack0Templates, ...tierTemplates];

function stableHash(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

function selectFromPool(pool: AckTemplateEntry[], hashInput: string, recentKeys: string[]): AckTemplateEntry {
  if (pool.length === 0) {
    throw new Error("selectFromPool requires at least one template");
  }

  const startIndex = stableHash(hashInput) % pool.length;
  const recent = new Set(recentKeys);

  for (let offset = 0; offset < pool.length; offset++) {
    const candidate = pool[(startIndex + offset) % pool.length];
    if (!recent.has(candidate.key)) {
      return candidate;
    }
  }

  return pool[startIndex];
}

export function createAckTemplateRegistry(templates: AckTemplateEntry[] = defaultTemplates): AckTemplateRegistry {
  const entries = [...templates];

  return {
    selectTemplate(input) {
      const stageEntries = entries.filter((entry) => entry.stage === input.stage);
      if (stageEntries.length === 0) {
        throw new Error(`No ACK templates registered for stage: ${input.stage}`);
      }

      const scopedPools = [
        stageEntries.filter((entry) => entry.channel === input.channel && entry.tone === input.tone),
        stageEntries.filter((entry) => entry.channel === input.channel && entry.tone === "neutral"),
        stageEntries.filter((entry) => entry.channel === "unknown" && entry.tone === input.tone),
        stageEntries.filter((entry) => entry.channel === "unknown" && entry.tone === "neutral"),
        stageEntries,
      ];
      const pool = scopedPools.find((candidatePool) => candidatePool.length > 0) ?? stageEntries;
      const hashInput = `${input.threadBindingKey}:${input.turnId}:${input.stage}`;

      return selectFromPool(pool, hashInput, input.recentKeys);
    },

    getAllForStage(stage) {
      return entries.filter((entry) => entry.stage === stage);
    },
  };
}

export const defaultAckTemplateRegistry = createAckTemplateRegistry();

export function selectAckTemplate(input: Parameters<AckTemplateRegistry["selectTemplate"]>[0]): AckTemplateEntry {
  return defaultAckTemplateRegistry.selectTemplate(input);
}

export function getAllAckTemplatesForStage(stage: string): AckTemplateEntry[] {
  return defaultAckTemplateRegistry.getAllForStage(stage);
}
