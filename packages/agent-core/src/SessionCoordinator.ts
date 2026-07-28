import { AgentError } from "@waing/domain";
import type { AgentSession, AgentSessionStatus } from "@waing/domain";

/**
 * Self-transitions are always legal: providers request several approvals at once (two tool calls in one
 * assistant message, or a question raised while another approval is parked), so waiting_permission is
 * entered again before it is left. A run can also finish while a request is still outstanding — the provider
 * ends the turn and the pending request is released — so waiting_permission reaches the terminal states too.
 */
const allowedTransitions: Record<AgentSessionStatus, ReadonlySet<AgentSessionStatus>> = {
  idle: new Set(["idle", "starting", "running", "completed", "failed"]),
  starting: new Set(["starting", "idle", "running", "failed"]),
  running: new Set(["running", "waiting_permission", "cancelling", "completed", "failed"]),
  waiting_permission: new Set(["waiting_permission", "running", "cancelling", "completed", "failed"]),
  cancelling: new Set(["cancelling", "completed", "failed"]),
  completed: new Set(["completed", "starting", "running"]),
  failed: new Set(["failed", "starting", "running"]),
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
