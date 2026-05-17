declare class Error {
  constructor(message?: string);
  message: string;
}

declare const process: {
  argv: string[];
  execPath: string;
  cwd(): string;
  env: Record<string, string | undefined>;
  platform: string;
  pid: number;
  stdin: unknown;
  stdout: { write(chunk: string): boolean };
};

declare function setTimeout(handler: () => void, timeout?: number): TimeoutHandle;
declare function clearTimeout(timeoutId: TimeoutHandle | null): void;

interface TimeoutHandle {
  readonly __timeoutBrand: unique symbol;
}

declare module "node:module" {
  export function createRequire(url: string): NodeRequire;
  interface NodeRequire {
    (moduleId: string): unknown;
  }
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
    tmpdir(): string;
  }
  const os: OsModule;
  export default os;
}

declare module "node:crypto" {
  interface Hash {
    update(data: string): Hash;
    digest(encoding: "hex"): string;
  }
  interface Hmac {
    update(data: string): Hmac;
    digest(encoding: "base64url"): string;
  }
  export function createHash(algorithm: string): Hash;
  export function createHmac(algorithm: string, key: string): Hmac;
  export function randomUUID(): string;
  const crypto: {
    createHash: typeof createHash;
    createHmac: typeof createHmac;
    randomUUID: typeof randomUUID;
  };
  export default crypto;
}

declare module "node:fs" {
  interface StatsLike {
    isDirectory(): boolean;
    mtimeMs: number;
    mtime?: Date;
  }

  interface FsConstants {
    X_OK: number;
  }

  interface FsModule {
    existsSync(path: string): boolean;
    accessSync(path: string, mode?: number): void;
    mkdirSync(path: string, options?: { recursive?: boolean }): void;
    writeFileSync(path: string | number, data: string, encoding?: string): void;
    appendFileSync(path: string | number, data: string, encoding?: string): void;
    realpathSync(path: string): string;
    statSync(path: string): StatsLike;
    readFileSync(path: string, encoding: string): string;
    readdirSync(path: string): string[];
    openSync(path: string, flags: string): number;
    closeSync(fd: number): void;
    unlinkSync(path: string): void;
    rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
    mkdtempSync(prefix: string): string;
    constants: FsConstants;
  }
  const fs: FsModule;
  export default fs;
}

declare module "fs/promises" {
  export function readFile(path: string, encoding: string): Promise<string>;
}

declare module "node:fs/promises" {
  export interface FileHandle {
    sync(): Promise<void>;
    close(): Promise<void>;
  }
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function open(path: string, flags: string): Promise<FileHandle>;
  export function readFile(path: string, encoding: string): Promise<string>;
  export function readdir(path: string): Promise<string[]>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function stat(path: string): Promise<unknown>;
  export function writeFile(path: string, data: string, encoding: string): Promise<void>;
  const fsPromises: {
    mkdir: typeof mkdir;
    mkdtemp: typeof mkdtemp;
    open: typeof open;
    readFile: typeof readFile;
    readdir: typeof readdir;
    rename: typeof rename;
    rm: typeof rm;
    stat: typeof stat;
    writeFile: typeof writeFile;
  };
  export default fsPromises;
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

  export interface SpawnSyncOptions {
    cwd?: string;
    env?: Record<string, string | undefined>;
    input?: string;
    encoding?: "utf8";
    timeout?: number;
    maxBuffer?: number;
  }

  export interface SpawnSyncResult {
    status: number | null;
    signal: string | null;
    error?: Error;
    stdout: string;
    stderr: string;
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
  export function spawnSync(command: string, args: string[], options?: SpawnSyncOptions): SpawnSyncResult;
  export function execFileSync(command: string, args?: string[], options?: SpawnSyncOptions & { stdio?: ["ignore", "pipe", "pipe"] }): string;
}

declare module "node:sqlite" {
  export interface StatementSync {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
    finalize(): void;
  }

  export interface DatabaseSync {
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }

  export class DatabaseSync {
    constructor(location: string, options?: { open?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
