export type AckTemplateStage = "ack0" | "tier1" | "tier2" | "tier3";
export type AckTemplateChannel = "chat" | "work" | "cli" | "unknown";
export type AckTemplateTone = "neutral" | "warm" | "terse";
export type AckTemplateTaskClass =
  | "lookup" | "coding" | "review" | "writing"
  | "status" | "long_running" | "unknown";
export type AckTemplateModality = "reaction" | "text" | "unknown";

export interface AckTemplateEntry {
  key: string;
  stage: AckTemplateStage;
  channel: AckTemplateChannel;
  tone: AckTemplateTone;
  taskClass: AckTemplateTaskClass;
  modality: AckTemplateModality;
  semanticKey?: string;
  text: string;
}

export interface AckTemplateRegistry {
  selectTemplate(input: {
    stage: AckTemplateStage;
    channel: AckTemplateChannel;
    tone: AckTemplateTone;
    taskClass: AckTemplateTaskClass;
    modality: AckTemplateModality;
    semanticKey?: string;
    threadBindingKey: string;
    turnId: string;
    recentKeys: string[];
  }): AckTemplateEntry;
  getAllForStage(stage: string): AckTemplateEntry[];
}

const ack0Templates: AckTemplateEntry[] = [
  { key: "ack0-chat-neutral-lookup-1", stage: "ack0", channel: "chat", tone: "neutral", taskClass: "lookup", modality: "text", text: "收到，在看。" },
  { key: "ack0-chat-neutral-lookup-2", stage: "ack0", channel: "chat", tone: "neutral", taskClass: "lookup", modality: "text", text: "收到。" },
  { key: "ack0-chat-neutral-coding-1", stage: "ack0", channel: "chat", tone: "neutral", taskClass: "coding", modality: "text", text: "收到，在看。" },
  { key: "ack0-chat-neutral-coding-2", stage: "ack0", channel: "chat", tone: "neutral", taskClass: "coding", modality: "text", text: "收到。" },
  { key: "ack0-chat-neutral-review-1", stage: "ack0", channel: "chat", tone: "neutral", taskClass: "review", modality: "text", text: "收到，在看。" },
  { key: "ack0-chat-neutral-writing-1", stage: "ack0", channel: "chat", tone: "neutral", taskClass: "writing", modality: "text", text: "收到，在写。" },
  { key: "ack0-chat-neutral-status-1", stage: "ack0", channel: "chat", tone: "neutral", taskClass: "status", modality: "text", text: "收到，在看。" },
  { key: "ack0-chat-neutral-long_running-1", stage: "ack0", channel: "chat", tone: "neutral", taskClass: "long_running", modality: "text", text: "收到，处理中。" },
  { key: "ack0-chat-neutral-unknown-1", stage: "ack0", channel: "chat", tone: "neutral", taskClass: "unknown", modality: "text", text: "收到。" },
  { key: "ack0-unknown-neutral-unknown-1", stage: "ack0", channel: "unknown", tone: "neutral", taskClass: "unknown", modality: "text", text: "收到。" },
  { key: "ack0-chat-neutral-unknown-reaction-1", stage: "ack0", channel: "chat", tone: "neutral", taskClass: "unknown", modality: "reaction", text: "" },
  { key: "ack0-unknown-neutral-unknown-reaction-1", stage: "ack0", channel: "unknown", tone: "neutral", taskClass: "unknown", modality: "reaction", text: "" },
];

const tierTemplates: AckTemplateEntry[] = [
  { key: "tier1-unknown-neutral-unknown-1", stage: "tier1", channel: "unknown", tone: "neutral", taskClass: "unknown", modality: "text", text: "还在处理，稍等。" },
  { key: "tier2-unknown-neutral-unknown-1", stage: "tier2", channel: "unknown", tone: "neutral", taskClass: "unknown", modality: "text", text: "还需要一点时间。" },
  { key: "tier3-unknown-neutral-unknown-1", stage: "tier3", channel: "unknown", tone: "neutral", taskClass: "unknown", modality: "text", text: "处理时间较长，整理中。" },
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
        stageEntries.filter((entry) => entry.channel === input.channel && entry.tone === input.tone && entry.taskClass === input.taskClass && entry.modality === input.modality),
        stageEntries.filter((entry) => entry.channel === input.channel && entry.tone === input.tone && entry.taskClass === input.taskClass && entry.modality === input.modality),
        stageEntries.filter((entry) => entry.channel === input.channel && entry.tone === input.tone && entry.modality === input.modality),
        stageEntries.filter((entry) => entry.channel === "unknown" && entry.tone === "neutral" && entry.modality === input.modality),
        stageEntries.filter((entry) => entry.modality === input.modality),
        stageEntries.filter((entry) => entry.channel === "unknown" && entry.tone === "neutral" && entry.text.length > 0),
        stageEntries.filter((entry) => entry.text.length > 0),
      ];
      const pool = scopedPools.find((candidatePool) => candidatePool.length > 0) ?? stageEntries;
      const hashInput = `${input.threadBindingKey}:${input.turnId}:${input.stage}:${input.semanticKey ?? input.taskClass}`;

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
