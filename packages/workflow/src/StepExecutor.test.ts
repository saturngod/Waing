import { describe, expect, it } from "vitest";
import { workflowHandoffPacketSchema, workflowStepResultSchema } from "@waing/domain";

describe("agent step contracts", () => {
  it("uses agent identity instead of a fixed role", () => {
    expect(workflowStepResultSchema.parse({ stepRunId: "s", nodeId: "coder", agentProfileId: "coder", agentName: "Coder",
      agentId: "codex", status: "completed", summary: "done", filesRead: [], filesChanged: [], commandsRun: [], testsRun: [] }).agentName).toBe("Coder");
  });
  it("accepts a diff in every agent handoff", () => expect(workflowHandoffPacketSchema.parse({ originalTask: "x", currentGoal: "review",
    priorStepSummaries: [], currentDiff: "@@", unresolvedIssues: [] }).currentDiff).toBe("@@"));
});
