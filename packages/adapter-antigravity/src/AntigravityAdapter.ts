import { randomUUID } from "node:crypto";
import { AsyncQueue, ProcessSupervisor, probeVersion, resolveExecutable } from "@waing/agent-core";
import type { CodingAgent, ManagedProcess } from "@waing/agent-core";
import { AgentError } from "@waing/domain";
import type {
  AgentDescriptor, AgentEvent, AgentModelDescriptor, AgentRequest, AgentRun, AgentSession, EffortLevel,
  ResumeSessionInput, StartSessionInput,
} from "@waing/domain";
import {
  isCommandTool, isReadTool, isWriteTool, parseAntigravityLine, toolCommand, toolPath,
} from "./AntigravityStream";
import type { AntigravityStepUpdate } from "./AntigravityStream";

type EventBaseKeys = "id" | "sessionId" | "runId" | "agentId" | "timestamp" | "sequence";
type EventPayload<T> = T extends unknown ? Omit<T, EventBaseKeys> : never;
interface State {
  session: AgentSession;
  root: string;
  queue: AsyncQueue<AgentEvent>;
  sequence: number;
  activeRunId?: string;
  process?: ManagedProcess;
  cancelled?: boolean;
  /** Tool steps report ACTIVE then DONE; the started event is emitted once per step index. */
  activeTools: Map<number, string>;
}

export interface AntigravityAdapterOptions {
  supervisor?: ProcessSupervisor;
  executable?: string;
  /** Upper bound handed to `--print-timeout`; the CLI's own default is five minutes. */
  printTimeoutSeconds?: number;
  /** `agy models` occasionally stalls, so model discovery is bounded and falls back to the provider default. */
  modelListTimeoutMs?: number;
}

/**
 * Antigravity CLI (`agy`) adapter. Each run is one `agy --output-format stream-json --print` process emitting JSONL:
 * an `init` header carrying the conversation id, `step_update` lines for assistant text and tool calls, then a
 * `result` line with the final response and token usage. The conversation id is reused with `--conversation` so a
 * Waing session keeps its context across turns.
 *
 * Print mode approves its own tool calls, so Waing cannot gate this provider's writes; that is published as a
 * descriptor warning rather than pretended away with a permission profile it cannot enforce.
 */
export class AntigravityAdapter implements CodingAgent {
  readonly id = "antigravity";
  private readonly supervisor: ProcessSupervisor;
  private readonly executable: string;
  private readonly sessions = new Map<string, State>();
  private path?: string;
  private version?: string;
  private models?: AgentModelDescriptor[];

  constructor(private readonly options: AntigravityAdapterOptions = {}) {
    this.supervisor = options.supervisor ?? new ProcessSupervisor();
    this.executable = options.executable ?? "agy";
  }

  async discover(): Promise<AgentDescriptor> {
    try {
      this.path ??= await resolveExecutable(this.executable);
      this.version ??= (await probeVersion(this.supervisor, this.path, ["--version"])).trim();
      return { id: this.id, displayName: "Antigravity", installed: true, available: true, version: this.version,
        executablePath: this.path, capabilities: this.capabilities(), authState: "unknown",
        warnings: ["Antigravity approves its own tool calls in print mode; Waing cannot prompt before its file writes or commands"] };
    } catch (error) {
      if (error instanceof AgentError && error.code === "NOT_INSTALLED") return { id: this.id, displayName: "Antigravity",
        installed: false, available: false, capabilities: this.capabilities(), authState: "missing", warnings: [error.message] };
      throw error;
    }
  }

  async listModels(): Promise<AgentModelDescriptor[]> {
    if (this.models !== undefined) return this.models;
    const { executablePath } = await this.discover();
    if (executablePath === undefined) return [];
    const output = await this.modelList(executablePath);
    const ids = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !line.includes(" "));
    if (ids.length === 0) {
      // Not cached: a stalled listing should not permanently hide the real models from the picker.
      return [{ agentId: this.id, modelId: "default", displayName: "Antigravity default", available: true,
        isDefault: true, modes: ["execute", "plan", "review", "investigate"],
        warnings: ["Could not read `agy models`; the CLI's own default model will be used"] }];
    }
    this.models = ids.map((modelId, index) => ({ agentId: this.id, modelId, displayName: modelId, available: true,
      isDefault: index === 0, effortLevels: ["low", "medium", "high"], modes: ["execute", "plan", "review", "investigate"] }));
    return this.models;
  }

  startSession(input: StartSessionInput): Promise<AgentSession> {
    return Promise.resolve(this.record(input));
  }

  resumeSession(input: ResumeSessionInput): Promise<AgentSession> {
    return Promise.resolve(this.record(input, input.providerSessionId));
  }

  async send(sessionId: string, request: AgentRequest): Promise<AgentRun> {
    const state = this.requireSession(sessionId);
    if (state.activeRunId !== undefined) throw new AgentError("PROTOCOL_ERROR", "Antigravity session already has an active run", this.id, true);
    const { executablePath } = await this.discover();
    if (executablePath === undefined) throw new AgentError("NOT_INSTALLED", "Antigravity CLI is unavailable", this.id);
    const run = { id: randomUUID(), sessionId, startedAt: new Date().toISOString() };
    state.activeRunId = run.id; state.cancelled = false; state.activeTools.clear();
    this.emit(state, run.id, { type: "run.started" });

    const process = this.supervisor.spawn(executablePath, this.args(state, request), { cwd: state.root });
    state.process = process;
    // The CLI never reads stdin in print mode; closing it keeps the child from waiting on an open pipe.
    process.child.stdin.end();
    let buffer = "";
    let settled = false;
    process.child.stdout.setEncoding("utf8");
    process.child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
      for (const line of lines) settled = this.consume(state, run.id, line) || settled;
    });
    void this.supervisor.waitForExit(process).then(() => {
      if (buffer.length > 0) settled = this.consume(state, run.id, buffer) || settled;
      delete state.process; delete state.activeRunId;
      // A clean exit without a result line still ends the run, or the caller would wait forever.
      if (!settled) this.emit(state, run.id, { type: "run.completed" });
    }).catch((cause: unknown) => {
      delete state.process; delete state.activeRunId;
      if (settled) return;
      if (state.cancelled === true) {
        this.emit(state, run.id, { type: "run.failed", code: "CANCELLED", message: "Antigravity run cancelled", retryable: false });
        return;
      }
      const reason = cause instanceof Error ? cause.message : "Antigravity run failed";
      const detail = process.stderr.join("").trim();
      this.emit(state, run.id, { type: "run.failed", code: "PROCESS_FAILED",
        message: detail.length > 0 ? `${reason}: ${detail.slice(-2_000)}` : reason, retryable: true });
    });
    return run;
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.requireSession(sessionId);
    state.cancelled = true;
    await state.process?.stop();
  }

  respondToPermission(): Promise<void> {
    return Promise.reject(new AgentError("CAPABILITY_UNSUPPORTED", "Antigravity print mode has no interactive permissions", this.id));
  }

  closeSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    state?.queue.end(); this.sessions.delete(sessionId);
    return Promise.resolve();
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(async (state) => { await state.process?.stop(); state.queue.end(); }));
    this.sessions.clear();
  }

  events(sessionId: string): AsyncIterable<AgentEvent> { return this.sessions.get(sessionId)?.queue ?? new AsyncQueue(); }

  /** Returns true once a terminal event has been emitted for this run. */
  private consume(state: State, runId: string, line: string): boolean {
    const parsed = parseAntigravityLine(line);
    if (parsed === undefined) return false;
    if (parsed.event === "init" && "conversation_id" in parsed && typeof parsed.conversation_id === "string") {
      state.session.providerSessionId = parsed.conversation_id;
      return false;
    }
    if (parsed.event === "step_update" && "step_update" in parsed && parsed.step_update !== undefined) {
      this.consumeStep(state, runId, parsed.step_update);
      return false;
    }
    if (parsed.event !== "result" || !("result" in parsed) || parsed.result === undefined) return false;
    // The result line ends the turn even though the process has not exited yet; a caller that saw the terminal
    // event must be able to send the next turn immediately.
    delete state.activeRunId;
    const { status, response, usage, error } = parsed.result;
    if (usage?.input_tokens !== undefined || usage?.output_tokens !== undefined) {
      this.emit(state, runId, { type: "usage.updated", inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 });
    }
    if (typeof response === "string" && response.trim().length > 0) {
      this.emit(state, runId, { type: "message.completed", text: response.trim() });
    }
    if (status !== undefined && status.toUpperCase() !== "SUCCESS") {
      const message = error ?? response ?? `Antigravity run ended with status ${status}`;
      const cancelled = status.toUpperCase() === "CANCELLED" || state.cancelled === true;
      this.emit(state, runId, { type: "run.failed", code: cancelled ? "CANCELLED" : "PROCESS_FAILED", message, retryable: !cancelled });
    } else this.emit(state, runId, { type: "run.completed" });
    return true;
  }

  private consumeStep(state: State, runId: string, step: AntigravityStepUpdate): void {
    if (typeof step.text_delta === "string" && step.text_delta.length > 0) {
      this.emit(state, runId, { type: "message.delta", text: step.text_delta });
    }
    if (step.step_type !== "tool") return;
    const tool = step.tool_name ?? step.tool_info?.name;
    if (tool === undefined) return;
    const parameters = step.tool_info?.parameters;
    const index = step.step_index ?? -1;
    const path = toolPath(parameters);
    const command = toolCommand(parameters);
    if (step.state?.toUpperCase() !== "DONE") {
      if (state.activeTools.get(index) === tool) return;
      state.activeTools.set(index, tool);
      this.emit(state, runId, { type: "tool.started", tool, ...(parameters === undefined ? {} : { input: parameters }) });
      if (isCommandTool(tool) && command !== undefined) this.emit(state, runId, { type: "command.started", command: [command] });
      return;
    }
    state.activeTools.delete(index);
    if (path !== undefined && isReadTool(tool)) this.emit(state, runId, { type: "file.read", path });
    if (path !== undefined && isWriteTool(tool)) this.emit(state, runId, { type: "file.changed", path, change: "updated" });
    if (isCommandTool(tool)) this.emit(state, runId, { type: "command.completed", exitCode: null });
    this.emit(state, runId, { type: "tool.completed", tool });
  }

  private args(state: State, request: AgentRequest): string[] {
    const args = ["--output-format", "stream-json", "--print", request.text, "--add-dir", state.root,
      "--print-timeout", `${String(this.options.printTimeoutSeconds ?? 3_600)}s`];
    // Reusing the conversation id is what makes a second turn in the same Waing session keep its context.
    if (state.session.providerSessionId !== undefined) args.push("--conversation", state.session.providerSessionId);
    if (request.model !== undefined && request.model !== "default") args.push("--model", request.model);
    if (request.effort !== undefined) args.push("--effort", effortFlag(request.effort));
    // Only plan maps to a CLI mode; review and investigate are prompt-level intents the model already receives.
    if (request.mode === "plan") args.push("--mode", "plan");
    return args;
  }

  private async modelList(executablePath: string): Promise<string> {
    const process = this.supervisor.spawn(executablePath, ["models"]);
    process.child.stdin.end();
    let output = "";
    process.child.stdout.setEncoding("utf8");
    process.child.stdout.on("data", (chunk: string) => { output += chunk; });
    const timeoutMs = this.options.modelListTimeoutMs ?? 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.supervisor.waitForExit(process), new Promise<void>((resolve) => {
        timer = setTimeout(() => { void process.stop().then(resolve, resolve); }, timeoutMs);
      })]);
      return output;
    } catch { return ""; } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  private record(input: StartSessionInput | ResumeSessionInput, providerSessionId?: string): AgentSession {
    const now = new Date().toISOString();
    const session: AgentSession = { id: randomUUID(), conversationId: input.conversationId,
      ...(providerSessionId === undefined ? {} : { providerSessionId }), agentId: this.id, projectId: input.projectId,
      createdAt: now, updatedAt: now, status: "idle" };
    this.sessions.set(session.id, { session, root: input.projectRoot, queue: new AsyncQueue(), sequence: 0, activeTools: new Map() });
    return session;
  }

  private requireSession(id: string): State {
    const state = this.sessions.get(id);
    if (state === undefined) throw new AgentError("SESSION_NOT_FOUND", `Unknown Antigravity session: ${id}`, this.id);
    return state;
  }

  private emit(state: State, runId: string, payload: EventPayload<AgentEvent>): void {
    state.queue.push({ id: randomUUID(), sessionId: state.session.id, runId, agentId: this.id,
      timestamp: new Date().toISOString(), sequence: state.sequence++, ...payload });
  }

  private capabilities() {
    return { streaming: true, persistentSessions: true, cancellation: true, concurrentRuns: false,
      nativeStructuredOutput: false, planMode: true, effortControl: true, interactivePermissions: false,
      diffEvents: false, shellEvents: true, fileEvents: true, modelSelection: true, mcp: false, customTools: false,
      additionalDirectories: true };
  }
}

/** The CLI accepts only low, medium, and high, so Waing's `max` maps onto its highest setting. */
function effortFlag(effort: EffortLevel): string { return effort === "max" ? "high" : effort; }
