import type { AgentDescriptor, AgentProfile, AgentQuestionResponse, AgentEvent, AgentModelDescriptor, AgentSession, AppConversation, EffortLevel, PermissionDecision, Project, RouterSettings, StepAnnouncement, WorkflowEvent, WorkspaceFileMatches } from "@waing/domain";
import { agentProfileSchema, agentQuestionResponseSchema, orchestrationModeSchema, routerSettingsSchema } from "@waing/domain";
import { z } from "zod";

export { IPC_CHANNELS } from "./channels";

export const emptyInputSchema = z.undefined();
export const runFakeInputSchema = z.object({ text: z.string().min(1) });
export const permissionResponseInputSchema = z.object({
  sessionId: z.string().min(1), requestId: z.string().min(1),
  decision: z.enum(["allow_once", "allow_session", "deny"]),
});
export const questionResponseInputSchema = z.object({
  sessionId: z.string().min(1), questionId: z.string().min(1), answers: agentQuestionResponseSchema,
});
export const projectIdInputSchema = z.object({ projectId: z.string().min(1) });
export const conversationIdInputSchema = z.object({ conversationId: z.string().min(1) });
export const conversationRemoveInputSchema = z.object({ conversationId: z.string().min(1), projectId: z.string().min(1) });
/** Replay payload for an earlier conversation: its user/assistant messages plus the stored activity events. */
export interface ConversationHistory {
  conversation: AppConversation;
  messages: Array<{ role: "user" | "assistant" | "system" | "activity"; content: string; createdAt: string }>;
  events: AgentEvent[];
  announcements: StepAnnouncement[];
}
export const agentModelsInputSchema = z.object({ agentId: z.string().min(1) });
/**
 * The `@` mention picker. It names a project, never a path: the renderer cannot point this at a directory of
 * its choosing, and results stay inside whatever root that project was canonicalized to.
 */
export const fileSearchInputSchema = z.object({ projectId: z.string().min(1),
  query: z.string().max(200), limit: z.number().int().min(1).max(50).optional() }).strict();
export const openLinkInputSchema = z.object({ target: z.string().min(1).max(4_096), projectId: z.string().min(1).optional() }).strict();
export const sessionSendInputSchema = z.object({ projectId: z.string().min(1), text: z.string().min(1),
  conversationId: z.string().min(1).optional(),
  attachmentIds: z.array(z.string().uuid()).max(10).optional(),
  agentId: z.string().min(1), orchestrationMode: orchestrationModeSchema.optional(), model: z.string().min(1).optional(), mode: z.enum(["execute", "plan", "review", "investigate"]),
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
}
export const agentSettingsInputSchema = z.object({ profiles: z.array(agentProfileSchema).min(1), router: routerSettingsSchema }).strict()
  .superRefine((value, context) => {
    if (!value.profiles.some((profile) => profile.enabled)) context.addIssue({ code: "custom", message: "At least one agent must be enabled" });
    if (new Set(value.profiles.map((profile) => profile.id)).size !== value.profiles.length) context.addIssue({ code: "custom", message: "Agent ids must be unique" });
  });
/** `needsReview` is true while routing still runs on seeded defaults the user has neither saved nor dismissed. */
export interface AgentSettingsView { profiles: AgentProfile[]; router: RouterSettings; needsReview: boolean }

/** Main-process context added to every workflow event so concurrent runs can be isolated in the renderer. */
export type DesktopWorkflowEvent = WorkflowEvent & { workflowRunId: string; projectId: string; conversationId: string };
export const attachmentChoiceSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(255), mimeType: z.string().min(1).max(255),
  kind: z.enum(["image", "file"]),
}).strict();
export type AttachmentChoice = z.infer<typeof attachmentChoiceSchema>;
export const attachmentsAddInputSchema = z.object({ files: z.array(z.object({
  name: z.string().min(1).max(255), mimeType: z.string().min(1).max(255),
  bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= 20 * 1024 * 1024,
    "Attachments must be between 1 byte and 20 MB"),
}).strict()).min(1).max(10) }).strict().refine(
  ({ files }) => files.reduce((total, file) => total + file.bytes.byteLength, 0) <= 50 * 1024 * 1024,
  "Attachments may total at most 50 MB",
);
export type AttachmentUpload = z.infer<typeof attachmentsAddInputSchema>["files"][number];

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
    reveal(projectId: string): Promise<void>;
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
  files: { search(projectId: string, query: string, limit?: number): Promise<WorkspaceFileMatches> };
  attachments: {
    choose(): Promise<AttachmentChoice[]>;
    add(files: AttachmentUpload[]): Promise<AttachmentChoice[]>;
  };
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
  questions: {
    respond(sessionId: string, questionId: string, answers: AgentQuestionResponse): Promise<void>;
  };
  workflows: {
    onEvent(callback: (event: DesktopWorkflowEvent) => void): () => void;
  };
  settings: {
    agents(): Promise<AgentSettingsView>;
    saveAgents(profiles: AgentProfile[], router: RouterSettings): Promise<AgentSettingsView>;
    acknowledgeRouting(): Promise<void>;
  };
  diagnostics: { export(): Promise<string | null> };
}
