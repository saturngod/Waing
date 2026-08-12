import { describe, expect, it } from "vitest";
import type { WorkflowContext } from "@waing/domain";
import { buildConversationMemory } from "./ConversationMemory";

const context = (overrides: Partial<WorkflowContext> = {}): WorkflowContext => ({
  workflowRunId: "run", projectId: "project", projectRoot: "/tmp/project", originalUserTask: "implement it", stateVersion: 1,
  routerDecisionCount: 0, routerDecisionHistory: [], activeNodeId: "complete", completedNodeIds: ["coder"], stepResults: [{
    stepRunId: "step", nodeId: "coder", agentProfileId: "coder", agentName: "Coder", agentId: "codex", status: "completed",
    summary: "Implemented the change", filesRead: [], filesChanged: ["src/index.ts"], commandsRun: [], testsRun: [],
  }], loopState: {}, providerSessions: {}, providerSessionMemoryRevisions: {},
  sharedState: { planItems: [], decisions: ["Keep the API stable"], openQuestions: [] }, ...overrides,
});

describe("conversation memory", () => {
  it("keeps prior memory, current state, and a bounded step projection", () => {
    const first = buildConversationMemory(undefined, context(), "Implement the feature", "conversation", "2026-08-12T00:00:00.000Z");
    const second = buildConversationMemory({ ...first, completedWork: ["Earlier work"] }, context({ stateVersion: 2 }),
      "Follow up", "conversation", "2026-08-12T00:01:00.000Z");
    expect(first.revision).toBe(1); expect(second.revision).toBe(2); expect(second.objective).toBe("Implement the feature");
    expect(second.decisions).toEqual(["Keep the API stable"]); expect(second.changedFiles).toEqual(["src/index.ts"]);
    expect(second.completedWork).toContain("Earlier work"); expect(second.completedWork).toContain("Coder: Implemented the change");
  });
});
