import { randomUUID } from "node:crypto";
import {
  AsyncQueue, JsonRpcTransport, ProcessSupervisor, probeVersion, providerCompatibility, resolveExecutable,
} from "@waing/agent-core";
import type { CodingAgent, ManagedProcess } from "@waing/agent-core";
import { AgentError } from "@waing/domain";
import type {
  AgentDescriptor, AgentEvent, AgentModelDescriptor, AgentQuestionItem, AgentQuestionResponse, AgentRequest,
  AgentRun, AgentSession, PermissionDecision, ResumeSessionInput, StartSessionInput,
} from "@waing/domain";
import type { ModelListResponse } from "../generated/v2/ModelListResponse";
import type { ThreadResumeResponse } from "../generated/v2/ThreadResumeResponse";
import type { ThreadStartResponse } from "../generated/v2/ThreadStartResponse";
import type { TurnStartResponse } from "../generated/v2/TurnStartResponse";
import type { ThreadItem } from "../generated/v2/ThreadItem";
import type { ToolRequestUserInputParams } from "../generated/v2/ToolRequestUserInputParams";
import type { ToolRequestUserInputResponse } from "../generated/v2/ToolRequestUserInputResponse";
import type { UserInput } from "../generated/v2/UserInput";

interface SessionState {
  session: AgentSession;
  providerThreadId: string;
  queue: AsyncQueue<AgentEvent>;
  sequence: number;
  activeTurnId?: string;
}

interface PendingApproval {
  sessionId: string;
  resolve: (result: Record<string, unknown>) => void;
  kind: "command" | "file" | "permissions";
  /** Each approval family answers in its own shape, so the user's decision is translated per request. */
  toResponse: (decision: PermissionDecision) => Record<string, unknown>;
}

/** The shape the per-item requestApproval methods and the legacy v1 approvals both answer in. */
const reviewDecision = (decision: PermissionDecision): Record<string, unknown> => ({
  decision: decision === "deny" ? "decline" : decision === "allow_session" ? "acceptForSession" : "accept",
});

/**
 * Codex only offers its ask-the-user tool when the client opts in twice: the tool itself is experimental, and it is
 * gated again to plan mode unless the default-mode feature is on. Without both, the model reports the tool as
 * "unavailable in this mode" and answers its own question instead of asking — so a Codex step never stops for the
 * user the way a Claude or OpenCode step does.
 */
const THREAD_CONFIG = {
  "tools.experimental_request_user_input": { enabled: true },
  "features.default_mode_request_user_input": true,
};

/** Codex keys its answers by question id, so the ids are kept beside the headers the app answers with. */
interface PendingQuestion {
  sessionId: string;
  questionIds: Record<string, string>;
  resolve: (result: ToolRequestUserInputResponse) => void;
}

type EventBaseKeys = "id" | "sessionId" | "runId" | "agentId" | "timestamp" | "sequence";
type WithoutEventBase<T> = T extends unknown ? Omit<T, EventBaseKeys> : never;
type AgentEventPayload = WithoutEventBase<AgentEvent>;
const stringValue = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

export interface CodexAdapterOptions {
  executable?: string;
  supervisor?: ProcessSupervisor;
  transportFactory?: () => Promise<{ transport: JsonRpcTransport; process?: ManagedProcess }>;
}

export class CodexAdapter implements CodingAgent {
  readonly id = "codex";
  private readonly supervisor: ProcessSupervisor;
  private readonly executable: string;
  private readonly sessions = new Map<string, SessionState>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly questions = new Map<string, PendingQuestion>();
  private transport?: JsonRpcTransport;
  private process?: ManagedProcess;
  private resolvedExecutable?: string;
  private version?: string;

  constructor(private readonly options: CodexAdapterOptions = {}) {
    this.supervisor = options.supervisor ?? new ProcessSupervisor();
    this.executable = options.executable ?? "codex";
  }

  async discover(): Promise<AgentDescriptor> {
    try {
      this.resolvedExecutable ??= await resolveExecutable(this.executable);
      this.version ??= (await probeVersion(this.supervisor, this.resolvedExecutable)).replace(/^codex-cli\s+/, "");
      return { id: this.id, displayName: "Codex", installed: true, available: true,
        version: this.version, executablePath: this.resolvedExecutable, capabilities: this.capabilities(),
        authState: "unknown", warnings: this.compatibilityWarnings(this.version) };
    } catch (error) {
      if (error instanceof AgentError && error.code === "NOT_INSTALLED") {
        return { id: this.id, displayName: "Codex", installed: false, available: false,
          capabilities: this.capabilities(), authState: "missing", warnings: [error.message] };
      }
      throw error;
    }
  }

  async listModels(): Promise<AgentModelDescriptor[]> {
    const transport = await this.ensureTransport();
    const response = await transport.request<ModelListResponse>("model/list", { includeHidden: false });
    return response.data.map((model) => ({
      agentId: this.id, modelId: model.model, displayName: model.displayName, available: !model.hidden,
      isDefault: model.isDefault,
      effortLevels: model.supportedReasoningEfforts.map((option) => option.reasoningEffort)
        .filter((effort): effort is "low" | "medium" | "high" | "max" =>
          ["low", "medium", "high", "max"].includes(effort)),
      modes: ["execute", "plan", "review", "investigate"],
    }));
  }

  async startSession(input: StartSessionInput): Promise<AgentSession> {
    const transport = await this.ensureTransport();
    const response = await transport.request<ThreadStartResponse>("thread/start", {
      cwd: input.projectRoot, approvalPolicy: "on-request", sandbox: "workspace-write", config: THREAD_CONFIG,
    });
    return this.recordSession(input, response.thread.id);
  }

  async resumeSession(input: ResumeSessionInput): Promise<AgentSession> {
    const transport = await this.ensureTransport();
    const response = await transport.request<ThreadResumeResponse>("thread/resume", {
      threadId: input.providerSessionId, cwd: input.projectRoot,
      approvalPolicy: "on-request", sandbox: "workspace-write", config: THREAD_CONFIG,
    });
    return this.recordSession(input, response.thread.id);
  }

  async send(sessionId: string, request: AgentRequest): Promise<AgentRun> {
    const state = this.requireSession(sessionId);
    const transport = await this.ensureTransport();
    const input: UserInput[] = [{ type: "text", text: request.text, text_elements: [] }];
    for (const attachment of request.attachments ?? []) {
      if (attachment.path === undefined) continue;
      input.push(attachment.mimeType.startsWith("image/")
        ? { type: "localImage", path: attachment.path }
        : { type: "mention", name: attachment.name, path: attachment.path });
    }
    const response = await transport.request<TurnStartResponse>("turn/start", {
      threadId: state.providerThreadId,
      input,
      cwd: request.projectRoot,
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      ...(request.responseFormat === undefined ? {} : { outputSchema: request.responseFormat.schema }),
    });
    state.activeTurnId = response.turn.id;
    return { id: response.turn.id, sessionId, startedAt: new Date().toISOString() };
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.requireSession(sessionId);
    this.releaseQuestions(sessionId);
    if (state.activeTurnId === undefined) return;
    const transport = await this.ensureTransport();
    await transport.request("turn/interrupt", {
      threadId: state.providerThreadId, turnId: state.activeTurnId,
    });
  }

  respondToPermission(sessionId: string, requestId: string, decision: PermissionDecision): Promise<void> {
    const pending = this.approvals.get(requestId);
    if (pending === undefined || pending.sessionId !== sessionId) {
      throw new AgentError("SESSION_NOT_FOUND", `Unknown Codex approval: ${requestId}`, this.id);
    }
    this.approvals.delete(requestId);
    pending.resolve(pending.toResponse(decision));
    this.emit(sessionId, this.requireSession(sessionId).activeTurnId ?? requestId, {
      type: "permission.resolved", requestId, decision,
    });
    return Promise.resolve();
  }

  respondToQuestion(sessionId: string, questionId: string, answers: AgentQuestionResponse): Promise<void> {
    const pending = this.questions.get(questionId);
    if (pending === undefined || pending.sessionId !== sessionId) {
      throw new AgentError("SESSION_NOT_FOUND", `Unknown Codex question: ${questionId}`, this.id);
    }
    this.questions.delete(questionId);
    pending.resolve({ answers: Object.fromEntries(answers.flatMap((answer) => {
      const id = pending.questionIds[answer.header];
      return id === undefined ? [] : [[id, { answers: answer.values }] as const];
    })) });
    this.emit(sessionId, this.requireSession(sessionId).activeTurnId ?? questionId, {
      type: "question.resolved", questionId, answers,
    });
    return Promise.resolve();
  }

  async closeSession(sessionId: string): Promise<void> {
    const state = this.requireSession(sessionId);
    this.releaseQuestions(sessionId);
    this.sessions.delete(sessionId);
    state.queue.end();
    if (this.transport !== undefined) {
      await this.transport.request("thread/unsubscribe", { threadId: state.providerThreadId });
    }
  }

  async shutdown(): Promise<void> {
    for (const state of this.sessions.values()) state.queue.end();
    this.sessions.clear();
    this.transport?.close();
    await this.supervisor.shutdown();
  }

  events(sessionId: string): AsyncIterable<AgentEvent> { return this.requireSession(sessionId).queue; }

  private async ensureTransport(): Promise<JsonRpcTransport> {
    if (this.transport !== undefined) return this.transport;
    if (this.options.transportFactory !== undefined) {
      const created = await this.options.transportFactory();
      this.transport = created.transport;
      if (created.process !== undefined) this.process = created.process;
    } else {
      const descriptor = await this.discover();
      if (!descriptor.available || descriptor.executablePath === undefined) {
        throw new AgentError("NOT_INSTALLED", "Codex is not available", this.id);
      }
      this.process = this.supervisor.spawn(descriptor.executablePath, ["app-server", "--stdio"]);
      this.transport = new JsonRpcTransport(this.process, false);
    }
    this.bindProtocol(this.transport);
    await this.transport.request("initialize", {
      clientInfo: { name: "waing", title: "Waing", version: "0.1.0" },
      // The ask-the-user tool is an experimental method, so declining experimental API means declining questions.
      // Attestation stays off: it is a separate opt-in whose request this client has no way to satisfy.
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.transport.notify("initialized", {});
    return this.transport;
  }

  private bindProtocol(transport: JsonRpcTransport): void {
    const notifications = [
      "turn/started", "item/started", "item/completed", "item/agentMessage/delta",
      "item/commandExecution/outputDelta", "item/fileChange/outputDelta", "item/fileChange/patchUpdated",
      "turn/diff/updated", "thread/tokenUsage/updated",
      "turn/completed", "error",
    ];
    for (const method of notifications) {
      transport.onNotification(method, (params) => this.handleNotification(method, params));
    }
    transport.handle("item/commandExecution/requestApproval", (params) => this.awaitApproval("command", params));
    transport.handle("item/fileChange/requestApproval", (params) => this.awaitApproval("file", params));
    transport.handle("item/tool/requestUserInput", (params) => this.awaitAnswer(params));
    transport.handle("item/permissions/requestApproval", (params) => this.awaitPermissions(params));
    // Codex blocks the turn on every server request it sends. Answering the rest — rather than letting the transport
    // reply "method not found" — is what keeps an unsupported ask from failing a run that was otherwise fine.
    transport.handle("mcpServer/elicitation/request", (params) => this.declineElicitation(params));
    transport.handle("applyPatchApproval", (params) => this.awaitApproval("file", params));
    transport.handle("execCommandApproval", (params) => this.awaitApproval("command", params));
  }

  private handleNotification(method: string, raw: unknown): void {
    const params = raw as Record<string, unknown>;
    const threadId = stringValue(params.threadId);
    const state = [...this.sessions.values()].find((candidate) => candidate.providerThreadId === threadId);
    if (state === undefined) return;
    const turn = params.turn as { id?: string; status?: string; error?: { message?: string } | null } | undefined;
    const runId = stringValue(params.turnId, turn?.id ?? state.activeTurnId ?? "unknown");
    if (method === "turn/started") this.emit(state.session.id, runId, { type: "run.started" });
    else if (method === "item/agentMessage/delta") this.emit(state.session.id, runId,
      { type: "message.delta", text: stringValue(params.delta) });
    else if (method === "item/commandExecution/outputDelta") this.emit(state.session.id, runId,
      { type: "command.output", stream: "stdout", text: stringValue(params.delta) });
    else if (method === "item/fileChange/outputDelta") this.emit(state.session.id, runId,
      { type: "tool.progress", tool: "fileChange", detail: stringValue(params.delta) });
    else if (method === "item/fileChange/patchUpdated") {
      const changes = params.changes as Array<{ path?: unknown; kind?: { type?: unknown } }> | undefined;
      for (const change of changes ?? []) {
        const kind = change.kind?.type;
        this.emit(state.session.id, runId, { type: "file.changed", path: stringValue(change.path),
          change: kind === "add" ? "created" : kind === "delete" ? "deleted" : "updated" });
      }
    }
    else if (method === "turn/diff/updated") this.emit(state.session.id, runId,
      { type: "diff.updated", diff: stringValue(params.diff) });
    else if (method === "thread/tokenUsage/updated") {
      const usage = (params.tokenUsage as { total?: { inputTokens?: number; outputTokens?: number } } | undefined)?.total;
      this.emit(state.session.id, runId, { type: "usage.updated",
        inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 });
    } else if (method === "item/started" || method === "item/completed") {
      this.handleItem(state, runId, params.item as ThreadItem, method === "item/completed");
    } else if (method === "turn/completed") {
      delete state.activeTurnId;
      if (turn?.status === "failed") this.emit(state.session.id, runId,
        { type: "run.failed", code: "PROCESS_FAILED", message: turn.error?.message ?? "Codex turn failed", retryable: true });
      else if (turn?.status === "interrupted") this.emit(state.session.id, runId,
        { type: "run.failed", code: "CANCELLED", message: "Codex turn was cancelled", retryable: false });
      else this.emit(state.session.id, runId, { type: "run.completed" });
    } else if (method === "error") this.emit(state.session.id, runId,
      { type: "run.failed", code: "PROTOCOL_ERROR", message: stringValue(params.message, "Codex error"), retryable: true });
  }

  private handleItem(state: SessionState, runId: string, item: ThreadItem, completed: boolean): void {
    if (item.type === "agentMessage" && completed) this.emit(state.session.id, runId,
      { type: "message.completed", text: item.text });
    else if (item.type === "plan") this.emit(state.session.id, runId, { type: "plan.updated", text: item.text });
    else if (item.type === "commandExecution") {
      if (completed) this.emit(state.session.id, runId, { type: "command.completed", exitCode: item.exitCode });
      else this.emit(state.session.id, runId, { type: "command.started", command: [item.command] });
    } else if (item.type === "fileChange") {
      for (const change of item.changes) {
        const changeType = change.kind.type === "add" ? "created" : change.kind.type === "delete" ? "deleted" : "updated";
        this.emit(state.session.id, runId, { type: "file.changed", path: change.path, change: changeType });
      }
    }
  }

  /** A parked question holds a JSON-RPC request open; leaving one behind would hang the turn past cancellation. */
  private releaseQuestions(sessionId: string): void {
    for (const [questionId, pending] of this.questions) {
      if (pending.sessionId !== sessionId) continue;
      this.questions.delete(questionId);
      pending.resolve({ answers: {} });
    }
  }

  /** Codex's own AskUserQuestion equivalent. Left unhandled the transport answers "Method not found" and the
   * question is lost, so it is surfaced through the same question events the app already renders. */
  private awaitAnswer(raw: unknown): Promise<ToolRequestUserInputResponse> {
    const params = raw as ToolRequestUserInputParams;
    const state = [...this.sessions.values()].find((candidate) => candidate.providerThreadId === params.threadId);
    const questionIds: Record<string, string> = {};
    const questions = (params.questions ?? []).flatMap((entry): AgentQuestionItem[] => {
      const options = (entry.options ?? []).filter((option) => option.label.length > 0);
      if (entry.question.length === 0 || options.length === 0) return [];
      const header = entry.header.length > 0 ? entry.header : entry.question.slice(0, 12);
      questionIds[header] = entry.id;
      return [{ question: entry.question, header, options }];
    }).slice(0, 4);
    if (state === undefined || questions.length === 0) return Promise.resolve({ answers: {} });
    const questionId = stringValue(params.itemId, randomUUID());
    const runId = stringValue(params.turnId, state.activeTurnId ?? questionId);
    this.emit(state.session.id, runId, { type: "question.requested",
      question: { id: questionId, sessionId: state.session.id, runId, agentId: this.id, questions } });
    return new Promise((resolve) => this.questions.set(questionId, { sessionId: state.session.id, questionIds, resolve }));
  }

  private awaitApproval(kind: "command" | "file", raw: unknown): Promise<Record<string, unknown>> {
    const params = raw as Record<string, unknown>;
    const state = [...this.sessions.values()].find((candidate) =>
      candidate.providerThreadId === stringValue(params.threadId));
    if (state === undefined) return Promise.resolve({ decision: "decline" });
    const requestId = stringValue(params.itemId, randomUUID());
    this.emit(state.session.id, stringValue(params.turnId, state.activeTurnId ?? requestId), {
      type: "permission.requested",
      request: { id: requestId, sessionId: state.session.id,
        runId: stringValue(params.turnId, state.activeTurnId ?? requestId), agentId: this.id,
        kind: kind === "command" ? "shell" : "file_write",
        title: kind === "command" ? "Run command" : "Apply file changes",
        detail: stringValue(params.reason, stringValue(params.command, "Codex requests approval")), risk: "medium" },
    });
    return new Promise((resolve) => this.approvals.set(requestId,
      { sessionId: state.session.id, resolve, kind, toResponse: reviewDecision }));
  }

  /**
   * Codex asking to widen the sandbox — network access, or a directory outside the workspace. Denying grants an
   * empty profile rather than declining the turn, so the model carries on with what it already had.
   */
  private awaitPermissions(raw: unknown): Promise<Record<string, unknown>> {
    const params = raw as { threadId?: unknown; turnId?: unknown; itemId?: unknown; reason?: unknown;
      permissions?: { network?: unknown; fileSystem?: unknown } };
    const state = [...this.sessions.values()].find((candidate) =>
      candidate.providerThreadId === stringValue(params.threadId));
    if (state === undefined) return Promise.resolve({ permissions: {}, scope: "turn" });
    const profile = params.permissions ?? {};
    const granted = { ...(profile.network == null ? {} : { network: profile.network }),
      ...(profile.fileSystem == null ? {} : { fileSystem: profile.fileSystem }) };
    const requestId = stringValue(params.itemId, randomUUID());
    const runId = stringValue(params.turnId, state.activeTurnId ?? requestId);
    this.emit(state.session.id, runId, { type: "permission.requested",
      request: { id: requestId, sessionId: state.session.id, runId, agentId: this.id,
        kind: profile.network == null ? "external_directory" : "network",
        title: profile.network == null ? "Access files outside the workspace" : "Access the network",
        detail: stringValue(params.reason, JSON.stringify(granted)), risk: "high" } });
    return new Promise((resolve) => this.approvals.set(requestId, { sessionId: state.session.id, resolve,
      kind: "permissions", toResponse: (decision) => decision === "deny" ? { permissions: {}, scope: "turn" }
        : { permissions: granted, scope: decision === "allow_session" ? "session" : "turn" } }));
  }

  /**
   * An MCP server asking the user to fill in an arbitrary JSON-schema form. The app has no renderer for one, and a
   * request left unanswered stalls the turn, so it is declined — which is what the server's protocol expects.
   */
  private declineElicitation(raw: unknown): Promise<Record<string, unknown>> {
    const params = raw as { threadId?: unknown; turnId?: unknown; serverName?: unknown; message?: unknown };
    const state = [...this.sessions.values()].find((candidate) =>
      candidate.providerThreadId === stringValue(params.threadId));
    if (state !== undefined) {
      const runId = stringValue(params.turnId, state.activeTurnId ?? randomUUID());
      this.emit(state.session.id, runId, { type: "tool.progress", tool: stringValue(params.serverName, "mcp"),
        detail: `Declined a form request: ${stringValue(params.message, "no message")}` });
    }
    return Promise.resolve({ action: "decline", content: null, _meta: null });
  }

  private recordSession(input: StartSessionInput, providerThreadId: string): AgentSession {
    const now = new Date().toISOString();
    const session: AgentSession = { id: randomUUID(), conversationId: input.conversationId,
      providerSessionId: providerThreadId, agentId: this.id, projectId: input.projectId,
      createdAt: now, updatedAt: now, status: "idle" };
    this.sessions.set(session.id, { session, providerThreadId, queue: new AsyncQueue(), sequence: 0 });
    return session;
  }

  private emit(sessionId: string, runId: string,
    payload: AgentEventPayload): void {
    const state = this.requireSession(sessionId);
    state.queue.push({ id: randomUUID(), sessionId, runId, agentId: this.id,
      timestamp: new Date().toISOString(), sequence: state.sequence++, ...payload });
  }

  private requireSession(sessionId: string): SessionState {
    const state = this.sessions.get(sessionId);
    if (state === undefined) throw new AgentError("SESSION_NOT_FOUND", `Unknown Codex session: ${sessionId}`, this.id);
    return state;
  }

  private capabilities() {
    return { streaming: true, persistentSessions: true, cancellation: true, concurrentRuns: false,
      nativeStructuredOutput: true, planMode: true, effortControl: true, interactivePermissions: true,
      diffEvents: true, shellEvents: true, fileEvents: true, modelSelection: true, mcp: true,
      customTools: false, additionalDirectories: true };
  }

  private compatibilityWarnings(version: string): string[] {
    const result = providerCompatibility(this.id, version);
    return result.warning === undefined ? [] : [result.warning];
  }
}
