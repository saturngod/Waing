import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { AgentError } from "@waing/domain";

export async function resolveExecutable(
  executable: string,
  searchPath = process.env.PATH ?? "",
): Promise<string> {
  const candidates = isAbsolute(executable)
    ? [executable]
    : searchPath.split(delimiter).filter(Boolean).map((directory) => join(directory, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through the explicit PATH entries.
    }
  }
  throw new AgentError("NOT_INSTALLED", `Executable was not found: ${executable}`);
}
