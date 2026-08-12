import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { AgentError } from "@waing/domain";

export async function resolveExecutable(
  executable: string,
  searchPath = process.env.PATH ?? "",
): Promise<string> {
  return (await resolveExecutables(executable, searchPath))[0]!;
}

/**
 * Resolves every executable with this name in PATH, preserving PATH order while collapsing symlinks that point to
 * the same file. Provider adapters can use this when a stale package-manager shim must not hide a working install
 * later in PATH.
 */
export async function resolveExecutables(
  executable: string,
  searchPath = process.env.PATH ?? "",
  additionalCandidates: readonly string[] = [],
): Promise<string[]> {
  const candidates = isAbsolute(executable)
    ? [executable]
    : [...searchPath.split(delimiter).filter(Boolean).map((directory) => join(directory, executable)),
      ...additionalCandidates];
  const resolved: string[] = [];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const path = await realpath(candidate);
      if (!resolved.includes(path)) resolved.push(path);
    } catch {
      // Continue through the explicit PATH entries.
    }
  }
  if (resolved.length > 0) return resolved;
  throw new AgentError("NOT_INSTALLED", `Executable was not found: ${executable}`);
}
