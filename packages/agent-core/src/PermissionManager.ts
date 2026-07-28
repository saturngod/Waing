import { AgentError } from "@waing/domain";
import type { PermissionDecision, PermissionProfile, PermissionRequest } from "@waing/domain";

export interface PermissionAuditEntry {
  request: PermissionRequest;
  projectId: string;
  decision: PermissionDecision;
  source: "user" | "remembered" | "profile" | "session_closed";
  decidedAt: string;
}

export interface PermissionRequestOptions {
  /** The saved profile for whichever role is running; omitted means always ask. */
  profile?: PermissionProfile;
  /**
   * What "allow for session" is remembered against. A workflow opens a fresh provider session per step, so
   * scoping to the session that happened to ask would re-prompt for the same command at every handoff. Callers
   * pass the conversation instead, which is what the user means by "this session".
   */
  scopeId?: string;
}

interface PendingDecision {
  request: PermissionRequest;
  projectId: string;
  scopeId: string;
  resolve: (decision: PermissionDecision) => void;
}

/**
 * Decides a request from the profile alone, or returns undefined to put it in front of the user.
 *
 * `read_only` denies every kind, not just writes: each one is a side effect on the workspace or the network,
 * and a role the user marked read-only should fail loudly rather than shell out. `auto_edit` covers file writes
 * only — running commands stays a prompt, because a command can do far more than the edit it claims to make.
 */
function automaticDecision(profile: PermissionProfile,
  kind: PermissionRequest["kind"]): PermissionDecision | undefined {
  switch (profile) {
    case "autonomous": return "allow_once";
    case "auto_edit": return kind === "file_write" ? "allow_once" : undefined;
    case "read_only": return "deny";
    case "ask_before_changes": return undefined;
  }
}

export class PermissionManager {
  private readonly pending = new Map<string, PendingDecision>();
  private readonly sessionRules = new Set<string>();
  private readonly historyEntries: PermissionAuditEntry[] = [];

  request(projectId: string, request: PermissionRequest,
    options: PermissionRequestOptions = {}): Promise<PermissionDecision> {
    if (this.pending.has(request.id)) {
      return Promise.reject(new AgentError("PROTOCOL_ERROR", `Duplicate permission request: ${request.id}`));
    }
    const scopeId = options.scopeId ?? request.sessionId;
    const automatic = automaticDecision(options.profile ?? "ask_before_changes", request.kind);
    if (automatic !== undefined) {
      this.audit(request, projectId, automatic, "profile");
      return Promise.resolve(automatic);
    }
    if (this.sessionRules.has(this.ruleKey(projectId, scopeId, request))) {
      this.audit(request, projectId, "allow_session", "remembered");
      return Promise.resolve("allow_session");
    }
    return new Promise((resolve) => this.pending.set(request.id, { request, projectId, scopeId, resolve }));
  }

  respond(requestId: string, decision: PermissionDecision, sessionId?: string): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) throw new AgentError("SESSION_NOT_FOUND", `Unknown permission request: ${requestId}`);
    if (sessionId !== undefined && pending.request.sessionId !== sessionId) {
      throw new AgentError("PERMISSION_DENIED", "Permission request does not belong to this session");
    }
    this.pending.delete(requestId);
    if (decision === "allow_session") {
      this.sessionRules.add(this.ruleKey(pending.projectId, pending.scopeId, pending.request));
    }
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
    // Only rules this session itself scoped are dropped; a conversation-scoped rule outlives the step that made it.
    this.closeScope(sessionId);
  }

  /** Forgets every remembered rule for one scope — the conversation ending, or the user revoking it. */
  closeScope(scopeId: string): void {
    for (const rule of this.sessionRules) {
      if (rule.includes(`\u0000${scopeId}\u0000`)) this.sessionRules.delete(rule);
    }
  }

  closeAll(): void {
    const sessions = new Set([...this.pending.values()].map((pending) => pending.request.sessionId));
    for (const sessionId of sessions) this.closeSession(sessionId);
    this.sessionRules.clear();
  }

  get history(): readonly PermissionAuditEntry[] { return this.historyEntries; }
  get pendingCount(): number { return this.pending.size; }

  private ruleKey(projectId: string, scopeId: string, request: PermissionRequest): string {
    const target = request.command?.join("\u0001") ?? request.paths?.join("\u0001") ?? request.kind;
    return `${projectId}\u0000${scopeId}\u0000${request.kind}\u0000${target}`;
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
