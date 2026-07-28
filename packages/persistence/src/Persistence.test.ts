import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { AgentEvent, RoleExecutionProfile, WorkflowRole, WorkflowStepResult } from "@waing/domain";
import { WorkflowCompiler, WorkflowEngine } from "@waing/workflow";
import type { GlobalRoleProfiles, StepExecutionInput, WorkflowRouter, WorkflowStepExecutor } from "@waing/workflow";
import { MigrationRunner } from "./MigrationRunner";
import { PersistenceStore } from "./PersistenceStore";
import { SqliteDatabase } from "./SqliteDatabase";
import { SqliteWorkflowRepository } from "./SqliteWorkflowRepository";

const profiles = Object.fromEntries((["router", "planning", "low", "medium", "high", "review", "bugfix", "document"] as WorkflowRole[])
  .map((role) => [role, { role, enabled: true, agentId: role === "router" || role === "document" ? "opencode" : "codex",
    effort: "low", mode: role === "review" ? "review" : role === "planning" ? "plan" : "execute", permissionProfileId: "ask" } satisfies RoleExecutionProfile])) as GlobalRoleProfiles;

class PersistedFakeExecutor implements WorkflowStepExecutor {
  calls = 0;
  describe(profile: RoleExecutionProfile): Promise<{ agentDisplayName: string }> { return Promise.resolve({ agentDisplayName: profile.agentId }); }
  execute(input: StepExecutionInput): Promise<WorkflowStepResult> {
    this.calls += 1;
    return Promise.resolve({ stepRunId: input.stepRunId, nodeId: input.node.id, role: input.node.role,
      agentId: input.profile.agentId, status: "completed", summary: "Persisted fake result", filesRead: [],
      filesChanged: ["src/index.ts"], commandsRun: [], testsRun: [], artifacts: [{ id: `artifact-${input.stepRunId}`,
        kind: "report", path: "docs/report.md", createdByStepRunId: input.stepRunId }], reviewVerdict: "pass",
      findings: [{ id: `finding-${input.stepRunId}`, severity: "info", category: "documentation", title: "Documented",
        description: "History finding" }] });
  }
}
class PersistedFakeRouter implements WorkflowRouter {
  decideNext(): Promise<unknown> { return Promise.resolve({ action: "execute_low", statusIntent: { activity: "implementing" },
    rationale: "Small task", confidence: 0.99 }); }
}

describe("SQLite persistence", () => {
  it("reconstructs application and workflow history after a fresh database connection without replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "waing-persistence-")); const path = join(directory, "waing.sqlite");
    let database = new SqliteDatabase(path); let store = new PersistenceStore(database);
    const now = new Date().toISOString();
    store.saveProject({ id: "project-1", name: "Waing", root: "/tmp/waing", realPath: "/private/tmp/waing",
      createdAt: now, lastOpenedAt: now, preferredAgentId: "codex", preferredRouterId: "opencode", permissionProfileId: "ask" });
    store.saveConversation({ id: "conversation-1", projectId: "project-1", title: "Persistence", createdAt: now, updatedAt: now });
    store.saveProviderSession({ id: "session-1", conversationId: "conversation-1", agentId: "codex", providerSessionId: "thread-1",
      status: "running", payload: { resumable: true }, updatedAt: now });
    expect(store.recoverInterruptedSessions()).toBe(1);
    expect(store.listProviderSessions("conversation-1")).toMatchObject([{ id: "session-1", status: "failed",
      providerSessionId: "thread-1", payload: { resumable: true } }]);
    store.saveMessage({ id: "message-1", conversationId: "conversation-1", role: "user", content: "Persist this", createdAt: now });
    const significant: AgentEvent = { id: "event-1", sessionId: "session-1", runId: "run-1", agentId: "codex", timestamp: now,
      sequence: 0, type: "run.completed", summary: "done" };
    const delta: AgentEvent = { ...significant, id: "event-2", sequence: 1, type: "message.delta", text: "token" };
    expect(store.saveSignificantEvent("conversation-1", significant)).toBe(true);
    expect(store.saveSignificantEvent("conversation-1", delta)).toBe(false);
    const permissionRequest = { id: "permission-1", sessionId: "session-1", runId: "run-1", agentId: "codex",
      kind: "shell" as const, title: "Run tests", detail: "npm test", risk: "medium" as const };
    store.savePermission("project-1", permissionRequest, "allow_once");
    store.saveRoutingDecision("conversation-1", { complexity: "low", taskType: "testing", mode: "execute", effort: "low",
      confidence: 0.98, rationale: "Narrow test task" });
    store.saveRoutingRule({ id: "low", enabled: true, match: { complexity: "low" }, targetRole: "low", priority: 10 });
    for (const profile of Object.values(profiles)) store.saveRoleProfile("global", "default", profile);
    store.setSetting("theme", { value: "dark" });
    store.saveProviderInstallation("codex", { version: "0.145.0" });
    store.saveProviderHealth("codex", { healthy: true });

    const repository = new SqliteWorkflowRepository(database);
    const definition = new WorkflowCompiler().compilePreset("standard"); await repository.saveDefinition(definition);
    const executor = new PersistedFakeExecutor();
    const result = await new WorkflowEngine(repository, executor, new PersistedFakeRouter()).run({ definition, profiles,
      projectId: "project-1", projectRoot: "/tmp/waing", task: "Persist workflow" });
    expect(result.run.status).toBe("completed"); expect(executor.calls).toBe(1);
    result.context.loopState.review = { iteration: 2, maxIterations: 3 };
    await repository.saveContext(result.context);
    database.close();

    database = new SqliteDatabase(path); store = new PersistenceStore(database);
    const reopened = new SqliteWorkflowRepository(database);
    expect(store.listProjects()).toMatchObject([{ id: "project-1", preferredAgentId: "codex" }]);
    expect(store.listConversations("project-1")).toMatchObject([{ id: "conversation-1", title: "Persistence" }]);
    expect(store.listMessages("conversation-1")).toMatchObject([{ content: "Persist this" }]);
    expect(store.getSetting("theme")).toEqual({ value: "dark" });
    await expect(reopened.getDefinition(definition.id, 1)).resolves.toMatchObject({ id: definition.id, version: 1 });
    await expect(reopened.loadRun(result.run.id)).resolves.toMatchObject({ run: { status: "completed", workflowVersion: 1 },
      context: { completedNodeIds: ["low"], stateVersion: 1, loopState: { review: { iteration: 2, maxIterations: 3 } } } });
    const history = reopened.loadHistory(result.run.id);
    expect(history.steps).toMatchObject([{ nodeId: "low", summary: "Persisted fake result" }]);
    expect(history.routerDecisions).toHaveLength(1);
    expect(history.announcements.map((announcement) => announcement.nodeId)).toEqual(["router", "low"]);
    expect(history.edges.map((edge) => edge.edgeId)).toEqual(["route-low", "low-complete"]);
    const counts = Object.fromEntries(["provider_sessions", "agent_events", "permission_decisions", "routing_rules",
      "workflow_role_profiles", "workflow_loop_state", "workflow_artifacts", "workflow_reviews", "workflow_findings",
      "provider_installations", "provider_health"].map((table) => [table,
      Number((database.connection.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count)]));
    expect(counts).toMatchObject({ provider_sessions: 1, agent_events: 1, permission_decisions: 1, routing_rules: 1,
      workflow_role_profiles: 8, workflow_loop_state: 1, workflow_artifacts: 1, workflow_reviews: 1,
      workflow_findings: 1, provider_installations: 1, provider_health: 1 });
    expect((database.connection.prepare("SELECT COUNT(*) count FROM schema_migrations").get() as { count: number }).count).toBe(1);
    database.close();
  });

  it("removes a project with its dependent history and leaves other projects untouched", () => {
    const database = new SqliteDatabase(":memory:"); const store = new PersistenceStore(database);
    const now = new Date().toISOString();
    for (const id of ["project-1", "project-2"]) {
      store.saveProject({ id, name: id, root: `/tmp/${id}`, realPath: `/tmp/${id}`, createdAt: now, lastOpenedAt: now });
      store.saveConversation({ id: `conversation-${id}`, projectId: id, title: "Chat", createdAt: now, updatedAt: now });
      store.saveMessage({ id: `message-${id}`, conversationId: `conversation-${id}`, role: "user", content: "Hi", createdAt: now });
      store.saveProviderSession({ id: `session-${id}`, conversationId: `conversation-${id}`, agentId: "codex",
        status: "completed", payload: {}, updatedAt: now });
      store.saveSignificantEvent(`conversation-${id}`, { id: `event-${id}`, sessionId: `session-${id}`, runId: "run-1",
        agentId: "codex", timestamp: now, sequence: 0, type: "run.completed", summary: "done" });
      store.saveRoutingDecision(`conversation-${id}`, { complexity: "low", taskType: "testing", mode: "execute",
        effort: "low", confidence: 0.9, rationale: "Narrow task" });
      store.savePermission(id, { id: `permission-${id}`, sessionId: `session-${id}`, runId: "run-1", agentId: "codex",
        kind: "shell", title: "Run tests", detail: "npm test", risk: "medium" }, "allow_once");
    }

    store.removeProject("project-1");

    expect(store.listProjects().map((project) => project.id)).toEqual(["project-2"]);
    expect(store.listConversations("project-1")).toEqual([]);
    expect(store.listMessages("conversation-project-1")).toEqual([]);
    expect(store.listProviderSessions("conversation-project-1")).toEqual([]);
    const remaining = (table: string) =>
      Number((database.connection.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count);
    expect({ messages: remaining("messages"), sessions: remaining("provider_sessions"), events: remaining("agent_events"),
      routes: remaining("routing_decisions"), permissions: remaining("permission_decisions"),
      conversations: remaining("conversations") })
      .toEqual({ messages: 1, sessions: 1, events: 1, routes: 1, permissions: 1, conversations: 1 });
    expect(store.listConversations("project-2")).toMatchObject([{ id: "conversation-project-2" }]);
    database.close();
  });

  it("replays one conversation's stored activity and removes only that conversation", () => {
    const database = new SqliteDatabase(":memory:"); const store = new PersistenceStore(database);
    const now = new Date().toISOString();
    store.saveProject({ id: "project-1", name: "Waing", root: "/tmp/waing", realPath: "/tmp/waing", createdAt: now, lastOpenedAt: now });
    for (const id of ["kept", "dropped"]) {
      store.saveConversation({ id, projectId: "project-1", title: `Chat ${id}`, createdAt: now, updatedAt: now });
      store.saveMessage({ id: `message-${id}`, conversationId: id, role: "user", content: `Ask ${id}`, createdAt: now });
      store.saveSignificantEvent(id, { id: `run-${id}`, sessionId: `session-${id}`, runId: "run-1", agentId: "codex",
        timestamp: now, sequence: 0, type: "run.started" });
      store.saveSignificantEvent(id, { id: `done-${id}`, sessionId: `session-${id}`, runId: "run-1", agentId: "codex",
        timestamp: now, sequence: 1, type: "message.completed", text: `Answer for ${id}` });
    }

    expect(store.getConversation("kept")).toMatchObject({ id: "kept", projectId: "project-1" });
    expect(store.listEvents("kept").map((event) => event.type)).toEqual(["run.started", "message.completed"]);
    expect(store.listEvents("kept").at(-1)).toMatchObject({ type: "message.completed", text: "Answer for kept" });

    store.removeConversation("dropped");

    expect(store.getConversation("dropped")).toBeUndefined();
    expect(store.listEvents("dropped")).toEqual([]);
    expect(store.listMessages("dropped")).toEqual([]);
    expect(store.listConversations("project-1").map((conversation) => conversation.id)).toEqual(["kept"]);
    expect(store.listEvents("kept")).toHaveLength(2);
    database.close();
  });

  it("keeps workflow versions immutable and returns only the latest version in listings", async () => {
    const database = new SqliteDatabase(":memory:"); const repository = new SqliteWorkflowRepository(database);
    const first = new WorkflowCompiler().compilePreset("standard", "Original"); await repository.saveDefinition(first);
    await repository.saveDefinition({ ...first, name: "Mutated same version" });
    await repository.saveDefinition({ ...first, version: 2, name: "Version two", updatedAt: new Date(Date.now() + 1000).toISOString() });
    await expect(repository.getDefinition(first.id, 1)).resolves.toMatchObject({ name: "Original" });
    await expect(repository.listLatestDefinitions()).resolves.toMatchObject([{ version: 2, name: "Version two" }]);
    database.close();
  });

  it("creates a recoverable backup before a destructive numbered migration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "waing-migration-")); const path = join(directory, "migration.sqlite");
    const database = new DatabaseSync(path);
    new MigrationRunner(database, path, [{ version: 1, name: "base", sql: "CREATE TABLE sample(id TEXT PRIMARY KEY);" }]).run();
    new MigrationRunner(database, path, [{ version: 2, name: "destructive", destructive: true,
      sql: "ALTER TABLE sample ADD COLUMN value TEXT;" }]).run();
    expect(existsSync(`${path}.backup-before-v2`)).toBe(true);
    expect((database.prepare("SELECT COUNT(*) count FROM schema_migrations").get() as { count: number }).count).toBe(2);
    database.close();
  });
});
