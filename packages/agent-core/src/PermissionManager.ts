import { AgentError } from "@waing/domain";
import type { PermissionDecision, PermissionRequest } from "@waing/domain";

export interface PermissionAuditEntry {
  request: PermissionRequest;
  projectId: string;
  decision: PermissionDecision;
  source: "user" | "remembered" | "session_closed";
  decidedAt: string;
}

interface PendingDecision {
  request: PermissionRequest;
  projectId: string;
  resolve: (decision: PermissionDecision) => void;
}

export class PermissionManager {
  private readonly pending = new Map<string, PendingDecision>();
  private readonly sessionRules = new Set<string>();
  private readonly historyEntries: PermissionAuditEntry[] = [];

  request(projectId: string, request: PermissionRequest): Promise<PermissionDecision> {
    if (this.pending.has(request.id)) {
      return Promise.reject(new AgentError("PROTOCOL_ERROR", `Duplicate permission request: ${request.id}`));
    }
    if (this.sessionRules.has(this.ruleKey(projectId, request))) {
      this.audit(request, projectId, "allow_session", "remembered");
      return Promise.resolve("allow_session");
    }
    return new Promise((resolve) => this.pending.set(request.id, { request, projectId, resolve }));
  }

  respond(requestId: string, decision: PermissionDecision, sessionId?: string): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) throw new AgentError("SESSION_NOT_FOUND", `Unknown permission request: ${requestId}`);
    if (sessionId !== undefined && pending.request.sessionId !== sessionId) {
      throw new AgentError("PERMISSION_DENIED", "Permission request does not belong to this session");
    }
    this.pending.delete(requestId);
    if (decision === "allow_session") this.sessionRules.add(this.ruleKey(pending.projectId, pending.request));
    this.audit(pending.request, pending.projectId, decision, "user");
    pending.resolve(decision);
  }

  closeSession(sessionId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.request.sessionId !== sessionId) continue;
      this.pending.delete(requestId);
      this.audit(pending.request, pending.projectId, "deny", "session_closed");
      pending.resolve("deny");
    }
    for (const rule of this.sessionRules) {
      if (rule.includes(`\u0000${sessionId}\u0000`)) this.sessionRules.delete(rule);
    }
  }

  closeAll(): void {
    const sessions = new Set([...this.pending.values()].map((pending) => pending.request.sessionId));
    for (const sessionId of sessions) this.closeSession(sessionId);
    this.sessionRules.clear();
  }

  get history(): readonly PermissionAuditEntry[] { return this.historyEntries; }
  get pendingCount(): number { return this.pending.size; }

  private ruleKey(projectId: string, request: PermissionRequest): string {
    const target = request.command?.join("\u0001") ?? request.paths?.join("\u0001") ?? request.kind;
    return `${projectId}\u0000${request.sessionId}\u0000${request.kind}\u0000${target}`;
  }

  private audit(
    request: PermissionRequest,
    projectId: string,
    decision: PermissionDecision,
    source: PermissionAuditEntry["source"],
  ): void {
    this.historyEntries.push({ request, projectId, decision, source, decidedAt: new Date().toISOString() });
  }
}
