import { z } from "zod";

export const workflowRoleSchema = z.enum(["router", "low", "medium", "high", "review", "bugfix", "document"]);
export type WorkflowRole = z.infer<typeof workflowRoleSchema>;
export type ExecutionWorkflowRole = Exclude<WorkflowRole, "router">;

export const routingInputSchema = z.object({
  task: z.string().min(1),
  project: z.object({
    languageHints: z.array(z.string().min(1)).optional(),
    frameworkHints: z.array(z.string().min(1)).optional(),
    repoSizeClass: z.enum(["small", "medium", "large"]).optional(),
  }).strict().optional(),
}).strict();
export type RoutingInput = z.infer<typeof routingInputSchema>;

export const routingDecisionSchema = z.object({
  complexity: z.enum(["low", "medium", "high"]),
  taskType: z.enum(["question", "bugfix", "feature", "refactor", "investigation", "planning", "review", "testing", "documentation"]),
  mode: z.enum(["execute", "plan", "investigate", "review"]),
  effort: z.enum(["low", "medium", "high"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(1_000),
}).strict();
export type RoutingDecision = z.infer<typeof routingDecisionSchema>;

export const routingRuleSchema = z.object({
  id: z.string().min(1), enabled: z.boolean(),
  match: z.object({
    complexity: routingDecisionSchema.shape.complexity.optional(),
    taskType: routingDecisionSchema.shape.taskType.optional(),
    mode: routingDecisionSchema.shape.mode.optional(),
  }).strict(),
  targetRole: workflowRoleSchema.exclude(["router"]),
  priority: z.number().int(),
}).strict();
export type RoutingRule = z.infer<typeof routingRuleSchema>;

export const routingPolicySchema = z.object({
  defaultRole: workflowRoleSchema.exclude(["router"]),
  rules: z.array(routingRuleSchema),
}).strict();
export type RoutingPolicy = z.infer<typeof routingPolicySchema>;

export const routeResolutionSchema = z.object({
  routingDecision: routingDecisionSchema,
  role: workflowRoleSchema.exclude(["router"]),
  matchedRuleId: z.string().min(1).optional(),
}).strict();
export type RouteResolution = z.infer<typeof routeResolutionSchema>;

export const confidenceFallbackSchema = z.enum(["ask_user", "use_default_role", "use_safest_route"]);
export type ConfidenceFallback = z.infer<typeof confidenceFallbackSchema>;

export const autoSelectionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("resolved"), resolution: routeResolutionSchema,
    confidenceFallbackApplied: confidenceFallbackSchema.optional() }).strict(),
  z.object({ status: z.literal("needs_confirmation"), decision: routingDecisionSchema,
    suggestedRole: workflowRoleSchema.exclude(["router"]) }).strict(),
]);
export type AutoSelection = z.infer<typeof autoSelectionSchema>;
