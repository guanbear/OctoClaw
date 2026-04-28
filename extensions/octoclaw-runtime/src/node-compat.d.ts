declare class Error {
  constructor(message?: string);
  message: string;
}

declare const process: {
  argv: string[];
  cwd(): string;
  env: Record<string, string | undefined>;
  stdin: unknown;
  stdout: { write(chunk: string): boolean };
};

declare function setTimeout(handler: () => void, timeout?: number): TimeoutHandle;
declare function clearTimeout(timeoutId: TimeoutHandle | null): void;

interface TimeoutHandle {
  readonly __timeoutBrand: unique symbol;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

declare module "node:path" {
  interface PathModule {
    join(...paths: string[]): string;
    resolve(...paths: string[]): string;
    dirname(path: string): string;
    isAbsolute(path: string): boolean;
    delimiter: string;
  }
  const path: PathModule;
  export default path;
}

declare module "node:os" {
  interface OsModule {
    homedir(): string;
  }
  const os: OsModule;
  export default os;
}

declare module "node:crypto" {
  interface Hash {
    update(data: string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
  export function randomUUID(): string;
  const crypto: {
    createHash: typeof createHash;
    randomUUID: typeof randomUUID;
  };
  export default crypto;
}

declare module "node:fs" {
  interface StatsLike {
    isDirectory(): boolean;
  }

  interface FsConstants {
    X_OK: number;
  }

  interface FsModule {
    existsSync(path: string): boolean;
    accessSync(path: string, mode?: number): void;
    mkdirSync(path: string, options?: { recursive?: boolean }): void;
    writeFileSync(path: string, data: string, encoding?: string): void;
    realpathSync(path: string): string;
    statSync(path: string): StatsLike;
    readFileSync(path: string, encoding: string): string;
    readdirSync(path: string): string[];
    constants: FsConstants;
  }
  const fs: FsModule;
  export default fs;
}

declare module "fs/promises" {
  export function readFile(path: string, encoding: string): Promise<string>;
}

declare module "node:readline" {
  export interface Interface {
    on(event: "line", listener: (input: string) => void | Promise<void>): Interface;
  }
  export function createInterface(options: { input: unknown }): Interface;
}

declare module "node:child_process" {
  export interface SpawnOptions {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdio?: ["ignore", "pipe", "pipe"];
  }

  export interface ReadableLike {
    on(event: "data", listener: (chunk: Uint8Array | string) => void): void;
  }

  export interface ChildProcessLike {
    stdout: ReadableLike;
    stderr: ReadableLike;
    on(event: "error", listener: (error: Error) => void): void;
    on(event: "close", listener: (code: number | null) => void): void;
    kill(signal?: string): void;
  }

  export function spawn(command: string, args: string[], options?: SpawnOptions): ChildProcessLike;
}
