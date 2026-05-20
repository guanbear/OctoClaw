import fs from "node:fs/promises";
import path from "node:path";

function tempPathFor(targetPath: string): string {
  const suffix = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  return `${targetPath}.tmp.${suffix}`;
}

export async function atomicWriteText(targetPath: string, text: string): Promise<void> {
  const tmpPath = tempPathFor(targetPath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await fs.writeFile(tmpPath, text, "utf8");
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}
