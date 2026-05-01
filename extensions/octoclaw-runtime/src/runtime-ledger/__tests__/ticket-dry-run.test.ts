import { describe, it, expect } from "vitest";
import type { ContextCoverageSnapshot } from "@octoclaw/contracts/work-contract";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "../../work-contract/builders.js";
import { buildDelegationTicketDryRun } from "../ticket-dry-run.js";

const coverage: ContextCoverageSnapshot = {
  precheckOrder: [
    "conversation_grounding", "continuation_route_reuse", "execution_coverage",
    "memory_coverage", "build_judge_context_packet", "local_judge",
    "validator_or_remote", "route_seal_commit",
  ],
  execution: { coverage: "none" },
  memory: { coverage: "none" },
  conflict: false,
  authority: "none",
};

describe("buildDelegationTicketDryRun", () => {
  it("does not issue a ticket for execution follow-up reply work", () => {
    const contract = buildWorkContractFromPolicy(
      "agent:main:ticket-followup",
      "为什么刚才自己回复一次又派发一次",
      "execution_followup",
      coverage,
      buildWorkDecisionSeal("execution_coverage", "reply", ["execution_followup"]),
    );

    const result = buildDelegationTicketDryRun({
      contract,
      decision: {
        route_decision: { route: "reply" },
        router_decision_v2: { request_kind: "status_or_provenance" },
      },
    });

    expect(result.ticket_decision).toBe("ticket_not_issued");
    expect(result.ticket_denial_reason).toBe("not_new_work");
    expect(result.is_new_work).toBe(false);
    expect(result.expected_deliverable).toBe("为什么刚才自己回复一次又派发一次");
  });

  it("would issue a dry-run ticket for fresh delegated work with deliverable", () => {
    const contract = buildWorkContractFromPolicy(
      "agent:main:ticket-delegate",
      "修改 runtime ledger 并补测试",
      "delegated_work",
      coverage,
      buildWorkDecisionSeal("local_judge", "delegate", ["needs_code_change"]),
    );

    const result = buildDelegationTicketDryRun({
      contract,
      decision: {
        route_decision: { route: "delegate" },
        router_decision_v2: { request_kind: "delegated_task" },
      },
    });

    expect(result.ticket_decision).toBe("ticket_would_issue");
    expect(result.ticket_denial_reason).toBe("");
    expect(result.is_new_work).toBe(true);
    expect(result.expected_deliverable).toBe("修改 runtime ledger 并补测试");
    expect(result.work_contract_id).toBe(contract.workContractId);
  });

  it("denies delegated route when semantic follow-up evidence is present", () => {
    const result = buildDelegationTicketDryRun({
      decision: {
        route_decision: { route: "delegate" },
        router_decision_v2: { request_kind: "status_or_provenance" },
      },
      payload: { summary: "检查刚才派发状态" },
    });

    expect(result.ticket_decision).toBe("ticket_not_issued");
    expect(result.ticket_denial_reason).toBe("not_new_work");
    expect(result.is_new_work).toBe(false);
  });

  it("does not issue a ticket for existing execution follow-up relation", () => {
    const result = buildDelegationTicketDryRun({
      decision: {
        route_decision: { route: "delegate" },
        router_decision_v2: { request_kind: "delegated_task" },
      },
      metadata: { relation_to_recent_execution: "existing_execution_followup" },
      payload: { summary: "检查刚才的执行结果" },
    });

    expect(result.ticket_decision).toBe("ticket_not_issued");
    expect(result.ticket_denial_reason).toBe("not_new_work");
    expect(result.is_new_work).toBe(false);
  });

  it("does not issue a ticket for existing execution provenance relation", () => {
    const result = buildDelegationTicketDryRun({
      decision: {
        route_decision: { route: "delegate" },
        router_decision_v2: { request_kind: "delegated_task" },
      },
      metadata: {
        intent_packet: {
          relation_to_recent_execution: "existing_execution_provenance_query",
        },
      },
      payload: { summary: "说明刚才为什么这么执行" },
    });

    expect(result.ticket_decision).toBe("ticket_not_issued");
    expect(result.ticket_denial_reason).toBe("not_new_work");
    expect(result.is_new_work).toBe(false);
  });

  it("would issue a ticket for new work relation with valid deliverable", () => {
    const result = buildDelegationTicketDryRun({
      decision: {
        route_decision: { route: "delegate" },
        router_decision_v2: { request_kind: "delegated_task" },
      },
      metadata: { relation_to_recent_execution: "new_work" },
      payload: { summary: "实现新的 runtime ledger 校验" },
    });

    expect(result.ticket_decision).toBe("ticket_would_issue");
    expect(result.ticket_denial_reason).toBe("");
    expect(result.is_new_work).toBe(true);
    expect(result.expected_deliverable).toBe("实现新的 runtime ledger 校验");
  });

  it("would issue a ticket for ambiguous relation with no other follow-up signals", () => {
    const result = buildDelegationTicketDryRun({
      decision: {
        route_decision: { route: "delegate" },
        router_decision_v2: { request_kind: "delegated_task" },
        request: {
          metadata: { relation_to_recent_execution: "ambiguous" },
        },
      },
      payload: { summary: "补充新的 dry-run 覆盖" },
    });

    expect(result.ticket_decision).toBe("ticket_would_issue");
    expect(result.ticket_denial_reason).toBe("");
    expect(result.is_new_work).toBe(true);
    expect(result.expected_deliverable).toBe("补充新的 dry-run 覆盖");
  });
});
