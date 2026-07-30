import {
  routerDecisionRecordSchema, stepAnnouncementSchema, workflowContextSchema, workflowDefinitionSchema,
  workflowRunStatusSchema, workflowStepResultSchema,
} from "@waing/domain";
import type {
  RouterDecisionRecord, StepAnnouncement, WorkflowContext, WorkflowDefinition, WorkflowRun, WorkflowStepResult,
} from "@waing/domain";
import type { WorkflowRepository } from "@waing/workflow";
import type { SqliteDatabase } from "./SqliteDatabase";

export interface PersistedWorkflowHistory {
  steps: WorkflowStepResult[];
  routerDecisions: RouterDecisionRecord[];
  announcements: StepAnnouncement[];
  edges: Array<{ edgeId: string; from: string; to: string }>;
}

export class SqliteWorkflowRepository implements WorkflowRepository {
  constructor(private readonly database: SqliteDatabase) {}

  saveDefinition(definition: WorkflowDefinition): Promise<void> {
    const value = workflowDefinitionSchema.parse(definition);
    this.database.connection.prepare(`INSERT INTO workflow_definitions(id,version,name,definition_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(id,version) DO NOTHING`).run(value.id, value.version, value.name, JSON.stringify(value),
      value.createdAt, value.updatedAt);
    return Promise.resolve();
  }
  getDefinition(id: string, version: number): Promise<WorkflowDefinition | undefined> {
    const row = this.database.connection.prepare("SELECT definition_json FROM workflow_definitions WHERE id=? AND version=?")
      .get(id, version) as { definition_json: string } | undefined;
    return Promise.resolve(row === undefined ? undefined : workflowDefinitionSchema.parse(JSON.parse(row.definition_json)));
  }
  listLatestDefinitions(): Promise<WorkflowDefinition[]> {
    const rows = this.database.connection.prepare(`SELECT d.definition_json FROM workflow_definitions d JOIN
      (SELECT id, MAX(version) version FROM workflow_definitions GROUP BY id) latest ON latest.id=d.id AND latest.version=d.version
      ORDER BY d.updated_at DESC`).all() as Array<{ definition_json: string }>;
    return Promise.resolve(rows.map((row) => workflowDefinitionSchema.parse(JSON.parse(row.definition_json))));
  }
  saveRun(run: WorkflowRun): Promise<void> {
    this.database.connection.prepare(`INSERT INTO workflow_runs(id,workflow_id,workflow_version,status,summary,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,summary=excluded.summary,updated_at=excluded.updated_at`)
      .run(run.id, run.workflowId, run.workflowVersion, run.status, run.summary ?? null, run.createdAt, run.updatedAt);
    return Promise.resolve();
  }
  saveContext(context: WorkflowContext): Promise<void> {
    const value = workflowContextSchema.parse(context);
    this.database.connection.prepare("UPDATE workflow_runs SET context_json=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(value), new Date().toISOString(), value.workflowRunId);
    const replaceLoop = this.database.connection.prepare(`INSERT INTO workflow_loop_state(workflow_run_id,loop_id,iteration,max_iterations)
      VALUES(?,?,?,?) ON CONFLICT(workflow_run_id,loop_id) DO UPDATE SET iteration=excluded.iteration,max_iterations=excluded.max_iterations`);
    for (const [loopId, state] of Object.entries(value.loopState)) replaceLoop.run(value.workflowRunId, loopId, state.iteration, state.maxIterations);
    return Promise.resolve();
  }
  saveStepResult(workflowRunId: string, result: WorkflowStepResult): Promise<void> {
    const value = workflowStepResultSchema.parse(result);
    this.database.connection.prepare(`INSERT OR REPLACE INTO workflow_step_runs(step_run_id,workflow_run_id,node_id,agent_profile_id,agent_name,status,result_json)
      VALUES(?,?,?,?,?,?,?)`).run(value.stepRunId, workflowRunId, value.nodeId, value.agentProfileId, value.agentName, value.status, JSON.stringify(value));
    return Promise.resolve();
  }
  saveRouterDecision(record: RouterDecisionRecord): Promise<void> {
    const value = routerDecisionRecordSchema.parse(record);
    void value;
    return Promise.resolve();
  }
  saveAnnouncement(announcement: StepAnnouncement): Promise<void> {
    const value = stepAnnouncementSchema.parse(announcement);
    this.database.connection.prepare(`INSERT OR REPLACE INTO workflow_announcements(step_run_id,workflow_run_id,announcement_json,created_at)
      VALUES(?,?,?,?)`).run(value.stepRunId, value.workflowRunId, JSON.stringify(value), value.createdAt);
    return Promise.resolve();
  }
  saveEdgeTaken(workflowRunId: string, edge: { id: string; from: string; to: string }): Promise<void> {
    this.database.connection.prepare(`INSERT INTO workflow_edges_taken(id,workflow_run_id,edge_id,from_node_id,to_node_id,created_at)
      VALUES(?,?,?,?,?,?)`).run(randomUUID(), workflowRunId, edge.id, edge.from, edge.to, new Date().toISOString());
    return Promise.resolve();
  }
  loadRun(id: string): Promise<{ run: WorkflowRun; context: WorkflowContext } | undefined> {
    const row = this.database.connection.prepare("SELECT * FROM workflow_runs WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (row === undefined || typeof row.context_json !== "string") return Promise.resolve(undefined);
    const run: WorkflowRun = { id: String(row.id), workflowId: String(row.workflow_id), workflowVersion: Number(row.workflow_version),
      status: workflowRunStatusSchema.parse(row.status), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      ...(typeof row.summary === "string" ? { summary: row.summary } : {}) };
    return Promise.resolve({ run, context: workflowContextSchema.parse(JSON.parse(row.context_json)) });
  }
  loadHistory(workflowRunId: string): PersistedWorkflowHistory {
    const stepRows = this.database.connection.prepare("SELECT result_json FROM workflow_step_runs WHERE workflow_run_id=? ORDER BY rowid")
      .all(workflowRunId) as Array<{ result_json: string }>;
    const announcementRows = this.database.connection.prepare("SELECT announcement_json FROM workflow_announcements WHERE workflow_run_id=? ORDER BY created_at")
      .all(workflowRunId) as Array<{ announcement_json: string }>;
    const edges = this.database.connection.prepare(`SELECT edge_id AS edgeId,from_node_id AS "from",to_node_id AS "to"
      FROM workflow_edges_taken WHERE workflow_run_id=? ORDER BY created_at`).all(workflowRunId) as unknown as PersistedWorkflowHistory["edges"];
    return { steps: stepRows.map((row) => workflowStepResultSchema.parse(JSON.parse(row.result_json))),
      routerDecisions: [],
      announcements: announcementRows.map((row) => stepAnnouncementSchema.parse(JSON.parse(row.announcement_json))), edges };
  }
}
import { randomUUID } from "node:crypto";
