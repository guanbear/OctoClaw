export const OCTOCLAW_PROJECTION_FOOTER_PREFIX = "octoclaw:";

export const OCTOCLAW_PROJECTION_FOOTER_LINE_RE =
  /^\s*(?:[•*-]\s*)?(?:octoclaw:\s*)?route=(?:reply|delegate)\s*\|\s*model=[^\r\n]*$/iu;

export function hasProjectionFooter(text: unknown): boolean {
  const value = typeof text === "string" ? text : String(text ?? "");
  if (!value) return false;
  return value.split(/\r?\n/u).some((line) => OCTOCLAW_PROJECTION_FOOTER_LINE_RE.test(line));
}

export function stripProjectionFooterFromText(text: unknown): string {
  const value = typeof text === "string" ? text : String(text ?? "");
  if (!value) return "";
  if (!hasProjectionFooter(value)) return value.trim();
  return value
    .split(/\r?\n/u)
    .filter((line) => !OCTOCLAW_PROJECTION_FOOTER_LINE_RE.test(line))
    .join("\n")
    .replace(/[ \t]+$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
