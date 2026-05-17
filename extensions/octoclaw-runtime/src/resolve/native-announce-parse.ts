import { createHash } from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import { resolveMainAgentSessionsPath } from "./env.js";
import { type UnknownRecord, asRecord } from "../util/type-coercion.js";
import { stringValue } from "../extension-entry-shared.js";
import { extractMessageText } from "../extension-entry-helpers.js";
import { type NativeAnnounceBlocker, type NativeAnnounceCompletion } from "./native-announce-types.js";

export function regexGroup(text: string, pattern: RegExp): string {
  return stringValue(pattern.exec(text)?.[1]);
}

function extractOctoClawWorkerResultPacket(text: string): UnknownRecord {
  const raw = regexGroup(
    text,
    /<<<BEGIN_OCTOCLAW_WORKER_RESULT>>>\s*([\s\S]*?)\s*<<<END_OCTOCLAW_WORKER_RESULT>>>/u,
  );
  if (!raw) return {};
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function extractNativeAnnounceBlocker(completion: NativeAnnounceCompletion): NativeAnnounceBlocker | null {
  const resultText = stringValue(completion.resultText);
  const status = stringValue(completion.status).toLowerCase();
  const workerResult = extractOctoClawWorkerResultPacket(resultText);
  if (
    stringValue(workerResult.schemaVersion || workerResult.schema_version) === "octoclaw.worker_result.v1"
    && stringValue(workerResult.status).toLowerCase() === "blocked"
  ) {
    const blockers = Array.isArray(workerResult.blockers)
      ? workerResult.blockers.map((item) => stringValue(item)).filter(Boolean)
      : [];
    const rawReason = blockers[0] || stringValue(workerResult.summary) || "child reported missing context";
    const reason = rawReason.replace(/\s+/gu, " ").trim().slice(0, 220) || "child reported missing context";
    return { blocked: true, reason };
  }
  const structuredBlocked = status === "blocked" || status.startsWith("blocked ");
  if (!structuredBlocked) return null;
  const rawReason = "child reported missing context";
  const reason = rawReason.replace(/\s+/gu, " ").trim().slice(0, 220) || "child reported missing context";
  return { blocked: true, reason };
}

function nativeAnnounceProvenance(event: UnknownRecord): UnknownRecord {
  const direct = asRecord(event.provenance);
  if (stringValue(direct.sourceTool || direct.source_tool || direct.kind)) return direct;
  const message = asRecord(event.message);
  const messageProvenance = asRecord(message.provenance);
  if (stringValue(messageProvenance.sourceTool || messageProvenance.source_tool || messageProvenance.kind)) {
    return messageProvenance;
  }
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = asRecord(messages[index]);
    const provenance = asRecord(candidate.provenance);
    if (stringValue(provenance.sourceTool || provenance.source_tool || provenance.kind)) {
      return provenance;
    }
  }
  return {};
}

export function extractNativeAnnounceCompletion(event: UnknownRecord, prompt: string): NativeAnnounceCompletion | null {
  const text = stringValue(prompt);
  if (!text) return null;
  const provenance = nativeAnnounceProvenance(event);
  const structuredSourceTool = stringValue(provenance.sourceTool || provenance.source_tool);
  const sourceTool = structuredSourceTool || regexGroup(text, /\bsourceTool=([^\s]+)/u);
  const internalSubagentCompletion = !structuredSourceTool
    && /\[Internal task completion event\][\s\S]*\bsource:\s*subagent\b/iu.test(text);
  if (sourceTool !== "subagent_announce" && (!structuredSourceTool && !text.includes("sourceTool=subagent_announce")) && !internalSubagentCompletion) {
    return null;
  }
  const sourceSessionFromPrompt = regexGroup(text, /\bsourceSession=([^\s]+)/u)
    || regexGroup(text, /\bsession_key:\s*([^\s]+)/u);
  const sourceSessionKey = sourceSessionFromPrompt
    || stringValue(provenance.sourceSessionKey || provenance.source_session_key);
  if (!sourceSessionKey) return null;
  const status = regexGroup(text, /\bstatus:\s*([^\n]+)/iu);
  const looksCompleted = /completed|success|succeed/i.test(status)
    || /completed subagent task is ready/i.test(text)
    || /\[Internal task completion event\]/u.test(text);
  if (!looksCompleted) return null;
  const resultText = regexGroup(
    text,
    /<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>\s*([\s\S]*?)\s*<<<END_UNTRUSTED_CHILD_RESULT>>>/u,
  );
  if (!resultText) return null;
  return {
    sourceSessionKey,
    sourceSessionId: stringValue(provenance.sourceSessionId || provenance.source_session_id)
      || regexGroup(text, /\bsession_id:\s*([^\s]+)/u),
    sourceTool: "subagent_announce",
    status,
    resultText,
    resultHash: createHash("sha256").update(resultText).digest("hex").slice(0, 16),
  };
}

function addNativeChildSessionFileCandidate(candidates: Set<string>, candidate: unknown, baseDir: string): void {
  const text = stringValue(candidate);
  if (!text) return;
  candidates.add(path.isAbsolute(text) ? text : path.join(baseDir, text));
}

function nativeChildSessionFileCandidates(childSessionKey: string, runId?: string): string[] {
  const sessionsPath = resolveMainAgentSessionsPath();
  const sessionsDir = path.dirname(sessionsPath);
  const refs = new Set([childSessionKey, runId].map(stringValue).filter(Boolean));
  const candidates = new Set<string>();
  for (const ref of refs) {
    addNativeChildSessionFileCandidate(candidates, `${ref}.jsonl`, sessionsDir);
  }
  try {
    const registry = JSON.parse(fsSync.readFileSync(sessionsPath, "utf8")) as unknown;
    if (registry && typeof registry === "object" && !Array.isArray(registry)) {
      for (const [key, value] of Object.entries(registry as UnknownRecord)) {
        const record = asRecord(value);
        const values = [
          key,
          record.sessionKey,
          record.sessionId,
          record.runId,
          record.childRunId,
          record.controlKey,
          record.channelSessionKey,
          record.bindingKey,
          record.threadKey,
        ].map(stringValue);
        if (!values.some((candidate) => refs.has(candidate))) continue;
        addNativeChildSessionFileCandidate(candidates, record.sessionFile, sessionsDir);
        const sessionId = stringValue(record.sessionId);
        if (sessionId) addNativeChildSessionFileCandidate(candidates, `${sessionId}.jsonl`, sessionsDir);
      }
    }
  } catch {}
  return [...candidates];
}

export function readNativeChildSessionCompletion(childSessionKey: string, runId?: string): NativeAnnounceCompletion | null {
  const sourceSessionKey = stringValue(childSessionKey);
  if (!sourceSessionKey) return null;
  let resultText = "";
  let sourceSessionId = "";
  for (const filePath of nativeChildSessionFileCandidates(sourceSessionKey, runId)) {
    let lines: string[];
    try {
      lines = fsSync.readFileSync(filePath, "utf8").split(/\n/u).filter(Boolean);
    } catch {
      continue;
    }
    for (const line of lines) {
      let record: UnknownRecord;
      try {
        record = JSON.parse(line) as UnknownRecord;
      } catch {
        continue;
      }
      if (record.type === "session") {
        sourceSessionId ||= stringValue(record.id);
      }
      if (record.type !== "message") continue;
      const message = asRecord(record.message);
      if (stringValue(message.role).toLowerCase() !== "assistant") continue;
      const text = extractMessageText(message.content);
      if (!text || text.trim().toUpperCase() === "NO_REPLY") continue;
      resultText = text;
    }
    if (resultText) break;
  }
  if (!resultText) return null;
  return {
    sourceSessionKey,
    sourceSessionId,
    sourceTool: "subagent_announce",
    status: "completed",
    resultText,
    resultHash: createHash("sha256").update(resultText).digest("hex").slice(0, 16),
  };
}
