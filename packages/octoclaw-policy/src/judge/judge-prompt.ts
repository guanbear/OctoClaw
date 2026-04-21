import {
  buildAckWriterSystemPrompt as buildCanonicalAckWriterSystemPrompt,
  buildLocalJudgeSystemPrompt as buildCanonicalLocalJudgeSystemPrompt,
  buildLocalJudgeUserPrompt as buildCanonicalLocalJudgeUserPrompt,
  buildRemoteJudgeSystemPrompt as buildCanonicalRemoteJudgeSystemPrompt,
  buildRemoteJudgeUserPrompt as buildCanonicalRemoteJudgeUserPrompt,
} from "../spec/prompt-builder.js";
import { JUDGE_INPUT_CAPS, type JudgeInput, type JudgeOutput, type RemoteJudgeExpandedPacket } from "./judge-schema.js";

export function buildJudgeSystemPrompt(): string {
  return buildCanonicalLocalJudgeSystemPrompt();
}

export function buildJudgeUserPrompt(input: JudgeInput): string {
  return buildCanonicalLocalJudgeUserPrompt(
    input.userMessage.slice(0, JUDGE_INPUT_CAPS.userMessage),
    input.contextPacket,
    input.sessionBinding,
    input.recentLedgerSummary?.slice(0, JUDGE_INPUT_CAPS.recentLedgerSummary),
  );
}

export function buildRemoteJudgeSystemPrompt(): string {
  return buildCanonicalRemoteJudgeSystemPrompt();
}

export function buildAckWriterSystemPrompt(): string {
  return buildCanonicalAckWriterSystemPrompt();
}

export function buildRemoteJudgeUserPrompt(
  input: JudgeInput,
  localResult: JudgeOutput,
  escalationReason: string,
  expandedPacket?: RemoteJudgeExpandedPacket,
): string {
  const effectiveExpandedPacket = expandedPacket ?? input.contextPacket;

  return buildCanonicalRemoteJudgeUserPrompt(
    input.userMessage.slice(0, JUDGE_INPUT_CAPS.userMessage),
    localResult,
    escalationReason,
    effectiveExpandedPacket,
  );
}
