import { randomUUID } from "node:crypto";
import { AsyncQueue, RestartPolicy, providerCompatibility } from "@waing/agent-core";
import type { CodingAgent } from "@waing/agent-core";
import { AgentError, agentQuestionSchema } from "@waing/domain";
import type {
  AgentDescriptor, AgentEvent, AgentModelDescriptor, AgentQuestionResponse, AgentRequest, AgentRun, AgentSession,
  PermissionDecision, ResumeSessionInput, StartSessionInput,
} from "@waing/domain";
import { SdkOpenCodeApi } from "./OpenCodeApi";
import type { OpenCodeApi } from "./OpenCodeApi";
import { OpenCodeServer } from "./OpenCodeServer";
import type { OpenCodeServerHandle } from "./OpenCodeServer";

type EventBaseKeys = "id" | "sessionId" | "runId" | "agentId" | "timestamp" | "sequence";
type EventPayload<T> = T extends unknown ? Omit<T, EventBaseKeys> : never;
interface SessionState {
  session: AgentSession;
  root: string;
  queue: AsyncQueue<AgentEvent>;
  sequence: number;
  abort: AbortController;
  assistantMessages: Set<string>;
  textByPart: Map<string, string>;
  toolStatus: Map<string, string>;
  /** Pending question requests, holding each one's headers in the order OpenCode asked them. */
  questionHeaders: Map<string, string[]>;
  activeRunId?: string;
}

export interface OpenCodeAdapterOptions {
  executable?: string;
  serverFactory?: () => Promise<OpenCodeServerHandle>;
  apiFactory?: (handle: OpenCodeServerHandle) => OpenCodeApi;
  restartPolicy?: RestartPolicy;
}

export class OpenCodeAdapter implements CodingAgent {
  readonly id = "opencode";
  private readonly server: OpenCodeServer;
  private readonly sessions = new Map<string, SessionState>();
  private handle?: OpenCodeServerHandle;
  private api?: OpenCodeApi;
  private discovered?: { path: string; version: string };

  constructor(private readonly options: OpenCodeAdapterOptions = {}) {
    this.server = new OpenCodeServer(options.executable);
  }

  async discover(): Promise<AgentDescriptor> {
    try {
      this.discovered ??= await this.server.discover();
      const compatibility = providerCompatibility(this.id, this.discovered.version);
      const compatible = compatibility.compatible;
      return { id: this.id, displayName: "OpenCode", installed: true, available: compatible,
        version: this.discovered.version, executablePath: this.discovered.path,
        capabilities: this.capabilities(), authState: "unknown",
        warnings: compatibility.warning === undefined ? [] : [compatibility.warning] };
    } catch (error) {
      if (error instanceof AgentError && error.code === "NOT_INSTALLED") return {
        id: this.id, displayName: "OpenCode", installed: false, available: false,
        capabilities: this.capabilities(), authState: "missing", warnings: [error.message],
      };
      throw error;
    }
  }

  async listModels(): Promise<AgentModelDescriptor[]> {
    const api = await this.ensureBackend();
    const models = await api.listModels();
    return models.map((model) => ({ agentId: this.id, modelId: `${model.providerId}/${model.modelId}`,
      displayName: model.displayName, available: true, modes: ["execute", "plan", "review", "investigate"] }));
  }

  async startSession(input: StartSessionInput): Promise<AgentSession> {
    const api = await this.ensureBackend();
    const provider = await api.createSession(input.projectRoot, `Waing · ${input.conversationId}`);
    return this.record(input, provider.id);
  }

  async resumeSession(input: ResumeSessionInput): Promise<AgentSession> {
    const api = await this.ensureBackend();
    await api.loadSession(input.projectRoot, input.providerSessionId);
    return this.record(input, input.providerSessionId);
  }

  async send(sessionId: string, request: AgentRequest): Promise<AgentRun> {
    const state = this.requireSession(sessionId);
    if (state.activeRunId !== undefined) throw new AgentError("PROTOCOL_ERROR", "OpenCode session already has an active run", this.id, true);
    const run = { id: randomUUID(), sessionId, startedAt: new Date().toISOString() };
    state.activeRunId = run.id;
    this.emit(state, run.id, { type: "run.started" });
    try {
      await (await this.ensureBackend()).prompt(state.root, this.providerId(state), request);
    } catch (cause) {
      delete state.activeRunId;
      this.emit(state, run.id, { type: "run.failed", code: "PROTOCOL_ERROR",
        message: cause instanceof Error ? cause.message : "OpenCode prompt failed", retryable: true });
    }
    return run;
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.requireSession(sessionId);
    await (await this.ensureBackend()).abort(state.root, this.providerId(state));
  }

  async respondToPermission(sessionId: string, requestId: string, decision: PermissionDecision): Promise<void> {
    const state = this.requireSession(sessionId);
    await (await this.ensureBackend()).respondToPermission(state.root, this.providerId(state), requestId, decision);
    this.emit(state, state.activeRunId ?? requestId, { type: "permission.resolved", requestId, decision });
  }

  /**
   * OpenCode expects one answer per question in the order it asked them, while the app answers by header. Anything
   * the user left unanswered — including questions past the four the card shows — goes back as an empty selection.
   */
  async respondToQuestion(sessionId: string, questionId: string, answers: AgentQuestionResponse): Promise<void> {
    const state = this.requireSession(sessionId);
    const headers = state.questionHeaders.get(questionId);
    if (headers === undefined) throw new AgentError("PROTOCOL_ERROR", `Unknown OpenCode question: ${questionId}`, this.id);
    state.questionHeaders.delete(questionId);
    const api = await this.ensureBackend();
    if (answers.length === 0) await api.rejectQuestion(state.root, questionId);
    else await api.respondToQuestion(state.root, questionId,
      headers.map((header) => answers.find((answer) => answer.header === header)?.values ?? []));
    this.emit(state, state.activeRunId ?? questionId, { type: "question.resolved", questionId, answers });
  }

  closeSession(sessionId: string): Promise<void> {
    const state = this.requireSession(sessionId);
    state.abort.abort(); state.queue.end(); this.sessions.delete(sessionId);
    return Promise.resolve();
  }

  async shutdown(): Promise<void> {
    for (const state of this.sessions.values()) { state.abort.abort(); state.queue.end(); }
    this.sessions.clear();
    await this.handle?.close();
    delete this.handle; delete this.api;
  }

  events(sessionId: string): AsyncIterable<AgentEvent> { return this.requireSession(sessionId).queue; }

  private async ensureBackend(): Promise<OpenCodeApi> {
    // A crashed server keeps answering from every cached reference — with a closed socket. Drop it and start a new
    // one, or every later call re-fails against a process that is not there.
    if (this.api !== undefined && this.handle?.isAlive?.() === false) { delete this.api; delete this.handle; }
    if (this.api !== undefined) return this.api;
    this.handle = this.options.serverFactory === undefined ? await this.server.start() : await this.options.serverFactory();
    if (!this.isCompatible(this.handle.version)) {
      const version = this.handle.version;
      await this.handle.close(); delete this.handle;
      throw new AgentError("UNSUPPORTED_VERSION", `OpenCode ${version} is not supported`, this.id);
    }
    this.api = this.options.apiFactory?.(this.handle) ?? new SdkOpenCodeApi(this.handle.baseUrl, this.handle.password);
    return this.api;
  }

  private record(input: StartSessionInput, providerSessionId: string): AgentSession {
    const now = new Date().toISOString();
    const session: AgentSession = { id: randomUUID(), conversationId: input.conversationId,
      providerSessionId, agentId: this.id, projectId: input.projectId, createdAt: now, updatedAt: now, status: "idle" };
    const state: SessionState = { session, root: input.projectRoot, queue: new AsyncQueue(), sequence: 0,
      abort: new AbortController(), assistantMessages: new Set(), textByPart: new Map(), toolStatus: new Map(),
      questionHeaders: new Map() };
    this.sessions.set(session.id, state);
    void this.consumeEvents(state);
    return session;
  }

  private async consumeEvents(state: SessionState): Promise<void> {
    const policy = this.options.restartPolicy ?? new RestartPolicy();
    let failedAttempts = 0;
    while (!state.abort.signal.aborted) {
      let failure: unknown;
      try {
        for await (const event of (await this.ensureBackend()).events(state.root, state.abort.signal)) {
          if (state.abort.signal.aborted) return;
          failedAttempts = 0; this.handleEvent(state, event);
        }
        failure = new Error("OpenCode event stream closed unexpectedly");
      } catch (cause) { failure = cause; }
      if (state.abort.signal.aborted) return;
      // The SDK ends the stream cleanly when the server dies, so a closed stream says nothing by itself. Whether the
      // process is still there is what separates a reconnect from a run that has lost its provider.
      const died = this.handle?.isAlive?.() === false ? this.handle.exitReason?.() : undefined;
      failedAttempts += 1;
      if (died !== undefined || !policy.canRetry(failedAttempts)) {
        if (state.activeRunId !== undefined) this.fail(state, "LOCAL_SERVER_FAILED", died === undefined
          ? failure instanceof Error ? failure.message : "OpenCode event stream failed"
          : `OpenCode server ${died}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, policy.delayMs(failedAttempts)));
    }
  }

  private handleEvent(state: SessionState, raw: unknown): void {
    if (typeof raw !== "object" || raw === null) return;
    const event = raw as { type?: unknown; properties?: Record<string, unknown> };
    if (typeof event.type !== "string" || event.properties === undefined) return;
    const properties = event.properties;
    const providerSessionId = this.providerId(state);
    if (event.type === "message.updated") {
      const info = properties.info as { id?: unknown; sessionID?: unknown; role?: unknown } | undefined;
      if (info?.sessionID === providerSessionId && info.role === "assistant" && typeof info.id === "string") {
        state.assistantMessages.add(info.id);
      }
      return;
    }
    if (event.type === "message.part.updated") {
      const part = properties.part as Record<string, unknown> | undefined;
      if (part?.sessionID !== providerSessionId || typeof part.id !== "string") return;
      this.handlePart(state, part, properties.delta);
      return;
    }
    const sessionId = properties.sessionID;
    if (sessionId !== providerSessionId) return;
    if (event.type === "permission.updated" || event.type === "permission.asked") this.permission(state, properties);
    // The ask-the-user tool ships as both `question.*` and `question.v2.*`; the payloads are the same shape.
    else if (event.type === "question.asked" || event.type === "question.v2.asked") this.question(state, properties);
    else if (event.type.startsWith("question.") && (event.type.endsWith(".replied") || event.type.endsWith(".rejected"))) {
      this.questionSettled(state, properties);
    }
    else if (event.type === "session.idle") this.complete(state);
    else if (event.type === "session.error") this.fail(state, "PROTOCOL_ERROR", this.errorMessage(properties.error));
    else if (event.type === "session.diff") this.emitActive(state, { type: "diff.updated", diff: JSON.stringify(properties.diff ?? []) });
  }

  private handlePart(state: SessionState, part: Record<string, unknown>, rawDelta: unknown): void {
    const runId = state.activeRunId;
    if (runId === undefined) return;
    if (part.type === "text" && typeof part.messageID === "string" && state.assistantMessages.has(part.messageID)) {
      const text = typeof part.text === "string" ? part.text : "";
      const previous = state.textByPart.get(part.id as string) ?? "";
      const delta = typeof rawDelta === "string" ? rawDelta : text.startsWith(previous) ? text.slice(previous.length) : text;
      state.textByPart.set(part.id as string, text);
      if (delta.length > 0) this.emit(state, runId, { type: "message.delta", text: delta });
    } else if (part.type === "reasoning" && typeof part.text === "string") {
      this.emit(state, runId, { type: "plan.updated", text: part.text });
    } else if (part.type === "tool") this.handleTool(state, runId, part);
    else if (part.type === "patch") this.emit(state, runId, { type: "diff.updated", diff: JSON.stringify(part.files ?? []) });
    else if (part.type === "step-finish") {
      const tokens = part.tokens as { input?: unknown; output?: unknown } | undefined;
      this.emit(state, runId, { type: "usage.updated", inputTokens: this.number(tokens?.input), outputTokens: this.number(tokens?.output) });
    }
  }

  private handleTool(state: SessionState, runId: string, part: Record<string, unknown>): void {
    const tool = typeof part.tool === "string" ? part.tool : "tool";
    const toolState = part.state as Record<string, unknown> | undefined;
    const status = typeof toolState?.status === "string" ? toolState.status : "pending";
    if (state.toolStatus.get(part.id as string) === status) return;
    state.toolStatus.set(part.id as string, status);
    if (status === "pending") {
      this.emit(state, runId, { type: "tool.started", tool, input: toolState?.input });
    } else if (status === "running") {
      this.emit(state, runId, { type: "tool.progress", tool, detail: this.errorMessage(toolState?.title ?? status) });
    } else {
      this.emit(state, runId, { type: "tool.completed", tool, output: toolState?.output ?? toolState?.error });
    }
  }

  private permission(state: SessionState, properties: Record<string, unknown>): void {
    const requestId = typeof properties.id === "string" ? properties.id
      : typeof properties.requestID === "string" ? properties.requestID : randomUUID();
    const action = typeof properties.permission === "string" ? properties.permission
      : typeof properties.type === "string" ? properties.type : "tool";
    const detail = JSON.stringify(properties.metadata ?? properties.patterns ?? properties.pattern ?? {});
    const kind = action.includes("bash") || action.includes("shell") ? "shell"
      : action.includes("external") ? "external_directory" : action.includes("network") ? "network" : "file_write";
    this.emitActive(state, { type: "permission.requested", request: { id: requestId, sessionId: state.session.id,
      runId: state.activeRunId ?? requestId, agentId: this.id, kind,
      title: typeof properties.title === "string" ? properties.title : `OpenCode requests ${action}`,
      detail, risk: kind === "shell" || kind === "external_directory" ? "high" : "medium" } });
  }

  /**
   * OpenCode's question tool blocks the run until the request is answered or rejected, so a question that never
   * reaches the user is a run that never ends. The provider's own shape already matches the app's, apart from its
   * `multiple` flag, so it only needs renaming.
   */
  private question(state: SessionState, properties: Record<string, unknown>): void {
    const requestId = properties.id;
    const asked = properties.questions;
    if (typeof requestId !== "string" || !Array.isArray(asked)) return;
    const items = asked.map((entry) => {
      const item = entry as { question?: unknown; header?: unknown; multiple?: unknown; options?: unknown };
      return { question: typeof item.question === "string" ? item.question : "",
        header: typeof item.header === "string" ? item.header : "",
        ...(item.multiple === true ? { multiSelect: true } : {}),
        options: (Array.isArray(item.options) ? item.options : []).map((raw) => {
          const option = raw as { label?: unknown; description?: unknown };
          return { label: typeof option.label === "string" ? option.label : "",
            description: typeof option.description === "string" ? option.description : "" };
        }) };
    });
    // Every question is answered positionally, so the full order is kept even when the card can only show four.
    state.questionHeaders.set(requestId, items.map((item) => item.header));
    const question = agentQuestionSchema.safeParse({ id: requestId, sessionId: state.session.id,
      runId: state.activeRunId ?? requestId, agentId: this.id, questions: items.slice(0, 4) });
    if (!question.success) { void this.rejectQuestion(state, requestId); return; }
    this.emitActive(state, { type: "question.requested", question: question.data });
  }

  private questionSettled(state: SessionState, properties: Record<string, unknown>): void {
    const requestId = properties.requestID;
    if (typeof requestId !== "string" || !state.questionHeaders.has(requestId)) return;
    state.questionHeaders.delete(requestId);
    this.emitActive(state, { type: "question.resolved", questionId: requestId, answers: [] });
  }

  private async rejectQuestion(state: SessionState, requestId: string): Promise<void> {
    state.questionHeaders.delete(requestId);
    // A question the app cannot render must still be answered, or OpenCode waits on it for the rest of the run.
    try { await (await this.ensureBackend()).rejectQuestion(state.root, requestId); }
    catch { /* the run's own failure will say more than a rejection that could not be delivered */ }
  }

  private complete(state: SessionState): void {
    if (state.activeRunId === undefined) return;
    const runId = state.activeRunId; delete state.activeRunId;
    this.emit(state, runId, { type: "run.completed" });
  }

  private fail(state: SessionState, code: string, message: string): void {
    if (state.activeRunId === undefined) return;
    const runId = state.activeRunId; delete state.activeRunId;
    this.emit(state, runId, { type: "run.failed", code, message, retryable: true });
  }

  private emitActive(state: SessionState, payload: EventPayload<AgentEvent>): void {
    this.emit(state, state.activeRunId ?? randomUUID(), payload);
  }
  private emit(state: SessionState, runId: string, payload: EventPayload<AgentEvent>): void {
    state.queue.push({ id: randomUUID(), sessionId: state.session.id, runId, agentId: this.id,
      timestamp: new Date().toISOString(), sequence: state.sequence++, ...payload });
  }
  private requireSession(id: string): SessionState {
    const state = this.sessions.get(id);
    if (state === undefined) throw new AgentError("SESSION_NOT_FOUND", `Unknown OpenCode session: ${id}`, this.id);
    return state;
  }
  private providerId(state: SessionState): string {
    if (state.session.providerSessionId === undefined) throw new AgentError("PROTOCOL_ERROR", "OpenCode session lacks a provider ID", this.id);
    return state.session.providerSessionId;
  }
  private isCompatible(version: string): boolean { return providerCompatibility(this.id, version).compatible; }
  private number(value: unknown): number { return typeof value === "number" && value >= 0 ? value : 0; }
  private errorMessage(value: unknown): string {
    if (typeof value === "string") return value;
    if (typeof value === "object" && value !== null && "message" in value && typeof value.message === "string") return value.message;
    return "OpenCode provider error";
  }
  private capabilities() { return { streaming: true, persistentSessions: true, cancellation: true,
    concurrentRuns: false, nativeStructuredOutput: true, planMode: true, effortControl: false,
    interactivePermissions: true, diffEvents: true, shellEvents: true, fileEvents: true,
    modelSelection: true, mcp: true, customTools: true, additionalDirectories: false }; }
}
