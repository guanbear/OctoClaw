import fsSync from "node:fs";
import path from "node:path";

interface AtomicFsLike {
  mkdirSync(pathname: string, options?: { recursive?: boolean }): void;
  writeFileSync(pathname: string, data: string, encoding: string): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(pathname: string): void;
}

const fs = fsSync as unknown as AtomicFsLike;

function tempPathFor(targetPath: string): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${targetPath}.tmp.${ts}.${rand}`;
}

export function atomicWriteJsonSync(
  targetPath: string,
  value: unknown,
): boolean {
  const tmpPath = tempPathFor(targetPath);

  try {
    const directory = path.dirname(targetPath);
    fs.mkdirSync(directory, { recursive: true });

    const json = JSON.stringify(value, null, 2);
    fs.writeFileSync(tmpPath, json, "utf-8");
    fs.renameSync(tmpPath, targetPath);
    return true;
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}

    console.warn(`octoclaw atomic write failed for ${targetPath}: ${String(err)}`);
    return false;
  }
}
