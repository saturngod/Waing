import { describe, expect, it } from "vitest";
import type { AgentProfile, ConversationMemory, RouterCheckpointInput, WorkflowStepResult } from "@waing/domain";
import { InMemoryWorkflowRepository } from "./WorkflowRepository";
import { WorkflowCompiler } from "./WorkflowCompiler";
import { WorkflowEngine } from "./WorkflowEngine";
import type { StepExecutionInput, WorkflowStepExecutor } from "./StepExecutor";

const profile = (index: number): AgentProfile => ({ id: `agent-${index}`, name: `Agent ${index}`, whereToUse: `Job ${index}`,
  enabled: true, agentId: "fake", position: index });
class Executor implements WorkflowStepExecutor {
  calls: StepExecutionInput[] = [];
  describe() { return Promise.resolve({ agentDisplayName: "Fake" }); }
  execute(input: StepExecutionInput): Promise<WorkflowStepResult> { this.calls.push(input); return Promise.resolve({ stepRunId: input.stepRunId,
    nodeId: input.node.id, agentProfileId: input.profile.id, agentName: input.profile.name, agentId: input.profile.agentId,
    status: "completed", summary: "done", filesRead: [], filesChanged: [], commandsRun: [], testsRun: [] }); }
}

describe("adaptive agent workflow", () => {
  it.each([1, 15])("compiles a valid roster of %i agents", (count) => {
    const workflow = new WorkflowCompiler().compileAdaptive(Array.from({ length: count }, (_, index) => profile(index)));
    expect(workflow.nodes.filter((node) => node.type === "role_task")).toHaveLength(count);
    expect(workflow.edges.filter((edge) => edge.condition?.type === "router_agent")).toHaveLength(count * 2);
  });
  it("delegates, carries the diff to the next agent, then completes", async () => {
    const profiles = [profile(0), profile(1)]; const executor = new Executor();
    executor.execute = (input) => { executor.calls.push(input); return Promise.resolve({ stepRunId: input.stepRunId, nodeId: input.node.id,
      agentProfileId: input.profile.id, agentName: input.profile.name, agentId: "fake", status: "completed", summary: "done",
      filesRead: [], filesChanged: [], ...(input.profile.id === "agent-0" ? { diff: "@@ change @@" } : {}), commandsRun: [], testsRun: [] }); };
    const decisions = [{ action: "delegate", agentProfileId: "agent-0", statusIntent: { activity: "implementing" }, rationale: "code", confidence: 1 },
      { action: "delegate", agentProfileId: "agent-1", statusIntent: { activity: "reviewing" }, rationale: "review", confidence: 1 },
      { action: "complete", statusIntent: { activity: "implementing" }, rationale: "done", confidence: 1 }];
    const result = await new WorkflowEngine(new InMemoryWorkflowRepository(), executor,
      { decideNext: () => Promise.resolve(decisions.shift()) }).run({ definition: new WorkflowCompiler().compileAdaptive(profiles), profiles,
        projectId: "p", projectRoot: "/tmp", task: "build" });
    expect(result.run.status).toBe("completed"); expect(executor.calls[1]?.handoff.currentDiff).toBe("@@ change @@");
  });
  it("resends memory only when a resumed lane has not seen the current revision", async () => {
    const profiles = [profile(0)]; const executor = new Executor();
    const memory: ConversationMemory = { conversationId: "conversation", version: 1, revision: 2, objective: "Build it", requirements: [],
      constraints: [], planItems: [], decisions: [], completedWork: [], changedFiles: [], openQuestions: [], unresolvedIssues: [], stepSummaries: [],
      updatedAt: "2026-08-12T00:00:00.000Z" };
    const decisions = [{ action: "delegate", agentProfileId: "agent-0", statusIntent: { activity: "implementing" }, rationale: "code", confidence: 1 },
      { action: "complete", statusIntent: { activity: "implementing" }, rationale: "done", confidence: 1 }];
    await new WorkflowEngine(new InMemoryWorkflowRepository(), executor,
      { decideNext: () => Promise.resolve(decisions.shift()) }).run({ definition: new WorkflowCompiler().compileAdaptive(profiles), profiles,
        projectId: "p", projectRoot: "/tmp", task: "follow up", conversationMemory: memory,
        providerSessions: { "agent-0": "thread" }, providerSessionMemoryRevisions: { "agent-0": 1 } });
    expect(executor.calls[0]?.handoff.conversationMemory?.revision).toBe(2);
  });

  it("bootstraps a new shared provider thread once, then omits repeated history", async () => {
    const profiles = [profile(0)]; const executor = new Executor(); const checkpoints: RouterCheckpointInput[] = [];
    const memory: ConversationMemory = { conversationId: "conversation", version: 1, revision: 2, objective: "Build it", requirements: [],
      constraints: [], planItems: [], decisions: [], completedWork: ["Earlier work"], changedFiles: [], openQuestions: [], unresolvedIssues: [],
      stepSummaries: [], updatedAt: "2026-08-12T00:00:00.000Z" };
    const decisions = [{ action: "delegate", agentProfileId: "agent-0", statusIntent: { activity: "implementing" }, rationale: "code", confidence: 1 },
      { action: "complete", statusIntent: { activity: "implementing" }, rationale: "done", confidence: 1 }];
    let providerHasContext = false;
    const engine = new WorkflowEngine(new InMemoryWorkflowRepository(), executor, { decideNext: (input) => {
      checkpoints.push(input); providerHasContext = true; return Promise.resolve(decisions.shift());
    } }, undefined, undefined, undefined, undefined, { providerThreadCarriesContext: () => providerHasContext });
    await engine.run({ definition: new WorkflowCompiler().compileAdaptive(profiles), profiles,
      projectId: "p", projectRoot: "/tmp", task: "follow up", conversationMemory: memory });
    expect(checkpoints[0]?.conversationMemory?.revision).toBe(2);
    expect(executor.calls[0]?.handoff).toMatchObject({ priorStepSummaries: [], unresolvedIssues: [] });
    expect(executor.calls[0]?.handoff.conversationMemory).toBeUndefined();
    expect(checkpoints[1]).toMatchObject({ priorStepSummaries: [] });
    expect(checkpoints[1]?.latestStepResult).toBeUndefined();
    expect(checkpoints[1]?.conversationMemory).toBeUndefined();
  });
});
