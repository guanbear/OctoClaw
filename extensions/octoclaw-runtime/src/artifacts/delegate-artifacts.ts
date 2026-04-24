import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { DelegateArtifactKind, DelegateArtifactRef } from "@octoclaw/contracts/delegate-context";

export interface DelegateArtifactRecord {
  ref: DelegateArtifactRef;
  delegateTaskId: string;
  content: string;
  bytes: number;
}

export interface WriteDelegateArtifactInput {
  delegateTaskId: string;
  title?: string;
  summary?: string;
  tokenEstimate?: number;
  createdAt?: string;
  rootDir?: string;
}

interface ArtifactIndex {
  artifacts: DelegateArtifactRecord[];
}

const artifactKinds: DelegateArtifactKind[] = [
  "worker_report",
  "worker_log_excerpt",
  "context_pack",
  "diff_or_patch",
  "verification_evidence",
  "operator_surface",
];

function defaultArtifactRoot(): string {
  return process.env.OCTOCLAW_ARTIFACT_ROOT || path.join(process.cwd(), "tmp", "octopus", "delegate-artifacts");
}

function indexPath(rootDir: string): string {
  return path.join(rootDir, "artifact-index.json");
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "_");
}

function readIndex(rootDir: string): ArtifactIndex {
  const file = indexPath(rootDir);
  if (!fs.existsSync(file)) {
    return { artifacts: [] };
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as ArtifactIndex;
}

function writeIndex(rootDir: string, index: ArtifactIndex): void {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(indexPath(rootDir), JSON.stringify(index, null, 2), "utf8");
}

function artifactPath(rootDir: string, artifactId: string): string {
  return path.join(rootDir, `${safeName(artifactId)}.txt`);
}

function buildArtifactId(kind: DelegateArtifactKind, delegateTaskId: string, content: string, createdAt: string): string {
  const digest = createHash("sha256").update(`${delegateTaskId}:${kind}:${createdAt}:${content}`).digest("hex").slice(0, 12);
  return `${kind}:${safeName(delegateTaskId)}:${digest}`;
}

export function writeDelegateArtifact(
  kind: DelegateArtifactKind,
  content: string,
  input: WriteDelegateArtifactInput,
): DelegateArtifactRef {
  if (!artifactKinds.includes(kind)) {
    throw new Error(`unsupported_delegate_artifact_kind:${kind}`);
  }

  const rootDir = input.rootDir ?? defaultArtifactRoot();
  const createdAt = input.createdAt ?? new Date().toISOString();
  const artifactId = buildArtifactId(kind, input.delegateTaskId, content, createdAt);
  const filePath = artifactPath(rootDir, artifactId);
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");

  const ref: DelegateArtifactRef = {
    artifactId,
    artifactKind: kind,
    uri: `file://${filePath}`,
    title: input.title,
    summary: input.summary,
    tokenEstimate: input.tokenEstimate,
    createdAt,
  };
  const record: DelegateArtifactRecord = {
    ref,
    delegateTaskId: input.delegateTaskId,
    content,
    bytes: content.length,
  };
  const index = readIndex(rootDir);
  index.artifacts = index.artifacts.filter((artifact) => artifact.ref.artifactId !== artifactId);
  index.artifacts.push(record);
  writeIndex(rootDir, index);

  return ref;
}

export function readDelegateArtifact(artifactId: string, rootDir = defaultArtifactRoot()): DelegateArtifactRecord | null {
  const record = readIndex(rootDir).artifacts.find((artifact) => artifact.ref.artifactId === artifactId);
  if (!record) {
    return null;
  }
  const filePath = artifactPath(rootDir, artifactId);
  if (!fs.existsSync(filePath)) {
    return record;
  }
  const content = fs.readFileSync(filePath, "utf8");
  return {
    ...record,
    content,
    bytes: content.length,
  };
}

export function listArtifactsForTask(delegateTaskId: string, rootDir = defaultArtifactRoot()): DelegateArtifactRef[] {
  return readIndex(rootDir)
    .artifacts
    .filter((artifact) => artifact.delegateTaskId === delegateTaskId)
    .map((artifact) => artifact.ref);
}
