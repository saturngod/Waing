import { randomUUID } from "node:crypto";
import { AsyncQueue } from "@waing/agent-core";
import type { CodingAgent } from "@waing/agent-core";
import type {
  AgentCapabilities, AgentDescriptor, AgentEvent, AgentRequest, AgentRun, AgentSession,
  PermissionDecision, ResumeSessionInput, StartSessionInput,
} from "@waing/domain";

const capabilities: AgentCapabilities = {
  streaming: true, persistentSessions: true, cancellation: true, concurrentRuns: false,
  nativeStructuredOutput: false, planMode: true, effortControl: true,
  interactivePermissions: true, diffEvents: true, shellEvents: true, fileEvents: true,
  modelSelection: true, mcp: false, customTools: false, additionalDirectories: false,
};
type EventBaseKeys = "id" | "sessionId" | "runId" | "agentId" | "timestamp" | "sequence";
type EventPayload<T> = T extends unknown ? Omit<T, EventBaseKeys> : never;

export class FakeAgent implements CodingAgent {
  readonly id = "fake";
  private readonly queues = new Map<string, AsyncQueue<AgentEvent>>();
  private readonly pending = new Map<string, { sessionId: string; runId: string; text: string }>();

  discover(): Promise<AgentDescriptor> {
    return Promise.resolve({ id: this.id, displayName: "Fake Agent", installed: true, available: true,
      version: "1.0.0", capabilities, authState: "ready", warnings: [] });
  }
  listModels() { return Promise.resolve([{ agentId: this.id, modelId: "fake-1", displayName: "Fake 1", available: true }]); }
  startSession(input: StartSessionInput): Promise<AgentSession> {
    const now = new Date().toISOString();
    const session: AgentSession = { id: randomUUID(), conversationId: input.conversationId,
      agentId: this.id, projectId: input.projectId, createdAt: now, updatedAt: now, status: "idle" };
    this.queues.set(session.id, new AsyncQueue());
    return Promise.resolve(session);
  }
  resumeSession(input: ResumeSessionInput) { return this.startSession(input); }
  send(sessionId: string, request: AgentRequest): Promise<AgentRun> {
    const run = { id: randomUUID(), sessionId, startedAt: new Date().toISOString() };
    this.emit(sessionId, run.id, 0, { type: "run.started" });
    this.emit(sessionId, run.id, 1, { type: "message.delta", text: request.text });
    const requestId = randomUUID();
    this.pending.set(requestId, { sessionId, runId: run.id, text: request.text });
    this.emit(sessionId, run.id, 2, { type: "permission.requested", request: {
      id: requestId, sessionId, runId: run.id, agentId: this.id, kind: "shell",
      title: "Run fake command", detail: "npm test", risk: "medium", command: ["npm", "test"],
    } });
    return Promise.resolve(run);
  }
  cancel() { return Promise.resolve(); }
  respondToPermission(sessionId: string, requestId: string, decision: PermissionDecision) {
    const pending = this.pending.get(requestId);
    if (pending === undefined || pending.sessionId !== sessionId) return Promise.reject(new Error("Unknown fake approval"));
    this.pending.delete(requestId);
    this.emit(sessionId, pending.runId, 3, { type: "permission.resolved", requestId, decision });
    if (decision === "deny") this.emit(sessionId, pending.runId, 4,
      { type: "run.failed", code: "PERMISSION_DENIED", message: "Permission denied", retryable: false });
    else {
      this.emit(sessionId, pending.runId, 4, { type: "message.completed", text: pending.text });
      this.emit(sessionId, pending.runId, 5, { type: "run.completed", summary: "Fake run completed" });
    }
    return Promise.resolve();
  }
  closeSession(sessionId: string) { this.queues.get(sessionId)?.end(); return Promise.resolve(); }
  shutdown() { for (const queue of this.queues.values()) queue.end(); return Promise.resolve(); }
  events(sessionId: string): AsyncIterable<AgentEvent> { return this.queues.get(sessionId) ?? new AsyncQueue(); }

  private emit(sessionId: string, runId: string, sequence: number,
    payload: EventPayload<AgentEvent>): void {
    this.queues.get(sessionId)?.push({ id: randomUUID(), sessionId, runId, agentId: this.id,
      timestamp: new Date().toISOString(), sequence, ...payload });
  }
}
