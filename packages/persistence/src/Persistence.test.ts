import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AgentProfile } from "@waing/domain";
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
});
