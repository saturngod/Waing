import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AgentEvent, AgentProfile, AppConversation, ConversationMemory, Project } from "@waing/domain";
import { PersistenceStore } from "./PersistenceStore";
import { SqliteDatabase } from "./SqliteDatabase";
import { SqliteWorkflowRepository } from "./SqliteWorkflowRepository";
import { MigrationRunner } from "./MigrationRunner";
import { migrations } from "./migrations";

let database: SqliteDatabase | undefined;
afterEach(() => { database?.close(); database = undefined; });
const profile: AgentProfile = { id: "coder", name: "Coder", whereToUse: "Write code", enabled: true,
  agentId: "codex", effort: "medium", permissionProfileId: "auto_edit", position: 0 };

describe("agent persistence", () => {
  it("creates the new roster schema without fixed-role tables", () => {
    database = new SqliteDatabase(":memory:");
    const tables = database.connection.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name));
    expect(tables).toContain("agent_profiles");
    expect(tables).toContain("conversation_memory"); expect(tables).toContain("provider_session_lanes"); expect(tables).toContain("usage_records");
    expect(tables).not.toContain("workflow_role_profiles"); expect(tables).not.toContain("workflow_reviews");
  });
  it("upgrades a database that already applied the old v1 schema", () => {
    const legacy = new DatabaseSync(":memory:");
    legacy.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, 'initial_application_schema', '2026-07-27T00:00:00.000Z');
      CREATE TABLE workflow_role_profiles (scope TEXT, scope_id TEXT, role TEXT, profile_json TEXT, updated_at TEXT);
      CREATE TABLE routing_rules (id TEXT); CREATE TABLE routing_decisions (id TEXT);
      CREATE TABLE workflow_definitions (id TEXT); CREATE TABLE workflow_runs (id TEXT PRIMARY KEY);
      CREATE TABLE workflow_step_runs (step_run_id TEXT PRIMARY KEY, workflow_run_id TEXT, node_id TEXT, role TEXT, status TEXT, result_json TEXT);
      CREATE TABLE workflow_edges_taken (id TEXT); CREATE TABLE workflow_loop_state (workflow_run_id TEXT);
      CREATE TABLE workflow_announcements (step_run_id TEXT); CREATE TABLE workflow_artifacts (id TEXT);
      CREATE TABLE workflow_reviews (step_run_id TEXT); CREATE TABLE workflow_findings (id TEXT);`);
    new MigrationRunner(legacy, ":memory:", migrations).run();
    const columns = legacy.prepare("PRAGMA table_info(workflow_step_runs)").all().map((row) => String(row.name));
    expect(columns).toContain("agent_profile_id"); expect(columns).toContain("agent_name"); expect(columns).not.toContain("role");
    expect(legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_profiles'").get()).toBeDefined();
    legacy.close();
  });
  it("removes obsolete Responses API continuation state during upgrade", () => {
    const legacy = new DatabaseSync(":memory:");
    legacy.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, 'initial_application_schema', '2026-07-27T00:00:00.000Z');
      INSERT INTO schema_migrations VALUES (2, 'replace_fixed_roles_with_agent_profiles', '2026-07-27T00:00:00.000Z');
      INSERT INTO schema_migrations VALUES (3, 'conversation_memory_session_lanes_and_usage', '2026-07-27T00:00:00.000Z');
      INSERT INTO schema_migrations VALUES (4, 'codex_responses_continuations', '2026-07-27T00:00:00.000Z');
      CREATE TABLE conversations (id TEXT PRIMARY KEY);
      INSERT INTO conversations VALUES ('conversation');
      CREATE TABLE codex_response_chains (conversation_id TEXT PRIMARY KEY, response_id TEXT, memory_revision INTEGER NOT NULL,
        status TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO codex_response_chains VALUES ('conversation', 'resp-old', 2, 'ready', '2026-07-27T00:00:00.000Z');`);
    new MigrationRunner(legacy, ":memory:", migrations).run();
    expect(legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='codex_conversations'").get()).toBeUndefined();
    expect(legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='codex_response_chains'").get()).toBeUndefined();
    legacy.close();
  });
  it("saves, orders, and removes agent profiles", () => {
    database = new SqliteDatabase(":memory:"); const store = new PersistenceStore(database);
    store.saveAgentProfile(profile); store.saveAgentProfile({ ...profile, id: "planner", name: "Planner", position: 1 });
    expect(store.listAgentProfiles().map((item) => item.id)).toEqual(["coder", "planner"]);
    store.removeAgentProfile("coder"); expect(store.listAgentProfiles().map((item) => item.id)).toEqual(["planner"]);
  });
  it("persists agent identity on workflow steps", async () => {
    database = new SqliteDatabase(":memory:"); const repository = new SqliteWorkflowRepository(database); const now = new Date().toISOString();
    await repository.saveRun({ id: "run", workflowId: "adaptive", workflowVersion: 1, status: "created", createdAt: now, updatedAt: now });
    await repository.saveStepResult("run", { stepRunId: "step", nodeId: "coder", agentProfileId: "coder", agentName: "Coder",
      agentId: "codex", status: "completed", summary: "done", filesRead: [], filesChanged: [], commandsRun: [], testsRun: [] });
    expect(repository.loadHistory("run").steps[0]).toMatchObject({ agentProfileId: "coder", agentName: "Coder" });
  });
  it("persists bounded conversation memory, session lanes, and usage records", () => {
    database = new SqliteDatabase(":memory:"); const store = new PersistenceStore(database);
    const now = new Date().toISOString();
    const project: Project = { id: "project", name: "Project", root: "/tmp/project" };
    const conversation: AppConversation = { id: "conversation", projectId: project.id, title: "Task", orchestrationMode: "codex", createdAt: now, updatedAt: now };
    store.saveProject({ ...project, realPath: project.root, createdAt: now, lastOpenedAt: now }); store.saveConversation(conversation);
    expect(store.getConversation(conversation.id)).toMatchObject({ orchestrationMode: "codex" });
    const memory: ConversationMemory = { conversationId: conversation.id, version: 1, revision: 1, objective: "Ship the task",
      requirements: [], constraints: [], planItems: [], decisions: ["Use the existing adapter"], completedWork: ["Inspected the project"],
      changedFiles: ["src/index.ts"], openQuestions: [], unresolvedIssues: [], stepSummaries: [], updatedAt: now };
    store.saveConversationMemory(memory); expect(store.getConversationMemory(conversation.id)).toEqual(memory);
    store.saveSessionLane({ conversationId: conversation.id, laneKey: "lane", agentId: "codex", providerSessionId: "thread-1", memoryRevision: 1, updatedAt: now });
    expect(store.getSessionLane(conversation.id, "lane")).toMatchObject({ agentId: "codex", providerSessionId: "thread-1" });
    const event: AgentEvent = { id: "usage-1", sessionId: "session", runId: "run", agentId: "codex", timestamp: now, sequence: 1,
      type: "usage.updated", inputTokens: 100, outputTokens: 20 };
    store.saveUsageRecord({ event, conversationId: conversation.id, workflowRunId: "workflow", scope: "worker" });
    expect(store.listUsageRecords(conversation.id)).toMatchObject([{ id: "usage-1", scope: "worker", inputTokens: 100, outputTokens: 20 }]);
    store.removeConversation(conversation.id);
    expect(store.getConversationMemory(conversation.id)).toBeUndefined(); expect(store.listSessionLanes(conversation.id)).toEqual([]);
    expect(store.listUsageRecords(conversation.id)).toEqual([]);
  });
});
