import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, Options, PermissionResult, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue, providerCompatibility } from "@waing/agent-core";
import type { CodingAgent } from "@waing/agent-core";
import { AgentError } from "@waing/domain";
import type {
  AgentDescriptor, AgentEvent, AgentModelDescriptor, AgentQuestionItem, AgentQuestionResponse, AgentRequest,
  AgentRun, AgentSession, PermissionDecision, ResumeSessionInput, StartSessionInput,
} from "@waing/domain";

/** Claude's built-in question tool. The CLI can only render it in its own terminal UI, so an SDK host that
 * lets it execute gets "The user did not answer the questions." back — the question must be intercepted
 * at the permission callback instead, and the answer returned as the tool's result. */
const QUESTION_TOOL = "AskUserQuestion";

function parseQuestions(input: Record<string, unknown>): AgentQuestionItem[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  return raw.flatMap((entry): AgentQuestionItem[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const item = entry as Record<string, unknown>;
    const options = (Array.isArray(item.options) ? item.options : []).flatMap((choice) => {
      if (typeof choice !== "object" || choice === null) return [];
      const values = choice as Record<string, unknown>;
      return typeof values.label === "string" && values.label.length > 0
        ? [{ label: values.label, description: typeof values.description === "string" ? values.description : "" }] : [];
    });
    if (typeof item.question !== "string" || options.length === 0) return [];
    return [{ question: item.question, header: typeof item.header === "string" && item.header.length > 0
      ? item.header : item.question.slice(0, 12),
      ...(item.multiSelect === true ? { multiSelect: true } : {}), options }];
  }).slice(0, 4);
}

type QueryFactory = (params: { prompt: string; options?: Options }) => Query;
type EventBaseKeys = "id" | "sessionId" | "runId" | "agentId" | "timestamp" | "sequence";
type EventPayload<T> = T extends unknown ? Omit<T, EventBaseKeys> : never;

interface ClaudeSessionState {
  session: AgentSession;
  projectRoot: string;
  queue: AsyncQueue<AgentEvent>;
  sequence: number;
  active?: { runId: string; query: Query };
}

export class ClaudeAdapter implements CodingAgent {
  readonly id = "claude";
  private readonly sessions = new Map<string, ClaudeSessionState>();
  private readonly permissionResolvers = new Map<string, {
    sessionId: string;
    suggestions?: Parameters<CanUseTool>[2]["suggestions"];
    resolve: (result: PermissionResult) => void;
  }>();
  private readonly questionResolvers = new Map<string, {
    sessionId: string;
    resolve: (result: PermissionResult) => void;
  }>();

  constructor(
    private readonly queryFactory: QueryFactory = query,
    private readonly sdkVersion = "0.3.220",
  ) {}

  discover(): Promise<AgentDescriptor> {
    return Promise.resolve({
      id: this.id, displayName: "Claude Code", installed: true, available: true,
      version: this.sdkVersion, capabilities: this.capabilities(), authState: "unknown",
      warnings: [providerCompatibility(this.id, this.sdkVersion).warning]
        .filter((warning): warning is string => warning !== undefined),
    });
  }

  listModels(): Promise<AgentModelDescriptor[]> {
    return Promise.resolve(["sonnet", "opus", "haiku"].map((modelId, index) => ({
      agentId: this.id, modelId, displayName: `Claude ${modelId[0]?.toUpperCase() ?? ""}${modelId.slice(1)}`,
      available: true, isDefault: index === 0, effortLevels: ["low", "medium", "high", "max"],
      modes: ["execute", "plan", "review", "investigate"],
      warnings: ["Alias resolves to the currently configured Claude Code model"],
    })));
  }

  startSession(input: StartSessionInput): Promise<AgentSession> {
    return Promise.resolve(this.recordSession(input));
  }

  resumeSession(input: ResumeSessionInput): Promise<AgentSession> {
    return Promise.resolve(this.recordSession(input, input.providerSessionId));
  }

  send(sessionId: string, request: AgentRequest): Promise<AgentRun> {
    const state = this.requireSession(sessionId);
    if (state.active !== undefined) throw new AgentError("PROTOCOL_ERROR", "Claude session already has an active run", this.id, true);
    const run: AgentRun = { id: randomUUID(), sessionId, startedAt: new Date().toISOString() };
    const canUseTool = this.createPermissionHandler(state, run.id);
    const options: Options = {
      cwd: request.projectRoot,
      includePartialMessages: true,
      canUseTool,
      permissionMode: request.mode === "plan" ? "plan" : "default",
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      ...(request.additionalDirectories === undefined ? {} : { additionalDirectories: request.additionalDirectories }),
      ...(request.responseFormat === undefined ? {} : {
        outputFormat: { type: "json_schema", schema: request.responseFormat.schema },
      }),
      ...(state.session.providerSessionId === undefined ? {} : { resume: state.session.providerSessionId }),
    };
    const activeQuery = this.queryFactory({ prompt: request.text, options });
    state.active = { runId: run.id, query: activeQuery };
    this.emit(state, run.id, { type: "run.started" });
    void this.consume(state, run.id, activeQuery);
    return Promise.resolve(run);
  }

  async cancel(sessionId: string): Promise<void> {
    this.releaseQuestions(sessionId);
    const active = this.requireSession(sessionId).active;
    if (active !== undefined) await active.query.interrupt();
  }

  respondToPermission(sessionId: string, requestId: string, decision: PermissionDecision): Promise<void> {
    const pending = this.permissionResolvers.get(requestId);
    if (pending === undefined || pending.sessionId !== sessionId) {
      throw new AgentError("SESSION_NOT_FOUND", `Unknown Claude permission: ${requestId}`, this.id);
    }
    this.permissionResolvers.delete(requestId);
    if (decision === "deny") pending.resolve({ behavior: "deny", message: "User denied this action" });
    else pending.resolve({ behavior: "allow",
      ...(decision === "allow_session" && pending.suggestions !== undefined
        ? { updatedPermissions: pending.suggestions } : {}) });
    const state = this.requireSession(sessionId);
    this.emit(state, state.active?.runId ?? requestId, { type: "permission.resolved", requestId, decision });
    return Promise.resolve();
  }

  /** The CLI has no channel for handing an answer to a tool it is executing, so the tool call is refused and
   * the answer travels back as the refusal message — which is what the model reads as the tool result. */
  respondToQuestion(sessionId: string, questionId: string, answers: AgentQuestionResponse): Promise<void> {
    const pending = this.questionResolvers.get(questionId);
    if (pending === undefined || pending.sessionId !== sessionId) {
      throw new AgentError("SESSION_NOT_FOUND", `Unknown Claude question: ${questionId}`, this.id);
    }
    this.questionResolvers.delete(questionId);
    pending.resolve({ behavior: "deny", message: answers.length === 0
      ? "The user did not answer the questions."
      : answers.map((answer) => `${answer.header}: ${answer.values.join(", ")}`).join("\n") });
    const state = this.requireSession(sessionId);
    this.emit(state, state.active?.runId ?? questionId, { type: "question.resolved", questionId, answers });
    return Promise.resolve();
  }

  closeSession(sessionId: string): Promise<void> {
    const state = this.requireSession(sessionId);
    this.releaseQuestions(sessionId);
    state.active?.query.close();
    state.queue.end();
    this.sessions.delete(sessionId);
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    for (const sessionId of this.sessions.keys()) this.releaseQuestions(sessionId);
    for (const state of this.sessions.values()) {
      state.active?.query.close(); state.queue.end();
    }
    this.sessions.clear();
    return Promise.resolve();
  }

  events(sessionId: string): AsyncIterable<AgentEvent> { return this.requireSession(sessionId).queue; }

  private async consume(state: ClaudeSessionState, runId: string, activeQuery: Query): Promise<void> {
    try {
      for await (const message of activeQuery) this.handleMessage(state, runId, message);
    } catch (cause) {
      this.emit(state, runId, { type: "run.failed", code: "PROCESS_FAILED",
        message: cause instanceof Error ? cause.message : "Claude SDK failed", retryable: true });
    } finally {
      delete state.active;
    }
  }

  private handleMessage(state: ClaudeSessionState, runId: string, message: SDKMessage): void {
    if (message.session_id !== "") {
      state.session.providerSessionId = message.session_id;
      state.session.updatedAt = new Date().toISOString();
    }
    if (message.type === "stream_event") {
      const event = message.event as unknown as { type?: string; delta?: { type?: string; text?: string } };
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        this.emit(state, runId, { type: "message.delta", text: event.delta.text ?? "" });
      }
    } else if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") this.emit(state, runId, { type: "message.completed", text: block.text });
        else if (block.type === "tool_use") this.emitToolStarted(state, runId, block.name, block.input, block.id);
      }
    } else if (message.type === "tool_progress") {
      this.emit(state, runId, { type: "tool.progress", tool: message.tool_name,
        detail: `${Math.round(message.elapsed_time_seconds)}s elapsed` });
    } else if (message.type === "result") {
      this.emit(state, runId, { type: "usage.updated", inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens });
      if (message.subtype === "success") this.emit(state, runId, { type: "run.completed", summary: message.result });
      else this.emit(state, runId, { type: "run.failed", code: "PROCESS_FAILED",
        message: message.errors.join("\n") || message.subtype, retryable: true });
    } else if (message.type === "system" && message.subtype === "permission_denied") {
      this.emit(state, runId, { type: "tool.completed", tool: message.tool_name, output: message.message });
    } else if (message.type === "auth_status" && message.error !== undefined) {
      this.emit(state, runId, { type: "run.failed", code: "AUTH_FAILED", message: message.error, retryable: false });
    }
  }

  private emitToolStarted(state: ClaudeSessionState, runId: string, tool: string, input: unknown, toolUseId: string): void {
    const data = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
    if (tool === "Bash") {
      const command = typeof data.command === "string" ? data.command : "";
      this.emit(state, runId, { type: "command.started", command: [command] });
    } else if (["Read", "Edit", "Write"].includes(tool)) {
      const path = typeof data.file_path === "string" ? data.file_path : "";
      if (tool === "Read") this.emit(state, runId, { type: "file.read", path });
      else this.emit(state, runId, { type: "file.changed", path, change: tool === "Write" ? "created" : "updated" });
    } else this.emit(state, runId, { type: "tool.started", tool, input: { toolUseId, input } });
  }

  private createPermissionHandler(state: ClaudeSessionState, runId: string): CanUseTool {
    return (toolName, input, options) => {
      const requestId = options.toolUseID;
      if (toolName === QUESTION_TOOL) return this.askQuestion(state, runId, requestId, input);
      const command = toolName === "Bash" && typeof input.command === "string" ? [input.command] : undefined;
      const filePath = typeof input.file_path === "string" ? [input.file_path] :
        options.blockedPath === undefined ? undefined : [options.blockedPath];
      this.emit(state, runId, { type: "permission.requested", request: {
        id: requestId, sessionId: state.session.id, runId, agentId: this.id,
        kind: toolName === "Bash" ? "shell" : "file_write",
        title: options.title ?? options.displayName ?? `Use ${toolName}`,
        detail: options.description ?? options.decisionReason ?? JSON.stringify(input), risk: "medium",
        ...(command === undefined ? {} : { command }), ...(filePath === undefined ? {} : { paths: filePath }),
      } });
      return new Promise((resolve) => this.permissionResolvers.set(requestId, {
        sessionId: state.session.id, suggestions: options.suggestions, resolve,
      }));
    };
  }

  /** Parks the tool call and surfaces the question. Nothing else can answer it, so a run left waiting here
   * would only end at the step timeout. */
  private askQuestion(state: ClaudeSessionState, runId: string, questionId: string,
    input: Record<string, unknown>): Promise<PermissionResult> {
    const questions = parseQuestions(input);
    if (questions.length === 0) {
      return Promise.resolve({ behavior: "deny", message: "The user did not answer the questions." });
    }
    this.emit(state, runId, { type: "question.requested",
      question: { id: questionId, sessionId: state.session.id, runId, agentId: this.id, questions } });
    return new Promise((resolve) => this.questionResolvers.set(questionId, { sessionId: state.session.id, resolve }));
  }

  /** A parked question holds the SDK's tool call open; leaving one behind would hang the run past cancellation. */
  private releaseQuestions(sessionId: string): void {
    for (const [questionId, pending] of this.questionResolvers) {
      if (pending.sessionId !== sessionId) continue;
      this.questionResolvers.delete(questionId);
      pending.resolve({ behavior: "deny", message: "The user did not answer the questions." });
    }
  }

  private recordSession(input: StartSessionInput, providerSessionId?: string): AgentSession {
    const now = new Date().toISOString();
    const session: AgentSession = { id: randomUUID(), conversationId: input.conversationId,
      ...(providerSessionId === undefined ? {} : { providerSessionId }), agentId: this.id,
      projectId: input.projectId, createdAt: now, updatedAt: now, status: "idle" };
    this.sessions.set(session.id, { session, projectRoot: input.projectRoot, queue: new AsyncQueue(), sequence: 0 });
    return session;
  }

  private emit(state: ClaudeSessionState, runId: string, payload: EventPayload<AgentEvent>): void {
    state.queue.push({ id: randomUUID(), sessionId: state.session.id, runId, agentId: this.id,
      timestamp: new Date().toISOString(), sequence: state.sequence++, ...payload });
  }

  private requireSession(sessionId: string): ClaudeSessionState {
    const state = this.sessions.get(sessionId);
    if (state === undefined) throw new AgentError("SESSION_NOT_FOUND", `Unknown Claude session: ${sessionId}`, this.id);
    return state;
  }

  private capabilities() {
    return { streaming: true, persistentSessions: true, cancellation: true, concurrentRuns: false,
      nativeStructuredOutput: true, planMode: true, effortControl: true, interactivePermissions: true,
      diffEvents: false, shellEvents: true, fileEvents: true, modelSelection: true, mcp: true,
      customTools: true, additionalDirectories: true };
  }
}
