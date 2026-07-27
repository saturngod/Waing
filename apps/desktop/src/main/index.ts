import { randomUUID } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { AgentManager, PermissionManager, canonicalizeWorkspaceRoot, redactSensitiveData } from "@waing/agent-core";
import { CodexAdapter } from "@waing/adapter-codex";
import { ClaudeAdapter } from "@waing/adapter-claude";
import { AntigravityAdapter } from "@waing/adapter-antigravity";
import { OpenCodeAdapter } from "@waing/adapter-opencode";
import { AgentRouterClient, AutoSelector, OpenCodeRouterClient, RouterManager } from "@waing/router";
import type { RouterClient } from "@waing/router";
import { AgentStepExecutor, InMemoryWorkflowRepository, ROLE_ORDER, WorkflowCompiler, WorkflowEngine,
  buildDefaultRoleProfiles, sortRoleProfiles } from "@waing/workflow";
import type { GlobalRoleProfiles } from "@waing/workflow";
import { PersistenceStore, SqliteDatabase, SqliteWorkflowRepository } from "@waing/persistence";
import { IPC_CHANNELS, agentModelsInputSchema, conversationIdInputSchema, conversationRemoveInputSchema, emptyInputSchema,
  permissionResponseInputSchema, projectIdInputSchema, roleProfilesInputSchema, routerPreviewInputSchema, runFakeInputSchema,
  sessionCancelInputSchema, sessionSendInputSchema, workflowRunInputSchema } from "@waing/ipc-contracts";
import type { ConversationHistory, RoleProfilesView, SessionSendResult } from "@waing/ipc-contracts";
import type { AgentDescriptor, AppConversation, Project, RoleExecutionProfile } from "@waing/domain";
import { FakeAgent } from "./FakeAgent";
import { SecretStore } from "./SecretStore";

const projects = new Map<string, Project>();
const agentManager = new AgentManager();
const permissionManager = new PermissionManager();
const assistantBuffers = new Map<string, string>();
const trustedWebContents = new Set<number>();
let database: SqliteDatabase | undefined;
let persistence: PersistenceStore | undefined;
let workflowRepository: SqliteWorkflowRepository | undefined;
let secretStore: SecretStore | undefined;
let activeChatRun: { id: string; engine: WorkflowEngine } | undefined;
/** Routing runs are internal: their events must not reach the transcript as if an agent were answering the user. */
const routerSessionIds = new Set<string>();
const ROUTER_TIMEOUT_MS = 90_000;
let contentSecurityPolicyConfigured = false;
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
  const projectId = agentManager.sessions.get(event.sessionId).projectId;
  void permissionManager.request(projectId, event.request).then((decision) => {
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
    persistence?.saveProviderSession({ id: session.id, conversationId: session.conversationId, agentId: session.agentId,
      ...(session.providerSessionId === undefined ? {} : { providerSessionId: session.providerSessionId }),
      status: session.status, payload: session, updatedAt: session.updatedAt });
    persistence?.saveSignificantEvent(session.conversationId, safeEvent);
    if (safeEvent.type === "message.delta") {
      assistantBuffers.set(session.id, `${assistantBuffers.get(session.id) ?? ""}${safeEvent.text}`);
    } else if (safeEvent.type === "message.completed") {
      assistantBuffers.set(session.id, safeEvent.text);
    } else if (safeEvent.type === "run.completed") {
      const content = assistantBuffers.get(session.id);
      if (content !== undefined && content.length > 0) persistence?.saveMessage({ id: randomUUID(),
        conversationId: session.conversationId, role: "assistant", content, createdAt: safeEvent.timestamp });
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
async function resolveRoleProfiles(): Promise<RoleProfilesView> {
  const stored = persistence?.listRoleProfiles("global", "default") ?? [];
  const configured = persistence?.getSetting<boolean>(ROUTING_CONFIGURED_SETTING) === true;
  const acknowledged = persistence?.getSetting<boolean>(ROUTING_ACKNOWLEDGED_SETTING) === true;
  if (stored.length === ROLE_ORDER.length) {
    return { profiles: sortRoleProfiles(stored), needsReview: !configured && !acknowledged };
  }
  const seeded = buildDefaultRoleProfiles(await agentManager.discoverAll());
  for (const profile of seeded) persistence?.saveRoleProfile("global", "default", profile);
  return { profiles: seeded, needsReview: !acknowledged };
}

/**
 * Builds the routing client for whichever provider the Router role profile names. OpenCode gets the dedicated client
 * that switches every tool off at the protocol level; any other provider runs the routing prompt through its own
 * adapter. Passing a model that belongs to one provider to a different one is what made a non-OpenCode router hang.
 */
function createRouterClient(profile: RoleExecutionProfile | undefined, project: Project): RouterClient & { shutdown(): Promise<void> } {
  const model = profile?.modelId;
  // "default" is a placeholder some model lists expose; it must never be forwarded as a real model id.
  const usableModel = model === undefined || model === "default" ? undefined : model;
  if (profile === undefined || profile.agentId === "opencode") {
    return new OpenCodeRouterClient({ projectRoot: project.root, ...(usableModel === undefined ? {} : { model: usableModel }) });
  }
  return new AgentRouterClient({ agents: agentManager, agentId: profile.agentId, projectId: project.id,
    projectRoot: project.root, ...(usableModel === undefined ? {} : { model: usableModel }),
    onSession: (sessionId) => routerSessionIds.add(sessionId) });
}

/**
 * Runs a chat message as the adaptive multi-agent workflow: router → implementing role → optional review/document.
 * Step providers, models, and efforts come from the saved role profiles, and every engine event is forwarded to the
 * renderer so the chat transcript shows each agent as it starts.
 */
async function runChatWorkflow(project: Project, task: string): Promise<SessionSendResult> {
  const { profiles } = await resolveRoleProfiles();
  await assertRolesUsable(profiles);
  const routerProfile = profiles.find((profile) => profile.role === "router");
  const definition = new WorkflowCompiler().compilePreset("adaptive");
  const repository = workflowRepository ?? new InMemoryWorkflowRepository();
  await repository.saveDefinition(definition);
  const routerClient = createRouterClient(routerProfile, project);
  // A router call may have to cold-start a provider CLI, which routinely outlasts the 15s library default.
  const engine = new WorkflowEngine(repository, new AgentStepExecutor(agentManager), new RouterManager(routerClient, ROUTER_TIMEOUT_MS));
  const title = task.slice(0, 80);
  let conversation: AppConversation = { id: randomUUID(), projectId: project.id, title,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const unsubscribe = engine.events.subscribe((event) => {
    if (event.type === "workflow.started") {
      // Step sessions use the workflow run id as their conversation id, so the row has to exist under that id.
      const now = new Date().toISOString();
      conversation = { id: event.workflowRunId, projectId: project.id, title, createdAt: now, updatedAt: now };
      persistence?.saveConversation(conversation);
      persistence?.saveMessage({ id: randomUUID(), conversationId: conversation.id, role: "user", content: task, createdAt: now });
      activeChatRun = { id: event.workflowRunId, engine };
    }
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC_CHANNELS.workflowsEvent, event);
  });
  try {
    const result = await engine.run({ definition, profiles: Object.fromEntries(profiles.map((profile) => [profile.role, profile])) as GlobalRoleProfiles,
      projectId: project.id, projectRoot: project.root, task });
    if (result.run.summary !== undefined) persistence?.saveMessage({ id: randomUUID(), conversationId: conversation.id,
      role: "assistant", content: result.run.summary, createdAt: new Date().toISOString() });
    return { conversation, workflowRunId: result.run.id, workflowStatus: result.run.status };
  } finally {
    unsubscribe(); activeChatRun = undefined; await routerClient.shutdown();
    for (const sessionId of routerSessionIds) routerSessionIds.delete(sessionId);
  }
}

/**
 * Fails before the first step when a role points at a provider that cannot run, naming the role and the reason.
 * Without this a workflow dies three steps in — for instance when the review role still points at a provider whose
 * CLI has stopped accepting this client.
 */
async function assertRolesUsable(profiles: readonly RoleExecutionProfile[]): Promise<void> {
  const descriptors = new Map((await agentManager.discoverAll()).map((descriptor) => [descriptor.id, descriptor]));
  const broken = profiles.filter((profile) => profile.enabled)
    .map((profile) => ({ profile, descriptor: descriptors.get(profile.agentId) }))
    .filter((entry) => entry.descriptor === undefined || !entry.descriptor.available);
  if (broken.length === 0) return;
  const details = broken.map(({ profile, descriptor }) => {
    const reason = descriptor === undefined ? "provider is not registered"
      : !descriptor.installed ? "CLI is not installed" : descriptor.warnings[0] ?? "provider is unavailable";
    return `${profile.role} → ${profile.agentId} (${reason})`;
  });
  throw new Error(`Change these roles in Settings before running: ${details.join("; ")}`);
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
    if (!projects.has(projectId)) throw new Error("Unknown project");
    persistence?.removeProject(projectId);
    projects.delete(projectId);
    return [...projects.values()];
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
      events: persistence?.listEvents(conversationId) ?? [] } satisfies ConversationHistory;
  });
  ipcMain.handle(IPC_CHANNELS.conversationsRemove, (event, input: unknown) => {
    assertTrustedIpc(event);
    const { conversationId, projectId } = conversationRemoveInputSchema.parse(input);
    if (!projects.has(projectId)) throw new Error("Unknown project");
    if (persistence?.getConversation(conversationId)?.projectId !== projectId) throw new Error("Unknown conversation");
    if (activeChatRun?.id === conversationId) throw new Error("Stop the running task before removing this conversation");
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
  ipcMain.handle(IPC_CHANNELS.sessionsSend, async (event, input: unknown) => {
    assertTrustedIpc(event);
    const request = sessionSendInputSchema.parse(input);
    const project = projects.get(request.projectId);
    if (project === undefined) throw new Error("Choose a project before sending a task");
    // Auto is the multi-agent path: the router picks the implementing role and decides after each stage whether the
    // work still needs a review or documentation. An explicit provider choice stays a single run below.
    if (request.agentId === "auto" && process.env.WAING_E2E !== "1") return runChatWorkflow(project, request.text);
    const now = new Date().toISOString();
    const conversation = { id: randomUUID(), projectId: project.id, title: request.text.slice(0, 80), createdAt: now, updatedAt: now };
    persistence?.saveConversation(conversation);
    persistence?.saveMessage({ id: randomUUID(), conversationId: conversation.id, role: "user", content: request.text, createdAt: now });
    let resolvedAgentId = request.agentId;
    let routing: SessionSendResult["routing"];
    if (request.agentId === "auto") {
      resolvedAgentId = "fake";
      routing = { routerAgentId: "opencode-router", role: "medium", decision: { complexity: "medium",
        taskType: "feature", mode: "execute", effort: "medium", confidence: 0.92,
        rationale: "The task spans several tested components." } };
    }
    const session = await agentManager.startSession(resolvedAgentId, { conversationId: conversation.id,
      projectId: project.id, projectRoot: project.root });
    persistence?.saveProviderSession({ id: session.id, conversationId: conversation.id, agentId: session.agentId,
      ...(session.providerSessionId === undefined ? {} : { providerSessionId: session.providerSessionId }), status: session.status,
      payload: session, updatedAt: session.updatedAt });
    const model = request.model;
    const effort = request.effort;
    await agentManager.send(session.id, { text: request.text, projectRoot: project.root, mode: request.mode,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }) });
    // Nothing chose a model, so report the provider default the run fell back to instead of leaving the label blank.
    const resolvedModel = model ?? await defaultModelId(resolvedAgentId);
    return { conversation, session, resolvedAgentId,
      ...(resolvedModel === undefined ? {} : { resolvedModel }),
      ...(effort === undefined ? {} : { resolvedEffort: effort }),
      ...(routing === undefined ? {} : { routing }) } satisfies SessionSendResult;
  });
  ipcMain.handle(IPC_CHANNELS.sessionsCancel, async (event, input: unknown) => {
    assertTrustedIpc(event);
    const { sessionId } = sessionCancelInputSchema.parse(input);
    // Auto chat runs are workflows, so Stop cancels the engine when the renderer passes back a workflow run id.
    if (activeChatRun?.id === sessionId) { await activeChatRun.engine.cancel(); return; }
    await agentManager.cancel(sessionId);
  });
  ipcMain.handle(IPC_CHANNELS.permissionsRespond, (event, input: unknown) => {
    assertTrustedIpc(event);
    const response = permissionResponseInputSchema.parse(input);
    permissionManager.respond(response.requestId, response.decision, response.sessionId);
  });
  ipcMain.handle(IPC_CHANNELS.routerPreview, async (event, input: unknown) => {
    assertTrustedIpc(event);
    const request = routerPreviewInputSchema.parse(input);
    if (process.env.WAING_E2E === "1") return { status: "resolved" as const, resolution: {
      routingDecision: { complexity: "medium" as const, taskType: "feature" as const, mode: "execute" as const,
        effort: "medium" as const, confidence: 0.92, rationale: "The task spans several tested components." },
      role: "medium" as const, matchedRuleId: "medium",
    } };
    const project = projects.get(request.projectId);
    if (project === undefined) throw new Error("Choose a project before routing a task");
    // Preview must route through the same provider the real run would use, or it previews the wrong router.
    const client = createRouterClient((await resolveRoleProfiles()).profiles.find((profile) => profile.role === "router"), project);
    try {
      const selector = new AutoSelector(new RouterManager(client, ROUTER_TIMEOUT_MS));
      const result = await selector.select({ type: "auto" }, { task: request.task }, {
        defaultRole: "medium", rules: [
          { id: "documentation", enabled: true, match: { taskType: "documentation" }, targetRole: "document", priority: 100 },
          { id: "review", enabled: true, match: { taskType: "review" }, targetRole: "review", priority: 100 },
          { id: "bugfix", enabled: true, match: { taskType: "bugfix" }, targetRole: "bugfix", priority: 100 },
          { id: "low", enabled: true, match: { complexity: "low" }, targetRole: "low", priority: 10 },
          { id: "medium", enabled: true, match: { complexity: "medium" }, targetRole: "medium", priority: 10 },
          { id: "high", enabled: true, match: { complexity: "high" }, targetRole: "high", priority: 10 },
        ],
      });
      if (result.type !== "routed") throw new Error("Auto routing was unexpectedly bypassed");
      return result.selection;
    } finally {
      await client.shutdown();
      for (const sessionId of routerSessionIds) routerSessionIds.delete(sessionId);
    }
  });
  ipcMain.handle(IPC_CHANNELS.workflowsRun, async (event, input: unknown) => {
    assertTrustedIpc(event);
    const request = workflowRunInputSchema.parse(input);
    const project = projects.get(request.projectId);
    if (project === undefined) throw new Error("Choose a project before running a workflow");
    if (process.env.WAING_E2E === "1") {
      const workflowRunId = randomUUID(); const stepRunId = randomUUID();
      for (const event of [
        { type: "workflow.started" as const, workflowRunId },
        { type: "workflow.step.announced" as const, announcement: { workflowRunId, stepRunId, nodeId: "medium",
          role: "medium" as const, agentId: "codex", agentDisplayName: "Codex", activity: "implementing" as const,
          message: "Codex is implementing the task.", createdAt: new Date().toISOString() } },
        { type: "workflow.node.started" as const, nodeId: "medium", stepRunId },
        { type: "workflow.node.completed" as const, nodeId: "medium", stepRunId },
        { type: "workflow.completed" as const, workflowRunId },
      ]) for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC_CHANNELS.workflowsEvent, event);
      return { runId: workflowRunId, status: "completed", summary: "1 workflow step completed; 0 artifacts produced.",
        steps: [{ nodeId: "medium", role: "medium", summary: "Task completed" }], loopState: {} };
    }
    const definition = new WorkflowCompiler().compilePreset(request.preset);
    const profiles = Object.fromEntries(request.profiles.map((profile) => [profile.role, profile])) as GlobalRoleProfiles;
    const routerClient = new OpenCodeRouterClient({ projectRoot: project.root });
    try {
      const repository = workflowRepository ?? new InMemoryWorkflowRepository();
      await repository.saveDefinition(definition);
      for (const profile of request.profiles) persistence?.saveRoleProfile("global", "default", profile);
      const engine = new WorkflowEngine(repository, new AgentStepExecutor(agentManager), new RouterManager(routerClient));
      const unsubscribe = engine.events.subscribe((event) => {
        if (event.type === "workflow.started") {
          const now = new Date().toISOString();
          persistence?.saveConversation({ id: event.workflowRunId, projectId: project.id, title: request.task.slice(0, 80),
            createdAt: now, updatedAt: now });
          persistence?.saveMessage({ id: randomUUID(), conversationId: event.workflowRunId, role: "user",
            content: request.task, createdAt: now });
        }
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC_CHANNELS.workflowsEvent, event);
      });
      try {
        const result = await engine.run({ definition, profiles, projectId: project.id, projectRoot: project.root, task: request.task });
        if (result.run.summary !== undefined) persistence?.saveMessage({ id: randomUUID(), conversationId: result.run.id,
          role: "assistant", content: result.run.summary, createdAt: new Date().toISOString() });
        return { runId: result.run.id, status: result.run.status, ...(result.run.summary === undefined ? {} : { summary: result.run.summary }),
          steps: result.context.stepResults.map((step) => ({ nodeId: step.nodeId, role: step.role, summary: step.summary })),
          loopState: result.context.loopState };
      } finally { unsubscribe(); }
    } finally { await routerClient.shutdown(); }
  });
  ipcMain.handle(IPC_CHANNELS.settingsRolesGet, async (event, input: unknown) => {
    assertTrustedIpc(event);
    emptyInputSchema.parse(input);
    return resolveRoleProfiles();
  });
  ipcMain.handle(IPC_CHANNELS.settingsRolesSave, (event, input: unknown): RoleProfilesView => {
    assertTrustedIpc(event);
    const { profiles } = roleProfilesInputSchema.parse(input);
    const roles = new Set(profiles.map((profile) => profile.role));
    if (roles.size !== ROLE_ORDER.length) throw new Error("Every workflow role needs exactly one profile");
    for (const profile of profiles) persistence?.saveRoleProfile("global", "default", profile);
    persistence?.setSetting(ROUTING_CONFIGURED_SETTING, true);
    return { profiles: sortRoleProfiles(profiles), needsReview: false };
  });
  ipcMain.handle(IPC_CHANNELS.settingsRolesAcknowledge, (event, input: unknown) => {
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
app.on("will-quit", () => { database?.close(); database = undefined; persistence = undefined; workflowRepository = undefined; secretStore = undefined; });
