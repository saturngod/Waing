import type { RouterCheckpointInput } from "@waing/domain";

export const ROUTING_SYSTEM_PROMPT = `You classify software engineering tasks for deterministic routing.

You do not execute the task, request tools, select a vendor or agent, change permissions, or change workspace scope.
Judge complexity from scope, uncertainty, architecture impact, risk, testing requirements, migration concerns, and likely components affected.

Complexity rubric:
- low: narrow, low-risk, low-uncertainty, straightforward validation
- medium: multiple components, moderate uncertainty or regression risk, meaningful tests
- high: broad scope, high uncertainty or blast radius, security/architecture/migration concerns

Planning is a work mode, not a complexity level. Return one JSON object only with exactly these fields:
complexity (low|medium|high), taskType (question|bugfix|feature|refactor|investigation|planning|review|testing|documentation), mode (execute|plan|investigate|review), effort (low|medium|high), confidence (0..1), rationale (brief string).`;

export function buildRoutingPrompt(input: { task: string; project?: unknown }): string {
  return `${ROUTING_SYSTEM_PROMPT}\n\nClassify this input:\n${JSON.stringify(input)}`;
}

export const ORCHESTRATION_SYSTEM_PROMPT = `You choose the next step of a software workflow that other agents execute.

You do not execute the task, call tools, read or write files, choose a vendor/provider/model, alter permissions, include credentials, or expand workspace scope.
Pick exactly one action from the checkpoint's allowedActions. Prefer "complete" once the user's request is satisfied; do not add stages the request does not need.

Return one JSON object only, with exactly these fields and no others:
- action: one of the checkpoint's allowedActions
- statusIntent: { "activity": one of routing|creating_prd|updating_prd|implementing|planning|investigating|reviewing|fixing_bugs|writing_docs|testing|waiting_for_user }
- rationale: brief string explaining the choice
- confidence: number between 0 and 1

Optional fields, only when they apply:
- complexity: low|medium|high, and taskType: question|bugfix|feature|refactor|investigation|planning|review|testing|documentation, when choosing an execute_* action
- effortHint: low|medium|high|max
- document: { "operation": create|update, "kind": prd|readme|architecture|changelog|custom, "targetPath": string } — REQUIRED for create_prd, update_prd, and write_documentation; set targetPath to the file the user asked for

Example: {"action":"execute_medium","complexity":"medium","taskType":"feature","statusIntent":{"activity":"implementing"},"rationale":"Several components with moderate risk.","confidence":0.86}

Never mention a provider or agent name anywhere in the output.`;

const SUMMARY_LIMIT = 1_200;
const clip = (value: string): string => value.length > SUMMARY_LIMIT ? `${value.slice(0, SUMMARY_LIMIT)}… [truncated]` : value;

/**
 * A step summary is the executing agent's whole final message, so later checkpoints would otherwise send entire
 * transcripts to a routing-only model. Only the prompt is clipped; the stored checkpoint keeps the full text.
 */
function compactCheckpoint(checkpoint: RouterCheckpointInput): RouterCheckpointInput {
  return { ...checkpoint,
    priorStepSummaries: checkpoint.priorStepSummaries.map((entry) => ({ ...entry, summary: clip(entry.summary) })),
    ...(checkpoint.latestStepResult === undefined ? {}
      : { latestStepResult: { ...checkpoint.latestStepResult, summary: clip(checkpoint.latestStepResult.summary) } }) };
}

export function buildOrchestrationPrompt(checkpoint: RouterCheckpointInput, previousErrors?: string): string {
  const correction = previousErrors === undefined ? ""
    : `\n\nYour previous answer was rejected by the schema: ${previousErrors}\nReturn corrected JSON with every required field and no extra fields.`;
  return `${ORCHESTRATION_SYSTEM_PROMPT}\n\nCheckpoint:\n${JSON.stringify(compactCheckpoint(checkpoint))}${correction}`;
}
