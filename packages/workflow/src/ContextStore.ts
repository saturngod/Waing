import { workflowContextSchema } from "@waing/domain";
import type { WorkflowContext, WorkflowSharedState, WorkflowSharedStateUpdate, WorkflowStepResult } from "@waing/domain";
import type { WorkflowRunRepository } from "./WorkflowRepository";

/** Ceilings so a misbehaving agent cannot turn the one uncompactable part of the context into the largest one. */
const LIMITS = { planItems: 40, decisions: 20, openQuestions: 20 };

/**
 * Plan items are addressed by id, so a step revises an existing one instead of restating the whole plan; decisions and
 * open questions are append-only sets. Everything is bounded and deduplicated, because this state is deliberately
 * exempt from compaction and therefore travels in every packet for the rest of the run.
 */
export function mergeSharedState(current: WorkflowSharedState, update: WorkflowSharedStateUpdate): WorkflowSharedState {
  const planItems = new Map(current.planItems.map((item) => [item.id, item]));
  for (const item of update.planItems ?? []) planItems.set(item.id, item);
  const append = (existing: string[], added: string[] | undefined, limit: number): string[] =>
    [...new Set([...existing, ...added ?? []])].slice(-limit);
  return { planItems: [...planItems.values()].slice(-LIMITS.planItems),
    decisions: append(current.decisions, update.decisions, LIMITS.decisions),
    openQuestions: append(current.openQuestions, update.openQuestions, LIMITS.openQuestions) };
}

export class ContextStore {
  constructor(private readonly repository: WorkflowRunRepository) {}
  async initialize(context: WorkflowContext): Promise<WorkflowContext> {
    const validated = workflowContextSchema.parse(context); await this.repository.saveContext(validated); return structuredClone(validated);
  }
  async recordStep(context: WorkflowContext, result: WorkflowStepResult): Promise<void> {
    context.stepResults.push(result); context.completedNodeIds.push(result.nodeId);
    context.artifacts.push(...result.artifacts); context.stateVersion += 1;
    if (result.stateUpdate !== undefined) context.sharedState = mergeSharedState(context.sharedState, result.stateUpdate);
    await this.repository.saveStepResult(context.workflowRunId, result); await this.repository.saveContext(context);
  }
  async checkpoint(context: WorkflowContext): Promise<void> { await this.repository.saveContext(workflowContextSchema.parse(context)); }
}
