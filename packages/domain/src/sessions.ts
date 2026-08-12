import { z } from "zod";
import { orchestrationModeSchema } from "./agents";

export const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  root: z.string().min(1),
});
export type Project = z.infer<typeof projectSchema>;

export const appConversationSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  orchestrationMode: orchestrationModeSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AppConversation = z.infer<typeof appConversationSchema>;

export const agentSessionStatusSchema = z.enum([
  "idle", "starting", "running", "waiting_permission", "cancelling", "completed", "failed",
]);
export type AgentSessionStatus = z.infer<typeof agentSessionStatusSchema>;

export const agentSessionSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  providerSessionId: z.string().min(1).optional(),
  agentId: z.string().min(1),
  projectId: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  status: agentSessionStatusSchema,
});
export type AgentSession = z.infer<typeof agentSessionSchema>;

export const agentRunSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  startedAt: z.string().datetime(),
});
export type AgentRun = z.infer<typeof agentRunSchema>;

export interface StartSessionInput {
  conversationId: string;
  projectId: string;
  projectRoot: string;
}

export interface ResumeSessionInput extends StartSessionInput {
  providerSessionId: string;
}
