import type { AgentManager } from "@waing/agent-core";
import {
  AgentError, resolvePermissionProfile, workflowHandoffPacketSchema,
  workflowSharedStateUpdateSchema, workflowStepResultSchema,
} from "@waing/domain";
import type {
  AgentEvent, AgentProfile, AgentRequest, AgentSession, StepAnnouncementIntent, WorkflowContext,
  WorkflowHandoffPacket, WorkflowNode, WorkflowSharedStateUpdate, WorkflowStepResult,
} from "@waing/domain";
import { renderPacket } from "./ContextCompactor";

/** Fence label an agent wraps its shared-state amendment in, so it is separable from its prose. */
const STATE_FENCE = "waing-state";

export interface ResolvedProfileDisplay { agentDisplayName: string; modelDisplayName?: string }
export interface StepExecutionInput {
  stepRunId: string;
  node: Exclude<WorkflowNode, { type: "router" | "loop" | "complete" }>;
  profile: AgentProfile;
  context: WorkflowContext;
  handoff: WorkflowHandoffPacket;
  intent?: StepAnnouncementIntent;
  /** A provider session an earlier step on this same agent left behind; resumed when the provider can, so the prior
   * turns never have to be re-sent through the packet. */
  resumeProviderSessionId?: string;
  signal: AbortSignal;
}
export interface WorkflowStepExecutor {
  describe(profile: AgentProfile): Promise<ResolvedProfileDisplay>;
  execute(input: StepExecutionInput): Promise<WorkflowStepResult>;
  cancel?(): Promise<void>;
}

export class AgentStepExecutor implements WorkflowStepExecutor {
  private activeSessionId?: string;
  constructor(private readonly agents: AgentManager) {}

  async describe(profile: AgentProfile): Promise<ResolvedProfileDisplay> {
    const agent = this.agents.registry.get(profile.agentId);
    const descriptor = await agent.discover();
    const models = await agent.listModels().catch(() => []);
    const model = profile.modelId === undefined ? models.find((candidate) => candidate.isDefault)
      : models.find((candidate) => candidate.modelId === profile.modelId);
    return { agentDisplayName: descriptor.displayName,
      ...(model === undefined ? {} : { modelDisplayName: model.displayName }) };
  }

  async execute(input: StepExecutionInput): Promise<WorkflowStepResult> {
    workflowHandoffPacketSchema.parse(input.handoff);
    if (input.signal.aborted) throw new AgentError("CANCELLED", "Workflow step cancelled");
    const session = await this.openSession(input);
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
      return this.result(input, events, terminalEvent, session);
    } finally {
      input.signal.removeEventListener("abort", onAbort); unsubscribe(); delete this.activeSessionId;
    }
  }

  async cancel(): Promise<void> { if (this.activeSessionId !== undefined) await this.agents.cancel(this.activeSessionId); }

  /**
   * Consecutive steps on one agent are the cheapest context handoff there is: the provider still holds the earlier
   * turns, so resuming costs nothing where re-sending them costs the whole history again. Providers without
   * persistent sessions, and sessions the provider has since dropped, fall back to a fresh session plus the full
   * packet — the workflow context stays provider-neutral either way.
   */
  private async openSession(input: StepExecutionInput): Promise<AgentSession> {
    const start = { conversationId: input.context.workflowRunId, projectId: input.context.projectId,
      projectRoot: input.context.projectRoot };
    // The role's saved permission profile travels with the session, so approvals this step raises are answered
    // by the rule the user set for that role rather than prompting for every one of them.
    const permissions = resolvePermissionProfile(input.profile.permissionProfileId);
    if (input.resumeProviderSessionId !== undefined) {
      const { capabilities } = await this.agents.registry.get(input.profile.agentId).discover();
      if (capabilities.persistentSessions) {
        try {
          return await this.agents.resumeSession(input.profile.agentId,
            { ...start, providerSessionId: input.resumeProviderSessionId }, permissions);
        } catch { /* The provider forgot the session; a fresh one with the full packet is still correct. */ }
      }
    }
    return this.agents.startSession(input.profile.agentId, start, permissions);
  }

  /**
   * A role profile carries a mode, model, and effort for every role, but providers differ: some CLIs expose no model
   * selection, and only some expose reasoning effort or plan mode. Requesting an unsupported control makes
   * `AgentManager.send` fail the step outright, so a saved default is dropped rather than allowed to kill the run.
   * An explicit per-run choice in the renderer still fails loudly — that path never comes through here.
   */
  private async supportedControls(input: StepExecutionInput): Promise<Pick<AgentRequest, "mode" | "model" | "effort">> {
    const { capabilities } = await this.agents.registry.get(input.profile.agentId).discover();
    const mode = "execute" as const;
    const model = capabilities.modelSelection ? input.profile.modelId : undefined;
    const effort = capabilities.effortControl ? input.profile.effort : undefined;
    return { mode, ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
  }

  /**
   * Packets are rendered as headed plain text rather than JSON: identical content costs roughly half the tokens once
   * braces, quotes and repeated keys are gone. Empty fields render to nothing, so a short run sends a short prompt.
   */
  private prompt(input: StepExecutionInput): string {
    const sections = [input.profile.instructions, "instructions" in input.node ? input.node.instructions : undefined,
      renderPacket("Provider-neutral workflow handoff", input.handoff)].filter((value): value is string => value !== undefined);
    if (input.handoff.changedFiles !== undefined && input.handoff.currentDiff === undefined) sections.push(
      "Read the changed files listed above from the workspace; the diff is not reproduced here.");
    // Amending the shared state costs a few dozen tokens and spares every later step from re-deriving the plan out of
    // prose that compaction will eventually throw away.
    sections.push(`If the plan, a decision, or an open question changed, end with a ${STATE_FENCE} block containing`
      + ` only {"planItems":[{"id","title","status":pending|in_progress|done|dropped}],"decisions":[],"openQuestions":[]}.`
      + " Include only the keys that changed, and reuse an existing plan item id to revise it.");
    return sections.filter((section) => section.trim().length > 0).join("\n\n");
  }

  private result(input: StepExecutionInput, events: AgentEvent[], terminal: AgentEvent,
    session: AgentSession): WorkflowStepResult {
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
    // Stripped before anything else reads the message: the review gate scans for a bare JSON object and would
    // otherwise swallow the state block, and the stored summary should not repeat what the state already holds.
    const { text, update } = this.parseStateUpdate(messages);
    return workflowStepResultSchema.parse({ stepRunId: input.stepRunId, nodeId: input.node.id,
      agentProfileId: input.profile.id, agentName: input.profile.name,
      agentId: input.profile.agentId, ...(session.providerSessionId === undefined ? {} : { providerSessionId: session.providerSessionId }),
      ...(input.profile.modelId === undefined ? {} : { modelId: input.profile.modelId }),
      ...(input.profile.effort === undefined ? {} : { effort: input.profile.effort }),
      status: terminal.type === "run.completed" ? "completed"
        : terminal.type === "run.failed" && terminal.code === "CANCELLED" ? "cancelled" : "failed",
      summary: text || (terminal.type === "run.failed" ? terminal.message : `${input.node.label} completed`),
      ...(update === undefined ? {} : { stateUpdate: update }),
      filesRead, filesChanged, ...(diff === undefined ? {} : { diff }), commandsRun: commands,
      testsRun: commands.filter((command) => command.command.some((part) => /test/u.test(part))).map((command) => ({
        command: command.command.join(" "), passed: command.exitCode === 0, exitCode: command.exitCode,
      })),
    });
  }

  /**
   * The state block is advisory: a provider that ignores it, or emits something malformed, must not fail the step.
   * Only a well-formed block is taken, and it is always removed from the text the rest of the pipeline sees.
   */
  private parseStateUpdate(text: string): { text: string; update?: WorkflowSharedStateUpdate } {
    const pattern = new RegExp(`\`\`\`${STATE_FENCE}\\s*([\\s\\S]*?)\`\`\``, "gu");
    const matches = [...text.matchAll(pattern)];
    if (matches.length === 0) return this.parseBareStateUpdate(text);
    const stripped = text.replace(pattern, "").trim();
    const parsed = workflowSharedStateUpdateSchema.safeParse(this.json(matches.at(-1)?.[1] ?? ""));
    return parsed.success ? { text: stripped, update: parsed.data } : { text: stripped };
  }

  /**
   * Providers drop the fence often enough that the block would otherwise be read as prose and shown to the user as a
   * wall of JSON. A bare object is only taken when it parses as a state update and nothing but whitespace follows it.
   */
  private parseBareStateUpdate(text: string): { text: string; update?: WorkflowSharedStateUpdate } {
    const start = text.search(/\{\s*"(?:planItems|decisions|openQuestions)"/u);
    if (start < 0 || text.slice(start).trimEnd().at(-1) !== "}") return { text };
    const candidate = text.slice(start).trimEnd();
    const parsed = workflowSharedStateUpdateSchema.safeParse(this.json(candidate));
    return parsed.success ? { text: text.slice(0, start).trim(), update: parsed.data } : { text };
  }
  private json(value: string): unknown {
    try { return JSON.parse(value) as unknown; } catch { return undefined; }
  }

}
