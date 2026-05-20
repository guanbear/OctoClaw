declare module "node:fs/promises" {
  export interface DirentLike {
    isFile(): boolean;
    name: string;
  }

  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function readFile(path: string, encoding: string): Promise<string>;
  export function readdir(path: string, options: { withFileTypes: true }): Promise<DirentLike[]>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function writeFile(path: string, data: string, encoding: string): Promise<void>;

  const fsPromises: {
    mkdir: typeof mkdir;
    readFile: typeof readFile;
    readdir: typeof readdir;
    rename: typeof rename;
    rm: typeof rm;
    writeFile: typeof writeFile;
  };

  export default fsPromises;
}

declare module "node:fs" {
  export interface Dirent {
    isFile(): boolean;
    name: string;
  }

  export function existsSync(path: string): boolean;
  export function closeSync(fd: number): void;
  export function openSync(path: string, flags: string): number;

  const fsSync: {
    closeSync: typeof closeSync;
    existsSync: typeof existsSync;
    openSync: typeof openSync;
  };

  export default fsSync;
}

declare module "node:os" {
  const os: { homedir(): string };
  export default os;
}

declare module "node:path" {
  const path: {
    basename(target: string, suffix?: string): string;
    delimiter: string;
    dirname(target: string): string;
    join(...paths: string[]): string;
  };
  export default path;
}

declare module "node:readline/promises" {
  export interface Interface {
    question(query: string): Promise<string>;
    close(): void;
  }
  export function createInterface(options: { input: unknown; output: unknown }): Interface;
  const readline: { createInterface: typeof createInterface };
  export default readline;
}

declare module "node:child_process" {
  export interface SpawnOptions {
    cwd?: string;
    detached?: boolean;
    env?: Record<string, string | undefined>;
    timeout?: number;
    stdio?: ["ignore", "pipe", "pipe"] | ["ignore", number, number] | "pipe";
  }

  export interface ReadableLike {
    on(event: "data", listener: (chunk: Uint8Array | string) => void): void;
  }

  export interface ChildProcess {
    pid?: number;
    stdout?: ReadableLike | null;
    stderr?: ReadableLike | null;
    on(event: "error", listener: (error: Error) => void): void;
    on(event: "close", listener: (code: number | null) => void): void;
    unref(): void;
  }

  export function spawn(command: string, args: string[], options?: SpawnOptions): ChildProcess;
  export interface SpawnSyncResult<T> {
    error?: Error;
    status: number | null;
    stdout: T;
    stderr: T;
    signal: string | null;
    output: Array<T | null>;
    pid: number;
  }
  export function spawnSync(command: string, args: string[], options?: { timeout?: number; encoding?: "utf8" }): SpawnSyncResult<string>;
}
