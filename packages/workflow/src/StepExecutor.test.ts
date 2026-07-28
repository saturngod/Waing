import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AgentManager, AsyncQueue } from "@waing/agent-core";
import type { CodingAgent } from "@waing/agent-core";
import type {
  AgentCapabilities, AgentDescriptor, AgentEvent, AgentRequest, AgentRun, AgentSession, ResumeSessionInput,
  RoleExecutionProfile, StartSessionInput, WorkflowContext, WorkflowNode, WorkflowStepResult,
} from "@waing/domain";
import { AgentStepExecutor } from "./StepExecutor";

const capabilities = (overrides: Partial<AgentCapabilities> = {}): AgentCapabilities => ({
  streaming: true, persistentSessions: false, cancellation: true, concurrentRuns: false, nativeStructuredOutput: false,
  planMode: false, effortControl: false, interactivePermissions: false, diffEvents: false, shellEvents: false,
  fileEvents: false, modelSelection: false, mcp: false, customTools: false, additionalDirectories: false, ...overrides,
});

class StepAgent implements CodingAgent {
  readonly requests: AgentRequest[] = [];
  readonly resumed: string[] = [];
  started = 0;
  resumeFails = false;
  private readonly queues = new Map<string, AsyncQueue<AgentEvent>>();
  private sequence = 0;
  constructor(readonly id: string, private readonly caps: AgentCapabilities) {}
  discover(): Promise<AgentDescriptor> {
    return Promise.resolve({ id: this.id, displayName: this.id, installed: true, available: true,
      capabilities: this.caps, authState: "unknown", warnings: [] });
  }
  listModels() { return Promise.resolve([]); }
  startSession(input: StartSessionInput, providerSessionId = `provider-${String(this.started)}`): Promise<AgentSession> {
    this.started += 1;
    const now = new Date().toISOString();
    const session: AgentSession = { id: randomUUID(), conversationId: input.conversationId, agentId: this.id,
      providerSessionId, projectId: input.projectId, createdAt: now, updatedAt: now, status: "idle" };
    this.queues.set(session.id, new AsyncQueue());
    return Promise.resolve(session);
  }
  resumeSession(input: ResumeSessionInput): Promise<AgentSession> {
    this.resumed.push(input.providerSessionId);
    if (this.resumeFails) return Promise.reject(new Error("provider dropped the session"));
    return this.startSession(input, input.providerSessionId);
  }
  reply = "done";
  send(sessionId: string, request: AgentRequest): Promise<AgentRun> {
    this.requests.push(request);
    const run = { id: randomUUID(), sessionId, startedAt: new Date().toISOString() };
    this.queues.get(sessionId)?.push({ id: randomUUID(), sessionId, runId: run.id, agentId: this.id,
      timestamp: new Date().toISOString(), sequence: this.sequence++, type: "message.completed", text: this.reply });
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
  stepResults: [], artifacts: [], loopState: {}, providerSessions: {},
  sharedState: { planItems: [], decisions: [], openQuestions: [] } };

async function runStep(agent: StepAgent, profile: Partial<RoleExecutionProfile>,
  resumeProviderSessionId?: string, stepNode: WorkflowNode = node): Promise<WorkflowStepResult> {
  const agents = new AgentManager(); agents.registry.register(agent);
  return new AgentStepExecutor(agents).execute({
    stepRunId: "step-1", node: stepNode as Exclude<WorkflowNode, { type: "router" | "loop" | "complete" }>,
    profile: { role: "medium", enabled: true, agentId: agent.id, permissionProfileId: "ask", ...profile },
    context, handoff: { originalTask: "build", currentGoal: "Medium Level Task", priorStepSummaries: [], unresolvedIssues: [] },
    ...(resumeProviderSessionId === undefined ? {} : { resumeProviderSessionId }),
    signal: new AbortController().signal,
  });
}

describe("AgentStepExecutor capability gating", () => {
  it("drops a saved model and effort the provider cannot accept instead of failing the step", async () => {
    // Some CLIs expose neither model selection nor effort control, yet every role profile carries both.
    const agent = new StepAgent("antigravity", capabilities());
    await runStep(agent, { modelId: "default", effort: "high" });
    expect(agent.requests[0]).toMatchObject({ mode: "execute" });
    expect(agent.requests[0]?.model).toBeUndefined();
    expect(agent.requests[0]?.effort).toBeUndefined();
  });

  it("passes the saved model and effort through to a provider that supports them", async () => {
    const agent = new StepAgent("codex", capabilities({ modelSelection: true, effortControl: true }));
    await runStep(agent, { modelId: "gpt-5-codex", effort: "high" });
    expect(agent.requests[0]).toMatchObject({ model: "gpt-5-codex", effort: "high" });
  });
});

describe("AgentStepExecutor mode derivation", () => {
  type RoleTaskNode = Extract<WorkflowNode, { type: "role_task" }>;
  const roleNode = (role: RoleTaskNode["role"]): WorkflowNode =>
    ({ id: role, label: `${role} step`, enabled: true, type: "role_task", role });

  it("derives the mode from the role rather than from a saved setting", async () => {
    const modeFor = async (node: WorkflowNode): Promise<string | undefined> => {
      const agent = new StepAgent("codex", capabilities({ planMode: true }));
      await runStep(agent, {}, undefined, node);
      return agent.requests[0]?.mode;
    };
    await expect(modeFor(roleNode("planning"))).resolves.toBe("plan");
    await expect(modeFor(roleNode("review"))).resolves.toBe("review");
    await expect(modeFor(roleNode("medium"))).resolves.toBe("execute");
  });

  it("puts a review gate in review mode too", async () => {
    const agent = new StepAgent("codex", capabilities({ planMode: true }));
    // A gate parses its own reply as structured JSON, so it needs a well-formed one to reach the assertion.
    agent.reply = '{"verdict":"pass","summary":"looks good","findings":[],"testsObserved":[],"confidence":0.9}';
    await runStep(agent, {}, undefined,
      { id: "gate", label: "Review gate", enabled: true, type: "review_gate", role: "review",
        passEdge: "done", failEdge: "bugfix" });
    expect(agent.requests[0]?.mode).toBe("review");
  });

  it("falls back to execute when the derived mode is plan and the provider has no plan mode", async () => {
    const agent = new StepAgent("opencode", capabilities({ planMode: false }));
    await runStep(agent, {}, undefined, roleNode("planning"));
    expect(agent.requests[0]?.mode).toBe("execute");
  });

  it("ignores a mode left on an older stored profile", async () => {
    const agent = new StepAgent("codex", capabilities({ planMode: true }));
    // Rows saved by the build that had a Mode column must not override the role any more.
    await runStep(agent, { mode: "plan" });
    expect(agent.requests[0]?.mode).toBe("execute");
  });
});

describe("AgentStepExecutor provider session reuse", () => {
  it("resumes the session an earlier step left behind and reports it back for the next step", async () => {
    const agent = new StepAgent("codex", capabilities({ persistentSessions: true }));
    const result = await runStep(agent, {}, "provider-earlier");
    expect(agent.resumed).toEqual(["provider-earlier"]);
    expect(agent.started).toBe(1);
    expect(result.providerSessionId).toBe("provider-earlier");
  });

  it("starts fresh when the provider has no persistent sessions to resume", async () => {
    const agent = new StepAgent("antigravity", capabilities({ persistentSessions: false }));
    await runStep(agent, {}, "provider-earlier");
    expect(agent.resumed).toEqual([]);
    expect(agent.started).toBe(1);
  });

  it("falls back to a fresh session when the provider has forgotten the one being resumed", async () => {
    const agent = new StepAgent("codex", capabilities({ persistentSessions: true }));
    agent.resumeFails = true;
    const result = await runStep(agent, {}, "provider-gone");
    expect(agent.resumed).toEqual(["provider-gone"]);
    expect(result.status).toBe("completed");
    expect(result.providerSessionId).toBe("provider-0");
  });
});

describe("AgentStepExecutor shared state", () => {
  it("lifts a state block out of the message and keeps it off the stored summary", async () => {
    const agent = new StepAgent("codex", capabilities());
    agent.reply = "Implemented the parser.\n\n```waing-state\n"
      + '{"planItems":[{"id":"p1","title":"Parse tokens","status":"done"}],"decisions":["Reuse the lexer"]}\n```';
    const result = await runStep(agent, {});
    expect(result.stateUpdate).toEqual({ planItems: [{ id: "p1", title: "Parse tokens", status: "done" }],
      decisions: ["Reuse the lexer"] });
    expect(result.summary).toBe("Implemented the parser.");
  });

  it("lifts a trailing state object out even when the provider drops the fence", async () => {
    const agent = new StepAgent("codex", capabilities());
    agent.reply = "The fix is complete.\n\n"
      + '{"planItems":[{"id":"p6","title":"Deploy site","status":"pending"}],"decisions":[],"openQuestions":[]}';
    const result = await runStep(agent, {});
    expect(result.stateUpdate).toEqual({ planItems: [{ id: "p6", title: "Deploy site", status: "pending" }],
      decisions: [], openQuestions: [] });
    expect(result.summary).toBe("The fix is complete.");
  });

  it("leaves prose that merely mentions the state keys alone", async () => {
    const agent = new StepAgent("codex", capabilities());
    agent.reply = 'I looked at {"planItems": ...} in the docs and it is unchanged.';
    const result = await runStep(agent, {});
    expect(result.stateUpdate).toBeUndefined();
    expect(result.summary).toBe(agent.reply);
  });

  it("ignores a malformed state block rather than failing the step", async () => {
    const agent = new StepAgent("codex", capabilities());
    agent.reply = 'Done.\n\n```waing-state\n{"planItems":[{"id":"p1"}]}\n```';
    const result = await runStep(agent, {});
    expect(result.stateUpdate).toBeUndefined();
    expect(result.status).toBe("completed");
    // The block is still stripped, so a broken amendment never leaks into the next step's packet.
    expect(result.summary).toBe("Done.");
  });

  it("tells every step how to amend the shared state", async () => {
    const agent = new StepAgent("codex", capabilities());
    await runStep(agent, {});
    expect(agent.requests[0]?.text).toContain("waing-state");
  });
});

describe("AgentStepExecutor permission profiles", () => {
  /** Runs one step and reports the profile registered against the session the executor opened. */
  async function profileForStep(permissionProfileId: string | undefined): Promise<string | undefined> {
    const agent = new StepAgent("codex", capabilities());
    const agents = new AgentManager(); agents.registry.register(agent);
    const sessionIds = new Set<string>();
    agents.eventBus.subscribe((event) => sessionIds.add(event.sessionId));
    await new AgentStepExecutor(agents).execute({
      stepRunId: "step-1", node: node as Exclude<WorkflowNode, { type: "router" | "loop" | "complete" }>,
      profile: { role: "medium", enabled: true, agentId: agent.id,
        ...(permissionProfileId === undefined ? {} : { permissionProfileId }) },
      context, handoff: { originalTask: "build", currentGoal: "Medium Level Task", priorStepSummaries: [], unresolvedIssues: [] },
      signal: new AbortController().signal,
    });
    return agents.permissionProfileFor([...sessionIds][0] ?? "");
  }

  it("carries the role's saved profile onto the session so approvals are answered by it", async () => {
    await expect(profileForStep("auto_edit")).resolves.toBe("auto_edit");
    await expect(profileForStep("autonomous")).resolves.toBe("autonomous");
  });

  it("falls back to asking when the stored id is missing or no longer a known profile", async () => {
    await expect(profileForStep(undefined)).resolves.toBe("ask_before_changes");
    // Older rows stored short ids like "ask"; an unrecognized one must never widen permissions.
    await expect(profileForStep("ask")).resolves.toBe("ask_before_changes");
  });
});
