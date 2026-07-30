import { randomUUID } from "node:crypto";
import type {
  AgentEvent, AgentProfile, AppConversation, PermissionDecision, PermissionRequest, Project, StepAnnouncement,
} from "@waing/domain";
import type { SqliteDatabase } from "./SqliteDatabase";

export interface PersistedProject extends Project { realPath: string; createdAt: string; lastOpenedAt: string;
  preferredAgentId?: string; preferredRouterId?: string; permissionProfileId?: string }
export interface PersistedMessage { id: string; conversationId: string; role: "user" | "assistant" | "system" | "activity";
  content: string; createdAt: string }
export interface PersistedProviderSession { id: string; conversationId: string; agentId: string; providerSessionId?: string;
  status: string; payload: unknown; updatedAt: string }

export class PersistenceStore {
  constructor(private readonly database: SqliteDatabase) {}

  saveProject(project: PersistedProject): void {
    this.database.connection.prepare(`INSERT INTO projects(id,name,root,real_path,created_at,last_opened_at,preferred_agent_id,preferred_router_id,permission_profile_id)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,root=excluded.root,real_path=excluded.real_path,
      last_opened_at=excluded.last_opened_at,preferred_agent_id=excluded.preferred_agent_id,preferred_router_id=excluded.preferred_router_id,
      permission_profile_id=excluded.permission_profile_id`).run(project.id, project.name, project.root, project.realPath,
      project.createdAt, project.lastOpenedAt, project.preferredAgentId ?? null, project.preferredRouterId ?? null,
      project.permissionProfileId ?? null);
  }
  listProjects(): PersistedProject[] {
    const rows = this.database.connection.prepare("SELECT * FROM projects ORDER BY last_opened_at DESC").all() as Record<string, unknown>[];
    return rows.map((row) => ({ id: String(row.id), name: String(row.name), root: String(row.root), realPath: String(row.real_path),
      createdAt: String(row.created_at), lastOpenedAt: String(row.last_opened_at),
      ...(typeof row.preferred_agent_id === "string" ? { preferredAgentId: row.preferred_agent_id } : {}),
      ...(typeof row.preferred_router_id === "string" ? { preferredRouterId: row.preferred_router_id } : {}),
      ...(typeof row.permission_profile_id === "string" ? { permissionProfileId: row.permission_profile_id } : {}) }));
  }
  /**
   * Removes a project and the local history the UI reads for it. Dependants are deleted before their parents
   * because `PRAGMA foreign_keys` is on. Workflow run tables are left alone: they record no project column, so
   * there is no reliable link to follow. Nothing on the user's filesystem is touched.
   */
  removeProject(projectId: string): void {
    const conversationScope = "SELECT id FROM conversations WHERE project_id=?";
    const statements = [
      `DELETE FROM messages WHERE conversation_id IN (${conversationScope})`,
      `DELETE FROM provider_sessions WHERE conversation_id IN (${conversationScope})`,
      `DELETE FROM agent_events WHERE conversation_id IN (${conversationScope})`,
      "DELETE FROM permission_decisions WHERE project_id=?",
      "DELETE FROM conversations WHERE project_id=?",
      "DELETE FROM projects WHERE id=?",
    ];
    this.database.connection.exec("BEGIN");
    try {
      for (const statement of statements) this.database.connection.prepare(statement).run(projectId);
      this.database.connection.exec("COMMIT");
    } catch (cause) {
      this.database.connection.exec("ROLLBACK");
      throw cause;
    }
  }
  saveConversation(conversation: AppConversation): void {
    this.database.connection.prepare(`INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,updated_at=excluded.updated_at`).run(conversation.id, conversation.projectId,
      conversation.title, conversation.createdAt, conversation.updatedAt);
  }
  listConversations(projectId: string): AppConversation[] {
    return this.database.connection.prepare("SELECT id,project_id AS projectId,title,created_at AS createdAt,updated_at AS updatedAt FROM conversations WHERE project_id=? ORDER BY updated_at DESC")
      .all(projectId) as unknown as AppConversation[];
  }
  getConversation(conversationId: string): AppConversation | undefined {
    return this.database.connection.prepare("SELECT id,project_id AS projectId,title,created_at AS createdAt,updated_at AS updatedAt FROM conversations WHERE id=?")
      .get(conversationId) as unknown as AppConversation | undefined;
  }
  removeConversation(conversationId: string): void {
    const statements = ["DELETE FROM messages WHERE conversation_id=?", "DELETE FROM provider_sessions WHERE conversation_id=?",
      "DELETE FROM agent_events WHERE conversation_id=?",
      "DELETE FROM conversations WHERE id=?"];
    this.database.connection.exec("BEGIN");
    try {
      for (const statement of statements) this.database.connection.prepare(statement).run(conversationId);
      this.database.connection.exec("COMMIT");
    } catch (cause) {
      this.database.connection.exec("ROLLBACK");
      throw cause;
    }
  }
  saveProviderSession(session: { id: string; conversationId: string; agentId: string; providerSessionId?: string;
    status: string; payload: unknown; updatedAt: string }): void {
    this.database.connection.prepare(`INSERT INTO provider_sessions(id,conversation_id,agent_id,provider_session_id,status,payload_json,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider_session_id=excluded.provider_session_id,status=excluded.status,
      payload_json=excluded.payload_json,updated_at=excluded.updated_at`).run(session.id, session.conversationId, session.agentId,
      session.providerSessionId ?? null, session.status, JSON.stringify(session.payload), session.updatedAt);
  }
  listProviderSessions(conversationId?: string): PersistedProviderSession[] {
    const rows = (conversationId === undefined
      ? this.database.connection.prepare("SELECT * FROM provider_sessions ORDER BY updated_at DESC").all()
      : this.database.connection.prepare("SELECT * FROM provider_sessions WHERE conversation_id=? ORDER BY updated_at DESC").all(conversationId)) as Record<string, unknown>[];
    return rows.map((row) => ({ id: String(row.id), conversationId: String(row.conversation_id), agentId: String(row.agent_id),
      ...(typeof row.provider_session_id === "string" ? { providerSessionId: row.provider_session_id } : {}), status: String(row.status),
      payload: JSON.parse(String(row.payload_json)) as unknown, updatedAt: String(row.updated_at) }));
  }
  recoverInterruptedSessions(): number {
    const result = this.database.connection.prepare(`UPDATE provider_sessions SET status='failed',updated_at=?
      WHERE status IN ('starting','running','waiting_permission','cancelling')`).run(new Date().toISOString());
    return Number(result.changes);
  }
  saveMessage(message: PersistedMessage): void {
    this.database.connection.prepare("INSERT OR REPLACE INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)")
      .run(message.id, message.conversationId, message.role, message.content, message.createdAt);
  }
  listMessages(conversationId: string): PersistedMessage[] {
    return this.database.connection.prepare("SELECT id,conversation_id AS conversationId,role,content,created_at AS createdAt FROM messages WHERE conversation_id=? ORDER BY created_at")
      .all(conversationId) as unknown as PersistedMessage[];
  }
  /** Replays a conversation's stored activity in order. Deltas were never persisted, so this is the significant set. */
  listEvents(conversationId: string): AgentEvent[] {
    const rows = this.database.connection.prepare("SELECT payload_json FROM agent_events WHERE conversation_id=? ORDER BY created_at,rowid")
      .all(conversationId) as Record<string, unknown>[];
    return rows.map((row) => JSON.parse(String(row.payload_json)) as AgentEvent);
  }
  saveSignificantEvent(conversationId: string | undefined, event: AgentEvent): boolean {
    if (event.type === "message.delta" || event.type === "tool.progress" || event.type === "command.output") return false;
    this.database.connection.prepare("INSERT INTO agent_events(id,conversation_id,workflow_run_id,event_type,payload_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(event.id, conversationId ?? null, event.workflowRunId ?? null, event.type, JSON.stringify(event), event.timestamp);
    return true;
  }
  savePermission(projectId: string, request: PermissionRequest, decision: PermissionDecision): void {
    this.database.connection.prepare("INSERT INTO permission_decisions(id,project_id,session_id,request_id,decision,request_json,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(randomUUID(), projectId, request.sessionId, request.id, decision, JSON.stringify(request), new Date().toISOString());
  }
  saveAgentProfile(profile: AgentProfile): void {
    this.database.connection.prepare(`INSERT INTO agent_profiles(id,profile_json,position,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET profile_json=excluded.profile_json,position=excluded.position,updated_at=excluded.updated_at`)
      .run(profile.id, JSON.stringify(profile), profile.position, new Date().toISOString());
  }
  listAgentProfiles(): AgentProfile[] {
    const rows = this.database.connection.prepare("SELECT profile_json FROM agent_profiles ORDER BY position,id").all() as { profile_json: string }[];
    return rows.map((row) => JSON.parse(row.profile_json) as AgentProfile);
  }
  removeAgentProfile(id: string): void { this.database.connection.prepare("DELETE FROM agent_profiles WHERE id=?").run(id); }
  saveAnnouncement(announcement: StepAnnouncement): void {
    this.database.connection.prepare("INSERT OR REPLACE INTO workflow_announcements(step_run_id,workflow_run_id,announcement_json,created_at) VALUES(?,?,?,?)")
      .run(announcement.stepRunId, announcement.workflowRunId, JSON.stringify(announcement), announcement.createdAt);
  }
  recordEdge(workflowRunId: string, edge: { id: string; from: string; to: string }): void {
    this.database.connection.prepare("INSERT INTO workflow_edges_taken(id,workflow_run_id,edge_id,from_node_id,to_node_id,created_at) VALUES(?,?,?,?,?,?)")
      .run(randomUUID(), workflowRunId, edge.id, edge.from, edge.to, new Date().toISOString());
  }
  setSetting(key: string, value: unknown): void {
    this.database.connection.prepare("INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at")
      .run(key, JSON.stringify(value), new Date().toISOString());
  }
  getSetting<T>(key: string): T | undefined {
    const row = this.database.connection.prepare("SELECT value_json FROM settings WHERE key=?").get(key) as { value_json: string } | undefined;
    return row === undefined ? undefined : JSON.parse(row.value_json) as T;
  }
  saveProviderInstallation(providerId: string, payload: unknown): void {
    this.database.connection.prepare("INSERT INTO provider_installations(provider_id,payload_json,updated_at) VALUES(?,?,?) ON CONFLICT(provider_id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at")
      .run(providerId, JSON.stringify(payload), new Date().toISOString());
  }
  saveProviderHealth(providerId: string, payload: unknown): void {
    this.database.connection.prepare("INSERT INTO provider_health(provider_id,payload_json,checked_at) VALUES(?,?,?) ON CONFLICT(provider_id) DO UPDATE SET payload_json=excluded.payload_json,checked_at=excluded.checked_at")
      .run(providerId, JSON.stringify(payload), new Date().toISOString());
  }
}
