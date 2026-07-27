import { z } from "zod";

export const agentIdSchema = z.enum(["codex", "claude", "antigravity", "opencode"]);
export type AgentId = z.infer<typeof agentIdSchema>;

export const agentModeSchema = z.enum(["execute", "plan", "review", "investigate"]);
export type AgentMode = z.infer<typeof agentModeSchema>;
export const effortLevelSchema = z.enum(["low", "medium", "high", "max"]);
export type EffortLevel = z.infer<typeof effortLevelSchema>;

export const agentCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  persistentSessions: z.boolean(),
  cancellation: z.boolean(),
  concurrentRuns: z.boolean(),
  nativeStructuredOutput: z.boolean(),
  planMode: z.boolean(),
  effortControl: z.boolean(),
  interactivePermissions: z.boolean(),
  diffEvents: z.boolean(),
  shellEvents: z.boolean(),
  fileEvents: z.boolean(),
  modelSelection: z.boolean(),
  mcp: z.boolean(),
  customTools: z.boolean(),
  additionalDirectories: z.boolean(),
});
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;

export const agentDescriptorSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  installed: z.boolean(),
  available: z.boolean(),
  version: z.string().optional(),
  executablePath: z.string().optional(),
  capabilities: agentCapabilitiesSchema,
  authState: z.enum(["unknown", "ready", "missing", "error"]),
  warnings: z.array(z.string()),
});
export type AgentDescriptor = z.infer<typeof agentDescriptorSchema>;

export const agentModelDescriptorSchema = z.object({
  agentId: z.string().min(1),
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  available: z.boolean(),
  isDefault: z.boolean().optional(),
  effortLevels: z.array(effortLevelSchema).optional(),
  modes: z.array(agentModeSchema).optional(),
  warnings: z.array(z.string()).optional(),
});
export type AgentModelDescriptor = z.infer<typeof agentModelDescriptorSchema>;

export const agentAttachmentSchema = z.object({
  name: z.string().min(1),
  mimeType: z.string().min(1),
  path: z.string().min(1).optional(),
  data: z.string().optional(),
}).refine((value) => value.path !== undefined || value.data !== undefined, {
  message: "An attachment requires a path or inline data",
});

export const agentRequestSchema = z.object({
  text: z.string().min(1),
  projectRoot: z.string().min(1),
  mode: agentModeSchema,
  effort: effortLevelSchema.optional(),
  model: z.string().min(1).optional(),
  attachments: z.array(agentAttachmentSchema).optional(),
  additionalDirectories: z.array(z.string().min(1)).optional(),
  responseFormat: z.object({
    type: z.literal("json_schema"),
    name: z.string().min(1),
    schema: z.record(z.string(), z.unknown()),
  }).optional(),
});
export type AgentRequest = z.infer<typeof agentRequestSchema>;
