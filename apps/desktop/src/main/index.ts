import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { AgentManager, PermissionManager, WorkspaceFileIndex, canonicalizeWorkspaceRoot, redactSensitiveData } from "@waing/agent-core";
import { CodexAdapter } from "@waing/adapter-codex";
import { ClaudeAdapter } from "@waing/adapter-claude";
import { AntigravityAdapter } from "@waing/adapter-antigravity";
import { OpenCodeAdapter } from "@waing/adapter-opencode";
import { AgentRouterClient, OpenCodeRouterClient, RouterManager } from "@waing/router";
import type { RouterClient } from "@waing/router";
import { AgentStepExecutor, InMemoryWorkflowRepository, WorkflowCompiler,
  WorkflowEngine, WorkflowEventBus, WorkflowValidator, buildDefaultRouterSettings, buildStarterAgentProfiles, sortAgentProfiles } from "@waing/workflow";
import { PersistenceStore, SqliteDatabase, SqliteWorkflowRepository } from "@waing/persistence";
import { IPC_CHANNELS, agentModelsInputSchema, conversationIdInputSchema, conversationRemoveInputSchema, emptyInputSchema,
  agentSettingsInputSchema, attachmentChoiceSchema, attachmentsAddInputSchema, fileSearchInputSchema, permissionResponseInputSchema, questionResponseInputSchema, projectIdInputSchema, runFakeInputSchema,
  sessionCancelInputSchema, sessionSendInputSchema, openLinkInputSchema } from "@waing/ipc-contracts";
import type { AgentSettingsView, AttachmentChoice, ConversationHistory, SessionSendResult } from "@waing/ipc-contracts";
import type { AgentDescriptor, AgentProfile, AgentRequest, AppConversation, Project, RouterSettings } from "@waing/domain";
import { FakeAgent } from "./FakeAgent";
import { SecretStore } from "./SecretStore";

const projects = new Map<string, Project>();
const agentManager = new AgentManager();
const permissionManager = new PermissionManager();
const workspaceFiles = new WorkspaceFileIndex();
const assistantBuffers = new Map<string, string>();
/** Workflow step sessions use the run id internally; persistence and the UI use the stable app conversation id. */
const workflowConversationIds = new Map<string, string>();
const selectedAttachments = new Map<string, AttachmentChoice & { path: string }>();
let attachmentTempDirectory: string | undefined;
const trustedWebContents = new Set<number>();
let database: SqliteDatabase | undefined;
let persistence: PersistenceStore | undefined;
let workflowRepository: SqliteWorkflowRepository | undefined;
let secretStore: SecretStore | undefined;
const activeChatRuns = new Map<string, WorkflowEngine>();
/** Routing runs are internal: their events must not reach the transcript as if an agent were answering the user. */
const routerSessionIds = new Set<string>();
const ROUTER_TIMEOUT_MS = 90_000;
let contentSecurityPolicyConfigured = false;

const IMAGE_MIME_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic", ".svg": "image/svg+xml" };
function attachmentMimeType(path: string): string {
  return IMAGE_MIME_TYPES[extname(path).toLocaleLowerCase()] ?? "application/octet-stream";
}
function safeAttachmentExtension(name: string): string {
  const extension = extname(basename(name));
  return /^\.[a-z0-9]{1,10}$/iu.test(extension) ? extension.toLocaleLowerCase() : "";
}
function takeAttachments(ids: readonly string[] | undefined): Array<AttachmentChoice & { path: string }> {
  if (ids === undefined) return [];
  return ids.map((id) => {
    const attachment = selectedAttachments.get(id);
    if (attachment === undefined) throw new Error("Choose the attachment again before sending");
    return attachment;
  });
}
function taskWithAttachments(text: string, attachments: ReadonlyArray<AttachmentChoice & { path: string }>): string {
  if (attachments.length === 0) return text;
  const references = attachments.map((item) => `- ${item.name.replaceAll(/[\r\n]/g, " ")} (${item.mimeType}): ${item.path}`);
  return `${text}\n\nUser-selected attachments:\n${references.join("\n")}\nUse these files as task context.`;
}
/** Gives a fresh routed workflow enough bounded history to understand a follow-up without changing the user's text. */
function taskWithConversationHistory(text: string, messages: ReadonlyArray<{ role: string; content: string }>): string {
  if (messages.length === 0) return text;
  const transcript = messages.slice(-20).map((message) => `${message.role.toUpperCase()}: ${message.content}`).join("\n\n");
  const boundedTranscript = transcript.length > 20_000 ? transcript.slice(-20_000) : transcript;
  return `Continue the existing Waing conversation. Use its prior plan, decisions, and results as context.\n\n`
    + `Prior conversation:\n${boundedTranscript}\n\nNew user message:\n${text}`;
}
export function getSecretStore(): SecretStore {
  if (secretStore === undefined) throw new Error("Secret storage is not initialized");
  return secretStore;
}

function configureContentSecurityPolicy(electronSession: Electron.Session): void {
  if (contentSecurityPolicyConfigured) return;
  contentSecurityPolicyConfigured = true;
  const development = process.env.ELECTRON_RENDERER_URL !== undefined;
  // The dev policy allows inline scripts only because @vitejs/plugin-react injects an inline Fast Refresh
  // preamble into the dev server's HTML. The packaged policy below stays free of every inline escape hatch.
  const policy = development
    ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  electronSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== "mainFrame") {
      callback(details.responseHeaders === undefined ? {} : { responseHeaders: details.responseHeaders }); return;
    }
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [policy] } });
  });
}
agentManager.registry.register(new CodexAdapter());
agentManager.registry.register(new ClaudeAdapter());
agentManager.registry.register(new AntigravityAdapter());
agentManager.registry.register(new OpenCodeAdapter());
agentManager.eventBus.subscribe((event) => {
  if (event.type !== "permission.requested") return;
  const session = agentManager.sessions.get(event.sessionId);
  const projectId = session.projectId;
  // Every workflow step opens its own provider session, so "allow for session" is remembered against the
  // conversation instead — otherwise the same command is re-approved at every handoff between roles.
  const scopeId = workflowConversationIds.get(session.conversationId) ?? session.conversationId;
  const profile = agentManager.permissionProfileFor(event.sessionId);
  void permissionManager.request(projectId, event.request,
    { scopeId, ...(profile === undefined ? {} : { profile }) }).then((decision) => {
    try { persistence?.savePermission(projectId, event.request, decision); }
    catch { /* a persistence failure must not strand an active provider approval */ }
    return agentManager.respondToPermission(event.sessionId, event.request.id, decision);
  });
});
agentManager.eventBus.subscribe((event) => {
  if (routerSessionIds.has(event.sessionId)) return;
  const safeEvent = redactSensitiveData(event);
  try {
    const session = agentManager.sessions.get(event.sessionId);
    const conversationId = workflowConversationIds.get(session.conversationId) ?? session.conversationId;
    persistence?.saveProviderSession({ id: session.id, conversationId, agentId: session.agentId,
      ...(session.providerSessionId === undefined ? {} : { providerSessionId: session.providerSessionId }),
      status: session.status, payload: session, updatedAt: session.updatedAt });
    persistence?.saveSignificantEvent(conversationId, safeEvent);
    if (safeEvent.type === "message.delta") {
      assistantBuffers.set(session.id, `${assistantBuffers.get(session.id) ?? ""}${safeEvent.text}`);
    } else if (safeEvent.type === "message.completed") {
      assistantBuffers.set(session.id, safeEvent.text);
    } else if (safeEvent.type === "run.completed") {
      const content = assistantBuffers.get(session.id);
      if (content !== undefined && content.length > 0) persistence?.saveMessage({ id: randomUUID(),
        conversationId, role: "assistant", content, createdAt: safeEvent.timestamp });
      assistantBuffers.delete(session.id);
    }
  } catch { /* workflow/session setup can race the first normalized event */ }
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC_CHANNELS.sessionsEvent, safeEvent);
});

function assertTrustedIpc(event: Electron.IpcMainInvokeEvent): void {
  if (!trustedWebContents.has(event.sender.id)) throw new Error("IPC request rejected from an untrusted renderer");
}

const ROUTING_CONFIGURED_SETTING = "routing.configured";
const ROUTING_ACKNOWLEDGED_SETTING = "routing.acknowledged";

/**
 * Role profiles are the single source of truth for which provider runs which role. Settings owns them; the first
 * launch seeds them from the providers that are actually installed and flags the result for review.
 */
async function resolveAgentProfiles(): Promise<AgentSettingsView> {
  const stored = persistence?.listAgentProfiles() ?? [];
  const configured = persistence?.getSetting<boolean>(ROUTING_CONFIGURED_SETTING) === true;
  const acknowledged = persistence?.getSetting<boolean>(ROUTING_ACKNOWLEDGED_SETTING) === true;
  const descriptors = await agentManager.discoverAll();
  const router = persistence?.getSetting<RouterSettings>("router.settings") ?? buildDefaultRouterSettings(descriptors);
  if (stored.length > 0) return { profiles: sortAgentProfiles(stored), router, needsReview: !configured && !acknowledged };
  const seeded = buildStarterAgentProfiles(descriptors);
  for (const profile of seeded) persistence?.saveAgentProfile(profile);
  persistence?.setSetting("router.settings", router);
  return { profiles: seeded, router, needsReview: !configured && !acknowledged };
}

/**
 * Builds the routing client for whichever provider the Router role profile names. OpenCode gets the dedicated client
 * that switches every tool off at the protocol level; any other provider runs the routing prompt through its own
 * adapter. Passing a model that belongs to one provider to a different one is what made a non-OpenCode router hang.
 */
function createRouterClient(profile: RouterSettings | undefined, project: Project,
  onRouterSession?: (sessionId: string) => void): RouterClient & { shutdown(): Promise<void> } {
  const model = profile?.modelId;
  // "default" is a placeholder some model lists expose; it must never be forwarded as a real model id.
  const usableModel = model === undefined || model === "default" ? undefined : model;
  if (profile === undefined || profile.agentId === "opencode") {
    return new OpenCodeRouterClient({ projectRoot: project.root, ...(usableModel === undefined ? {} : { model: usableModel }) });
  }
  return new AgentRouterClient({ agents: agentManager, agentId: profile.agentId, projectId: project.id,
    projectRoot: project.root, ...(usableModel === undefined ? {} : { model: usableModel }),
    ...(profile.effort === undefined ? {} : { effort: profile.effort }),
    onSession: (sessionId) => { routerSessionIds.add(sessionId); onRouterSession?.(sessionId); } });
}

/**
 * Runs a chat message as the adaptive multi-agent workflow: router → implementing role → optional review/document.
 * Step providers, models, and efforts come from the saved role profiles, and every engine event is forwarded to the
 * renderer so the chat transcript shows each agent as it starts.
 */
async function runChatWorkflow(project: Project, task: string, workflowTask = task,
  existingConversation?: AppConversation): Promise<SessionSendResult> {
  const { profiles, router } = await resolveAgentProfiles();
  await assertAgentsUsable(profiles);
  const definition = new WorkflowCompiler().compileAdaptive(profiles);
  const repository = workflowRepository ?? new InMemoryWorkflowRepository();
  await repository.saveDefinition(definition);
  const ownedRouterSessionIds = new Set<string>();
  const routerClient = createRouterClient(router, project, (sessionId) => ownedRouterSessionIds.add(sessionId));
  // A router call may have to cold-start a provider CLI, which routinely outlasts the 15s library default. The chat
  // preset consults the router after every step, so it also needs the larger decision budget that loop is sized for.
  const engine = new WorkflowEngine(repository, new AgentStepExecutor(agentManager),
    new RouterManager(routerClient, ROUTER_TIMEOUT_MS), new WorkflowEventBus(), new WorkflowValidator(),
    { maxRouterDecisions: 20, maxSameActionWithoutStateChange: 2, onExhausted: "ask_user" });
  const title = existingConversation?.title ?? task.slice(0, 80);
  let conversation: AppConversation = existingConversation ?? { id: randomUUID(), projectId: project.id, title,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let workflowRunId: string | undefined;
  const unsubscribe = engine.events.subscribe((event) => {
    if (event.type === "workflow.started") {
      const now = new Date().toISOString();
      conversation = { ...conversation, updatedAt: now };
      persistence?.saveConversation(conversation);
      persistence?.saveMessage({ id: randomUUID(), conversationId: conversation.id, role: "user", content: task, createdAt: now });
      workflowRunId = event.workflowRunId;
      workflowConversationIds.set(event.workflowRunId, conversation.id);
      activeChatRuns.set(event.workflowRunId, engine);
    }
    const runId = event.type === "workflow.started" ? event.workflowRunId : workflowRunId;
    if (runId !== undefined) {
      const desktopEvent = { ...event, workflowRunId: runId, projectId: project.id, conversationId: conversation.id };
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC_CHANNELS.workflowsEvent, desktopEvent);
    }
  });
  try {
    const result = await engine.run({ definition, profiles,
      projectId: project.id, projectRoot: project.root, task: workflowTask });
    if (result.run.summary !== undefined) persistence?.saveMessage({ id: randomUUID(), conversationId: conversation.id,
      role: "assistant", content: result.run.summary, createdAt: new Date().toISOString() });
    return { conversation, workflowRunId: result.run.id, workflowStatus: result.run.status };
  } finally {
    unsubscribe();
    if (workflowRunId !== undefined) activeChatRuns.delete(workflowRunId);
    if (workflowRunId !== undefined) workflowConversationIds.delete(workflowRunId);
    await routerClient.shutdown();
    for (const sessionId of ownedRouterSessionIds) routerSessionIds.delete(sessionId);
  }
}

/**
 * Fails before the first step when a role points at a provider that cannot run, naming the role and the reason.
 * Without this a workflow dies three steps in — for instance when the review role still points at a provider whose
 * CLI has stopped accepting this client.
 */
async function assertAgentsUsable(profiles: readonly AgentProfile[]): Promise<void> {
  const descriptors = new Map((await agentManager.discoverAll()).map((descriptor) => [descriptor.id, descriptor]));
  const broken = profiles.filter((profile) => profile.enabled)
    .map((profile) => ({ profile, descriptor: descriptors.get(profile.agentId) }))
    .filter((entry) => entry.descriptor === undefined || !entry.descriptor.available);
  if (broken.length === 0) return;
  const details = broken.map(({ profile, descriptor }) => {
    const reason = descriptor === undefined ? "provider is not registered"
      : !descriptor.installed ? "CLI is not installed" : descriptor.warnings[0] ?? "provider is unavailable";
    return `${profile.name} → ${profile.agentId} (${reason})`;
  });
  throw new Error(`Change these agents in Settings before running: ${details.join("; ")}`);
}

/** Best-effort provider default, used only for display; a probe failure must never fail the run. */
async function defaultModelId(agentId: string): Promise<string | undefined> {
  try { return (await agentManager.registry.get(agentId).listModels()).find((model) => model.isDefault)?.modelId; }
  catch { return undefined; }
}

function registerIpc(): void {
  if (process.env.WAING_E2E === "1") {
    const project = { id: "e2e-project", name: "E2E Workspace", root: process.cwd() };
    projects.set(project.id, project); const now = new Date().toISOString();
    persistence?.saveProject({ ...project, realPath: project.root, createdAt: now, lastOpenedAt: now });
  }
  ipcMain.handle(IPC_CHANNELS.appInfo, (event, input: unknown) => {
    assertTrustedIpc(event);
    emptyInputSchema.parse(input);
    return { name: app.getName(), version: app.getVersion(), platform: process.platform };
  });

  ipcMain.handle(IPC_CHANNELS.projectsChoose, async (event, input: unknown) => {
    assertTrustedIpc(event);
    emptyInputSchema.parse(input);
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    const selected = result.filePaths[0];
    if (result.canceled || selected === undefined) return null;

    const root = await canonicalizeWorkspaceRoot(await realpath(selected));
    // Scanning now means the first `@` in the composer renders from cache instead of waiting on a cold scan.
    void workspaceFiles.warm(root).catch(() => { /* the picker rescans on demand */ });
    const existing = [...projects.values()].find((project) => project.root === root);
    if (existing !== undefined) return existing;

    const project: Project = { id: randomUUID(), name: basename(root), root };
    projects.set(project.id, project);
    const now = new Date().toISOString();
    persistence?.saveProject({ ...project, realPath: root, createdAt: now, lastOpenedAt: now });
    return project;
  });

  ipcMain.handle(IPC_CHANNELS.projectsList, (event, input: unknown) => {
    assertTrustedIpc(event);
    emptyInputSchema.parse(input);
    return [...projects.values()];
  });
  ipcMain.handle(IPC_CHANNELS.projectsRemove, (event, input: unknown) => {
    assertTrustedIpc(event);
    const { projectId } = projectIdInputSchema.parse(input);
    const removed = projects.get(projectId);
    if (removed === undefined) throw new Error("Unknown project");
    persistence?.removeProject(projectId);
    workspaceFiles.invalidate(removed.root);
    projects.delete(projectId);
    return [...projects.values()];
  });
  ipcMain.handle(IPC_CHANNELS.projectsReveal, (event, input: unknown) => {
    assertTrustedIpc(event);
    const { projectId } = projectIdInputSchema.parse(input);
    const project = projects.get(projectId);
    if (project === undefined) throw new Error("Unknown project");
    shell.showItemInFolder(project.root);
  });
  ipcMain.handle(IPC_CHANNELS.systemOpenLink, async (event, input: unknown) => {
    assertTrustedIpc(event);
    const { target, projectId } = openLinkInputSchema.parse(input);
    let url: URL | undefined;
    try { url = new URL(target); } catch { /* Relative project path. */ }
    if (url !== undefined && ["http:", "https:", "mailto:"].includes(url.protocol)) {
      await shell.openExternal(url.toString()); return;
    }
    if (url !== undefined && url.protocol !== "file:") throw new Error("Unsupported link type");
    if (projectId === undefined) throw new Error("A project is required to open a local link");
    const project = projects.get(projectId);
    if (project === undefined) throw new Error("Unknown project");
    const rawPath = url?.protocol === "file:" ? decodeURIComponent(url.pathname) : target.split(/[?#]/u, 1)[0]!;
    const candidate = isAbsolute(rawPath) ? rawPath : resolve(project.root, rawPath);
    const [workspaceRoot, targetPath] = await Promise.all([realpath(project.root), realpath(candidate)]);
    const child = relative(workspaceRoot, targetPath);
    if (child.startsWith("..") || isAbsolute(child)) throw new Error("Local links must stay inside the project");
    const failure = await shell.openPath(targetPath);
    if (failure.length > 0) throw new Error(failure);
  });
  ipcMain.handle(IPC_CHANNELS.conversationsList, (event, input: unknown) => {
    assertTrustedIpc(event);
    const { projectId } = projectIdInputSchema.parse(input);
    if (!projects.has(projectId)) throw new Error("Unknown project");
    return persistence?.listConversations(projectId) ?? [];
  });
  ipcMain.handle(IPC_CHANNELS.conversationsHistory, (event, input: unknown) => {
    assertTrustedIpc(event);
    const { conversationId } = conversationIdInputSchema.parse(input);
    const conversation = persistence?.getConversation(conversationId);
    // Reading history is scoped to projects the session actually has open, never an arbitrary row id.
    if (conversation === undefined || !projects.has(conversation.projectId)) throw new Error("Unknown conversation");
    return { conversation, messages: persistence?.listMessages(conversationId) ?? [],
      events: persistence?.listEvents(conversationId) ?? [],
      announcements: workflowRepository?.loadHistory(conversationId).announcements ?? [] } satisfies ConversationHistory;
  });
  ipcMain.handle(IPC_CHANNELS.conversationsRemove, (event, input: unknown) => {
    assertTrustedIpc(event);
    const { conversationId, projectId } = conversationRemoveInputSchema.parse(input);
    if (!projects.has(projectId)) throw new Error("Unknown project");
    if (persistence?.getConversation(conversationId)?.projectId !== projectId) throw new Error("Unknown conversation");
    if ([...workflowConversationIds.values()].includes(conversationId)) throw new Error("Stop the running task before removing this conversation");
    persistence?.removeConversation(conversationId);
    return persistence?.listConversations(projectId) ?? [];
  });

  const listAgents = async (_event: Electron.IpcMainInvokeEvent, input: unknown): Promise<AgentDescriptor[]> => {
    assertTrustedIpc(_event);
    emptyInputSchema.parse(input);
    const descriptors = await agentManager.discoverAll();
    for (const descriptor of descriptors) {
      persistence?.saveProviderInstallation(descriptor.id, { installed: descriptor.installed, version: descriptor.version,
        executablePath: descriptor.executablePath, warnings: descriptor.warnings });
      persistence?.saveProviderHealth(descriptor.id, { available: descriptor.available, authState: descriptor.authState,
        capabilities: descriptor.capabilities, warnings: descriptor.warnings });
    }
    return descriptors;
  };
  ipcMain.handle(IPC_CHANNELS.agentsList, listAgents);
  ipcMain.handle(IPC_CHANNELS.agentsRefresh, listAgents);
  ipcMain.handle(IPC_CHANNELS.agentsModels, async (event, input: unknown) => {
    assertTrustedIpc(event);
    const { agentId } = agentModelsInputSchema.parse(input);
    return agentManager.registry.get(agentId).listModels();
  });
  ipcMain.handle(IPC_CHANNELS.filesSearch, async (event, input: unknown) => {
    assertTrustedIpc(event);
    const { projectId, query, limit } = fileSearchInputSchema.parse(input);
    const project = projects.get(projectId);
    if (project === undefined) throw new Error("Unknown project");
    return workspaceFiles.search(project.root, query, limit ?? 20);
  });
  ipcMain.handle(IPC_CHANNELS.attachmentsChoose, async (event, input: unknown): Promise<AttachmentChoice[]> => {
    assertTrustedIpc(event);
    emptyInputSchema.parse(input);
    const result = await dialog.showOpenDialog({ title: "Attach files to this task",
      properties: ["openFile", "multiSelections"], filters: [
        { name: "Images and files", extensions: ["png", "jpg", "jpeg", "gif", "webp", "heic", "svg", "pdf", "txt", "md", "json", "csv"] },
        { name: "All files", extensions: ["*"] },
      ] });
    if (result.canceled) return [];
    const choices = result.filePaths.slice(0, 10).map((path) => {
      const id = randomUUID(); const mimeType = attachmentMimeType(path);
      const choice: AttachmentChoice & { path: string } = { id, name: basename(path), mimeType,
        kind: mimeType.startsWith("image/") ? "image" : "file", path };
      selectedAttachments.set(id, choice);
      return { id: choice.id, name: choice.name, mimeType: choice.mimeType, kind: choice.kind };
    });
    while (selectedAttachments.size > 100) {
      const oldest = selectedAttachments.keys().next().value;
      if (oldest === undefined) break; selectedAttachments.delete(oldest);
    }
    return choices;
  });
  ipcMain.handle(IPC_CHANNELS.attachmentsAdd, async (event, input: unknown): Promise<AttachmentChoice[]> => {
    assertTrustedIpc(event);
    const { files } = attachmentsAddInputSchema.parse(input);
    attachmentTempDirectory ??= join(app.getPath("temp"), `waing-attachments-${String(process.pid)}`);
    await mkdir(attachmentTempDirectory, { recursive: true });
    const choices = await Promise.all(files.map(async (file) => {
      const id = randomUUID();
      const path = join(attachmentTempDirectory!, `${id}${safeAttachmentExtension(file.name)}`);
      await writeFile(path, file.bytes, { flag: "wx", mode: 0o600 });
      const choice: AttachmentChoice & { path: string } = { id, name: basename(file.name), mimeType: file.mimeType,
        kind: file.mimeType.startsWith("image/") ? "image" : "file", path };
      selectedAttachments.set(id, choice);
      return attachmentChoiceSchema.parse({ id: choice.id, name: choice.name, mimeType: choice.mimeType, kind: choice.kind });
    }));
    while (selectedAttachments.size > 100) {
      const oldest = selectedAttachments.keys().next().value;
      if (oldest === undefined) break; selectedAttachments.delete(oldest);
    }
    return choices;
  });
  ipcMain.handle(IPC_CHANNELS.sessionsSend, async (event, input: unknown) => {
    assertTrustedIpc(event);
    const request = sessionSendInputSchema.parse(input);
    const project = projects.get(request.projectId);
    if (project === undefined) throw new Error("Choose a project before sending a task");
    const existingConversation = request.conversationId === undefined ? undefined : persistence?.getConversation(request.conversationId);
    if (request.conversationId !== undefined
      && (existingConversation === undefined || existingConversation.projectId !== project.id)) throw new Error("Unknown conversation");
    const priorMessages = existingConversation === undefined ? [] : persistence?.listMessages(existingConversation.id) ?? [];
    const attachments = takeAttachments(request.attachmentIds);
    const effectiveText = taskWithAttachments(request.text, attachments);
    const contextualText = taskWithConversationHistory(effectiveText, priorMessages);
    // Auto is the multi-agent path: the router picks the implementing role and decides after each stage whether the
    // work still needs a review or documentation. An explicit provider choice stays a single run below.
    if (request.agentId === "auto" && process.env.WAING_E2E !== "1") {
      return runChatWorkflow(project, request.text, contextualText, existingConversation);
    }
    const now = new Date().toISOString();
    const conversation: AppConversation = existingConversation === undefined
      ? { id: randomUUID(), projectId: project.id, title: request.text.slice(0, 80), createdAt: now, updatedAt: now }
      : { ...existingConversation, updatedAt: now };
    persistence?.saveConversation(conversation);
    persistence?.saveMessage({ id: randomUUID(), conversationId: conversation.id, role: "user", content: request.text, createdAt: now });
    let resolvedAgentId = request.agentId;
    if (request.agentId === "auto") {
      resolvedAgentId = "fake";
      const workflowRunId = randomUUID();
      const desktopEvent = { type: "workflow.route.selected" as const, agentProfileId: "coder", agentName: "Coder",
        workflowRunId, projectId: project.id, conversationId: conversation.id };
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC_CHANNELS.workflowsEvent, desktopEvent);
    }
    const previousSession = persistence?.listProviderSessions(conversation.id)
      .find((candidate) => candidate.agentId === resolvedAgentId && candidate.providerSessionId !== undefined);
    const session = previousSession?.providerSessionId === undefined
      ? await agentManager.startSession(resolvedAgentId, { conversationId: conversation.id,
        projectId: project.id, projectRoot: project.root })
      : await agentManager.resumeSession(resolvedAgentId, { conversationId: conversation.id,
        projectId: project.id, projectRoot: project.root, providerSessionId: previousSession.providerSessionId });
    persistence?.saveProviderSession({ id: session.id, conversationId: conversation.id, agentId: session.agentId,
      ...(session.providerSessionId === undefined ? {} : { providerSessionId: session.providerSessionId }), status: session.status,
      payload: session, updatedAt: session.updatedAt });
    const model = request.model;
    const effort = request.effort;
    const agentAttachments: NonNullable<AgentRequest["attachments"]> = attachments.map((item) =>
      ({ name: item.name, mimeType: item.mimeType, path: item.path }));
    await agentManager.send(session.id, { text: previousSession === undefined ? contextualText : effectiveText,
      projectRoot: project.root, mode: request.mode,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(agentAttachments.length === 0 ? {} : { attachments: agentAttachments }) });
    // Nothing chose a model, so report the provider default the run fell back to instead of leaving the label blank.
    const resolvedModel = model ?? await defaultModelId(resolvedAgentId);
    return { conversation, session, resolvedAgentId,
      ...(resolvedModel === undefined ? {} : { resolvedModel }),
      ...(effort === undefined ? {} : { resolvedEffort: effort }) } satisfies SessionSendResult;
  });
  ipcMain.handle(IPC_CHANNELS.sessionsCancel, async (event, input: unknown) => {
    assertTrustedIpc(event);
    const { sessionId } = sessionCancelInputSchema.parse(input);
    // Auto chat runs are workflows, so Stop cancels the engine when the renderer passes back a workflow run id.
    const workflow = activeChatRuns.get(sessionId);
    if (workflow !== undefined) { await workflow.cancel(); return; }
    await agentManager.cancel(sessionId);
  });
  ipcMain.handle(IPC_CHANNELS.permissionsRespond, (event, input: unknown) => {
    assertTrustedIpc(event);
    const response = permissionResponseInputSchema.parse(input);
    permissionManager.respond(response.requestId, response.decision, response.sessionId);
  });
  ipcMain.handle(IPC_CHANNELS.questionsRespond, async (event, input: unknown) => {
    assertTrustedIpc(event);
    const response = questionResponseInputSchema.parse(input);
    await agentManager.respondToQuestion(response.sessionId, response.questionId, response.answers);
  });
  ipcMain.handle(IPC_CHANNELS.settingsAgentsGet, async (event, input: unknown) => {
    assertTrustedIpc(event);
    emptyInputSchema.parse(input);
    return resolveAgentProfiles();
  });
  ipcMain.handle(IPC_CHANNELS.settingsAgentsSave, (event, input: unknown): AgentSettingsView => {
    assertTrustedIpc(event);
    const { profiles, router } = agentSettingsInputSchema.parse(input);
    const previous = persistence?.listAgentProfiles() ?? [];
    for (const profile of previous) if (!profiles.some((candidate) => candidate.id === profile.id)) persistence?.removeAgentProfile(profile.id);
    for (const profile of profiles) persistence?.saveAgentProfile(profile);
    persistence?.setSetting("router.settings", router);
    persistence?.setSetting(ROUTING_CONFIGURED_SETTING, true);
    return { profiles: sortAgentProfiles(profiles), router, needsReview: false };
  });
  ipcMain.handle(IPC_CHANNELS.settingsAgentsAcknowledge, (event, input: unknown) => {
    assertTrustedIpc(event);
    emptyInputSchema.parse(input);
    persistence?.setSetting(ROUTING_ACKNOWLEDGED_SETTING, true);
  });
  ipcMain.handle(IPC_CHANNELS.diagnosticsExport, async (event, input: unknown) => {
    assertTrustedIpc(event); emptyInputSchema.parse(input);
    const result = await dialog.showSaveDialog({ title: "Export redacted Waing diagnostics",
      defaultPath: `waing-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (result.canceled || result.filePath === undefined) return null;
    const providers = redactSensitiveData(await agentManager.discoverAll());
    await writeFile(result.filePath, JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(),
      app: { version: app.getVersion(), platform: process.platform, arch: process.arch }, providers,
      diagnosticsPolicy: "No source files, message content, credentials, or environment variables are included." }, null, 2),
    { encoding: "utf8", mode: 0o600 });
    return result.filePath;
  });

  if (process.env.WAING_E2E === "1") {
    agentManager.registry.register(new FakeAgent());
    ipcMain.handle(IPC_CHANNELS.sessionsRunFake, async (event, input: unknown) => {
      assertTrustedIpc(event);
      const { text } = runFakeInputSchema.parse(input);
      const session = await agentManager.startSession("fake", {
        conversationId: randomUUID(), projectId: "e2e-project", projectRoot: process.cwd(),
      });
      await agentManager.send(session.id, { text, projectRoot: process.cwd(), mode: "execute" });
      return session;
    });
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 860,
    minHeight: 600,
    show: false,
    title: "Waing",
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const,
      trafficLightPosition: { x: 16, y: 18 } } : {}),
    webPreferences: {
      preload: new URL("../preload/index.cjs", import.meta.url).pathname,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  configureContentSecurityPolicy(window.webContents.session);
  const webContentsId = window.webContents.id;
  trustedWebContents.add(webContentsId);

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const current = window.webContents.getURL();
    if (url !== current) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  // `closed` fires after the native window is destroyed, so the id must be captured while it is still reachable.
  window.once("closed", () => { trustedWebContents.delete(webContentsId); permissionManager.closeAll(); });

  if (process.env.ELECTRON_RENDERER_URL !== undefined) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(new URL("../renderer/index.html", import.meta.url).pathname);
  }
  return window;
}

void app.whenReady().then(() => {
  secretStore = new SecretStore(join(app.getPath("userData"), "secrets.enc.json"));
  database = new SqliteDatabase(process.env.WAING_E2E === "1" ? ":memory:" : join(app.getPath("userData"), "waing.sqlite"));
  persistence = new PersistenceStore(database);
  persistence.recoverInterruptedSessions();
  workflowRepository = new SqliteWorkflowRepository(database);
  for (const stored of persistence.listProjects()) projects.set(stored.id, { id: stored.id, name: stored.name, root: stored.root });
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  permissionManager.closeAll();
  void agentManager.shutdown();
});
app.on("will-quit", () => {
  if (attachmentTempDirectory !== undefined) rmSync(attachmentTempDirectory, { recursive: true, force: true });
  database?.close(); database = undefined; persistence = undefined; workflowRepository = undefined; secretStore = undefined;
});
