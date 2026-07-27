import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AgentManager, AsyncQueue } from "@waing/agent-core";
import type { CodingAgent } from "@waing/agent-core";
import type {
  AgentCapabilities, AgentDescriptor, AgentEvent, AgentRequest, AgentRun, AgentSession, ResumeSessionInput,
  RoleExecutionProfile, StartSessionInput, WorkflowContext, WorkflowNode,
} from "@waing/domain";
import { AgentStepExecutor } from "./StepExecutor";

const capabilities = (overrides: Partial<AgentCapabilities> = {}): AgentCapabilities => ({
  streaming: true, persistentSessions: false, cancellation: true, concurrentRuns: false, nativeStructuredOutput: false,
  planMode: false, effortControl: false, interactivePermissions: false, diffEvents: false, shellEvents: false,
  fileEvents: false, modelSelection: false, mcp: false, customTools: false, additionalDirectories: false, ...overrides,
});

class StepAgent implements CodingAgent {
  readonly requests: AgentRequest[] = [];
  private readonly queues = new Map<string, AsyncQueue<AgentEvent>>();
  private sequence = 0;
  constructor(readonly id: string, private readonly caps: AgentCapabilities) {}
  discover(): Promise<AgentDescriptor> {
    return Promise.resolve({ id: this.id, displayName: this.id, installed: true, available: true,
      capabilities: this.caps, authState: "unknown", warnings: [] });
  }
  listModels() { return Promise.resolve([]); }
  startSession(input: StartSessionInput): Promise<AgentSession> {
    const now = new Date().toISOString();
    const session: AgentSession = { id: randomUUID(), conversationId: input.conversationId, agentId: this.id,
      projectId: input.projectId, createdAt: now, updatedAt: now, status: "idle" };
    this.queues.set(session.id, new AsyncQueue());
    return Promise.resolve(session);
  }
  resumeSession(input: ResumeSessionInput): Promise<AgentSession> { return this.startSession(input); }
  send(sessionId: string, request: AgentRequest): Promise<AgentRun> {
    this.requests.push(request);
    const run = { id: randomUUID(), sessionId, startedAt: new Date().toISOString() };
    this.queues.get(sessionId)?.push({ id: randomUUID(), sessionId, runId: run.id, agentId: this.id,
      timestamp: new Date().toISOString(), sequence: this.sequence++, type: "message.completed", text: "done" });
    this.queues.get(sessionId)?.push({ id: randomUUID(), sessionId, runId: run.id, agentId: this.id,
      timestamp: new Date().toISOString(), sequence: this.sequence++, type: "run.completed", summary: "done" });
    return Promise.resolve(run);
  }
  cancel() { return Promise.resolve(); }
  respondToPermission() { return Promise.resolve(); }
  closeSession(sessionId: string) { this.queues.get(sessionId)?.end(); return Promise.resolve(); }
  shutdown() { for (const queue of this.queues.values()) queue.end(); return Promise.resolve(); }
  events(sessionId: string): AsyncIterable<AgentEvent> { return this.queues.get(sessionId) ?? new AsyncQueue(); }
}

const node: WorkflowNode = { id: "medium", label: "Medium Level Task", enabled: true, type: "role_task", role: "medium" };
const context: WorkflowContext = { workflowRunId: "run-1", projectId: "p", projectRoot: "/tmp", originalUserTask: "build",
  stateVersion: 0, routerDecisionCount: 0, routerDecisionHistory: [], activeNodeId: "medium", completedNodeIds: [],
  stepResults: [], artifacts: [], loopState: {} };

async function runStep(agent: StepAgent, profile: Partial<RoleExecutionProfile>): Promise<void> {
  const agents = new AgentManager(); agents.registry.register(agent);
  await new AgentStepExecutor(agents).execute({
    stepRunId: "step-1", node: node as Exclude<WorkflowNode, { type: "router" | "loop" | "complete" }>,
    profile: { role: "medium", enabled: true, agentId: agent.id, permissionProfileId: "ask", ...profile },
    context, handoff: { originalTask: "build", currentGoal: "Medium Level Task", priorStepSummaries: [], unresolvedIssues: [] },
    signal: new AbortController().signal,
  });
}

describe("AgentStepExecutor capability gating", () => {
  it("drops a saved model and effort the provider cannot accept instead of failing the step", async () => {
    // Some CLIs expose neither model selection nor effort control, yet every role profile carries both.
    const agent = new StepAgent("antigravity", capabilities());
    await runStep(agent, { modelId: "default", effort: "high", mode: "plan" });
    expect(agent.requests[0]).toMatchObject({ mode: "execute" });
    expect(agent.requests[0]?.model).toBeUndefined();
    expect(agent.requests[0]?.effort).toBeUndefined();
  });

  it("passes the saved model, effort, and plan mode through to a provider that supports them", async () => {
    const agent = new StepAgent("codex", capabilities({ modelSelection: true, effortControl: true, planMode: true }));
    await runStep(agent, { modelId: "gpt-5-codex", effort: "high", mode: "plan" });
    expect(agent.requests[0]).toMatchObject({ mode: "plan", model: "gpt-5-codex", effort: "high" });
  });
});
