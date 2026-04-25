import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildConversationGrounding,
  buildConversationControlHintsFromIntent,
  buildConversationIntentPacket,
  buildDirectLookupGuard,
} from "./conversation-grounding.js";
import { buildDecision, resolveStatelessPolicyDecision } from "./resolve/policy-resolver.js";
import { enrichConversationControlMetadata } from "./resolve/session.js";

describe("conversation grounding route projection", () => {
  it("projects runtime version lookup to delegated observer control", () => {
    const intent = buildConversationIntentPacket({
      prompt: "你现在啥版本",
      replayLogPath: "/tmp/does-not-matter.jsonl",
      taskStatePath: "/tmp/does-not-matter.json",
      sessionKeys: [],
    });

    expect(intent.intent_class).toBe("local_surface_lookup");
    expect(intent.surface_id).toBe("runtime_version");

    const control = buildConversationControlHintsFromIntent(intent);
    expect(control.route_hint).toBe("delegate");
    expect(control.lane_hint).toBe("observe");
    expect(control.require_fresh_lookup).toBe(true);
    expect(control.require_state_grounding).toBe(true);
  });

  it("projects task status panel phrases to reply-only status surface tools", async () => {
    const intent = buildConversationIntentPacket({
      prompt: "哪个任务还在跑？跑了多久，用的哪个模型，结果在哪？",
      replayLogPath: "/tmp/does-not-matter.jsonl",
      taskStatePath: "/tmp/does-not-matter.json",
      sessionKeys: ["slack:default:channel:C123"],
    });

    expect(intent.intent_class).toBe("local_surface_lookup");
    expect(intent.surface_id).toBe("octoclaw_task_status_panel");
    expect(intent.lookup_scope).toBe("local_status_surface");

    const control = buildConversationControlHintsFromIntent(intent);
    expect(control).toMatchObject({
      route_hint: "reply",
      lane_hint: "status_surface",
      protected_lane: "control_observer",
      require_fresh_lookup: true,
      require_state_grounding: true,
      status_followup: true,
      surface_id: "octoclaw_task_status_panel",
    });

    const decision = await resolveStatelessPolicyDecision("显示 OctoClaw 状态面板", {
      metadata: {
        session_key: "slack:default:channel:C123",
        conversation_control: control,
        intent_packet: intent,
      },
    });

    const decisionRecord = decision as Record<string, unknown>;
    const routeDecision = decisionRecord.route_decision as Record<string, unknown>;
    const toolPolicy = decisionRecord.tool_policy as Record<string, unknown>;
    const stateGrounding = decisionRecord.state_grounding as Record<string, unknown>;

    expect(routeDecision.route).toBe("reply");
    expect(toolPolicy.allowed_control_tools).toEqual(["octoclaw_status", "octoclaw_task_action"]);
    expect(toolPolicy.block_tool_patterns).toEqual(["octoclaw_dispatch", "spawn"]);
    expect(stateGrounding).toMatchObject({
      required: true,
      source: "control_plane_status",
    });
  });

  it("renders sanitized DelegateStatusPacket facts without raw thread history", () => {
    const dir = path.join("/tmp", `octoclaw-grounding-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    const replayLogPath = path.join(dir, "runtime-policy-replay.jsonl");
    const taskStatePath = path.join(dir, "task-state.json");
    const taskEventsPath = path.join(dir, "task-events.jsonl");

    fs.writeFileSync(replayLogPath, [
      JSON.stringify({
        event: "policy_resolved",
        sessionKey: "session-grounding",
        sessionId: "session-grounding",
        at: "2026-04-22T10:00:00.000Z",
        prompt: "check release notes",
        route: "delegate",
        taskClass: "delegated_single",
        protectedLane: "worker_research",
      }),
      JSON.stringify({
        event: "dispatch_called",
        sessionKey: "session-grounding",
        sessionId: "session-grounding",
        at: "2026-04-22T10:00:01.000Z",
        executed: false,
        taskId: "task-grounding-1",
        materialization: {
          task_id: "task-grounding-1",
          status: "running",
        },
      }),
      JSON.stringify({
        event: "policy_resolved",
        sessionKey: "session-grounding",
        sessionId: "session-grounding",
        at: "2026-04-22T10:05:00.000Z",
        prompt: "task status",
        route: "reply",
      }),
    ].join("\n"));
    fs.writeFileSync(taskStatePath, JSON.stringify({
      tasks: [{
        id: "task-grounding-1",
        status: "running",
        summary: "User-visible: release lookup is still running. [Thread history - for context] secret transcript internal route rationale: hidden",
        worker_pool: "octoclaw-research",
        model: "worker_research",
        role: "worker_research",
        spawned_at: "2026-04-22T10:00:01.000Z",
        updated_at: "2026-04-22T10:01:00.000Z",
        openclaw_taskflow_substrate_state: "running",
        openclaw_taskflow_substrate_revision: 3,
      }],
    }));
    fs.writeFileSync(taskEventsPath, JSON.stringify({
      task_id: "task-grounding-1",
      kind: "delivery_sent",
      message: "progress delivered",
      at: "2026-04-22T10:01:30.000Z",
    }));

    const grounding = buildConversationGrounding({
      prompt: "task status",
      replayLogPath,
      taskStatePath,
      sessionKeys: ["session-grounding"],
    });

    expect(grounding.available).toBe(true);
    expect(grounding.context).toContain("schema: octoclaw.delegate_status.v1");
    expect(grounding.context).toContain("task_id: task-grounding-1");
    expect(grounding.context).toContain("status: running");
    expect(grounding.context).toContain("worker_pool: octoclaw-research");
    expect(grounding.context).toContain("model: worker_research");
    expect(grounding.context).toContain("progress: User-visible: release lookup is still running.");
    expect(grounding.context).not.toContain("internal route rationale");
    expect(grounding.context).not.toContain("secret transcript");
    expect(grounding.context).not.toContain("[Thread history]");
  });

  it("turns delegated follow-up control hints into delegate observer policy", () => {
    const decision = buildDecision("你是自己写的 还是子agent 写的", {
      metadata: {
        conversation_control: {
          available: true,
          intent_class: "execution_followup",
          route_hint: "delegate",
          lane_hint: "control_observer",
          require_state_grounding: true,
        },
      },
    });

    expect(decision.route).toBe("delegate");
    expect(decision.role).toBe("observer_probe");
    expect(decision.executionProfile).toBe("observer");
  });

  it("fills fresh live lookup control hints during session metadata enrichment", () => {
    const metadata = enrichConversationControlMetadata("openclaw 4.21 有啥新特性", {
      conversation_control: {
        available: true,
        source: "session_resolver_fallback",
        subject_prompt: "openclaw 4.21 有啥新特性",
      },
      intent_packet: {
        available: true,
        prompt: "openclaw 4.21 有啥新特性",
        intent_class: "fresh_live_lookup",
      },
    });

    expect(metadata.conversation_control).toMatchObject({
      available: true,
      intent_class: "fresh_live_lookup",
      route_hint: "delegate",
      lane_hint: "observe",
      require_fresh_lookup: true,
    });
  });

  it("does not let main-agent reply hints override fresh live lookup delegation", () => {
    const decision = buildDecision("openclaw 4.21 有啥新特性", {
      metadata: {
        route_hint: "reply",
        requested_route: "reply",
        conversation_control: {
          available: true,
          intent_class: "fresh_live_lookup",
          route_hint: "delegate",
          lane_hint: "observe",
          require_fresh_lookup: true,
        },
      },
    });

    expect(decision.route).toBe("delegate");
    expect(decision.role).toBe("observer_probe");
    expect(decision.executionProfile).toBe("observer");
  });

  it("keeps delegated route when route_hint tool prefers reply for fresh live lookup", async () => {
    const decision = await resolveStatelessPolicyDecision("openclaw 4.21 有啥新特性", {
      metadata: {
        conversation_control: {
          available: true,
          intent_class: "fresh_live_lookup",
          route_hint: "delegate",
          lane_hint: "observe",
          require_fresh_lookup: true,
        },
      },
      routeHint: {
        route_hint: "reply",
        requested_route: "reply",
        work_type: "research",
        confidence: 0.72,
      },
    });

    expect((decision.route_decision as { route: string }).route).toBe("delegate");
    expect((decision.request as { metadata: { requested_route: string } }).metadata.requested_route).toBe("delegate");
    expect((decision.request as { metadata: { route_hint: string } }).metadata.route_hint).toBe("reply");
  });

  it("allows explicit route objection to override default fresh live lookup delegation", async () => {
    const decision = await resolveStatelessPolicyDecision("openclaw 4.21 有啥新特性", {
      metadata: {
        conversation_control: {
          available: true,
          intent_class: "fresh_live_lookup",
          route_hint: "delegate",
          lane_hint: "observe",
          require_fresh_lookup: true,
        },
      },
      routeHint: {
        route_hint: "reply",
        route_objection: true,
        objection_reason: "I already have the verified release notes in current context and do not need a fresh fetch.",
        requested_route: "reply",
        work_type: "research",
        confidence: 0.82,
      },
    });

    expect((decision.route_decision as { route: string }).route).toBe("reply");
    expect((decision.route_hint_policy as { objection_submitted: boolean }).objection_submitted).toBe(true);
    expect((decision.route_hint_policy as { objection_accepted: boolean }).objection_accepted).toBe(true);
    expect((decision.request as { metadata: { requested_route: string } }).metadata.requested_route).toBe("reply");
    expect((decision.request as { metadata: { objection_requested_route: string } }).metadata.objection_requested_route).toBe("reply");
  });
});

describe("Chinese provenance prompt intent classification", () => {
  it("classifies provenance follow-up with prior replay history as execution_followup", () => {
    const dir = path.join("/tmp", `octoclaw-provenance-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    const replayLogPath = path.join(dir, "runtime-policy-replay.jsonl");
    const taskStatePath = path.join(dir, "task-state.json");

    fs.writeFileSync(replayLogPath, [
      JSON.stringify({
        event: "policy_resolved",
        sessionKey: "test-session",
        sessionId: "test-session",
        at: new Date(Date.now() - 30_000).toISOString(),
        prompt: "查一下 guanzhicheng.com 的 SSL 证书到期时间",
        route: "reply",
        taskClass: "main_direct",
      }),
      JSON.stringify({
        event: "tool_used",
        sessionKey: "test-session",
        sessionId: "test-session",
        at: new Date(Date.now() - 25_000).toISOString(),
        toolName: "web_fetch",
      }),
      JSON.stringify({
        event: "agent_end",
        sessionKey: "test-session",
        sessionId: "test-session",
        at: new Date(Date.now() - 20_000).toISOString(),
        directToolsSeen: ["web_fetch"],
        delegated: false,
      }),
    ].join("\n"));
    fs.writeFileSync(taskStatePath, JSON.stringify({ tasks: [] }));

    const intent = buildConversationIntentPacket({
      prompt: "你是自己查的还是子agent查的",
      replayLogPath,
      taskStatePath,
      sessionKeys: ["test-session"],
    });

    expect(intent.intent_class).toBe("execution_followup");
    expect(intent.reason_codes).toContain("recent_execution_followup");
  });

  it("classifies '谁查的' with history as execution_followup", () => {
    const dir = path.join("/tmp", `octoclaw-provenance-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    const replayLogPath = path.join(dir, "runtime-policy-replay.jsonl");
    const taskStatePath = path.join(dir, "task-state.json");

    fs.writeFileSync(replayLogPath, [
      JSON.stringify({
        event: "policy_resolved",
        sessionKey: "test-session",
        sessionId: "test-session",
        at: new Date(Date.now() - 60_000).toISOString(),
        prompt: "查一下 redis 连接状态",
        route: "reply",
      }),
    ].join("\n"));
    fs.writeFileSync(taskStatePath, JSON.stringify({ tasks: [] }));

    const intent = buildConversationIntentPacket({
      prompt: "谁查的",
      replayLogPath,
      taskStatePath,
      sessionKeys: ["test-session"],
    });

    expect(intent.intent_class).toBe("execution_followup");
  });

  it("classifies '你是怎么查到的' with history as execution_followup", () => {
    const dir = path.join("/tmp", `octoclaw-provenance-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    const replayLogPath = path.join(dir, "runtime-policy-replay.jsonl");
    const taskStatePath = path.join(dir, "task-state.json");

    fs.writeFileSync(replayLogPath, [
      JSON.stringify({
        event: "policy_resolved",
        sessionKey: "test-session",
        sessionId: "test-session",
        at: new Date(Date.now() - 30_000).toISOString(),
        prompt: "查一下 nginx 配置",
        route: "reply",
      }),
    ].join("\n"));
    fs.writeFileSync(taskStatePath, JSON.stringify({ tasks: [] }));

    const intent = buildConversationIntentPacket({
      prompt: "你是怎么查到的",
      replayLogPath,
      taskStatePath,
      sessionKeys: ["test-session"],
    });

    expect(intent.intent_class).toBe("execution_followup");
  });

  it("does NOT classify '帮我写个Python脚本' as execution_followup", () => {
    const intent = buildConversationIntentPacket({
      prompt: "帮我写个Python脚本转换CSV到JSON",
      replayLogPath: "/tmp/does-not-matter.jsonl",
      taskStatePath: "/tmp/does-not-matter.json",
      sessionKeys: ["test-session"],
    });

    expect(intent.intent_class).not.toBe("execution_followup");
  });

  it("uses prompt similarity only as fallback for non-explicit follow-up prompts", () => {
    const dir = path.join("/tmp", `octoclaw-similarity-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    const replayLogPath = path.join(dir, "runtime-policy-replay.jsonl");
    const taskStatePath = path.join(dir, "task-state.json");

    fs.writeFileSync(replayLogPath, [
      JSON.stringify({
        event: "policy_resolved",
        sessionKey: "test-session",
        sessionId: "test-session",
        at: new Date(Date.now() - 30_000).toISOString(),
        prompt: "查一下 nginx 配置",
        route: "reply",
      }),
    ].join("\n"));
    fs.writeFileSync(taskStatePath, JSON.stringify({ tasks: [] }));

    const intent = buildConversationIntentPacket({
      prompt: "[Queued messages while agent was busy]\nSystem: 12:00: 查一下 nginx 配置",
      replayLogPath,
      taskStatePath,
      sessionKeys: ["test-session"],
    });

    expect(intent.intent_class).toBe("execution_followup");
    expect(intent.reason_codes).toContain("recent_execution_followup_similarity_fallback");
  });

  it("does not use router_decision_v2 evidence_required as grounding route signal", () => {
    const guard = buildDirectLookupGuard({
      latency_ack: { required: false },
      router_decision_v2: {
        compatibility_view: true,
        evidence_required: ["web_lookup"],
      },
      request: {
        metadata: {
          intent_packet: { intent_class: "plain_chat" },
        },
      },
    });

    expect(guard).toBe("");
  });

  it("provenance without history → execution_followup with provenance_followup=true", () => {
    const intent = buildConversationIntentPacket({
      prompt: "你是自己查的还是子agent查的",
      replayLogPath: "/tmp/does-not-matter.jsonl",
      taskStatePath: "/tmp/does-not-matter.json",
      sessionKeys: ["test-session"],
    });

    expect(intent.intent_class).toBe("execution_followup");
    expect(intent.provenance_followup).toBe(true);
    expect(intent.reason_codes).toContain("provenance_followup_no_history");

    const control = buildConversationControlHintsFromIntent(intent);
    expect(control.provenance_followup).toBe(true);
    expect(control.require_state_grounding).toBe(true);
  });

  it("classifies Slack plain chat 在吗 as plain_chat without state grounding", () => {
    const intent = buildConversationIntentPacket({
      prompt: "在吗",
      replayLogPath: "/tmp/does-not-matter.jsonl",
      taskStatePath: "/tmp/does-not-matter.json",
      sessionKeys: ["slack:default:dm:U123"],
    });

    expect(intent.intent_class).toBe("plain_chat");
    expect(intent.reason_codes).toContain("plain_chat_short_greeting");

    const control = buildConversationControlHintsFromIntent(intent);
    expect(control.require_state_grounding).toBe(false);
    expect(control.route_hint).toBe("reply");
  });
});

describe("Phase B acceptance: Slack/IM intent routing", () => {
  it('plain_chat "在吗" → conversation_control available=false (no spawn, just reply)', () => {
    const intent = buildConversationIntentPacket({
      prompt: "在吗",
      replayLogPath: "/tmp/does-not-matter.jsonl",
      taskStatePath: "/tmp/does-not-matter.json",
      sessionKeys: ["slack:default:dm:U123"],
    });
    const control = buildConversationControlHintsFromIntent(intent);

    expect(intent.intent_class).toBe("plain_chat");
    expect(control.available).toBe(true);
    expect(control.route_hint).toBe("reply");
    expect(control.require_state_grounding).not.toBe(true);
  });

  it('execution_followup "刚才那个任务判定是啥" → conversation_control with route_hint', () => {
    const dir = path.join("/tmp", `octoclaw-phase-b-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    const replayLogPath = path.join(dir, "runtime-policy-replay.jsonl");
    const taskStatePath = path.join(dir, "task-state.json");

    fs.writeFileSync(replayLogPath, JSON.stringify({
      event: "policy_resolved",
      sessionKey: "slack:default:channel:C123",
      sessionId: "slack-phase-b",
      at: new Date(Date.now() - 30_000).toISOString(),
      prompt: "implement this feature",
      route: "delegate",
    }));
    fs.writeFileSync(taskStatePath, JSON.stringify({ tasks: [] }));

    const intent = buildConversationIntentPacket({
      prompt: "刚才那个任务判定是啥",
      replayLogPath,
      taskStatePath,
      sessionKeys: ["slack:default:channel:C123"],
    });
    const control = buildConversationControlHintsFromIntent(intent);

    expect(intent.intent_class).toBe("execution_followup");
    expect(control.available).toBe(true);
    expect(control.route_hint).toBe("delegate");
    expect(control.lane_hint).toBe("control_observer");
  });

  it("delegated_work → conversation_control with route_hint=delegate", () => {
    const decision = buildDecision("implement this feature", {
      metadata: {
        conversation_control: {
          available: true,
          intent_class: "delegated_work",
          route_hint: "delegate",
        },
      },
    });

    expect(decision.route).toBe("delegate");
  });
});
