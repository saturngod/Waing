import type { RouterCheckpointInput } from "@waing/domain";

export const ORCHESTRATION_SYSTEM_PROMPT = `You route a software workflow to user-created agents.

You are called again after every step. Decide only the immediate next action: delegate to exactly one available agent, ask the user when work cannot continue without input, or complete when the request is satisfied.
Use each agent's name and "use when" description to choose by job. Judge remaining work from sharedState.planItems and openQuestions plus the latest result. You do not execute work, call tools, choose a provider or model, change permissions, or expand workspace scope.

Return one JSON object only with exactly: action (delegate|ask_user|complete), agentProfileId when action is delegate, statusIntent, rationale, confidence, and optional effortHint.
statusIntent must be an object shaped like {"activity":"implementing","subject":"the task"}; subject is optional. activity must be one of: routing, creating_prd, updating_prd, implementing, planning, investigating, reviewing, fixing_bugs, writing_docs, testing, waiting_for_user.
Never mention providers or models.`;

const SUMMARY_LIMIT = 1_200;
const clip = (value: string): string => value.length > SUMMARY_LIMIT ? `${value.slice(0, SUMMARY_LIMIT)}… [truncated]` : value;
function compactCheckpoint(checkpoint: RouterCheckpointInput): RouterCheckpointInput {
  const latest = checkpoint.latestStepResult === undefined ? undefined : { ...checkpoint.latestStepResult, summary: clip(checkpoint.latestStepResult.summary) };
  if (latest !== undefined) { delete (latest as Partial<typeof latest>).agentId; delete (latest as Partial<typeof latest>).modelId; }
  return { ...checkpoint, priorStepSummaries: checkpoint.priorStepSummaries.map((entry) => ({ ...entry, summary: clip(entry.summary) })),
    ...(latest === undefined ? {} : { latestStepResult: latest }) };
}
export function buildOrchestrationPrompt(checkpoint: RouterCheckpointInput, previousErrors?: string): string {
  const roster = checkpoint.availableAgents.map((agent) => `- id=${agent.id} | ${agent.name} | use when: ${agent.whereToUse}`).join("\n");
  const correction = previousErrors === undefined ? "" : `\n\nPrevious answer rejected: ${previousErrors}. Return corrected JSON.`;
  return `${ORCHESTRATION_SYSTEM_PROMPT}\n\nAvailable agents:\n${roster}\n\nCheckpoint:\n${JSON.stringify(compactCheckpoint(checkpoint))}${correction}`;
}
