import { conversationMemorySchema } from "@waing/domain";
import type { ConversationMemory, WorkflowContext, WorkflowStepResult } from "@waing/domain";
import { clip, compactHistory, dedupe } from "./ContextCompactor";

const MAX_COMPLETED_WORK = 40;
const MAX_ISSUES = 40;

function completedWork(results: readonly WorkflowStepResult[]): string[] {
  return results.map((result) => `${result.agentName}: ${clip(result.summary, 800)}`)
    .filter((summary) => summary.trim().length > 0);
}

/**
 * Builds the durable memory projection after a workflow run. This intentionally uses data already produced by the
 * workflow; it does not create a second summarizer request (which would make every handoff more expensive).
 */
export function buildConversationMemory(previous: ConversationMemory | undefined, context: WorkflowContext,
  currentTask: string, conversationId: string, updatedAt = new Date().toISOString()): ConversationMemory {
  const currentHistory = compactHistory(context.stepResults).summaries.map((summary) => ({ ...summary,
    filesChanged: summary.filesChanged.slice(-20), testsRun: summary.testsRun.slice(-20) }));
  const previousSummaries = previous?.stepSummaries ?? [];
  const latest = context.stepResults.at(-1);
  const verification = latest === undefined || latest.testsRun.length === 0 ? previous?.lastVerification : {
    summary: clip(latest.summary, 1_200), testsRun: latest.testsRun.slice(-20),
  };
  return conversationMemorySchema.parse({
    conversationId,
    version: 1,
    revision: (previous?.revision ?? 0) + 1,
    objective: previous?.objective || clip(currentTask, 4_000),
    requirements: previous?.requirements ?? [],
    constraints: previous?.constraints ?? [],
    planItems: context.sharedState.planItems.slice(-40),
    decisions: context.sharedState.decisions.slice(-20),
    completedWork: dedupe([...(previous?.completedWork ?? []), ...completedWork(context.stepResults)]).slice(-MAX_COMPLETED_WORK),
    changedFiles: dedupe([...(previous?.changedFiles ?? []), ...context.stepResults.flatMap((result) => result.filesChanged)]).slice(-100),
    openQuestions: context.sharedState.openQuestions.slice(-20),
    unresolvedIssues: dedupe([...(previous?.unresolvedIssues ?? []), ...context.stepResults.flatMap((result) => result.unresolvedIssues ?? [])]).slice(-MAX_ISSUES),
    stepSummaries: [...previousSummaries, ...currentHistory].slice(-8),
    ...(verification === undefined ? {} : { lastVerification: verification }),
    updatedAt,
  });
}
