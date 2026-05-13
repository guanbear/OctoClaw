declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(data: string): { digest(encoding: "hex"): string };
  };
}

declare module "node:fs" {
  export function appendFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function readFileSync(path: string, encoding: "utf-8" | "utf8"): string;
  export function existsSync(path: string): boolean;
}

declare module "node:path" {
  export function dirname(path: string): string;
}
