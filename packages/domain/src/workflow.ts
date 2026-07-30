import { z } from "zod";
import { effortLevelSchema } from "./agent";

export const routerActionSchema = z.enum(["delegate", "ask_user", "complete"]);
export type RouterAction = z.infer<typeof routerActionSchema>;

const nodeBase = { id: z.string().min(1), label: z.string().min(1), enabled: z.boolean() };
export const routerCheckpointReasonSchema = z.enum(["initial", "after_execution", "before_completion", "manual_reroute", "recovery"]);
export type RouterCheckpointReason = z.infer<typeof routerCheckpointReasonSchema>;
const routerNodeCheckpointSchema = z.enum(["initial", "after_execution", "before_completion", "custom"]);
export const routerNodeSchema = z.object({ ...nodeBase, type: z.literal("router"), checkpoint: routerNodeCheckpointSchema,
  allowedActions: z.array(routerActionSchema).min(1), instructions: z.string().optional() }).strict();
export const roleTaskNodeSchema = z.object({ ...nodeBase, type: z.literal("role_task"),
  agentProfileId: z.string().min(1), instructions: z.string().optional() }).strict();
export const loopNodeSchema = z.object({ ...nodeBase, type: z.literal("loop"), loopId: z.string().min(1),
  bodyEntryNodeId: z.string().min(1), exitNodeId: z.string().min(1), maxIterations: z.number().int().min(1).max(100),
  stopCondition: z.literal("condition_true"), onExhausted: z.enum(["ask_user", "fail_workflow", "continue_with_warning"]) }).strict();
export const completeNodeSchema = z.object({ ...nodeBase, type: z.literal("complete") }).strict();
export const workflowNodeSchema = z.discriminatedUnion("type", [routerNodeSchema, roleTaskNodeSchema, loopNodeSchema, completeNodeSchema]);
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;

export const workflowEdgeConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("always") }).strict(),
  z.object({ type: z.literal("router_agent"), agentProfileId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("router_action"), action: z.literal("complete") }).strict(),
  z.object({ type: z.literal("loop_remaining") }).strict(),
  z.object({ type: z.literal("loop_exhausted") }).strict(),
]);
export const workflowEdgeSchema = z.object({ id: z.string().min(1), from: z.string().min(1), to: z.string().min(1),
  loopId: z.string().min(1).optional(), condition: workflowEdgeConditionSchema.optional() }).strict();
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;

export const workflowDefinitionSchema = z.object({ id: z.string().min(1), name: z.string().min(1),
  version: z.number().int().positive(), description: z.string().optional(), entryNodeId: z.string().min(1),
  nodes: z.array(workflowNodeSchema).min(1), edges: z.array(workflowEdgeSchema),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime() }).strict();
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export const commandRecordSchema = z.object({ command: z.array(z.string()), exitCode: z.number().int().nullable() }).strict();
export type CommandRecord = z.infer<typeof commandRecordSchema>;
export const testRecordSchema = z.object({ command: z.string(), passed: z.boolean(), exitCode: z.number().int().nullable() }).strict();
export type TestRecord = z.infer<typeof testRecordSchema>;

export const planItemSchema = z.object({ id: z.string().min(1).max(64), title: z.string().min(1).max(200),
  status: z.enum(["pending", "in_progress", "done", "dropped"]) }).strict();
export type PlanItem = z.infer<typeof planItemSchema>;
export const workflowSharedStateSchema = z.object({ planItems: z.array(planItemSchema).default([]),
  decisions: z.array(z.string().min(1).max(300)).default([]), openQuestions: z.array(z.string().min(1).max(300)).default([]) }).strict();
export type WorkflowSharedState = z.infer<typeof workflowSharedStateSchema>;
export const workflowSharedStateUpdateSchema = z.object({ planItems: z.array(planItemSchema).optional(),
  decisions: z.array(z.string().min(1).max(300)).optional(), openQuestions: z.array(z.string().min(1).max(300)).optional() }).strict();
export type WorkflowSharedStateUpdate = z.infer<typeof workflowSharedStateUpdateSchema>;

export const workflowStepResultSchema = z.object({ stepRunId: z.string().min(1), nodeId: z.string().min(1),
  agentProfileId: z.string().min(1), agentName: z.string().min(1), agentId: z.string().min(1),
  modelId: z.string().optional(), effort: z.string().optional(), status: z.enum(["completed", "failed", "cancelled"]),
  summary: z.string(), filesRead: z.array(z.string()), filesChanged: z.array(z.string()), diff: z.string().optional(),
  providerSessionId: z.string().min(1).optional(), stateUpdate: workflowSharedStateUpdateSchema.optional(),
  commandsRun: z.array(commandRecordSchema), testsRun: z.array(testRecordSchema), unresolvedIssues: z.array(z.string()).optional() }).strict();
export type WorkflowStepResult = z.infer<typeof workflowStepResultSchema>;

export const stepSummaryEntrySchema = z.object({ agentProfileId: z.string().min(1), agentName: z.string().min(1),
  summary: z.string(), filesChanged: z.array(z.string()), testsRun: z.array(testRecordSchema), collapsed: z.boolean().optional() }).strict();
export type StepSummaryEntry = z.infer<typeof stepSummaryEntrySchema>;
export const workflowHandoffPacketSchema = z.object({ originalTask: z.string(), currentGoal: z.string(),
  priorStepSummaries: z.array(stepSummaryEntrySchema), currentDiff: z.string().optional(), unresolvedIssues: z.array(z.string()),
  changedFiles: z.array(z.string()).optional(), omittedStepCount: z.number().int().min(0).optional(),
  providerSessionRetained: z.boolean().optional(), sharedState: workflowSharedStateSchema.optional() }).strict();
export type WorkflowHandoffPacket = z.infer<typeof workflowHandoffPacketSchema>;

export const stepActivityKindSchema = z.enum(["routing", "creating_prd", "updating_prd", "implementing", "planning",
  "investigating", "reviewing", "fixing_bugs", "writing_docs", "testing", "waiting_for_user"]);
export type StepActivityKind = z.infer<typeof stepActivityKindSchema>;
export const stepAnnouncementIntentSchema = z.object({ activity: stepActivityKindSchema, subject: z.string().optional(),
  template: z.string().max(160).refine((value) => !/\b(?:codex|claude|antigravity|opencode)\b/iu.test(value),
    "Announcement templates cannot hardcode provider identities").optional() }).strict();
export type StepAnnouncementIntent = z.infer<typeof stepAnnouncementIntentSchema>;
export const stepAnnouncementSchema = z.object({ workflowRunId: z.string(), stepRunId: z.string(), nodeId: z.string(),
  agentProfileId: z.string().min(1), agentName: z.string().min(1), agentId: z.string(), agentDisplayName: z.string(),
  modelId: z.string().optional(), modelDisplayName: z.string().optional(), effort: z.string().optional(),
  activity: stepActivityKindSchema, message: z.string().max(160), createdAt: z.string().datetime() }).strict();
export type StepAnnouncement = z.infer<typeof stepAnnouncementSchema>;

export const availableAgentSchema = z.object({ id: z.string().min(1), name: z.string().min(1).max(40),
  whereToUse: z.string().min(1).max(200) }).strict();
export const routerCheckpointInputSchema = z.object({ checkpointReason: routerCheckpointReasonSchema,
  originalUserTask: z.string(), latestStepResult: workflowStepResultSchema.optional(),
  priorStepSummaries: z.array(stepSummaryEntrySchema), omittedStepCount: z.number().int().min(0).optional(),
  sharedState: workflowSharedStateSchema.optional(), availableAgents: z.array(availableAgentSchema).min(1),
  allowedActions: z.array(routerActionSchema).min(1) }).strict();
export type RouterCheckpointInput = z.infer<typeof routerCheckpointInputSchema>;
export const routerOrchestrationDecisionSchema = z.object({ action: routerActionSchema,
  agentProfileId: z.string().min(1).optional(), effortHint: effortLevelSchema.optional(), statusIntent: stepAnnouncementIntentSchema,
  rationale: z.string().min(1), confidence: z.number().min(0).max(1) }).strict().superRefine((value, context) => {
    if (value.action === "delegate" && value.agentProfileId === undefined) context.addIssue({ code: "custom", message: "delegate requires agentProfileId" });
    if (value.action !== "delegate" && value.agentProfileId !== undefined) context.addIssue({ code: "custom", message: `${value.action} cannot include agentProfileId` });
  });
export type RouterOrchestrationDecision = z.infer<typeof routerOrchestrationDecisionSchema>;
export const routerDecisionRecordSchema = z.object({ id: z.string(), workflowRunId: z.string(), routerNodeId: z.string(),
  checkpointReason: routerCheckpointReasonSchema, inputStateVersion: z.number().int().min(0), decision: routerOrchestrationDecisionSchema,
  resolvedNodeId: z.string().optional(), agentProfileId: z.string().optional(), agentName: z.string().optional(),
  resolvedAgentId: z.string().optional(), resolvedModelId: z.string().optional(), createdAt: z.string().datetime() }).strict();
export type RouterDecisionRecord = z.infer<typeof routerDecisionRecordSchema>;

export const workflowContextSchema = z.object({ workflowRunId: z.string(), projectId: z.string(), projectRoot: z.string(),
  originalUserTask: z.string(), stateVersion: z.number().int().min(0), routerDecisionCount: z.number().int().min(0),
  routerDecisionHistory: z.array(routerDecisionRecordSchema), latestRouterDecision: routerOrchestrationDecisionSchema.optional(),
  activeNodeId: z.string(), completedNodeIds: z.array(z.string()), stepResults: z.array(workflowStepResultSchema),
  loopState: z.record(z.string(), z.object({ iteration: z.number().int().min(0), maxIterations: z.number().int().positive() }).strict()),
  providerSessions: z.record(z.string(), z.string()).default({}),
  sharedState: workflowSharedStateSchema.default({ planItems: [], decisions: [], openQuestions: [] }) }).strict();
export type WorkflowContext = z.infer<typeof workflowContextSchema>;

export const workflowRunStatusSchema = z.enum(["created", "validating", "ready", "running_node", "waiting_permission",
  "node_completed", "paused", "cancelled", "failed", "completed"]);
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;
export interface WorkflowRun { id: string; workflowId: string; workflowVersion: number; status: WorkflowRunStatus; createdAt: string; updatedAt: string; summary?: string }

export type WorkflowEvent =
  | { type: "workflow.started"; workflowRunId: string }
  | { type: "workflow.router.started"; nodeId: string; checkpointReason: RouterCheckpointReason }
  | { type: "workflow.router.decided"; record: RouterDecisionRecord }
  | { type: "workflow.step.announced"; announcement: StepAnnouncement }
  | { type: "workflow.node.started"; nodeId: string; stepRunId: string }
  | { type: "workflow.node.completed"; nodeId: string; stepRunId: string }
  | { type: "workflow.state.updated"; sharedState: WorkflowSharedState }
  | { type: "workflow.route.selected"; agentProfileId: string; agentName: string }
  | { type: "workflow.loop.iteration"; loopId: string; iteration: number }
  | { type: "workflow.loop.exhausted"; loopId: string }
  | { type: "workflow.completed"; workflowRunId: string }
  | { type: "workflow.paused"; workflowRunId: string; reason: string }
  | { type: "workflow.cancelled"; workflowRunId: string }
  | { type: "workflow.failed"; workflowRunId: string; code: string; message: string };
