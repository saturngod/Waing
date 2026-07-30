function stringField(value: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) if (typeof value[name] === "string") return value[name];
  return undefined;
}

function lines(value: string): string[] {
  const normalized = value.replace(/\r\n/g, "\n");
  const result = normalized.split("\n");
  if (result.at(-1) === "") result.pop();
  return result;
}

function range(start: number, count: number): string {
  return count === 1 ? String(start) : `${String(start)},${String(count)}`;
}

/** OpenCode's older API sends before/after source rather than a patch; turn it into a compact unified hunk. */
function sourcePatch(path: string, before: string, after: string): string {
  const oldLines = lines(before);
  const newLines = lines(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix += 1;
  const hunkStart = Math.max(0, prefix - 3);
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + 3);
  const newEnd = Math.min(newLines.length, newLines.length - suffix + 3);
  const oldCount = oldEnd - hunkStart;
  const newCount = newEnd - hunkStart;
  const body = [
    ...oldLines.slice(hunkStart, prefix).map((line) => ` ${line}`),
    ...oldLines.slice(prefix, oldLines.length - suffix).map((line) => `-${line}`),
    ...newLines.slice(prefix, newLines.length - suffix).map((line) => `+${line}`),
    ...newLines.slice(newLines.length - suffix, newEnd).map((line) => ` ${line}`),
  ];
  if (body.length === 0) return "";
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`,
    `@@ -${range(hunkStart + 1, oldCount)} +${range(hunkStart + 1, newCount)} @@`, ...body].join("\n");
}

function patchWithHeader(path: string, patch: string): string {
  if (patch.startsWith("diff --git ")) return patch;
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, patch].join("\n");
}

/** Keep OpenCode protocol objects inside the adapter and emit the same unified string every renderer consumes. */
export function normalizeOpenCodeDiff(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  return raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const value = entry as Record<string, unknown>;
    const path = stringField(value, "file", "path");
    if (path === undefined) return [];
    const patch = stringField(value, "patch");
    if (patch !== undefined && patch.trim().length > 0) return [patchWithHeader(path, patch)];
    const before = stringField(value, "before");
    const after = stringField(value, "after");
    return before === undefined || after === undefined ? [] : [sourcePatch(path, before, after)];
  }).filter((patch) => patch.length > 0).join("\n");
}
