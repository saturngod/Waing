import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./DiffViewer";

const DIFF = `diff --git a/src/one.ts b/src/one.ts
index 1111111..2222222 100644
--- a/src/one.ts
+++ b/src/one.ts
@@ -10,3 +10,4 @@ export function one() {
 unchanged
-old value
+new value
+another value
 end
diff --git a/src/removed.ts b/src/removed.ts
deleted file mode 100644
--- a/src/removed.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-first
-second`;

describe("unified diff parsing", () => {
  it("groups hunks by file and counts actual changed lines", () => {
    const files = parseUnifiedDiff(DIFF);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ path: "src/one.ts", oldPath: "src/one.ts", newPath: "src/one.ts", additions: 2, deletions: 1 });
    expect(files[1]).toMatchObject({ path: "src/removed.ts", oldPath: "src/removed.ts", newPath: undefined, additions: 0, deletions: 2 });
  });

  it("assigns old and new line numbers and reports collapsed unchanged ranges", () => {
    const file = parseUnifiedDiff(DIFF)[0];
    expect(file).toBeDefined();
    if (file === undefined) return;
    const hunk = file.hunks[0];
    expect(hunk).toBeDefined();
    if (hunk === undefined) return;
    expect(hunk.omittedBefore).toBe(9);
    expect(hunk.lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ["context", 10, 10], ["deletion", 11, undefined], ["addition", undefined, 11],
      ["addition", undefined, 12], ["context", 12, 13],
    ]);
  });

  it("accepts a unified diff without a git header", () => {
    const file = parseUnifiedDiff("--- a/readme.md\n+++ b/readme.md\n@@ -1 +1 @@\n-old\n+new")[0];
    expect(file).toMatchObject({ path: "readme.md", additions: 1, deletions: 1 });
  });
});
