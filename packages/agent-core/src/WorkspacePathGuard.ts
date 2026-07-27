import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { AgentError } from "@waing/domain";

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel));
}

export async function canonicalizeWorkspaceRoot(path: string): Promise<string> {
  const root = await realpath(path).catch(() => { throw new AgentError("PERMISSION_DENIED", "Workspace path does not exist"); });
  const metadata = await stat(root);
  if (!metadata.isDirectory()) throw new AgentError("PERMISSION_DENIED", "Workspace path must be a directory");
  return root;
}

async function nearestExistingAncestor(path: string): Promise<{ ancestor: string; suffix: string[] }> {
  let cursor = path;
  const suffix: string[] = [];
  for (;;) {
    try { await lstat(cursor); return { ancestor: cursor, suffix }; }
    catch {
      const parent = dirname(cursor);
      if (parent === cursor) throw new AgentError("PERMISSION_DENIED", "No existing parent for workspace path");
      suffix.unshift(cursor.slice(parent.length + (parent.endsWith("/") || parent.endsWith("\\") ? 0 : 1)));
      cursor = parent;
    }
  }
}

export async function resolveWorkspacePath(root: string, requestedPath: string, forWrite = false): Promise<string> {
  const realRoot = await canonicalizeWorkspaceRoot(root);
  const candidate = resolve(realRoot, requestedPath);
  let target: string;
  if (forWrite) {
    const { ancestor, suffix } = await nearestExistingAncestor(candidate);
    target = join(await realpath(ancestor), ...suffix);
  } else {
    target = await realpath(candidate).catch(() => { throw new AgentError("PERMISSION_DENIED", "Workspace path does not exist"); });
  }
  if (!isInside(realRoot, target)) throw new AgentError("PERMISSION_DENIED", "Filesystem request escapes the workspace");
  return target;
}

export async function assertPermissionPathsWithinWorkspace(root: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) await resolveWorkspacePath(root, path, true);
}
