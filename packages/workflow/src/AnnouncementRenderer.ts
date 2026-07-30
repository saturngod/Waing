import type { AgentProfile, StepActivityKind, StepAnnouncement, StepAnnouncementIntent, WorkflowNode } from "@waing/domain";

const templates: Record<StepActivityKind, string> = {
  routing: "{identity} is routing {subject}.", creating_prd: "{identity} is creating the PRD.",
  updating_prd: "{identity} is updating the PRD.", implementing: "{identity} is implementing the task.",
  planning: "{identity} is planning the task.", investigating: "{identity} is investigating the task.",
  reviewing: "{identity} is reviewing the changes.", fixing_bugs: "{identity} is fixing the bugs.",
  writing_docs: "{identity} is writing the documentation.", testing: "{identity} is testing the changes.",
  waiting_for_user: "{identity} is waiting for user input.",
};

export function defaultIntent(): StepAnnouncementIntent { return { activity: "implementing" }; }

export function renderAnnouncement(input: { workflowRunId: string; stepRunId: string;
  node: Extract<WorkflowNode, { type: "role_task" }>; profile: AgentProfile; agentDisplayName: string;
  modelDisplayName?: string; intent?: StepAnnouncementIntent }): StepAnnouncement {
  const intent = input.intent ?? defaultIntent(); const identity = input.modelDisplayName ?? input.agentDisplayName;
  const subject = intent.subject ?? "the task";
  const template = intent.template?.replaceAll("{model}", "{identity}").replaceAll("{modelOrAgent}", "{identity}")
    ?? templates[intent.activity] ?? "{identity} is working on {subject}.";
  return { workflowRunId: input.workflowRunId, stepRunId: input.stepRunId, nodeId: input.node.id,
    agentProfileId: input.profile.id, agentName: input.profile.name, agentId: input.profile.agentId,
    agentDisplayName: input.agentDisplayName, ...(input.profile.modelId === undefined ? {} : { modelId: input.profile.modelId }),
    ...(input.modelDisplayName === undefined ? {} : { modelDisplayName: input.modelDisplayName }),
    ...(input.profile.effort === undefined ? {} : { effort: input.profile.effort }), activity: intent.activity,
    message: template.replaceAll("{identity}", identity).replaceAll("{subject}", subject).slice(0, 160), createdAt: new Date().toISOString() };
}
