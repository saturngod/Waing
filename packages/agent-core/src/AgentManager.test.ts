import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentCapabilities,
  AgentDescriptor,
  AgentEvent,
  AgentRequest,
  AgentRun,
  AgentSession,
  PermissionDecision,
  ResumeSessionInput,
  StartSessionInput,
} from "@waing/domain";
import { AgentCapabilityError, AgentError } from "@waing/domain";
import { AgentManager } from "./AgentManager";
import { AsyncQueue } from "./AsyncQueue";
import type { CodingAgent } from "./CodingAgent";

const capabilities: AgentCapabilities = {
  streaming: true,
  persistentSessions: true,
  cancellation: true,
  concurrentRuns: false,
  nativeStructuredOutput: false,
  planMode: false,
  effortControl: false,
  interactivePermissions: true,
  diffEvents: true,
  shellEvents: true,
  fileEvents: true,
  modelSelection: false,
  mcp: false,
  customTools: false,
  additionalDirectories: false,
};

class FakeAgent implements CodingAgent {
  readonly id: string = "fake";
  protected readonly queues = new Map<string, AsyncQueue<AgentEvent>>();
  private sequence = 0;

  discover(): Promise<AgentDescriptor> {
    return Promise.resolve({
      id: this.id,
      displayName: "Fake Agent",
      installed: true,
      available: true,
      capabilities,
      authState: "ready",
      warnings: [],
    });
  }
  listModels() { return Promise.resolve([]); }
  startSession(input: StartSessionInput): Promise<AgentSession> {
    const now = new Date().toISOString();
    const session = {
      id: randomUUID(), conversationId: input.conversationId, agentId: this.id,
      projectId: input.projectId, createdAt: now, updatedAt: now, status: "idle" as const,
    };
    this.queues.set(session.id, new AsyncQueue());
    return Promise.resolve(session);
  }
  async resumeSession(input: ResumeSessionInput): Promise<AgentSession> {
    return { ...await this.startSession(input), providerSessionId: input.providerSessionId };
  }
  send(sessionId: string, request: AgentRequest): Promise<AgentRun> {
    const run = { id: randomUUID(), sessionId, startedAt: new Date().toISOString() };
    this.emit(sessionId, run.id, { type: "run.started" });
    this.emit(sessionId, run.id, { type: "message.delta", text: request.text });
    this.emit(sessionId, run.id, { type: "run.completed", summary: "done" });
    return Promise.resolve(run);
  }
  cancel() { return Promise.resolve(); }
  respondToPermission(_sessionId: string, _requestId: string, _decision: PermissionDecision) { return Promise.resolve(); }
  closeSession() { return Promise.resolve(); }
  shutdown() { for (const queue of this.queues.values()) queue.end(); return Promise.resolve(); }
  events(sessionId: string): AsyncIterable<AgentEvent> { return this.queues.get(sessionId) ?? new AsyncQueue(); }
  protected push(sessionId: string, event: AgentEvent): void { this.queues.get(sessionId)?.push(event); }

  private emit(
    sessionId: string,
    runId: string,
    payload: { type: "run.started" } | { type: "message.delta"; text: string } | { type: "run.completed"; summary: string },
  ): void {
    this.queues.get(sessionId)?.push({
      id: randomUUID(), sessionId, runId, agentId: this.id, timestamp: new Date().toISOString(),
      sequence: this.sequence++, ...payload,
    });
  }
}

/** Emits two overlapping approvals plus one event the schema rejects, the shapes that used to kill the pump. */
class StackingAgent extends FakeAgent {
  override readonly id = "stacking";
  override send(sessionId: string, _request: AgentRequest): Promise<AgentRun> {
    const run = { id: randomUUID(), sessionId, startedAt: new Date().toISOString() };
    const base = { sessionId, runId: run.id, agentId: this.id, timestamp: new Date().toISOString() };
    const request = { id: "request-1", sessionId, runId: run.id, agentId: this.id, kind: "shell" as const,
      title: "Run tests", detail: "npm test", risk: "medium" as const };
    this.push(sessionId, { ...base, id: randomUUID(), sequence: 0, type: "run.started" });
    this.push(sessionId, { ...base, id: randomUUID(), sequence: 1, type: "permission.requested", request });
    this.push(sessionId, { ...base, id: randomUUID(), sequence: 2, type: "question.requested", question: {
      id: "question-1", sessionId, runId: run.id, agentId: this.id,
      questions: [{ question: "Which one?", header: "Pick", options: [{ label: "A", description: "" }] }] } });
    this.push(sessionId, { ...base, id: randomUUID(), sequence: 3, type: "nonsense" } as unknown as AgentEvent);
    this.push(sessionId, { ...base, id: randomUUID(), sequence: 4, type: "question.resolved",
      questionId: "question-1", answers: [{ header: "Pick", values: ["A"] }] });
    this.push(sessionId, { ...base, id: randomUUID(), sequence: 5, type: "run.completed", summary: "done" });
    return Promise.resolve(run);
  }
}

class BrokenDiscoveryAgent extends FakeAgent {
  override readonly id = "broken";
  override discover(): Promise<AgentDescriptor> {
    return Promise.reject(new AgentError("PROCESS_FAILED", "Child process exited with 1", this.id, true));
  }
}

describe("AgentManager", () => {
  it("registers a fake adapter and forwards its stream to a UI consumer", async () => {
    const manager = new AgentManager();
    manager.registry.register(new FakeAgent());
    const descriptors = await manager.discoverAll();
    expect(descriptors[0]?.displayName).toBe("Fake Agent");

    const session = await manager.startSession("fake", {
      conversationId: "conversation-1", projectId: "project-1", projectRoot: "/tmp/project",
    });
    const received: AgentEvent[] = [];
    const completed = new Promise<void>((resolve) => {
      manager.eventBus.subscribe((event) => {
        received.push(event);
        if (event.type === "run.completed") resolve();
      });
    });
    await manager.send(session.id, { text: "hello", projectRoot: "/tmp/project", mode: "execute" });
    await completed;

    expect(received.map((event) => event.type)).toEqual([
      "run.started", "message.delta", "run.completed",
    ]);
    expect(manager.sessions.get(session.id).status).toBe("completed");
    await manager.shutdown();
  });

  it("keeps one provider discovery failure from breaking the provider roster", async () => {
    const manager = new AgentManager(); manager.registry.register(new BrokenDiscoveryAgent());
    await expect(manager.discoverAll()).resolves.toMatchObject([{
      id: "broken", installed: true, available: false, authState: "error",
      warnings: ["Provider discovery failed: Child process exited with 1"],
    }]);
    await manager.shutdown();
  });

  it("fails unsupported controls before starting a provider run", async () => {
    const manager = new AgentManager();
    manager.registry.register(new FakeAgent());
    const session = await manager.startSession("fake", {
      conversationId: "conversation-1", projectId: "project-1", projectRoot: "/tmp/project",
    });
    await expect(manager.send(session.id, {
      text: "plan", projectRoot: "/tmp/project", mode: "plan",
    })).rejects.toBeInstanceOf(AgentCapabilityError);
    await manager.shutdown();
  });

  it("keeps pumping when a provider stacks two approvals and one event is unnormalizable", async () => {
    const manager = new AgentManager();
    const agent = new StackingAgent();
    manager.registry.register(agent);
    const seen: AgentEvent[] = [];
    manager.eventBus.subscribe((event) => seen.push(event));
    const session = await manager.startSession("stacking", {
      conversationId: "conversation-1", projectId: "project-1", projectRoot: "/tmp/project",
    });
    await manager.send(session.id, { text: "go", projectRoot: "/tmp/project", mode: "execute" });
    await vi.waitFor(() => { expect(seen.map((event) => event.type)).toContain("run.completed"); });
    // The second request used to be an illegal waiting_permission → waiting_permission transition, which threw
    // inside the pump and silently stranded every later event — including the run's own terminal one.
    expect(seen.map((event) => event.type)).toEqual([
      "run.started", "permission.requested", "question.requested", "question.resolved", "run.completed",
    ]);
    expect(manager.sessions.get(session.id).status).toBe("completed");
    await manager.shutdown();
  });

  it("restores provider-backed sessions and reconnects their event pump", async () => {
    const manager = new AgentManager(); manager.registry.register(new FakeAgent());
    const session = await manager.resumeSession("fake", { conversationId: "conversation-1", projectId: "project-1",
      projectRoot: "/tmp/project", providerSessionId: "provider-session-1" });
    expect(session.providerSessionId).toBe("provider-session-1");
    await manager.send(session.id, { text: "resumed", projectRoot: "/tmp/project", mode: "execute" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.sessions.get(session.id).status).toBe("completed");
    await manager.shutdown();
  });
});
