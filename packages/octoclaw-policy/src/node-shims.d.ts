declare module "node:fs" {
  export function appendFileSync(path: string, data: string): void;
  export function mkdtempSync(prefix: string): string;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function readFileSync(path: string, encoding: "utf-8" | "utf8"): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function existsSync(path: string): boolean;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}
