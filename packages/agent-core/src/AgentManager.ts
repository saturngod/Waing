import { AgentCapabilityError, AgentError, agentEventSchema } from "@waing/domain";
import type { AgentDescriptor, AgentRequest, AgentRun, AgentSession, ResumeSessionInput, StartSessionInput } from "@waing/domain";
import type { PermissionDecision } from "@waing/domain";
import { AgentRegistry } from "./AgentRegistry";
import { EventBus } from "./EventBus";
import { SessionCoordinator } from "./SessionCoordinator";

export class AgentManager {
  private readonly pumps = new Map<string, Promise<void>>();
  private readonly runningSessions = new Set<string>();

  constructor(
    readonly registry = new AgentRegistry(),
    readonly eventBus = new EventBus(),
    readonly sessions = new SessionCoordinator(),
  ) {}

  async discoverAll(): Promise<AgentDescriptor[]> {
    return Promise.all(this.registry.list().map((agent) => agent.discover()));
  }

  async startSession(agentId: string, input: StartSessionInput): Promise<AgentSession> {
    const agent = this.registry.get(agentId);
    const session = await agent.startSession(input);
    this.sessions.add(session);
    this.startEventPump(agentId, session.id);
    return session;
  }

  async resumeSession(agentId: string, input: ResumeSessionInput): Promise<AgentSession> {
    const agent = this.registry.get(agentId);
    const descriptor = await agent.discover();
    if (!descriptor.capabilities.persistentSessions) throw new AgentCapabilityError(agent.id, "persistent sessions");
    const session = await agent.resumeSession(input);
    this.sessions.add(session); this.startEventPump(agentId, session.id);
    return session;
  }

  async send(sessionId: string, request: AgentRequest): Promise<AgentRun> {
    const session = this.sessions.get(sessionId);
    const agent = this.registry.get(session.agentId);
    const descriptor = await agent.discover();
    if (this.runningSessions.has(sessionId) && !descriptor.capabilities.concurrentRuns) {
      throw new AgentError("PROTOCOL_ERROR", "A run is already active in this session", agent.id, true);
    }
    if (request.mode === "plan" && !descriptor.capabilities.planMode) {
      throw new AgentCapabilityError(agent.id, "plan mode");
    }
    if (request.effort !== undefined && !descriptor.capabilities.effortControl) {
      throw new AgentCapabilityError(agent.id, "effort control");
    }

    this.runningSessions.add(sessionId);
    this.sessions.transition(sessionId, "running");
    try {
      return await agent.send(sessionId, request);
    } catch (error) {
      this.runningSessions.delete(sessionId);
      this.sessions.transition(sessionId, "failed");
      throw error;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.sessions.transition(sessionId, "cancelling");
    const agent = this.registry.get(session.agentId);
    const descriptor = await agent.discover();
    if (!descriptor.capabilities.cancellation) throw new AgentCapabilityError(agent.id, "cancellation");
    await agent.cancel(sessionId);
  }

  async respondToPermission(sessionId: string, requestId: string, decision: PermissionDecision): Promise<void> {
    const session = this.sessions.get(sessionId);
    await this.registry.get(session.agentId).respondToPermission(sessionId, requestId, decision);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(this.registry.list().map((agent) => agent.shutdown()));
  }

  private startEventPump(agentId: string, sessionId: string): void {
    if (this.pumps.has(sessionId)) return;
    const agent = this.registry.get(agentId);
    const pump = (async () => {
      for await (const rawEvent of agent.events(sessionId)) {
        const event = agentEventSchema.parse(rawEvent);
        this.eventBus.publish(event);
        if (event.type === "run.completed" || event.type === "run.failed") {
          this.runningSessions.delete(sessionId);
          this.sessions.transition(sessionId, event.type === "run.completed" ? "completed" : "failed");
        } else if (event.type === "permission.requested") {
          this.sessions.transition(sessionId, "waiting_permission");
        } else if (event.type === "permission.resolved") {
          this.sessions.transition(sessionId, "running");
        }
      }
    })().finally(() => this.pumps.delete(sessionId));
    this.pumps.set(sessionId, pump);
  }
}
