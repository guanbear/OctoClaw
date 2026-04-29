import {
  buildAckWriterSystemPrompt as buildCanonicalAckWriterSystemPrompt,
  buildLocalJudgeSystemPrompt as buildCanonicalLocalJudgeSystemPrompt,
  buildLocalJudgeUserPrompt as buildCanonicalLocalJudgeUserPrompt,
} from "../spec/prompt-builder.js";
import { JUDGE_INPUT_CAPS, type JudgeInput } from "./judge-schema.js";

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

export function buildAckWriterSystemPrompt(): string {
  return buildCanonicalAckWriterSystemPrompt();
}
