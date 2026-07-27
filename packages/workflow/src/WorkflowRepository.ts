import type { RouterDecisionRecord, StepAnnouncement, WorkflowContext, WorkflowDefinition, WorkflowRun, WorkflowStepResult } from "@waing/domain";

export interface WorkflowDefinitionRepository {
  saveDefinition(definition: WorkflowDefinition): Promise<void>;
  getDefinition(id: string, version: number): Promise<WorkflowDefinition | undefined>;
  listLatestDefinitions(): Promise<WorkflowDefinition[]>;
}
export interface WorkflowRunRepository {
  saveRun(run: WorkflowRun): Promise<void>;
  saveContext(context: WorkflowContext): Promise<void>;
  saveStepResult(workflowRunId: string, result: WorkflowStepResult): Promise<void>;
  saveRouterDecision(record: RouterDecisionRecord): Promise<void>;
  saveAnnouncement?(announcement: StepAnnouncement): Promise<void>;
  saveEdgeTaken?(workflowRunId: string, edge: { id: string; from: string; to: string }): Promise<void>;
  loadRun(id: string): Promise<{ run: WorkflowRun; context: WorkflowContext } | undefined>;
}
export interface WorkflowRepository extends WorkflowDefinitionRepository, WorkflowRunRepository {}

export class InMemoryWorkflowRepository implements WorkflowRepository {
  private readonly definitions = new Map<string, WorkflowDefinition>();
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly contexts = new Map<string, WorkflowContext>();
  readonly stepResults: WorkflowStepResult[] = [];
  readonly routerDecisions: RouterDecisionRecord[] = [];
  readonly announcements: StepAnnouncement[] = [];
  readonly edgesTaken: Array<{ workflowRunId: string; id: string; from: string; to: string }> = [];
  saveDefinition(definition: WorkflowDefinition): Promise<void> {
    this.definitions.set(`${definition.id}@${String(definition.version)}`, structuredClone(definition)); return Promise.resolve();
  }
  getDefinition(id: string, version: number): Promise<WorkflowDefinition | undefined> {
    const value = this.definitions.get(`${id}@${String(version)}`); return Promise.resolve(value === undefined ? undefined : structuredClone(value));
  }
  listLatestDefinitions(): Promise<WorkflowDefinition[]> {
    const latest = new Map<string, WorkflowDefinition>();
    for (const definition of this.definitions.values()) if ((latest.get(definition.id)?.version ?? 0) < definition.version) latest.set(definition.id, definition);
    return Promise.resolve([...latest.values()].map((value) => structuredClone(value)));
  }
  saveRun(run: WorkflowRun): Promise<void> { this.runs.set(run.id, structuredClone(run)); return Promise.resolve(); }
  saveContext(context: WorkflowContext): Promise<void> { this.contexts.set(context.workflowRunId, structuredClone(context)); return Promise.resolve(); }
  saveStepResult(_workflowRunId: string, result: WorkflowStepResult): Promise<void> { this.stepResults.push(structuredClone(result)); return Promise.resolve(); }
  saveRouterDecision(record: RouterDecisionRecord): Promise<void> { this.routerDecisions.push(structuredClone(record)); return Promise.resolve(); }
  saveAnnouncement(announcement: StepAnnouncement): Promise<void> { this.announcements.push(structuredClone(announcement)); return Promise.resolve(); }
  saveEdgeTaken(workflowRunId: string, edge: { id: string; from: string; to: string }): Promise<void> {
    this.edgesTaken.push({ workflowRunId, ...edge }); return Promise.resolve();
  }
  loadRun(id: string): Promise<{ run: WorkflowRun; context: WorkflowContext } | undefined> {
    const run = this.runs.get(id); const context = this.contexts.get(id);
    return Promise.resolve(run === undefined || context === undefined ? undefined
      : { run: structuredClone(run), context: structuredClone(context) });
  }
}
