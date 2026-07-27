import { randomUUID } from "node:crypto";
import type { AgentManager } from "@waing/agent-core";
import { AgentError, reviewResultSchema, workflowHandoffPacketSchema, workflowStepResultSchema } from "@waing/domain";
import type {
  AgentEvent, AgentRequest, DocumentTaskInput, FixPacket, RoleExecutionProfile, StepAnnouncementIntent, WorkflowContext,
  WorkflowHandoffPacket, WorkflowNode, WorkflowStepResult,
} from "@waing/domain";

export interface ResolvedProfileDisplay { agentDisplayName: string; modelDisplayName?: string }
export interface StepExecutionInput {
  stepRunId: string;
  node: Exclude<WorkflowNode, { type: "router" | "loop" | "complete" }>;
  profile: RoleExecutionProfile;
  context: WorkflowContext;
  handoff: WorkflowHandoffPacket;
  fixPacket?: FixPacket;
  documentInput?: DocumentTaskInput;
  intent?: StepAnnouncementIntent;
  signal: AbortSignal;
}
export interface WorkflowStepExecutor {
  describe(profile: RoleExecutionProfile): Promise<ResolvedProfileDisplay>;
  execute(input: StepExecutionInput): Promise<WorkflowStepResult>;
  cancel?(): Promise<void>;
}

export class AgentStepExecutor implements WorkflowStepExecutor {
  private activeSessionId?: string;
  constructor(private readonly agents: AgentManager) {}

  async describe(profile: RoleExecutionProfile): Promise<ResolvedProfileDisplay> {
    const agent = this.agents.registry.get(profile.agentId);
    const descriptor = await agent.discover();
    const model = profile.modelId === undefined ? undefined : (await agent.listModels()).find((candidate) => candidate.modelId === profile.modelId);
    return { agentDisplayName: descriptor.displayName,
      ...(model === undefined ? {} : { modelDisplayName: model.displayName }) };
  }

  async execute(input: StepExecutionInput): Promise<WorkflowStepResult> {
    workflowHandoffPacketSchema.parse(input.handoff);
    if (input.signal.aborted) throw new AgentError("CANCELLED", "Workflow step cancelled");
    const session = await this.agents.startSession(input.profile.agentId, { conversationId: input.context.workflowRunId,
      projectId: input.context.projectId, projectRoot: input.context.projectRoot });
    this.activeSessionId = session.id;
    const events: AgentEvent[] = [];
    let settle: ((event: AgentEvent) => void) | undefined;
    const terminal = new Promise<AgentEvent>((resolve) => { settle = resolve; });
    const unsubscribe = this.agents.eventBus.subscribe((event) => {
      if (event.sessionId !== session.id) return; events.push(event);
      if (event.type === "run.completed" || event.type === "run.failed") settle?.(event);
    });
    const onAbort = (): void => { void this.agents.cancel(session.id); };
    input.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await this.agents.send(session.id, { text: this.prompt(input), projectRoot: input.context.projectRoot,
        ...await this.supportedControls(input) });
      const timeoutMs = input.profile.timeoutMs ?? 30 * 60 * 1000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const terminalEvent = await Promise.race([terminal, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AgentError("TIMEOUT", `Workflow step ${input.node.id} timed out`, input.profile.agentId, true)), timeoutMs);
      })]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
      return this.result(input, events, terminalEvent);
    } finally {
      input.signal.removeEventListener("abort", onAbort); unsubscribe(); delete this.activeSessionId;
    }
  }

  async cancel(): Promise<void> { if (this.activeSessionId !== undefined) await this.agents.cancel(this.activeSessionId); }

  /**
   * A role profile carries a mode, model, and effort for every role, but providers differ: some CLIs expose no model
   * selection, and only some expose reasoning effort or plan mode. Requesting an unsupported control makes
   * `AgentManager.send` fail the step outright, so a saved default is dropped rather than allowed to kill the run.
   * An explicit per-run choice in the renderer still fails loudly — that path never comes through here.
   */
  private async supportedControls(input: StepExecutionInput): Promise<Pick<AgentRequest, "mode" | "model" | "effort">> {
    const { capabilities } = await this.agents.registry.get(input.profile.agentId).discover();
    const requested = input.profile.mode ?? this.defaultMode(input.node);
    const mode = requested === "plan" && !capabilities.planMode ? "execute" : requested;
    const model = capabilities.modelSelection ? input.profile.modelId : undefined;
    const effort = capabilities.effortControl ? input.profile.effort : undefined;
    return { mode, ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
  }

  private prompt(input: StepExecutionInput): string {
    const sections = [input.profile.instructions, "instructions" in input.node ? input.node.instructions : undefined,
      `Provider-neutral workflow handoff:\n${JSON.stringify(input.handoff)}`].filter((value): value is string => value !== undefined);
    if (input.node.type === "review_gate") sections.push("Return a final JSON object with verdict, summary, findings, testsObserved, and confidence.");
    if (input.node.type === "document") sections.push(`Document task input:\n${JSON.stringify(input.documentInput)}`);
    if (input.node.type === "role_task" && input.node.role === "bugfix") sections.push(
      "Address blocking review finding IDs first; avoid unrelated refactoring; report unresolved findings.",
      `Fix packet:\n${JSON.stringify(input.fixPacket)}`,
    );
    return sections.join("\n\n");
  }

  private result(input: StepExecutionInput, events: AgentEvent[], terminal: AgentEvent): WorkflowStepResult {
    const messages = events.filter((event) => event.type === "message.delta" || event.type === "message.completed")
      .map((event) => event.text).join("");
    const commands: Array<{ command: string[]; exitCode: number | null }> = events
      .filter((event) => event.type === "command.started").map((event) => ({ command: [...event.command], exitCode: null }));
    const completions = events.filter((event) => event.type === "command.completed");
    completions.forEach((event, index) => { if (commands[index] !== undefined) commands[index].exitCode = event.exitCode; });
    const filesChanged = [...new Set(events.filter((event) => event.type === "file.changed").map((event) => event.path))];
    // The newest diff is what a later reviewer or doc writer has to work from, so it travels with the result.
    const diff = [...events].reverse().find((event) => event.type === "diff.updated")?.diff;
    const filesRead = [...new Set(events.filter((event) => event.type === "file.read").map((event) => event.path))];
    const review = input.node.type === "review_gate" ? this.parseReview(messages) : undefined;
    const artifacts = input.node.type === "document" && input.node.path !== undefined ? [{ id: randomUUID(), kind: input.node.documentKind,
      path: input.node.path, createdByStepRunId: input.stepRunId }] : [];
    return workflowStepResultSchema.parse({ stepRunId: input.stepRunId, nodeId: input.node.id, role: input.node.role,
      agentId: input.profile.agentId, ...(input.profile.modelId === undefined ? {} : { modelId: input.profile.modelId }),
      ...(input.profile.effort === undefined ? {} : { effort: input.profile.effort }),
      status: terminal.type === "run.completed" ? "completed"
        : terminal.type === "run.failed" && terminal.code === "CANCELLED" ? "cancelled" : "failed",
      summary: messages || (terminal.type === "run.failed" ? terminal.message : `${input.node.label} completed`),
      filesRead, filesChanged, ...(diff === undefined ? {} : { diff }), commandsRun: commands,
      testsRun: commands.filter((command) => command.command.some((part) => /test/u.test(part))).map((command) => ({
        command: command.command.join(" "), passed: command.exitCode === 0, exitCode: command.exitCode,
      })), artifacts,
      ...(review === undefined ? {} : { findings: review.findings, reviewVerdict: review.verdict,
        unresolvedIssues: review.findings.filter((finding) => finding.severity === "critical" || finding.severity === "high").map((finding) => finding.title) }),
    });
  }

  private parseReview(text: string) {
    const start = text.indexOf("{"); const end = text.lastIndexOf("}");
    if (start < 0 || end < start) throw new AgentError("PROTOCOL_ERROR", "Review step did not return structured JSON");
    return reviewResultSchema.parse(JSON.parse(text.slice(start, end + 1)) as unknown);
  }
  private defaultMode(node: StepExecutionInput["node"]): "execute" | "review" {
    return node.type === "review_gate" || node.type === "role_task" && node.role === "review" ? "review" : "execute";
  }
}
