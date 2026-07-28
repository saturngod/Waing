import type { RoleExecutionProfile, StepActivityKind, StepAnnouncement, StepAnnouncementIntent, WorkflowNode } from "@waing/domain";

const templates: Record<StepActivityKind, string> = {
  routing: "{identity} is routing {subject}.", creating_prd: "{identity} is creating the PRD.",
  updating_prd: "{identity} is updating the PRD.", implementing: "{identity} is implementing the task.",
  planning: "{identity} is planning the task.", investigating: "{identity} is investigating the task.",
  reviewing: "{identity} is reviewing the changes.", fixing_bugs: "{identity} is fixing the bugs.",
  writing_docs: "{identity} is writing the documentation.", testing: "{identity} is testing the changes.",
  waiting_for_user: "{identity} is waiting for user input.",
};

export function defaultIntent(node: WorkflowNode): StepAnnouncementIntent {
  if (node.type === "router") return { activity: "routing" };
  if (node.type === "document") return { activity: node.documentKind === "prd"
    ? node.operation === "create" ? "creating_prd" : "updating_prd" : "writing_docs" };
  if (node.type === "review_gate" || node.type === "role_task" && node.role === "review") return { activity: "reviewing" };
  if (node.type === "role_task" && node.role === "bugfix") return { activity: "fixing_bugs" };
  if (node.type === "role_task" && node.role === "planning") return { activity: "planning" };
  return { activity: "implementing" };
}

export function renderAnnouncement(input: { workflowRunId: string; stepRunId: string; node: WorkflowNode;
  profile: RoleExecutionProfile; agentDisplayName: string; modelDisplayName?: string; intent?: StepAnnouncementIntent }): StepAnnouncement {
  if (input.node.type === "loop" || input.node.type === "complete") throw new Error("Control nodes cannot be announced as agent steps");
  const intent = input.intent ?? defaultIntent(input.node);
  const identity = input.modelDisplayName ?? input.agentDisplayName;
  const subject = intent.subject ?? "the task";
  const template = intent.template?.replaceAll("{model}", "{identity}").replaceAll("{modelOrAgent}", "{identity}")
    ?? templates[intent.activity] ?? "{identity} is working on {subject}.";
  const message = template.replaceAll("{identity}", identity).replaceAll("{subject}", subject).slice(0, 160);
  return { workflowRunId: input.workflowRunId, stepRunId: input.stepRunId, nodeId: input.node.id, role: input.node.role,
    agentId: input.profile.agentId, agentDisplayName: input.agentDisplayName,
    ...(input.profile.modelId === undefined ? {} : { modelId: input.profile.modelId }),
    ...(input.modelDisplayName === undefined ? {} : { modelDisplayName: input.modelDisplayName }),
    ...(input.profile.effort === undefined ? {} : { effort: input.profile.effort }),
    activity: intent.activity, message, createdAt: new Date().toISOString() };
}
