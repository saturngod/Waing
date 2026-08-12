import { z } from "zod";
import { effortLevelSchema } from "./agent";

export const orchestrationModeSchema = z.enum(["multi_agent", "codex"]);
export type OrchestrationMode = z.infer<typeof orchestrationModeSchema>;

export const codexExecutionTargetSchema = z.object({
  modelId: z.string().min(1),
  effort: effortLevelSchema,
}).strict();
export type CodexExecutionTarget = z.infer<typeof codexExecutionTargetSchema>;

export const agentProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(40),
  whereToUse: z.string().min(1).max(200),
  instructions: z.string().max(4_000).optional(),
  enabled: z.boolean(),
  agentId: z.string().min(1),
  modelId: z.string().min(1).optional(),
  effort: effortLevelSchema.optional(),
  permissionProfileId: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  /** Codex app-server target used when the conversation runs in Codex mode. */
  codex: codexExecutionTargetSchema.optional(),
  position: z.number().int().min(0),
}).strict();
export type AgentProfile = z.infer<typeof agentProfileSchema>;

export const routerSettingsSchema = z.object({
  agentId: z.string().min(1),
  modelId: z.string().min(1).optional(),
  effort: effortLevelSchema.optional(),
  /** Codex app-server target used when the conversation runs in Codex mode. */
  codex: codexExecutionTargetSchema.optional(),
}).strict();
export type RouterSettings = z.infer<typeof routerSettingsSchema>;
