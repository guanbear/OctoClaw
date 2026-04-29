import type {
  DelegateAttempt,
  DelegateProgressEvent,
  DelegateTask,
  NativeTaskBinding,
  RecoveryInfo,
  StatusQueryPacket,
  TimelineEntry,
} from "@octoclaw/contracts/delegate";
import { buildContractEnvelope } from "@octoclaw/contracts/schemas";

function now(): string {
  return new Date().toISOString();
}

function compareIsoTime(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

function buildTimelineEntries(progressEvents: DelegateProgressEvent[]): TimelineEntry[] {
  return [...progressEvents]
    .sort((left, right) => compareIsoTime(left.eventAt, right.eventAt))
    .slice(-50)
    .map((event) => ({
      eventAt: event.eventAt,
      eventType: event.eventType,
      summary: event.summary,
    }));
}

export function buildStatusQueryPacket(input: {
  delegateTask: DelegateTask;
  currentAttempt: DelegateAttempt | null;
  nativeBinding: NativeTaskBinding | null;
  progressEvents: DelegateProgressEvent[];
  recoveryInfo?: RecoveryInfo | null;
}): StatusQueryPacket {
  const queriedAt = now();
  const timelineEntries = buildTimelineEntries(input.progressEvents);

  return {
    ...buildContractEnvelope("projection", queriedAt),
    kind: "projection",
    delegateTaskId: input.delegateTask.delegateTaskId,
    currentAttemptId: input.delegateTask.currentAttemptId,
    currentAttemptStatus: input.currentAttempt?.status ?? null,
    nativeBinding: input.nativeBinding,
    taskStatus: input.delegateTask.status,
    role: input.delegateTask.role,
    coordinationMode: input.delegateTask.coordinationMode,
    modelProfile: input.currentAttempt?.modelProfile ?? null,
    backend: input.currentAttempt?.backend ?? null,
    totalAttempts: input.delegateTask.totalAttempts,
    timeline: {
      entries: timelineEntries,
      lastEventAt: timelineEntries.at(-1)?.eventAt ?? null,
      totalEvents: input.progressEvents.length,
    },
    recoveryInfo: input.recoveryInfo ?? null,
    queriedAt,
  };
}
