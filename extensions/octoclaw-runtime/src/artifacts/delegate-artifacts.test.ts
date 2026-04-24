import { describe, expect, it } from "vitest";
import type { DelegateArtifactKind } from "@octoclaw/contracts/delegate-context";
import { listArtifactsForTask, readDelegateArtifact, writeDelegateArtifact } from "./delegate-artifacts.js";

describe("delegate artifact storage", () => {
  const kinds: DelegateArtifactKind[] = [
    "worker_report",
    "worker_log_excerpt",
    "context_pack",
    "diff_or_patch",
    "verification_evidence",
    "operator_surface",
  ];

  it.each(kinds)("writes and reads %s artifacts", (kind) => {
    const rootDir = `/tmp/octoclaw-delegate-artifacts-${kind}-${Date.now()}`;
    const ref = writeDelegateArtifact(kind, `${kind} content`, {
      delegateTaskId: "delegate-1",
      title: `${kind} title`,
      summary: `${kind} summary`,
      createdAt: "2026-04-24T00:00:00.000Z",
      rootDir,
    });
    const record = readDelegateArtifact(ref.artifactId, rootDir);

    expect(ref.artifactKind).toBe(kind);
    expect(record?.content).toBe(`${kind} content`);
    expect(record?.delegateTaskId).toBe("delegate-1");
  });

  it("lists artifacts for a delegate task", () => {
    const rootDir = `/tmp/octoclaw-delegate-artifacts-list-${Date.now()}`;
    writeDelegateArtifact("worker_report", "report", {
      delegateTaskId: "delegate-1",
      createdAt: "2026-04-24T00:00:00.000Z",
      rootDir,
    });
    writeDelegateArtifact("operator_surface", "surface", {
      delegateTaskId: "delegate-2",
      createdAt: "2026-04-24T00:00:01.000Z",
      rootDir,
    });

    expect(listArtifactsForTask("delegate-1", rootDir)).toHaveLength(1);
    expect(listArtifactsForTask("delegate-1", rootDir)[0]?.artifactKind).toBe("worker_report");
  });
});
