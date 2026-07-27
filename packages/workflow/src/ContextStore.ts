import { workflowContextSchema } from "@waing/domain";
import type { WorkflowContext, WorkflowStepResult } from "@waing/domain";
import type { WorkflowRunRepository } from "./WorkflowRepository";

export class ContextStore {
  constructor(private readonly repository: WorkflowRunRepository) {}
  async initialize(context: WorkflowContext): Promise<WorkflowContext> {
    const validated = workflowContextSchema.parse(context); await this.repository.saveContext(validated); return structuredClone(validated);
  }
  async recordStep(context: WorkflowContext, result: WorkflowStepResult): Promise<void> {
    context.stepResults.push(result); context.completedNodeIds.push(result.nodeId);
    context.artifacts.push(...result.artifacts); context.stateVersion += 1;
    await this.repository.saveStepResult(context.workflowRunId, result); await this.repository.saveContext(context);
  }
  async checkpoint(context: WorkflowContext): Promise<void> { await this.repository.saveContext(workflowContextSchema.parse(context)); }
}
