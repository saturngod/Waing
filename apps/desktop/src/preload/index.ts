import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "@waing/ipc-contracts/channels";
import type { AgentSettingsView, AppInfo, AttachmentChoice, AttachmentUpload, ConversationHistory, DesktopApi, DesktopWorkflowEvent, SessionSendResult } from "@waing/ipc-contracts";
import type { AgentDescriptor, AgentEvent, AgentModelDescriptor, AgentProfile, AgentQuestionResponse, AgentSession, AppConversation, PermissionDecision, Project, RouterSettings, WorkspaceFileMatches } from "@waing/domain";

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
  files: Object.freeze({
    search: (projectId: string, query: string, limit?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.filesSearch,
        { projectId, query, ...(limit === undefined ? {} : { limit }) }) as Promise<WorkspaceFileMatches>,
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
  questions: Object.freeze({
    respond: (sessionId: string, questionId: string, answers: AgentQuestionResponse) =>
      ipcRenderer.invoke(IPC_CHANNELS.questionsRespond, { sessionId, questionId, answers }) as Promise<void>,
  }),
  workflows: Object.freeze({
    onEvent: (callback: (event: DesktopWorkflowEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, event: DesktopWorkflowEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.workflowsEvent, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.workflowsEvent, listener);
    },
  }),
  settings: Object.freeze({
    agents: () => invoke<AgentSettingsView>(IPC_CHANNELS.settingsAgentsGet),
    saveAgents: (profiles: AgentProfile[], router: RouterSettings) =>
      ipcRenderer.invoke(IPC_CHANNELS.settingsAgentsSave, { profiles, router }) as Promise<AgentSettingsView>,
    acknowledgeRouting: () => invoke<void>(IPC_CHANNELS.settingsAgentsAcknowledge),
  }),
  diagnostics: Object.freeze({
    export: () => invoke<string | null>(IPC_CHANNELS.diagnosticsExport),
  }),
});

contextBridge.exposeInMainWorld("waing", desktopApi);
