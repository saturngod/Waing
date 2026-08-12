import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { redactSensitiveData, redactText } from "./Redaction";
import { providerCompatibility } from "./CompatibilityManifest";
import { RestartPolicy } from "./RestartPolicy";
import { canonicalizeWorkspaceRoot, resolveWorkspacePath } from "./WorkspacePathGuard";

const temporaryPaths: string[] = [];
afterEach(async () => Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("workspace boundary", () => {
  it("canonicalizes directories and permits existing and new nested paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "waing-security-")); temporaryPaths.push(root);
    await mkdir(join(root, "src")); await writeFile(join(root, "src", "index.ts"), "ok");
    const canonical = await canonicalizeWorkspaceRoot(root);
    expect(canonical).toContain("waing-security-");
    await expect(resolveWorkspacePath(root, "src/index.ts")).resolves.toBe(join(canonical, "src", "index.ts"));
    await expect(resolveWorkspacePath(root, "src/new/deep.ts", true)).resolves.toBe(join(canonical, "src", "new", "deep.ts"));
    await expect(resolveWorkspacePath(root, "../escape.ts", true)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("rejects a symlink escape for reads and writes", async () => {
    const parent = await mkdtemp(join(tmpdir(), "waing-symlink-")); temporaryPaths.push(parent);
    const root = join(parent, "workspace"); const outside = join(parent, "outside");
    await mkdir(root); await mkdir(outside); await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "linked"));
    await expect(resolveWorkspacePath(root, "linked/secret.txt")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(resolveWorkspacePath(root, "linked/new.txt", true)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});

describe("secret redaction", () => {
  it("redacts headers, common credentials, and secret-shaped object fields", () => {
    expect(redactText("Authorization: Bearer abc.def.ghi password=hunter2 sk-abcdefghijklmnop"))
      .not.toContain("hunter2");
    expect(redactSensitiveData({ authorization: "Basic Zm9vOmJhcg==", nested: { apiKey: "top-secret", value: "safe" } }))
      .toEqual({ authorization: "[REDACTED]", nested: { apiKey: "[REDACTED]", value: "safe" } });
  });
});

describe("compatibility and restart policy", () => {
  it("reports versions outside the provider compatibility manifest", () => {
    expect(providerCompatibility("codex", "0.147.0")).toMatchObject({
      compatible: true, testedRange: "0.145.x–0.147.x",
    });
    expect(providerCompatibility("opencode", "1.18.5")).toMatchObject({ compatible: true, testedRange: "1.x" });
    const incompatible = providerCompatibility("opencode", "2.0.0");
    expect(incompatible.compatible).toBe(false); expect(incompatible.warning).toContain("2.0.0");
  });
  it("uses bounded exponential restart delays", () => {
    const policy = new RestartPolicy({ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 250 });
    expect([policy.delayMs(1), policy.delayMs(2), policy.delayMs(3)]).toEqual([100, 200, 250]);
    expect(policy.canRetry(2)).toBe(true); expect(policy.canRetry(3)).toBe(false);
  });
});
