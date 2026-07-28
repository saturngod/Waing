import type { AgentDescriptor, AgentEvent, AgentModelDescriptor, AgentSession, AppConversation, AutoSelection, EffortLevel, ExecutionWorkflowRole, PermissionDecision, Project, RoleExecutionProfile, RoutingDecision, WorkflowEvent } from "@waing/domain";
import { roleExecutionProfileSchema } from "@waing/domain";
import { z } from "zod";

export { IPC_CHANNELS } from "./channels";

export const emptyInputSchema = z.undefined();
export const runFakeInputSchema = z.object({ text: z.string().min(1) });
export const permissionResponseInputSchema = z.object({
  sessionId: z.string().min(1), requestId: z.string().min(1),
  decision: z.enum(["allow_once", "allow_session", "deny"]),
});
export const routerPreviewInputSchema = z.object({ task: z.string().min(1), projectId: z.string().min(1) });
export const projectIdInputSchema = z.object({ projectId: z.string().min(1) });
export const conversationIdInputSchema = z.object({ conversationId: z.string().min(1) });
export const conversationRemoveInputSchema = z.object({ conversationId: z.string().min(1), projectId: z.string().min(1) });
/** Replay payload for an earlier conversation: its user/assistant messages plus the stored activity events. */
export interface ConversationHistory {
  conversation: AppConversation;
  messages: Array<{ role: "user" | "assistant" | "system" | "activity"; content: string; createdAt: string }>;
  events: AgentEvent[];
}
export const agentModelsInputSchema = z.object({ agentId: z.string().min(1) });
export const openLinkInputSchema = z.object({ target: z.string().min(1).max(4_096), projectId: z.string().min(1).optional() }).strict();
export const sessionSendInputSchema = z.object({ projectId: z.string().min(1), text: z.string().min(1),
  attachmentIds: z.array(z.string().uuid()).max(10).optional(),
  agentId: z.string().min(1), model: z.string().min(1).optional(), mode: z.enum(["execute", "plan", "review", "investigate"]),
  effort: z.enum(["low", "medium", "high", "max"]).optional() });
export const sessionCancelInputSchema = z.object({ sessionId: z.string().min(1) });
/**
 * Auto runs a multi-agent workflow, so `workflowRunId` is set and `session`/`resolvedAgentId` are absent — per-step
 * providers arrive as workflow events instead. A single-agent run is the mirror image: a session, no workflow run.
 * `resolvedModel`/`resolvedEffort` are what that single run actually used, including a resolved provider default.
 */
export interface SessionSendResult {
  conversation: AppConversation; session?: AgentSession; resolvedAgentId?: string;
  resolvedModel?: string; resolvedEffort?: EffortLevel; workflowRunId?: string; workflowStatus?: string;
  routing?: { routerAgentId: string; routerModelId?: string; role: ExecutionWorkflowRole; decision: RoutingDecision };
}
export const workflowRunInputSchema = z.object({ task: z.string().min(1), projectId: z.string().min(1),
  preset: z.enum(["standard", "review_loop", "review_documentation", "prd_driven"]),
  profiles: z.array(roleExecutionProfileSchema).length(8) });
export interface WorkflowRunView { runId: string; status: string; summary?: string; steps: Array<{ nodeId: string; role: string; summary: string }>; loopState: Record<string, { iteration: number; maxIterations: number }> }

export const roleProfilesInputSchema = z.object({ profiles: z.array(roleExecutionProfileSchema).length(8) });
/** `needsReview` is true while routing still runs on seeded defaults the user has neither saved nor dismissed. */
export interface RoleProfilesView { profiles: RoleExecutionProfile[]; needsReview: boolean }

/** Main-process context added to every workflow event so concurrent runs can be isolated in the renderer. */
export type DesktopWorkflowEvent = WorkflowEvent & { workflowRunId: string; projectId: string };
export interface AttachmentChoice { id: string; name: string; mimeType: string; kind: "image" | "file" }

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
}

export interface DesktopApi {
  app: { info(): Promise<AppInfo> };
  projects: {
    choose(): Promise<Project | null>;
    list(): Promise<Project[]>;
    remove(projectId: string): Promise<Project[]>;
  };
  conversations: {
    list(projectId: string): Promise<AppConversation[]>;
    history(conversationId: string): Promise<ConversationHistory>;
    remove(conversationId: string, projectId: string): Promise<AppConversation[]>;
  };
  agents: {
    list(): Promise<AgentDescriptor[]>;
    refresh(): Promise<AgentDescriptor[]>;
    models(agentId: string): Promise<AgentModelDescriptor[]>;
  };
  attachments: { choose(): Promise<AttachmentChoice[]> };
  system: { openLink(target: string, projectId?: string): Promise<void> };
  sessions: {
    send(input: z.infer<typeof sessionSendInputSchema>): Promise<SessionSendResult>;
    cancel(sessionId: string): Promise<void>;
    runFake(text: string): Promise<AgentSession>;
    onEvent(callback: (event: AgentEvent) => void): () => void;
  };
  permissions: {
    respond(sessionId: string, requestId: string, decision: PermissionDecision): Promise<void>;
  };
  router: { preview(task: string, projectId: string): Promise<AutoSelection> };
  workflows: {
    run(input: z.infer<typeof workflowRunInputSchema>): Promise<WorkflowRunView>;
    onEvent(callback: (event: DesktopWorkflowEvent) => void): () => void;
  };
  settings: {
    roles(): Promise<RoleProfilesView>;
    saveRoles(profiles: RoleExecutionProfile[]): Promise<RoleProfilesView>;
    acknowledgeRouting(): Promise<void>;
  };
  diagnostics: { export(): Promise<string | null> };
}
