import { AgentError } from "@waing/domain";
import type { AgentSession, AgentSessionStatus } from "@waing/domain";

const allowedTransitions: Record<AgentSessionStatus, ReadonlySet<AgentSessionStatus>> = {
  idle: new Set(["starting", "running", "completed", "failed"]),
  starting: new Set(["idle", "running", "failed"]),
  running: new Set(["waiting_permission", "cancelling", "completed", "failed"]),
  waiting_permission: new Set(["running", "cancelling", "failed"]),
  cancelling: new Set(["completed", "failed"]),
  completed: new Set(["starting", "running"]),
  failed: new Set(["starting", "running"]),
};

export class SessionCoordinator {
  private readonly sessions = new Map<string, AgentSession>();

  add(session: AgentSession): void {
    this.sessions.set(session.id, session);
  }

  get(sessionId: string): AgentSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new AgentError("SESSION_NOT_FOUND", `Unknown session: ${sessionId}`);
    return session;
  }

  transition(sessionId: string, status: AgentSessionStatus): AgentSession {
    const current = this.get(sessionId);
    if (!allowedTransitions[current.status].has(status)) {
      throw new AgentError("PROTOCOL_ERROR", `Invalid session transition ${current.status} → ${status}`, current.agentId);
    }
    const updated = { ...current, status, updatedAt: new Date().toISOString() };
    this.sessions.set(sessionId, updated);
    return updated;
  }
}
