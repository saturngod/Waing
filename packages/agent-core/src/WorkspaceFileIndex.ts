import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceFile, WorkspaceFileMatches } from "@waing/domain";
import { resolveExecutable } from "./ExecutableResolver";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_ENTRIES = 50_000;
const DEFAULT_TTL_MS = 15_000;
/** 50k paths of ~60 bytes overruns the 1 MB default, and a truncated listing would look like a missing file. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Only the walker consults this list. In a git workspace `--exclude-standard` already applies the real ignore
 * rules, including nested and negated ones; this is the approximation used when there is nothing to ask.
 */
const IGNORED_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules", "bower_components", "vendor",
  "dist", "out", "build", "release", "target", "coverage", ".next", ".nuxt", ".turbo", ".parcel-cache",
  ".cache", ".gradle", ".idea", ".vscode-test", "Pods", "DerivedData", ".venv", "venv", "__pycache__",
  ".pytest_cache", ".mypy_cache", ".tox", ".terraform"]);

export interface WorkspaceFileIndexOptions {
  /** Hard ceiling on indexed entries; a workspace larger than this is served truncated rather than slowly. */
  maxEntries?: number;
  /** How long a scan is reused before the next lookup rescans, so files created mid-conversation show up. */
  ttlMs?: number;
}

/**
 * Case-folding is done once at scan time, not per keystroke: lowercasing 50k paths and names on every lookup
 * allocated 100k throwaway strings on the main process, which is also the process dispatching key events.
 */
interface IndexedEntry { entry: WorkspaceFile; lowerPath: string; lowerName: string }
interface IndexSnapshot { entries: IndexedEntry[]; truncated: boolean; scannedAt: number }

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/**
 * Lists tracked and untracked files in one call, with ignore rules applied by git itself. `-z` is required:
 * without it git quotes paths containing newlines or non-ASCII bytes and the output can no longer be split.
 * Returns undefined when this is not a git workspace, which is the caller's signal to walk the tree instead.
 */
async function listGitFiles(root: string): Promise<string[] | undefined> {
  if (!existsSync(join(root, ".git"))) return undefined;
  try {
    const git = await resolveExecutable(process.platform === "win32" ? "git.exe" : "git");
    // No --deduplicate: it needs git 2.31, and buildEntries already collapses repeats into a set for free.
    const { stdout } = await execFileAsync(git, ["-C", root, "ls-files", "--cached", "--others",
      "--exclude-standard", "-z"], { maxBuffer: GIT_MAX_BUFFER, windowsHide: true });
    return stdout.split("\0").filter((path) => path.length > 0);
  } catch {
    // A missing git, or a bare or corrupt repository, falls back to the walker rather than failing the lookup.
    return undefined;
  }
}

/**
 * Breadth-first so that hitting `maxEntries` costs the deepest paths rather than whole top-level directories,
 * and iterative so a deep tree cannot exhaust the stack. Symlinks are skipped entirely: following them can
 * loop forever, and a link pointing outside the workspace has no business in a workspace file picker.
 */
async function walkFiles(root: string, maxEntries: number): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = [];
  const queue = [root];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const directory = queue[cursor]!;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { continue; /* unreadable directories are skipped, not fatal */ }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) queue.push(full);
      } else if (entry.isFile()) {
        if (paths.length >= maxEntries) return { paths, truncated: true };
        paths.push(toPosix(relative(root, full)));
      }
    }
  }
  return { paths, truncated: false };
}

/**
 * Directories are derived from the file paths rather than listed separately, so a directory git ignores can
 * never reappear through its parent. An entirely empty directory therefore has no entry — it also has nothing
 * a prompt could refer to.
 */
function buildEntries(paths: readonly string[]): IndexedEntry[] {
  const files = new Set<string>();
  const directories = new Set<string>();
  for (const path of paths) {
    files.add(path);
    let cut = path.lastIndexOf("/");
    while (cut > 0) { directories.add(path.slice(0, cut)); cut = path.lastIndexOf("/", cut - 1); }
  }
  const entries: IndexedEntry[] = [];
  const add = (path: string, kind: WorkspaceFile["kind"]): void => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    entries.push({ entry: { path, name, kind }, lowerPath: path.toLowerCase(), lowerName: name.toLowerCase() });
  };
  for (const path of directories) add(path, "directory");
  for (const path of files) add(path, "file");
  const depth = (path: string): number => { let count = 0; for (const character of path) if (character === "/") count += 1; return count; };
  // Shallow first, so an empty query shows the top of the project instead of an arbitrary deep corner.
  return entries.sort((left, right) => depth(left.entry.path) - depth(right.entry.path)
    || left.entry.path.localeCompare(right.entry.path));
}

/**
 * Scores a candidate against an already-lowercased query, highest wins; a negative score means no match.
 * The tiers are ordered by how directly the user aimed at the entry — a filename prefix beats a filename
 * substring, which beats a path substring, which beats a scattered subsequence like "adcx" for "adapter-codex".
 */
function score(candidate: IndexedEntry, query: string): number {
  const path = candidate.lowerPath;
  const name = candidate.lowerName;
  const lengthPenalty = path.length / 200;
  const nameIndex = name.indexOf(query);
  if (nameIndex === 0) return 1_000 - lengthPenalty;
  if (nameIndex > 0) return 800 - nameIndex - lengthPenalty;
  const pathIndex = path.indexOf(query);
  if (pathIndex >= 0) return 600 - pathIndex / 10 - lengthPenalty;
  let cursor = -1;
  let gaps = 0;
  for (const character of query) {
    const next = path.indexOf(character, cursor + 1);
    if (next < 0) return -1;
    if (cursor >= 0) gaps += next - cursor - 1;
    cursor = next;
  }
  return 400 - gaps / 10 - lengthPenalty;
}

/**
 * The `@` mention index for a workspace: one scan per project, reused across keystrokes and refreshed on a
 * short TTL. Scanning is what costs time, so matching runs over the cached array in the main process and only
 * the handful of rows the picker shows crosses IPC.
 */
export class WorkspaceFileIndex {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, IndexSnapshot>();
  private readonly inFlight = new Map<string, Promise<IndexSnapshot>>();

  constructor(options: WorkspaceFileIndexOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  /** Warms the cache for a project the user just opened, so the first `@` renders without a scan pause. */
  async warm(root: string): Promise<void> {
    await this.snapshot(root);
  }

  /** Drops a workspace's scan, or every scan when no root is given. */
  invalidate(root?: string): void {
    if (root === undefined) { this.cache.clear(); return; }
    this.cache.delete(root);
  }

  async search(root: string, query: string, limit: number): Promise<WorkspaceFileMatches> {
    const { entries, truncated } = await this.snapshot(root);
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return { matches: entries.slice(0, limit).map((item) => item.entry), truncated };
    const scored: Array<{ candidate: IndexedEntry; value: number }> = [];
    for (const candidate of entries) {
      const value = score(candidate, needle);
      if (value >= 0) scored.push({ candidate, value });
    }
    scored.sort((left, right) => right.value - left.value
      || left.candidate.entry.path.length - right.candidate.entry.path.length);
    return { matches: scored.slice(0, limit).map((item) => item.candidate.entry), truncated };
  }

  /**
   * Stale-while-revalidate: a lapsed TTL refreshes in the background instead of making the keystroke that
   * noticed it wait on `git ls-files`. The cost is that a just-created file can be one lookup late.
   */
  private async snapshot(root: string): Promise<IndexSnapshot> {
    const cached = this.cache.get(root);
    if (cached !== undefined) {
      if (Date.now() - cached.scannedAt >= this.ttlMs) void this.rescan(root).catch(() => { /* keep serving the cache */ });
      return cached;
    }
    return this.rescan(root);
  }

  private async rescan(root: string): Promise<IndexSnapshot> {
    // Typing "@src" fires several lookups before the first scan returns; they must share one scan, not race it.
    const running = this.inFlight.get(root);
    if (running !== undefined) return running;
    const scan = this.scan(root).finally(() => this.inFlight.delete(root));
    this.inFlight.set(root, scan);
    return scan;
  }

  private async scan(root: string): Promise<IndexSnapshot> {
    const tracked = await listGitFiles(root);
    const { paths, truncated } = tracked === undefined
      ? await walkFiles(root, this.maxEntries)
      : { paths: tracked.slice(0, this.maxEntries), truncated: tracked.length > this.maxEntries };
    const snapshot: IndexSnapshot = { entries: buildEntries(paths), truncated, scannedAt: Date.now() };
    this.cache.set(root, snapshot);
    return snapshot;
  }
}
