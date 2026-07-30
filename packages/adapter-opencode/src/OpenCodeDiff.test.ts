import { describe, expect, it } from "vitest";
import { normalizeOpenCodeDiff } from "./OpenCodeDiff";

describe("OpenCode diff normalization", () => {
  it("converts before and after source into a provider-neutral unified diff", () => {
    const diff = normalizeOpenCodeDiff([{ file: "src/a.ts", before: "one\nold\nthree\n", after: "one\nnew\nthree\n",
      additions: 1, deletions: 1 }]);
    expect(diff).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(diff).toContain("@@ -1,3 +1,3 @@");
    expect(diff).toContain("-old\n+new");
  });

  it("adds file headers to a patch supplied by newer OpenCode versions", () => {
    expect(normalizeOpenCodeDiff([{ file: "readme.md", patch: "@@ -1 +1 @@\n-old\n+new" }]))
      .toBe("diff --git a/readme.md b/readme.md\n--- a/readme.md\n+++ b/readme.md\n@@ -1 +1 @@\n-old\n+new");
  });
});
