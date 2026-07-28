import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "@waing/ipc-contracts/channels";
import type { AppInfo, AttachmentChoice, AttachmentUpload, ConversationHistory, DesktopApi, DesktopWorkflowEvent, RoleProfilesView, SessionSendResult, WorkflowRunView } from "@waing/ipc-contracts";
import type { z } from "zod";
import type { workflowRunInputSchema } from "@waing/ipc-contracts";
import type { AgentDescriptor, AgentEvent, AgentModelDescriptor, AgentSession, AppConversation, AutoSelection, PermissionDecision, Project, RoleExecutionProfile } from "@waing/domain";

const invoke = <T>(channel: string): Promise<T> => ipcRenderer.invoke(channel, undefined) as Promise<T>;

const desktopApi: DesktopApi = Object.freeze({
  app: Object.freeze({
    info: () => invoke<AppInfo>(IPC_CHANNELS.appInfo),
  }),
  projects: Object.freeze({
    choose: () => invoke<Project | null>(IPC_CHANNELS.projectsChoose),
    list: () => invoke<Project[]>(IPC_CHANNELS.projectsList),
    reveal: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.projectsReveal, { projectId }) as Promise<void>,
    remove: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.projectsRemove, { projectId }) as Promise<Project[]>,
  }),
  conversations: Object.freeze({
    list: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.conversationsList, { projectId }) as Promise<AppConversation[]>,
    history: (conversationId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.conversationsHistory, { conversationId }) as Promise<ConversationHistory>,
    remove: (conversationId: string, projectId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.conversationsRemove, { conversationId, projectId }) as Promise<AppConversation[]>,
  }),
  agents: Object.freeze({
    list: () => invoke<AgentDescriptor[]>(IPC_CHANNELS.agentsList),
    refresh: () => invoke<AgentDescriptor[]>(IPC_CHANNELS.agentsRefresh),
    models: (agentId: string) => ipcRenderer.invoke(IPC_CHANNELS.agentsModels, { agentId }) as Promise<AgentModelDescriptor[]>,
  }),
  attachments: Object.freeze({
    choose: () => invoke<AttachmentChoice[]>(IPC_CHANNELS.attachmentsChoose),
    add: (files: AttachmentUpload[]) =>
      ipcRenderer.invoke(IPC_CHANNELS.attachmentsAdd, { files }) as Promise<AttachmentChoice[]>,
  }),
  system: Object.freeze({
    openLink: (target: string, projectId?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.systemOpenLink, { target, ...(projectId === undefined ? {} : { projectId }) }) as Promise<void>,
  }),
  sessions: Object.freeze({
    send: (input: Parameters<DesktopApi["sessions"]["send"]>[0]) =>
      ipcRenderer.invoke(IPC_CHANNELS.sessionsSend, input) as Promise<SessionSendResult>,
    cancel: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.sessionsCancel, { sessionId }) as Promise<void>,
    runFake: (text: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.sessionsRunFake, { text }) as Promise<AgentSession>,
    onEvent: (callback: (event: AgentEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, event: AgentEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.sessionsEvent, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.sessionsEvent, listener);
    },
  }),
  permissions: Object.freeze({
    respond: (sessionId: string, requestId: string, decision: PermissionDecision) =>
      ipcRenderer.invoke(IPC_CHANNELS.permissionsRespond, { sessionId, requestId, decision }) as Promise<void>,
  }),
  router: Object.freeze({
    preview: (task: string, projectId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.routerPreview, { task, projectId }) as Promise<AutoSelection>,
  }),
  workflows: Object.freeze({
    run: (input: z.infer<typeof workflowRunInputSchema>) =>
      ipcRenderer.invoke(IPC_CHANNELS.workflowsRun, input) as Promise<WorkflowRunView>,
    onEvent: (callback: (event: DesktopWorkflowEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, event: DesktopWorkflowEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.workflowsEvent, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.workflowsEvent, listener);
    },
  }),
  settings: Object.freeze({
    roles: () => invoke<RoleProfilesView>(IPC_CHANNELS.settingsRolesGet),
    saveRoles: (profiles: RoleExecutionProfile[]) =>
      ipcRenderer.invoke(IPC_CHANNELS.settingsRolesSave, { profiles }) as Promise<RoleProfilesView>,
    acknowledgeRouting: () => invoke<void>(IPC_CHANNELS.settingsRolesAcknowledge),
  }),
  diagnostics: Object.freeze({
    export: () => invoke<string | null>(IPC_CHANNELS.diagnosticsExport),
  }),
});

contextBridge.exposeInMainWorld("waing", desktopApi);
