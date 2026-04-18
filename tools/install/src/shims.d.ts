declare module "node:fs/promises" {
  export function access(path: string): Promise<void>;
  export function copyFile(src: string, dest: string): Promise<void>;
  export function cp(src: string, dest: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function readFile(path: string, encoding: string): Promise<string>;
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Array<{ isDirectory(): boolean; name: string }>>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function stat(path: string): Promise<{ isDirectory(): boolean }>;
  export function writeFile(path: string, data: string, encoding: string): Promise<void>;
}

declare module "node:child_process" {
  interface SpawnedProcess {
    stdout: { on(event: "data", listener: (chunk: { toString(): string } | string) => void): void } | null;
    stderr: { on(event: "data", listener: (chunk: { toString(): string } | string) => void): void } | null;
    on(event: "error", listener: (error: Error) => void): void;
    on(event: "close", listener: (code: number | null) => void): void;
  }
  export function spawn(
    command: string,
    args: string[],
    options?: { cwd?: string; stdio?: "inherit" | "pipe"; env?: Record<string, string | undefined> },
  ): SpawnedProcess;
}

declare module "node:readline/promises" {
  export function createInterface(options: {
    input: { isTTY?: boolean };
    output: { write(chunk: string): boolean; isTTY?: boolean };
  }): {
    question(query: string): Promise<string>;
    close(): void;
  };
}

declare module "node:process" {
  export const stdin: { isTTY?: boolean };
  export const stdout: { write(chunk: string): boolean; isTTY?: boolean };
  export const stderr: { write(chunk: string): boolean };
  export const argv: string[];
  export const env: Record<string, string | undefined>;
  export function cwd(): string;
  export function exit(code?: number): never;
}

declare module "node:os" {
  const os: { homedir(): string };
  export default os;
}

declare module "node:path" {
  const path: {
    join(...paths: string[]): string;
    resolve(...paths: string[]): string;
    dirname(target: string): string;
    basename(target: string): string;
    isAbsolute(target: string): boolean;
  };
  export default path;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

declare module "@octoclaw/contracts/schemas" {
  export type ConcreteModelId = string;
  export type ModelProfile =
    | "judge_fast"
    | "observer_probe"
    | "direct_main"
    | "worker_default"
    | "worker_research"
    | "worker_code_normal"
    | "worker_code_deep"
    | "worker_review"
    | "worker_deep";
  export interface ModelProfileMapping {
    profile: ModelProfile;
    modelId: ConcreteModelId;
  }
}

declare module "@octoclaw/policy/model" {
  import type { ConcreteModelId, ModelProfile } from "@octoclaw/contracts/schemas";
  export const V1_MODEL_PROFILE_MAP: Record<ModelProfile, ConcreteModelId>;
}
