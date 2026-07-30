import { z } from "zod";
import { effortLevelSchema } from "./agent";

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
  position: z.number().int().min(0),
}).strict();
export type AgentProfile = z.infer<typeof agentProfileSchema>;

export const routerSettingsSchema = z.object({
  agentId: z.string().min(1),
  modelId: z.string().min(1).optional(),
  effort: effortLevelSchema.optional(),
}).strict();
export type RouterSettings = z.infer<typeof routerSettingsSchema>;
