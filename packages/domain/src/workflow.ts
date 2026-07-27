import { z } from "zod";
import { agentModeSchema, effortLevelSchema } from "./agent";
import { routingDecisionSchema, workflowRoleSchema } from "./routing";

export const roleExecutionProfileSchema = z.object({
  role: workflowRoleSchema, enabled: z.boolean(), agentId: z.string().min(1), modelId: z.string().min(1).optional(),
  effort: effortLevelSchema.optional(), mode: agentModeSchema.optional(), permissionProfileId: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(), maxRetries: z.number().int().min(0).max(10).optional(),
  instructions: z.string().optional(),
}).strict();
export type RoleExecutionProfile = z.infer<typeof roleExecutionProfileSchema>;

export const stepExecutionOverrideSchema = roleExecutionProfileSchema.pick({ agentId: true, modelId: true, effort: true,
  mode: true, permissionProfileId: true }).partial().strict();
export type StepExecutionOverride = z.infer<typeof stepExecutionOverrideSchema>;

export const workflowNextActionKindSchema = z.enum(["execute_low", "execute_medium", "execute_high", "create_prd",
  "update_prd", "write_documentation", "review", "fix", "ask_user", "complete"]);
export type WorkflowNextActionKind = z.infer<typeof workflowNextActionKindSchema>;

const nodeBase = { id: z.string().min(1), label: z.string().min(1), enabled: z.boolean() };
export const routerCheckpointReasonSchema = z.enum(["initial", "after_document", "after_execution", "after_review",
  "after_fix", "before_completion", "manual_reroute", "recovery"]);
export type RouterCheckpointReason = z.infer<typeof routerCheckpointReasonSchema>;
const routerNodeCheckpointSchema = z.enum(["initial", "after_document", "after_execution", "after_review", "after_fix",
  "before_completion", "custom"]);
export const routerNodeSchema = z.object({ ...nodeBase, type: z.literal("router"), role: z.literal("router"),
  checkpoint: routerNodeCheckpointSchema, allowedActions: z.array(workflowNextActionKindSchema).min(1),
  instructions: z.string().optional() }).strict();
export const roleTaskNodeSchema = z.object({ ...nodeBase, type: z.literal("role_task"),
  role: z.enum(["low", "medium", "high", "review", "bugfix"]), instructions: z.string().optional(),
  execution: stepExecutionOverrideSchema.optional() }).strict();
/** `optional` marks a gate the router may legitimately skip, so completion is not blocked when it never ran. */
export const documentNodeSchema = z.object({ ...nodeBase, type: z.literal("document"), role: z.literal("document"),
  operation: z.enum(["create", "update"]), documentKind: z.enum(["prd", "readme", "architecture", "changelog", "custom"]),
  path: z.string().optional(), instructions: z.string().optional(), optional: z.boolean().optional(),
  execution: stepExecutionOverrideSchema.optional() }).strict();
export const reviewGateNodeSchema = z.object({ ...nodeBase, type: z.literal("review_gate"), role: z.literal("review"),
  passEdge: z.string().min(1), failEdge: z.string().min(1), requireTests: z.boolean().optional(),
  optional: z.boolean().optional(), execution: stepExecutionOverrideSchema.optional() }).strict();
export const loopNodeSchema = z.object({ ...nodeBase, type: z.literal("loop"), loopId: z.string().min(1),
  bodyEntryNodeId: z.string().min(1), exitNodeId: z.string().min(1), maxIterations: z.number().int().min(1).max(100),
  stopCondition: z.enum(["review_passed", "condition_true"]),
  onExhausted: z.enum(["ask_user", "fail_workflow", "continue_with_warning"]) }).strict();
export const completeNodeSchema = z.object({ ...nodeBase, type: z.literal("complete") }).strict();
export const workflowNodeSchema = z.discriminatedUnion("type", [routerNodeSchema, roleTaskNodeSchema, documentNodeSchema,
  reviewGateNodeSchema, loopNodeSchema, completeNodeSchema]);
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;

export const workflowEdgeConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("always") }).strict(),
  z.object({ type: z.literal("router_role"), role: workflowRoleSchema.exclude(["router"]) }).strict(),
  z.object({ type: z.literal("router_action"), action: workflowNextActionKindSchema }).strict(),
  z.object({ type: z.literal("document_operation"), operation: z.enum(["create", "update"]) }).strict(),
  z.object({ type: z.literal("review_result"), result: z.enum(["pass", "fail"]) }).strict(),
  z.object({ type: z.literal("loop_remaining") }).strict(), z.object({ type: z.literal("loop_exhausted") }).strict(),
]);
export const workflowEdgeSchema = z.object({ id: z.string().min(1), from: z.string().min(1), to: z.string().min(1),
  loopId: z.string().min(1).optional(), condition: workflowEdgeConditionSchema.optional() }).strict();
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;

export const workflowDefinitionSchema = z.object({ id: z.string().min(1), name: z.string().min(1),
  version: z.number().int().positive(), description: z.string().optional(), entryNodeId: z.string().min(1),
  nodes: z.array(workflowNodeSchema).min(1), edges: z.array(workflowEdgeSchema),
  roleOverrides: z.partialRecord(workflowRoleSchema, roleExecutionProfileSchema.partial()).optional(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime() }).strict();
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export const commandRecordSchema = z.object({ command: z.array(z.string()), exitCode: z.number().int().nullable() }).strict();
export type CommandRecord = z.infer<typeof commandRecordSchema>;
export const testRecordSchema = z.object({ command: z.string(), passed: z.boolean(), exitCode: z.number().int().nullable() }).strict();
export type TestRecord = z.infer<typeof testRecordSchema>;
export const workflowArtifactRefSchema = z.object({ id: z.string().min(1), kind: z.string().min(1), path: z.string().min(1),
  createdByStepRunId: z.string().min(1) }).strict();
export type WorkflowArtifactRef = z.infer<typeof workflowArtifactRefSchema>;
export const reviewFindingSchema = z.object({ id: z.string().min(1), severity: z.enum(["critical", "high", "medium", "low", "info"]),
  category: z.enum(["correctness", "security", "regression", "performance", "maintainability", "testing", "documentation"]),
  title: z.string().min(1), description: z.string().min(1), file: z.string().optional(), line: z.number().int().positive().optional(),
  suggestedFix: z.string().optional() }).strict();
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export const reviewResultSchema = z.object({ verdict: z.enum(["pass", "fail"]), summary: z.string(),
  findings: z.array(reviewFindingSchema), testsObserved: z.array(z.string()), confidence: z.number().min(0).max(1) }).strict();
export type ReviewResult = z.infer<typeof reviewResultSchema>;
export const fixPacketSchema = z.object({ originalTask: z.string(), implementationSummary: z.string(),
  reviewIteration: z.number().int().min(1), findings: z.array(reviewFindingSchema), currentChangedFiles: z.array(z.string()),
  testsAlreadyRun: z.array(testRecordSchema), prdArtifact: workflowArtifactRefSchema.optional() }).strict();
export type FixPacket = z.infer<typeof fixPacketSchema>;
export const workflowStepResultSchema = z.object({ stepRunId: z.string().min(1), nodeId: z.string().min(1),
  role: workflowRoleSchema, agentId: z.string().min(1), modelId: z.string().optional(), effort: z.string().optional(),
  status: z.enum(["completed", "failed", "cancelled"]), summary: z.string(), filesRead: z.array(z.string()),
  filesChanged: z.array(z.string()), diff: z.string().optional(),
  commandsRun: z.array(commandRecordSchema), testsRun: z.array(testRecordSchema),
  artifacts: z.array(workflowArtifactRefSchema), findings: z.array(reviewFindingSchema).optional(),
  reviewVerdict: z.enum(["pass", "fail"]).optional(), unresolvedIssues: z.array(z.string()).optional() }).strict();
export type WorkflowStepResult = z.infer<typeof workflowStepResultSchema>;
export const documentTaskInputSchema = z.object({ operation: z.enum(["create", "update"]),
  kind: z.enum(["prd", "readme", "architecture", "changelog", "custom"]), targetPath: z.string().optional(),
  originalTask: z.string(), routingDecision: routingDecisionSchema.optional(), stepResults: z.array(workflowStepResultSchema),
  finalReview: reviewResultSchema.optional() }).strict();
export type DocumentTaskInput = z.infer<typeof documentTaskInputSchema>;

export const reviewFixLoopPolicySchema = z.object({ maxReviewAttempts: z.number().int().min(1).max(100),
  onExhausted: z.enum(["stop_and_ask_user", "fail_workflow", "continue_to_document_with_warning"]),
  blockingSeverities: z.array(z.enum(["critical", "high", "medium", "low"])) }).strict();
export type ReviewFixLoopPolicy = z.infer<typeof reviewFixLoopPolicySchema>;

export const workflowHandoffPacketSchema = z.object({ originalTask: z.string(), currentGoal: z.string(),
  routingDecision: routingDecisionSchema.optional(), prd: workflowArtifactRefSchema.optional(),
  priorStepSummaries: z.array(z.object({ role: workflowRoleSchema, summary: z.string(), filesChanged: z.array(z.string()),
    testsRun: z.array(testRecordSchema) }).strict()), currentDiff: z.string().optional(),
  reviewFindings: z.array(reviewFindingSchema).optional(), unresolvedIssues: z.array(z.string()) }).strict();
export type WorkflowHandoffPacket = z.infer<typeof workflowHandoffPacketSchema>;

export const stepActivityKindSchema = z.enum(["routing", "creating_prd", "updating_prd", "implementing", "planning",
  "investigating", "reviewing", "fixing_bugs", "writing_docs", "testing", "waiting_for_user"]);
export type StepActivityKind = z.infer<typeof stepActivityKindSchema>;
export const stepAnnouncementIntentSchema = z.object({ activity: stepActivityKindSchema, subject: z.string().optional(),
  template: z.string().max(160).refine((value) => !/\b(?:codex|claude|antigravity|opencode)\b/iu.test(value),
    "Announcement templates cannot hardcode provider identities").optional() }).strict();
export type StepAnnouncementIntent = z.infer<typeof stepAnnouncementIntentSchema>;
export const stepAnnouncementSchema = z.object({ workflowRunId: z.string(), stepRunId: z.string(), nodeId: z.string(),
  role: workflowRoleSchema, agentId: z.string(), agentDisplayName: z.string(), modelId: z.string().optional(),
  modelDisplayName: z.string().optional(), effort: z.string().optional(), activity: stepActivityKindSchema,
  message: z.string().max(160), createdAt: z.string().datetime() }).strict();
export type StepAnnouncement = z.infer<typeof stepAnnouncementSchema>;

export const routerCheckpointInputSchema = z.object({ checkpointReason: routerCheckpointReasonSchema,
  originalUserTask: z.string(), latestStepResult: workflowStepResultSchema.optional(), latestReview: reviewResultSchema.optional(),
  latestArtifact: workflowArtifactRefSchema.optional(), priorStepSummaries: z.array(z.object({ role: workflowRoleSchema,
    summary: z.string(), filesChanged: z.array(z.string()), testsRun: z.array(testRecordSchema) }).strict()),
  artifacts: z.array(workflowArtifactRefSchema), unresolvedIssues: z.array(z.string()), reviewIteration: z.number().int().min(0).optional(),
  allowedActions: z.array(workflowNextActionKindSchema).min(1) }).strict();
export type RouterCheckpointInput = z.infer<typeof routerCheckpointInputSchema>;
export const routerOrchestrationDecisionSchema = z.object({ action: workflowNextActionKindSchema,
  complexity: z.enum(["low", "medium", "high"]).optional(), taskType: routingDecisionSchema.shape.taskType.optional(),
  effortHint: effortLevelSchema.optional(), document: z.object({ operation: z.enum(["create", "update"]),
    kind: z.enum(["prd", "readme", "architecture", "changelog", "custom"]), targetPath: z.string().optional() }).strict().optional(),
  statusIntent: stepAnnouncementIntentSchema, rationale: z.string().min(1), confidence: z.number().min(0).max(1) }).strict()
  .superRefine((value, context) => {
    if ((value.action === "create_prd" || value.action === "update_prd") && value.document === undefined) {
      context.addIssue({ code: "custom", message: `${value.action} requires a document directive` });
    }
  });
export type RouterOrchestrationDecision = z.infer<typeof routerOrchestrationDecisionSchema>;
export const routerDecisionRecordSchema = z.object({ id: z.string(), workflowRunId: z.string(), routerNodeId: z.string(),
  checkpointReason: routerCheckpointReasonSchema, inputStateVersion: z.number().int().min(0), decision: routerOrchestrationDecisionSchema,
  resolvedNodeId: z.string().optional(), resolvedRole: workflowRoleSchema.optional(), resolvedAgentId: z.string().optional(),
  resolvedModelId: z.string().optional(), createdAt: z.string().datetime() }).strict();
export type RouterDecisionRecord = z.infer<typeof routerDecisionRecordSchema>;

export const workflowContextSchema = z.object({ workflowRunId: z.string(), projectId: z.string(), projectRoot: z.string(),
  originalUserTask: z.string(), routingDecision: routingDecisionSchema.optional(), stateVersion: z.number().int().min(0),
  routerDecisionCount: z.number().int().min(0), routerDecisionHistory: z.array(routerDecisionRecordSchema),
  latestRouterDecision: routerOrchestrationDecisionSchema.optional(), activeNodeId: z.string(),
  completedNodeIds: z.array(z.string()), stepResults: z.array(workflowStepResultSchema), artifacts: z.array(workflowArtifactRefSchema),
  loopState: z.record(z.string(), z.object({ iteration: z.number().int().min(0), maxIterations: z.number().int().positive() }).strict()) }).strict();
export type WorkflowContext = z.infer<typeof workflowContextSchema>;

export const workflowRunStatusSchema = z.enum(["created", "validating", "ready", "running_node", "waiting_permission",
  "node_completed", "paused", "cancelled", "failed", "completed"]);
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;
export interface WorkflowRun { id: string; workflowId: string; workflowVersion: number; status: WorkflowRunStatus; createdAt: string; updatedAt: string; summary?: string; }

export type WorkflowEvent =
  | { type: "workflow.started"; workflowRunId: string }
  | { type: "workflow.router.started"; nodeId: string; checkpointReason: RouterCheckpointReason }
  | { type: "workflow.router.decided"; record: RouterDecisionRecord }
  | { type: "workflow.step.announced"; announcement: StepAnnouncement }
  | { type: "workflow.node.started"; nodeId: string; stepRunId: string }
  | { type: "workflow.node.completed"; nodeId: string; stepRunId: string }
  | { type: "workflow.route.selected"; role: z.infer<typeof workflowRoleSchema> }
  | { type: "workflow.review.completed"; verdict: "pass" | "fail" }
  | { type: "workflow.loop.iteration"; loopId: string; iteration: number }
  | { type: "workflow.loop.exhausted"; loopId: string }
  | { type: "workflow.artifact.created"; artifactId: string }
  | { type: "workflow.completed"; workflowRunId: string }
  | { type: "workflow.paused"; workflowRunId: string; reason: string }
  | { type: "workflow.cancelled"; workflowRunId: string }
  | { type: "workflow.failed"; workflowRunId: string; code: string; message: string };
