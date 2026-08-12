import { randomUUID } from "node:crypto";
import { AgentError, routerCheckpointInputSchema, routerOrchestrationDecisionSchema } from "@waing/domain";
import type { AgentProfile, ConversationMemory, RouterCheckpointInput, RouterCheckpointReason, RouterDecisionRecord,
  RouterOrchestrationDecision, WorkflowContext, WorkflowDefinition, WorkflowEdge, WorkflowHandoffPacket, WorkflowNode,
  WorkflowRun } from "@waing/domain";
import { renderAnnouncement } from "./AnnouncementRenderer";
import { compactConversationMemory, compactDiff, compactHistory, DEFAULT_COMPACTION_BUDGET, dedupe, withoutDiff } from "./ContextCompactor";
import type { CompactionBudget } from "./ContextCompactor";
import { ContextStore } from "./ContextStore";
import { ProfileResolver } from "./ProfileResolver";
import type { WorkflowStepExecutor } from "./StepExecutor";
import { WorkflowEventBus } from "./WorkflowEventBus";
import type { WorkflowRepository } from "./WorkflowRepository";
import { WorkflowValidator } from "./WorkflowValidator";

export interface WorkflowRouter { decideNext(input: RouterCheckpointInput): Promise<unknown> }
export interface RouterLoopPolicy { maxRouterDecisions: number; maxSameActionWithoutStateChange: number; onExhausted: "ask_user" | "fail_workflow" }
export interface WorkflowStartInput {
  definition: WorkflowDefinition;
  profiles: AgentProfile[];
  projectId: string;
  projectRoot: string;
  task: string;
  /** Memory from the user-visible conversation, omitted for a brand-new conversation. */
  conversationMemory?: ConversationMemory;
  /** Provider session ids keyed by agent profile id and configuration lane. */
  providerSessions?: Record<string, string>;
  /** Memory revision last delivered to each resumed provider session lane. */
  providerSessionMemoryRevisions?: Record<string, number>;
}

export class WorkflowEngine {
  private paused = false;
  private cancelled = false;
  private resumeWaiter?: () => void;
  private readonly controller = new AbortController();
  constructor(private readonly repository: WorkflowRepository, private readonly executor: WorkflowStepExecutor,
    private readonly router: WorkflowRouter, readonly events = new WorkflowEventBus(), private readonly validator = new WorkflowValidator(),
    private readonly routerPolicy: RouterLoopPolicy = { maxRouterDecisions: 20, maxSameActionWithoutStateChange: 2, onExhausted: "ask_user" },
    private readonly compaction: CompactionBudget = DEFAULT_COMPACTION_BUDGET) {}

  async run(input: WorkflowStartInput): Promise<{ run: WorkflowRun; context: WorkflowContext }> {
    const definition = this.validator.validate(input.definition, input.profiles);
    const now = new Date().toISOString();
    const run: WorkflowRun = { id: randomUUID(), workflowId: definition.id, workflowVersion: definition.version, status: "created", createdAt: now, updatedAt: now };
    await this.transition(run, "validating");
    const context: WorkflowContext = { workflowRunId: run.id, projectId: input.projectId, projectRoot: input.projectRoot,
      originalUserTask: input.task, stateVersion: 0, routerDecisionCount: 0, routerDecisionHistory: [], activeNodeId: definition.entryNodeId,
      completedNodeIds: [], stepResults: [], loopState: {}, providerSessions: { ...input.providerSessions },
      providerSessionMemoryRevisions: { ...input.providerSessionMemoryRevisions },
      sharedState: input.conversationMemory === undefined ? { planItems: [], decisions: [], openQuestions: [] } : {
        planItems: structuredClone(input.conversationMemory.planItems), decisions: structuredClone(input.conversationMemory.decisions),
        openQuestions: structuredClone(input.conversationMemory.openQuestions),
      },
      ...(input.conversationMemory === undefined ? {} : { conversationMemory: structuredClone(input.conversationMemory) }) };
    const store = new ContextStore(this.repository); await store.initialize(context); await this.transition(run, "ready");
    this.events.publish({ type: "workflow.started", workflowRunId: run.id });
    const profiles = new ProfileResolver(input.profiles);
    try {
      for (let transitions = 0; transitions < 1_000; transitions += 1) {
        if (this.cancelled) return this.finishCancelled(run, context);
        if (this.paused) await this.waitWhilePaused(run);
        const node = this.node(definition, context.activeNodeId);
        if (node.type === "complete") return this.finishCompleted(run, context);
        if (node.type === "router") {
          const next = await this.executeRouter(definition, node, context, input.profiles, profiles, store, run);
          if (next === undefined) return { run, context };
          context.activeNodeId = next; continue;
        }
        if (node.type === "loop") { context.activeNodeId = await this.executeLoop(definition, node, context, store); continue; }
        await this.transition(run, "running_node");
        const profile = profiles.resolve(node.agentProfileId);
        const stepRunId = randomUUID(); const display = await this.executor.describe(profile);
        const announcement = renderAnnouncement({ workflowRunId: run.id, stepRunId, node, profile,
          agentDisplayName: display.agentDisplayName, ...(display.modelDisplayName === undefined ? {} : { modelDisplayName: display.modelDisplayName }),
          ...(context.latestRouterDecision === undefined ? {} : { intent: context.latestRouterDecision.statusIntent }) });
        await this.repository.saveAnnouncement?.(announcement); this.events.publish({ type: "workflow.step.announced", announcement });
        this.events.publish({ type: "workflow.node.started", nodeId: node.id, stepRunId });
        const retained = context.providerSessions[profile.id];
        const result = await this.executor.execute({ stepRunId, node, profile, context, handoff: this.handoff(context, node, retained),
          ...(retained === undefined ? {} : { resumeProviderSessionId: retained }), signal: this.controller.signal });
        await store.recordStep(context, result);
        if (result.stateUpdate !== undefined) this.events.publish({ type: "workflow.state.updated", sharedState: structuredClone(context.sharedState) });
        if (result.providerSessionId !== undefined) {
          context.providerSessions[profile.id] = result.providerSessionId;
          if (context.conversationMemory !== undefined) context.providerSessionMemoryRevisions[profile.id] = context.conversationMemory.revision;
        }
        if (result.status !== "completed") throw new AgentError(result.status === "cancelled" ? "CANCELLED" : "PROCESS_FAILED", result.summary, profile.agentId, result.status === "failed", true);
        this.events.publish({ type: "workflow.node.completed", nodeId: node.id, stepRunId }); await this.transition(run, "node_completed");
        const edge = this.nextAlways(definition, node.id); await this.takeEdge(context.workflowRunId, edge); context.activeNodeId = edge.to;
        await store.checkpoint(context);
      }
      throw new AgentError("WORKFLOW_OSCILLATION", "Workflow exceeded 1000 transitions");
    } catch (cause) {
      if (cause instanceof AgentError && cause.code === "CANCELLED") return this.finishCancelled(run, context);
      const error = cause instanceof Error ? cause : new Error("Workflow failed");
      await this.transition(run, "failed"); this.events.publish({ type: "workflow.failed", workflowRunId: run.id,
        code: cause instanceof AgentError ? cause.code : "WORKFLOW_INVALID", message: error.message }); return { run, context };
    }
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; this.resumeWaiter?.(); delete this.resumeWaiter; }
  async cancel(): Promise<void> { this.cancelled = true; this.controller.abort(); this.resume(); await this.executor.cancel?.(); }

  private async executeRouter(definition: WorkflowDefinition, node: Extract<WorkflowNode, { type: "router" }>, context: WorkflowContext,
    roster: AgentProfile[], profiles: ProfileResolver, store: ContextStore, run: WorkflowRun): Promise<string | undefined> {
    const reason = this.checkpointReason(node.checkpoint); this.events.publish({ type: "workflow.router.started", nodeId: node.id, checkpointReason: reason });
    const latest = context.stepResults.at(-1); const history = compactHistory(context.stepResults, this.compaction, latest === undefined ? 0 : 1);
    const checkpoint = routerCheckpointInputSchema.parse({ checkpointReason: reason, originalUserTask: context.originalUserTask,
      ...(latest === undefined ? {} : { latestStepResult: withoutDiff(latest, this.compaction) }), priorStepSummaries: history.summaries,
      ...(history.omittedStepCount === 0 ? {} : { omittedStepCount: history.omittedStepCount }),
      ...(this.hasSharedState(context) ? { sharedState: context.sharedState } : {}),
      ...(context.conversationMemory === undefined ? {} : { conversationMemory: compactConversationMemory(context.conversationMemory) }),
      availableAgents: roster.filter((profile) => profile.enabled).map(({ id, name, whereToUse }) => ({ id, name, whereToUse })),
      allowedActions: node.allowedActions });
    const decision = routerOrchestrationDecisionSchema.parse(await this.router.decideNext(checkpoint));
    if (!node.allowedActions.includes(decision.action)) throw new AgentError("ROUTER_INVALID_OUTPUT", `Router action ${decision.action} is not allowed at ${node.id}`);
    this.enforceRouterSafety(context, decision);
    if (decision.action === "ask_user") { await this.transition(run, "paused"); this.events.publish({ type: "workflow.paused", workflowRunId: run.id, reason: decision.rationale }); return undefined; }
    const edge = decision.action === "complete" ? this.edgeForComplete(definition, node.id) : this.edgeForAgent(definition, node.id, decision.agentProfileId!);
    const profile = decision.action === "delegate" ? profiles.resolve(decision.agentProfileId!) : undefined;
    const record: RouterDecisionRecord = { id: randomUUID(), workflowRunId: context.workflowRunId, routerNodeId: node.id,
      checkpointReason: reason, inputStateVersion: context.stateVersion, decision, resolvedNodeId: edge.to,
      ...(profile === undefined ? {} : { agentProfileId: profile.id, agentName: profile.name, resolvedAgentId: profile.agentId }),
      ...(profile?.modelId === undefined ? {} : { resolvedModelId: profile.modelId }), createdAt: new Date().toISOString() };
    context.routerDecisionCount += 1; context.routerDecisionHistory.push(record); context.latestRouterDecision = decision;
    await this.repository.saveRouterDecision(record); await store.checkpoint(context); this.events.publish({ type: "workflow.router.decided", record });
    if (profile !== undefined) this.events.publish({ type: "workflow.route.selected", agentProfileId: profile.id, agentName: profile.name });
    await this.takeEdge(context.workflowRunId, edge); return edge.to;
  }

  private async executeLoop(definition: WorkflowDefinition, node: Extract<WorkflowNode, { type: "loop" }>, context: WorkflowContext, store: ContextStore): Promise<string> {
    const state = context.loopState[node.loopId] ?? { iteration: 0, maxIterations: node.maxIterations }; state.iteration += 1; context.loopState[node.loopId] = state;
    const type = state.iteration < state.maxIterations ? "loop_remaining" : "loop_exhausted";
    this.events.publish(type === "loop_remaining" ? { type: "workflow.loop.iteration", loopId: node.loopId, iteration: state.iteration }
      : { type: "workflow.loop.exhausted", loopId: node.loopId });
    const edge = this.edgeByCondition(definition, node.id, type); await this.takeEdge(context.workflowRunId, edge); await store.checkpoint(context); return edge.to;
  }
  private enforceRouterSafety(context: WorkflowContext, decision: RouterOrchestrationDecision): void {
    if (context.routerDecisionCount >= this.routerPolicy.maxRouterDecisions) throw new AgentError("WORKFLOW_OSCILLATION", "Router decision budget exhausted");
    const repeats = context.routerDecisionHistory.filter((record) => record.inputStateVersion === context.stateVersion &&
      record.decision.action === decision.action && record.decision.agentProfileId === decision.agentProfileId).length;
    if (repeats >= this.routerPolicy.maxSameActionWithoutStateChange) throw new AgentError("WORKFLOW_OSCILLATION", "Router repeated the same delegation without a workflow state change");
  }
  private handoff(context: WorkflowContext, node: Extract<WorkflowNode, { type: "role_task" }>, retained?: string): WorkflowHandoffPacket {
    const carried = retained === undefined ? context.stepResults : context.stepResults.filter((result) => result.providerSessionId !== retained);
    const history = compactHistory(carried, this.compaction); const diff = compactDiff(this.latestDiff(context), this.compaction);
    const deliveredRevision = context.providerSessionMemoryRevisions[node.agentProfileId] ?? 0;
    const memoryChanged = context.conversationMemory !== undefined && deliveredRevision < context.conversationMemory.revision;
    return { originalTask: context.originalUserTask, currentGoal: node.label, priorStepSummaries: history.summaries,
      ...(history.changedFiles.length === 0 ? {} : { changedFiles: history.changedFiles }),
      ...(history.omittedStepCount === 0 ? {} : { omittedStepCount: history.omittedStepCount }), ...(diff === undefined ? {} : { currentDiff: diff }),
      ...(retained === undefined ? {} : { providerSessionRetained: true }), ...(this.hasSharedState(context) ? { sharedState: context.sharedState } : {}),
      ...(memoryChanged ? { conversationMemory: compactConversationMemory(context.conversationMemory!) } : {}),
      unresolvedIssues: dedupe(context.stepResults.flatMap((result) => result.unresolvedIssues ?? [])) };
  }
  private hasSharedState(context: WorkflowContext): boolean { const s = context.sharedState; return s.planItems.length + s.decisions.length + s.openQuestions.length > 0; }
  private latestDiff(context: WorkflowContext): string | undefined { return [...context.stepResults].reverse().find((result) => result.diff !== undefined)?.diff; }
  private node(definition: WorkflowDefinition, id: string): WorkflowNode { const node = definition.nodes.find((candidate) => candidate.id === id); if (!node) throw new AgentError("WORKFLOW_INVALID", `Unknown workflow node ${id}`); return node; }
  private nextAlways(definition: WorkflowDefinition, id: string): WorkflowEdge { const edges = definition.edges.filter((edge) => edge.from === id && (!edge.condition || edge.condition.type === "always")); if (edges.length !== 1) throw new AgentError("WORKFLOW_INVALID", `Node ${id} requires exactly one always edge`); return edges[0]!; }
  private edgeForAgent(definition: WorkflowDefinition, id: string, agentProfileId: string): WorkflowEdge { const edge = definition.edges.find((candidate) => candidate.from === id && candidate.condition?.type === "router_agent" && candidate.condition.agentProfileId === agentProfileId); if (!edge) throw new AgentError("ROUTER_INVALID_OUTPUT", `No enabled agent accepts ${agentProfileId}`); return edge; }
  private edgeForComplete(definition: WorkflowDefinition, id: string): WorkflowEdge { const edge = definition.edges.find((candidate) => candidate.from === id && candidate.condition?.type === "router_action" && candidate.condition.action === "complete"); if (!edge) throw new AgentError("WORKFLOW_INVALID", `Router ${id} cannot complete`); return edge; }
  private edgeByCondition(definition: WorkflowDefinition, id: string, type: "loop_remaining" | "loop_exhausted"): WorkflowEdge { const edge = definition.edges.find((candidate) => candidate.from === id && candidate.condition?.type === type); if (!edge) throw new AgentError("WORKFLOW_INVALID", `Loop ${id} lacks ${type}`); return edge; }
  private checkpointReason(value: Extract<WorkflowNode, { type: "router" }>["checkpoint"]): RouterCheckpointReason { return value === "custom" ? "manual_reroute" : value; }
  private async transition(run: WorkflowRun, status: WorkflowRun["status"]): Promise<void> { run.status = status; run.updatedAt = new Date().toISOString(); await this.repository.saveRun(run); }
  private async takeEdge(workflowRunId: string, edge: WorkflowEdge): Promise<void> { await this.repository.saveEdgeTaken?.(workflowRunId, { id: edge.id, from: edge.from, to: edge.to }); }
  private async waitWhilePaused(run: WorkflowRun): Promise<void> { await this.transition(run, "paused"); this.events.publish({ type: "workflow.paused", workflowRunId: run.id, reason: "Paused by user" }); await new Promise<void>((resolve) => { this.resumeWaiter = resolve; }); }
  private async finishCompleted(run: WorkflowRun, context: WorkflowContext) { run.summary = `${context.stepResults.length} workflow steps completed.`; await this.transition(run, "completed"); await this.repository.saveContext(context); this.events.publish({ type: "workflow.completed", workflowRunId: run.id }); return { run, context }; }
  private async finishCancelled(run: WorkflowRun, context: WorkflowContext) { await this.transition(run, "cancelled"); await this.repository.saveContext(context); this.events.publish({ type: "workflow.cancelled", workflowRunId: run.id }); return { run, context }; }
}
