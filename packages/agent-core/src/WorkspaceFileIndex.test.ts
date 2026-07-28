import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceFileIndex } from "./WorkspaceFileIndex";

const execFileAsync = promisify(execFile);
const temporaryPaths: string[] = [];
afterEach(async () => Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "waing-files-"));
  temporaryPaths.push(root);
  await mkdir(join(root, "src", "renderer"), { recursive: true });
  await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "README.md"), "# readme");
  await writeFile(join(root, "src", "index.ts"), "export {};");
  await writeFile(join(root, "src", "renderer", "App.tsx"), "export {};");
  await writeFile(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 0;");
  await writeFile(join(root, "dist", "bundle.js"), "0;");
  return root;
}

/** git is what the index prefers, so the fallback only gets exercised when a repo is not initialized. */
async function initGitRepository(root: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await writeFile(join(root, ".gitignore"), "node_modules/\ndist/\n");
}

const paths = (matches: ReadonlyArray<{ path: string }>): string[] => matches.map((match) => match.path);

describe("workspace file index", () => {
  it("indexes tracked and untracked files in a git workspace and applies its ignore rules", async () => {
    const root = await makeWorkspace();
    await initGitRepository(root);
    const index = new WorkspaceFileIndex();
    const { matches } = await index.search(root, "", 50);
    const found = paths(matches);
    expect(found).toContain("src/renderer/App.tsx");
    // Never committed, so only `--others` surfaces it — a file the user just created must be mentionable.
    expect(found).toContain("README.md");
    expect(found.some((path) => path.startsWith("node_modules"))).toBe(false);
    expect(found.some((path) => path.startsWith("dist"))).toBe(false);
  });

  it("walks the tree and skips build directories when there is no git repository", async () => {
    const root = await makeWorkspace();
    const index = new WorkspaceFileIndex();
    const found = paths((await index.search(root, "", 50)).matches);
    expect(found).toContain("src/index.ts");
    expect(found.some((path) => path.startsWith("node_modules"))).toBe(false);
    expect(found.some((path) => path.startsWith("dist"))).toBe(false);
  });

  it("never follows a symlink out of the workspace", async () => {
    const parent = await mkdtemp(join(tmpdir(), "waing-files-link-"));
    temporaryPaths.push(parent);
    const root = join(parent, "workspace");
    const outside = join(parent, "outside");
    await mkdir(root); await mkdir(outside);
    await writeFile(join(root, "own.ts"), "export {};");
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "linked"));
    const found = paths((await new WorkspaceFileIndex().search(root, "", 50)).matches);
    expect(found).toEqual(["own.ts"]);
  });

  it("offers directories alongside files and ranks a filename match above a path match", async () => {
    const root = await makeWorkspace();
    const index = new WorkspaceFileIndex();
    const { matches } = await index.search(root, "renderer", 10);
    expect(matches[0]).toEqual({ path: "src/renderer", name: "renderer", kind: "directory" });
    const appMatches = await index.search(root, "app.tsx", 10);
    expect(appMatches.matches[0]?.path).toBe("src/renderer/App.tsx");
  });

  it("matches a scattered subsequence so an abbreviation still finds the file", async () => {
    const root = await makeWorkspace();
    const found = paths((await new WorkspaceFileIndex().search(root, "srappt", 10)).matches);
    expect(found).toContain("src/renderer/App.tsx");
  });

  it("reports truncation instead of scanning an unbounded workspace", async () => {
    const root = await makeWorkspace();
    const result = await new WorkspaceFileIndex({ maxEntries: 2 }).search(root, "", 50);
    expect(result.truncated).toBe(true);
  });

  it("reuses one scan within the ttl", async () => {
    const root = await makeWorkspace();
    const index = new WorkspaceFileIndex({ ttlMs: 60_000 });
    await index.search(root, "", 50);
    await writeFile(join(root, "src", "added.ts"), "export {};");
    expect(paths((await index.search(root, "added", 10)).matches)).toEqual([]);
  });

  it("serves the cached scan while a lapsed index refreshes behind the keystroke", async () => {
    const root = await makeWorkspace();
    const index = new WorkspaceFileIndex({ ttlMs: 0 });
    await index.search(root, "", 50);
    await writeFile(join(root, "src", "added.ts"), "export {};");
    // The lookup that notices the lapsed ttl still answers from cache rather than waiting on a rescan.
    expect(paths((await index.search(root, "added", 10)).matches)).toEqual([]);
    await vi.waitFor(async () => {
      expect(paths((await index.search(root, "added", 10)).matches)).toContain("src/added.ts");
    });
  });

  it("drops a scan on demand so a removed project cannot be searched from cache", async () => {
    const root = await makeWorkspace();
    const index = new WorkspaceFileIndex({ ttlMs: 60_000 });
    await index.search(root, "", 50);
    await writeFile(join(root, "src", "added.ts"), "export {};");
    index.invalidate(root);
    expect(paths((await index.search(root, "added", 10)).matches)).toContain("src/added.ts");
  });
});
