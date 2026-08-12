import { describe, expect, it } from "vitest";
import type { ConversationMemory, WorkflowStepResult } from "@waing/domain";
import { compactConversationMemory, compactHistory, DEFAULT_COMPACTION_BUDGET, latestTestPerCommand, renderPacket, withoutDiff } from "./ContextCompactor";

function step(index: number, overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return { stepRunId: `step-${String(index)}`, nodeId: `node-${String(index)}`, agentProfileId: "coder", agentName: "Coder", agentId: "fake",
    status: "completed", summary: `Headline ${String(index)}\n${"detail ".repeat(500)}`, filesRead: [],
    filesChanged: [`src/file-${String(index)}.ts`], commandsRun: [], testsRun: [], ...overrides };
}

describe("ContextCompactor", () => {
  it("keeps the newest steps readable and collapses older ones to a headline", () => {
    const history = compactHistory(Array.from({ length: 5 }, (_value, index) => step(index)));
    expect(history.summaries).toHaveLength(5);
    expect(history.summaries.slice(0, 3).every((entry) => entry.collapsed === true)).toBe(true);
    expect(history.summaries[0]?.summary).toBe("Headline 0");
    expect(history.summaries.at(-1)?.collapsed).toBeUndefined();
    expect(history.summaries.at(-1)?.summary.length).toBeGreaterThan(DEFAULT_COMPACTION_BUDGET.collapsedChars);
  });

  it("carries each changed path once at packet level instead of repeating it per collapsed entry", () => {
    const history = compactHistory([step(0), step(1), step(1), step(2), step(3)]);
    expect(history.changedFiles).toEqual(["src/file-0.ts", "src/file-1.ts", "src/file-2.ts", "src/file-3.ts"]);
    expect(history.summaries.filter((entry) => entry.collapsed === true).flatMap((entry) => entry.filesChanged)).toEqual([]);
  });

  it("drops steps beyond the budget and reports how many were lost", () => {
    const history = compactHistory(Array.from({ length: 12 }, (_value, index) => step(index)));
    expect(history.summaries).toHaveLength(DEFAULT_COMPACTION_BUDGET.maxSteps);
    expect(history.omittedStepCount).toBe(4);
  });

  it("skips the newest steps a caller already sends in full so they are never counted twice", () => {
    const history = compactHistory([step(0), step(1), step(2)], DEFAULT_COMPACTION_BUDGET, 1);
    expect(history.summaries.map((entry) => entry.summary.split("\n")[0])).toEqual(["Headline 0", "Headline 1"]);
  });

  it("keeps failing tests on a collapsed step and discards the passing noise", () => {
    const failing = { command: "npm test", passed: false, exitCode: 1 };
    const passing = { command: "npm run lint", passed: true, exitCode: 0 };
    const history = compactHistory([step(0, { testsRun: [failing, passing] }), step(1), step(2)]);
    expect(history.summaries[0]?.testsRun).toEqual([failing]);
  });

  it("keeps only the latest outcome per command across review/fix iterations", () => {
    expect(latestTestPerCommand([{ command: "npm test", passed: false, exitCode: 1 },
      { command: "npm test", passed: true, exitCode: 0 }])).toEqual([{ command: "npm test", passed: true, exitCode: 0 }]);
  });

  it("strips the diff without disturbing the rest of a step result", () => {
    const stripped = withoutDiff(step(0, { diff: "@@ huge diff @@" }));
    expect(stripped.diff).toBeUndefined();
    expect(stripped.filesChanged).toEqual(["src/file-0.ts"]);
  });

  it("renders packets as headed text that costs less than the equivalent JSON", () => {
    const packet = { originalTask: "build", currentGoal: "Review", changedFiles: ["a.ts", "b.ts"],
      priorStepSummaries: [{ agentProfileId: "coder", agentName: "Coder", summary: "done", filesChanged: [], testsRun: [] }], unresolvedIssues: [] };
    const rendered = renderPacket("Handoff", packet);
    expect(rendered).toContain("originalTask: build");
    expect(rendered).toContain("- a.ts");
    // Empty collections carry no information and are omitted entirely.
    expect(rendered).not.toContain("unresolvedIssues");
    expect(rendered.length).toBeLessThan(JSON.stringify(packet).length);
  });

  it("projects durable memory to a small prompt-safe tail", () => {
    const memory: ConversationMemory = { conversationId: "c", version: 1, revision: 1, objective: "o".repeat(4_000),
      requirements: Array.from({ length: 20 }, () => "r".repeat(400)), constraints: [], planItems: [], decisions: [],
      completedWork: Array.from({ length: 40 }, () => "w".repeat(800)), changedFiles: Array.from({ length: 100 }, (_, i) => `file-${String(i)}`),
      openQuestions: [], unresolvedIssues: [], stepSummaries: [], updatedAt: "2026-08-12T00:00:00.000Z" };
    const compacted = compactConversationMemory(memory);
    expect(compacted.requirements).toHaveLength(10); expect(compacted.completedWork).toHaveLength(12); expect(compacted.changedFiles).toHaveLength(60);
    expect(compacted.objective.length).toBeLessThanOrEqual(2_013);
  });
});
