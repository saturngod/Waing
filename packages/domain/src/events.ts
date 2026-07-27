import { z } from "zod";
import { permissionRequestSchema, permissionDecisionSchema } from "./permissions";

const eventBaseShape = {
  id: z.string().min(1),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  agentId: z.string().min(1),
  timestamp: z.string().datetime(),
  sequence: z.number().int().nonnegative(),
  workflowRunId: z.string().min(1).optional(),
  stepRunId: z.string().min(1).optional(),
  providerEventType: z.string().optional(),
};

const event = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ ...eventBaseShape, type: z.literal(type), ...shape });

export const agentEventSchema = z.discriminatedUnion("type", [
  event("run.started", {}),
  event("message.delta", { text: z.string() }),
  event("message.completed", { text: z.string() }),
  event("plan.updated", { text: z.string() }),
  event("tool.started", { tool: z.string(), input: z.unknown().optional() }),
  event("tool.progress", { tool: z.string(), detail: z.string() }),
  event("tool.completed", { tool: z.string(), output: z.unknown().optional() }),
  event("file.read", { path: z.string() }),
  event("file.changed", { path: z.string(), change: z.enum(["created", "updated", "deleted"]) }),
  event("diff.updated", { diff: z.string() }),
  event("command.started", { command: z.array(z.string()) }),
  event("command.output", { stream: z.enum(["stdout", "stderr"]), text: z.string() }),
  event("command.completed", { exitCode: z.number().int().nullable() }),
  event("permission.requested", { request: permissionRequestSchema }),
  event("permission.resolved", { requestId: z.string(), decision: permissionDecisionSchema }),
  event("usage.updated", { inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative() }),
  event("run.completed", { summary: z.string().optional() }),
  event("run.failed", { code: z.string(), message: z.string(), retryable: z.boolean() }),
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;
