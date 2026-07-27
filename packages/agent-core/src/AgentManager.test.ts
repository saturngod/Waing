import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
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
import { AgentCapabilityError } from "@waing/domain";
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
  readonly id = "fake";
  private readonly queues = new Map<string, AsyncQueue<AgentEvent>>();
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
