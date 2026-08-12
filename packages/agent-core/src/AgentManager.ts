import { AgentCapabilityError, AgentError, agentEventSchema } from "@waing/domain";
import type { AgentDescriptor, AgentEvent, AgentRequest, AgentRun, AgentSession, AgentSessionStatus, ResumeSessionInput, StartSessionInput } from "@waing/domain";
import type { AgentQuestionResponse, PermissionDecision, PermissionProfile } from "@waing/domain";
import { AgentRegistry } from "./AgentRegistry";
import { EventBus } from "./EventBus";
import { SessionCoordinator } from "./SessionCoordinator";

/** The session status each normalized event reports; every other event leaves the status untouched. */
const PUMP_STATUS: Partial<Record<AgentEvent["type"], AgentSessionStatus>> = {
  "run.completed": "completed", "run.failed": "failed",
  "permission.requested": "waiting_permission", "question.requested": "waiting_permission",
  "permission.resolved": "running", "question.resolved": "running",
};

export class AgentManager {
  private readonly pumps = new Map<string, Promise<void>>();
  private readonly runningSessions = new Set<string>();
  /**
   * Which saved permission profile governs each session. A permission request arrives with nothing but a session
   * id, so whoever answers it — the main process — needs this to know which role's rule to apply.
   */
  private readonly permissionProfiles = new Map<string, PermissionProfile>();

  constructor(
    readonly registry = new AgentRegistry(),
    readonly eventBus = new EventBus(),
    readonly sessions = new SessionCoordinator(),
  ) {}

  async discoverAll(): Promise<AgentDescriptor[]> {
    return Promise.all(this.registry.list().map(async (agent) => {
      try { return await agent.discover(); }
      catch (cause) { return unavailableDescriptor(agent.id, cause); }
    }));
  }

  async startSession(agentId: string, input: StartSessionInput,
    permissionProfile?: PermissionProfile): Promise<AgentSession> {
    const agent = this.registry.get(agentId);
    const session = await agent.startSession(input);
    this.sessions.add(session);
    if (permissionProfile !== undefined) this.permissionProfiles.set(session.id, permissionProfile);
    this.startEventPump(agentId, session.id);
    return session;
  }

  async resumeSession(agentId: string, input: ResumeSessionInput,
    permissionProfile?: PermissionProfile): Promise<AgentSession> {
    const agent = this.registry.get(agentId);
    const descriptor = await agent.discover();
    if (!descriptor.capabilities.persistentSessions) throw new AgentCapabilityError(agent.id, "persistent sessions");
    const session = await agent.resumeSession(input);
    this.sessions.add(session);
    if (permissionProfile !== undefined) this.permissionProfiles.set(session.id, permissionProfile);
    this.startEventPump(agentId, session.id);
    return session;
  }

  /** The profile the session was opened with, or undefined when nothing set one and the user must be asked. */
  permissionProfileFor(sessionId: string): PermissionProfile | undefined {
    return this.permissionProfiles.get(sessionId);
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

  async respondToQuestion(sessionId: string, questionId: string, answers: AgentQuestionResponse): Promise<void> {
    const session = this.sessions.get(sessionId);
    const agent = this.registry.get(session.agentId);
    if (agent.respondToQuestion === undefined) {
      throw new AgentError("PROTOCOL_ERROR", `${agent.id} cannot answer questions`, agent.id);
    }
    await agent.respondToQuestion(sessionId, questionId, answers);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(this.registry.list().map((agent) => agent.shutdown()));
  }

  private startEventPump(agentId: string, sessionId: string): void {
    if (this.pumps.has(sessionId)) return;
    const agent = this.registry.get(agentId);
    const pump = (async () => {
      for await (const rawEvent of agent.events(sessionId)) {
        // Neither an unnormalizable event nor stale status bookkeeping may end this loop. Ending it strands
        // the run: no approval, question, or terminal event reaches the app again, and the only thing that
        // eventually notices is the workflow step timeout.
        const parsed = agentEventSchema.safeParse(rawEvent);
        if (!parsed.success) continue;
        const event = parsed.data;
        this.eventBus.publish(event);
        if (event.type === "run.completed" || event.type === "run.failed") this.runningSessions.delete(sessionId);
        const status = PUMP_STATUS[event.type];
        if (status === undefined) continue;
        try { this.sessions.transition(sessionId, status); } catch { /* status is a report, not a gate */ }
      }
    })().finally(() => this.pumps.delete(sessionId));
    this.pumps.set(sessionId, pump);
  }
}

const EMPTY_CAPABILITIES: AgentDescriptor["capabilities"] = {
  streaming: false, persistentSessions: false, cancellation: false, concurrentRuns: false,
  nativeStructuredOutput: false, planMode: false, effortControl: false, interactivePermissions: false,
  diffEvents: false, shellEvents: false, fileEvents: false, modelSelection: false, mcp: false,
  customTools: false, additionalDirectories: false,
};

function unavailableDescriptor(agentId: string, cause: unknown): AgentDescriptor {
  const missing = cause instanceof AgentError && cause.code === "NOT_INSTALLED";
  const reason = cause instanceof Error ? cause.message : "Provider discovery failed";
  const displayNames: Record<string, string> = {
    codex: "Codex", claude: "Claude Code", antigravity: "Antigravity", opencode: "OpenCode",
  };
  return { id: agentId, displayName: displayNames[agentId] ?? agentId, installed: !missing, available: false,
    capabilities: EMPTY_CAPABILITIES, authState: missing ? "missing" : "error",
    warnings: [`Provider discovery failed: ${reason}`] };
}
