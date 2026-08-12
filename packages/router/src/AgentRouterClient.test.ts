import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AgentManager, AsyncQueue } from "@waing/agent-core";
import type { CodingAgent } from "@waing/agent-core";
import type {
  AgentCapabilities, AgentDescriptor, AgentEvent, AgentRequest, AgentRun, AgentSession, ResumeSessionInput,
  StartSessionInput,
} from "@waing/domain";
import { AgentRouterClient } from "./AgentRouterClient";

const capabilities = (overrides: Partial<AgentCapabilities> = {}): AgentCapabilities => ({
  streaming: true, persistentSessions: false, cancellation: true, concurrentRuns: false, nativeStructuredOutput: false,
  planMode: false, effortControl: false, interactivePermissions: false, diffEvents: false, shellEvents: false,
  fileEvents: false, modelSelection: false, mcp: false, customTools: false, additionalDirectories: false, ...overrides,
});

class RoutingAgent implements CodingAgent {
  readonly requests: AgentRequest[] = [];
  readonly closed: string[] = [];
  readonly resumed: string[] = [];
  private readonly queues = new Map<string, AsyncQueue<AgentEvent>>();
  private sequence = 0;
  constructor(readonly id: string, private readonly reply: string, private readonly caps = capabilities()) {}

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
  async resumeSession(input: ResumeSessionInput): Promise<AgentSession> {
    this.resumed.push(input.providerSessionId);
    return { ...await this.startSession(input), providerSessionId: input.providerSessionId };
  }
  send(sessionId: string, request: AgentRequest): Promise<AgentRun> {
    this.requests.push(request);
    const run = { id: randomUUID(), sessionId, startedAt: new Date().toISOString() };
    this.emit(sessionId, run.id, { type: "message.delta", text: this.reply });
    this.emit(sessionId, run.id, { type: "run.completed", summary: "routed" });
    return Promise.resolve(run);
  }
  cancel() { return Promise.resolve(); }
  respondToPermission() { return Promise.resolve(); }
  closeSession(sessionId: string) { this.closed.push(sessionId); this.queues.get(sessionId)?.end(); return Promise.resolve(); }
  shutdown() { for (const queue of this.queues.values()) queue.end(); return Promise.resolve(); }
  events(sessionId: string): AsyncIterable<AgentEvent> { return this.queues.get(sessionId) ?? new AsyncQueue(); }

  private emit(sessionId: string, runId: string, payload: { type: "message.delta"; text: string } | { type: "run.completed"; summary: string }): void {
    this.queues.get(sessionId)?.push({ id: randomUUID(), sessionId, runId, agentId: this.id,
      timestamp: new Date().toISOString(), sequence: this.sequence++, ...payload });
  }
}

function manager(agent: CodingAgent): AgentManager {
  const agents = new AgentManager(); agents.registry.register(agent); return agents;
}

describe("AgentRouterClient", () => {
  it("routes through the configured provider, reports its session, and closes it", async () => {
    const agent = new RoutingAgent("antigravity", '```json\n{"action":"complete"}\n```');
    const agents = manager(agent);
    const seen: string[] = [];
    const client = new AgentRouterClient({ agents, agentId: "antigravity", projectId: "p", projectRoot: "/tmp",
      model: "default", onSession: (sessionId) => seen.push(sessionId) });

    await expect(client.classify("classify this")).resolves.toEqual({ action: "complete" });
    expect(client.id).toBe("antigravity-router");
    expect(seen).toHaveLength(1);
    expect(agent.closed).toEqual(seen);
    // Without model selection or plan mode the routing request must not ask for either.
    expect(agent.requests[0]).toMatchObject({ mode: "execute" });
    expect(agent.requests[0]?.model).toBeUndefined();
  });

  it("uses plan mode and the configured model when the provider supports them", async () => {
    const agent = new RoutingAgent("codex", '{"action":"review"}', capabilities({ planMode: true, modelSelection: true, effortControl: true }));
    const client = new AgentRouterClient({ agents: manager(agent), agentId: "codex", projectId: "p",
      projectRoot: "/tmp", model: "gpt-5-codex", effort: "high" });
    await expect(client.classify("classify")).resolves.toEqual({ action: "review" });
    expect(agent.requests[0]).toMatchObject({ mode: "plan", model: "gpt-5-codex", effort: "high" });
  });

  it("resumes and updates a provider thread shared with workflow roles", async () => {
    const agent = new RoutingAgent("codex", '{"action":"complete"}', capabilities({ persistentSessions: true }));
    let providerSessionId: string | undefined = "thread-1";
    const client = new AgentRouterClient({ agents: manager(agent), agentId: "codex", projectId: "p", projectRoot: "/tmp",
      conversationId: "conversation-1", sharedProviderSession: {
        get: () => providerSessionId, set: (next) => { providerSessionId = next; },
      } });
    await expect(client.classify("classify")).resolves.toEqual({ action: "complete" });
    expect(agent.resumed).toEqual(["thread-1"]);
    expect(providerSessionId).toBe("thread-1");
  });

  it("reports non-JSON answers as a retryable router error", async () => {
    const client = new AgentRouterClient({ agents: manager(new RoutingAgent("codex", "I cannot help with that")),
      agentId: "codex", projectId: "p", projectRoot: "/tmp" });
    await expect(client.classify("classify")).rejects.toMatchObject({ code: "ROUTER_INVALID_OUTPUT", retryable: true });
  });
});
