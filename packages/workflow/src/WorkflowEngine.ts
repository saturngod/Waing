import { randomUUID } from "node:crypto";
import { AgentError, routerCheckpointInputSchema, routerOrchestrationDecisionSchema } from "@waing/domain";
import type {
  ReviewResult, RoleExecutionProfile, RouterCheckpointInput, RouterCheckpointReason, RouterDecisionRecord,
  RouterOrchestrationDecision, WorkflowContext, WorkflowDefinition, WorkflowEdge, WorkflowHandoffPacket,
  WorkflowNextActionKind, WorkflowNode, WorkflowRole, WorkflowRun,
} from "@waing/domain";
import { renderAnnouncement } from "./AnnouncementRenderer";
import { clip, compactDiff, compactHistory, DEFAULT_COMPACTION_BUDGET, dedupe, latestTestPerCommand, withoutDiff } from "./ContextCompactor";
import type { CompactionBudget } from "./ContextCompactor";
import { ContextStore } from "./ContextStore";
import { ProfileResolver } from "./ProfileResolver";
import type { GlobalRoleProfiles } from "./ProfileResolver";
import type { WorkflowStepExecutor } from "./StepExecutor";
import { WorkflowEventBus } from "./WorkflowEventBus";
import type { WorkflowRepository } from "./WorkflowRepository";
import { WorkflowValidator } from "./WorkflowValidator";

export interface WorkflowRouter {
  decideNext(input: RouterCheckpointInput): Promise<unknown>;
}
export interface RouterLoopPolicy { maxRouterDecisions: number; maxSameActionWithoutStateChange: number; onExhausted: "ask_user" | "fail_workflow" }
export interface WorkflowStartInput { definition: WorkflowDefinition; profiles: GlobalRoleProfiles; projectId: string;
  projectRoot: string; task: string }

const actionRoles: Partial<Record<WorkflowNextActionKind, Exclude<WorkflowRole, "router">>> = {
  plan: "planning", execute_low: "low", execute_medium: "medium", execute_high: "high", create_prd: "document", update_prd: "document",
  write_documentation: "document", review: "review", fix: "bugfix",
};

export class WorkflowEngine {
  private paused = false;
  private cancelled = false;
  private resumeWaiter?: () => void;
  private readonly controller = new AbortController();
  private currentRun?: WorkflowRun;
  private currentContext?: WorkflowContext;

  constructor(private readonly repository: WorkflowRepository, private readonly executor: WorkflowStepExecutor,
    private readonly router: WorkflowRouter, readonly events = new WorkflowEventBus(), private readonly validator = new WorkflowValidator(),
    private readonly routerPolicy: RouterLoopPolicy = { maxRouterDecisions: 12, maxSameActionWithoutStateChange: 2, onExhausted: "ask_user" },
    private readonly compaction: CompactionBudget = DEFAULT_COMPACTION_BUDGET) {}

  async run(input: WorkflowStartInput): Promise<{ run: WorkflowRun; context: WorkflowContext }> {
    const definition = this.validator.validate(input.definition, input.profiles);
    const now = new Date().toISOString();
    const run: WorkflowRun = { id: randomUUID(), workflowId: definition.id, workflowVersion: definition.version,
      status: "created", createdAt: now, updatedAt: now };
    this.currentRun = run; await this.transition(run, "validating");
    const context: WorkflowContext = { workflowRunId: run.id, projectId: input.projectId, projectRoot: input.projectRoot,
      originalUserTask: input.task, stateVersion: 0, routerDecisionCount: 0, routerDecisionHistory: [],
      activeNodeId: definition.entryNodeId, completedNodeIds: [], stepResults: [], artifacts: [], loopState: {},
      providerSessions: {}, sharedState: { planItems: [], decisions: [], openQuestions: [] } };
    this.currentContext = context;
    const store = new ContextStore(this.repository); await store.initialize(context); await this.transition(run, "ready");
    this.events.publish({ type: "workflow.started", workflowRunId: run.id });
    const profiles = new ProfileResolver(input.profiles);
    try {
      for (let transitions = 0; transitions < 1_000; transitions += 1) {
        if (this.cancelled) return this.finishCancelled(run, context);
        if (this.paused) await this.waitWhilePaused(run);
        if (this.cancelled) return this.finishCancelled(run, context);
        const node = this.node(definition, context.activeNodeId);
        if (!node.enabled) { context.activeNodeId = this.nextAlways(definition, node.id).to; continue; }
        if (node.type === "complete") return this.finishCompleted(run, context);
        if (node.type === "router") {
          context.activeNodeId = await this.executeRouter(definition, node, context, profiles, store); continue;
        }
        if (node.type === "loop") {
          const next = await this.executeLoop(definition, node, context, run, store);
          if (next === undefined) return { run, context };
          context.activeNodeId = next; continue;
        }
        await this.transition(run, "running_node");
        const profile = profiles.resolveNode(node, definition);
        const stepRunId = randomUUID();
        const display = await this.executor.describe(profile);
        const announcement = renderAnnouncement({ workflowRunId: run.id, stepRunId, node, profile,
          agentDisplayName: display.agentDisplayName, ...(display.modelDisplayName === undefined ? {} : { modelDisplayName: display.modelDisplayName }),
          ...(context.latestRouterDecision === undefined ? {} : { intent: context.latestRouterDecision.statusIntent }) });
        await this.repository.saveAnnouncement?.(announcement);
        this.events.publish({ type: "workflow.step.announced", announcement });
        this.events.publish({ type: "workflow.node.started", nodeId: node.id, stepRunId });
        const retained = context.providerSessions[profile.agentId];
        const result = await this.executor.execute({ stepRunId, node, profile, context,
          handoff: this.handoff(context, node, retained),
          ...(retained === undefined ? {} : { resumeProviderSessionId: retained }),
          ...(node.type === "role_task" && node.role === "bugfix" ? { fixPacket: this.fixPacket(context) } : {}),
          ...(node.type === "document" ? { documentInput: this.documentInput(context, node) } : {}),
          signal: this.controller.signal });
        await store.recordStep(context, result);
        // The merged state, not the step's amendment: the renderer shows the whole plan, and a step only sends deltas.
        if (result.stateUpdate !== undefined) this.events.publish({ type: "workflow.state.updated", sharedState: structuredClone(context.sharedState) });
        if (result.providerSessionId !== undefined) context.providerSessions[profile.agentId] = result.providerSessionId;
        for (const artifact of result.artifacts) this.events.publish({ type: "workflow.artifact.created", artifactId: artifact.id });
        if (result.status !== "completed") throw new AgentError(result.status === "cancelled" ? "CANCELLED" : "PROCESS_FAILED",
          result.summary, profile.agentId, result.status === "failed", true);
        this.events.publish({ type: "workflow.node.completed", nodeId: node.id, stepRunId });
        await this.transition(run, "node_completed");
        if (node.type === "review_gate") {
          const verdict = result.reviewVerdict;
          if (verdict === undefined) throw new AgentError("PROTOCOL_ERROR", "Review gate lacks a validated verdict");
          this.events.publish({ type: "workflow.review.completed", verdict });
          const edge = this.edgeForReview(definition, node.id, verdict); await this.takeEdge(context.workflowRunId, edge);
          context.activeNodeId = edge.to;
        } else { const edge = this.nextAlways(definition, node.id); await this.takeEdge(context.workflowRunId, edge); context.activeNodeId = edge.to; }
        await store.checkpoint(context);
      }
      throw new AgentError("WORKFLOW_OSCILLATION", "Workflow exceeded 1000 transitions");
    } catch (cause) {
      if (cause instanceof AgentError && cause.code === "CANCELLED") return this.finishCancelled(run, context);
      const error = cause instanceof Error ? cause : new Error("Workflow failed");
      await this.transition(run, "failed"); this.events.publish({ type: "workflow.failed", workflowRunId: run.id,
        code: cause instanceof AgentError ? cause.code : "WORKFLOW_INVALID", message: error.message });
      return { run, context };
    }
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; this.resumeWaiter?.(); delete this.resumeWaiter; }
  async cancel(): Promise<void> { this.cancelled = true; this.controller.abort(); this.resume(); await this.executor.cancel?.(); }

  private async executeRouter(definition: WorkflowDefinition, node: Extract<WorkflowNode, { type: "router" }>,
    context: WorkflowContext, profiles: ProfileResolver, store: ContextStore): Promise<string> {
    const reason = this.checkpointReason(node.checkpoint);
    const routerProfile = profiles.resolveNode(node, definition);
    const display = await this.executor.describe(routerProfile);
    const announcement = renderAnnouncement({ workflowRunId: context.workflowRunId,
      stepRunId: randomUUID(), node, profile: routerProfile, agentDisplayName: display.agentDisplayName,
      ...(display.modelDisplayName === undefined ? {} : { modelDisplayName: display.modelDisplayName }) });
    await this.repository.saveAnnouncement?.(announcement);
    this.events.publish({ type: "workflow.step.announced", announcement });
    this.events.publish({ type: "workflow.router.started", nodeId: node.id, checkpointReason: reason });
    // The router only picks the next action, so it never needs a diff — and `latestStepResult` would otherwise carry
    // the whole one. It is also excluded from the history, which would repeat it a second time.
    const latest = context.stepResults.at(-1);
    const history = compactHistory(context.stepResults, this.compaction, latest === undefined ? 0 : 1);
    const checkpoint = routerCheckpointInputSchema.parse({ checkpointReason: reason, originalUserTask: context.originalUserTask,
      ...(latest === undefined ? {} : { latestStepResult: withoutDiff(latest, this.compaction) }),
      ...(this.latestReview(context) === undefined ? {} : { latestReview: this.latestReview(context) }),
      ...(context.artifacts.at(-1) === undefined ? {} : { latestArtifact: context.artifacts.at(-1) }),
      priorStepSummaries: history.summaries, artifacts: context.artifacts,
      ...(history.omittedStepCount === 0 ? {} : { omittedStepCount: history.omittedStepCount }),
      unresolvedIssues: dedupe(context.stepResults.flatMap((result) => result.unresolvedIssues ?? [])),
      // The plan is what "is there anything next?" is answered from, so it goes to the router whole.
      ...(this.hasSharedState(context) ? { sharedState: context.sharedState } : {}),
      reviewIteration: Object.values(context.loopState)[0]?.iteration ?? 0, allowedActions: node.allowedActions });
    const decision = routerOrchestrationDecisionSchema.parse(await this.router.decideNext(checkpoint));
    if (!node.allowedActions.includes(decision.action)) throw new AgentError("ROUTER_INVALID_OUTPUT",
      `Router action ${decision.action} is not allowed at ${node.id}`);
    this.enforceRouterSafety(context, decision);
    const edge = this.edgeForAction(definition, node.id, decision.action);
    if (decision.action === "complete") this.enforceCompletionGates(definition, context);
    const target = this.node(definition, edge.to);
    let profile: RoleExecutionProfile | undefined;
    if (target.type !== "complete" && target.type !== "loop") profile = profiles.resolveNode(target, definition);
    const role = actionRoles[decision.action] ?? ("role" in target ? target.role : undefined);
    const record: RouterDecisionRecord = { id: randomUUID(), workflowRunId: context.workflowRunId, routerNodeId: node.id,
      checkpointReason: reason, inputStateVersion: context.stateVersion, decision, resolvedNodeId: target.id,
      ...(role === undefined ? {} : { resolvedRole: role }), ...(profile === undefined ? {} : { resolvedAgentId: profile.agentId }),
      ...(profile?.modelId === undefined ? {} : { resolvedModelId: profile.modelId }), createdAt: new Date().toISOString() };
    context.routerDecisionCount += 1; context.routerDecisionHistory.push(record); context.latestRouterDecision = decision;
    await this.repository.saveRouterDecision(record); await store.checkpoint(context);
    this.events.publish({ type: "workflow.router.decided", record });
    if (role !== undefined) this.events.publish({ type: "workflow.route.selected", role });
    await this.takeEdge(context.workflowRunId, edge);
    return edge.to;
  }

  private async executeLoop(definition: WorkflowDefinition, node: Extract<WorkflowNode, { type: "loop" }>,
    context: WorkflowContext, run: WorkflowRun, store: ContextStore): Promise<string | undefined> {
    const state = context.loopState[node.loopId] ?? { iteration: 0, maxIterations: node.maxIterations };
    state.iteration += 1; context.loopState[node.loopId] = state;
    if (state.iteration < state.maxIterations) {
      this.events.publish({ type: "workflow.loop.iteration", loopId: node.loopId, iteration: state.iteration + 1 });
      const edge = this.edgeByCondition(definition, node.id, "loop_remaining");
      await this.takeEdge(context.workflowRunId, edge); await store.checkpoint(context); return edge.to;
    }
    this.events.publish({ type: "workflow.loop.exhausted", loopId: node.loopId });
    await store.checkpoint(context);
    if (node.onExhausted === "fail_workflow") throw new AgentError("WORKFLOW_LOOP_EXHAUSTED", `Loop ${node.loopId} exhausted`);
    if (node.onExhausted === "ask_user") {
      await this.transition(run, "paused"); this.events.publish({ type: "workflow.paused", workflowRunId: run.id,
        reason: `Loop ${node.loopId} exhausted and needs user input` }); return undefined;
    }
    const edge = this.edgeByCondition(definition, node.id, "loop_exhausted"); await this.takeEdge(context.workflowRunId, edge); return edge.to;
  }

  private enforceRouterSafety(context: WorkflowContext, decision: RouterOrchestrationDecision): void {
    if (context.routerDecisionCount >= this.routerPolicy.maxRouterDecisions) throw new AgentError("WORKFLOW_OSCILLATION", "Router decision budget exhausted");
    const repeats = context.routerDecisionHistory.filter((record) => record.inputStateVersion === context.stateVersion &&
      record.decision.action === decision.action).length;
    if (repeats >= this.routerPolicy.maxSameActionWithoutStateChange) throw new AgentError("WORKFLOW_OSCILLATION",
      `Router repeated ${decision.action} without a workflow state change`);
  }
  private enforceCompletionGates(definition: WorkflowDefinition, context: WorkflowContext): void {
    // Nodes flagged optional are reachable only through a router action the router may decide not to take.
    const required = definition.nodes.filter((node) => node.enabled &&
      (node.type === "review_gate" || node.type === "document") && node.optional !== true);
    const missing = required.filter((node) => !context.completedNodeIds.includes(node.id));
    if (missing.length > 0) throw new AgentError("ROUTER_INVALID_OUTPUT", `Completion is blocked by: ${missing.map((node) => node.label).join(", ")}`);
  }
  private handoff(context: WorkflowContext, node: WorkflowNode, retainedProviderSessionId?: string): WorkflowHandoffPacket {
    const latestReview = [...context.stepResults].reverse().find((result) => result.reviewVerdict !== undefined);
    // Steps that already ran inside the provider session about to be resumed are in that provider's own transcript.
    // Re-sending them would pay for the same history twice, so only the work of other agents is carried.
    const carried = retainedProviderSessionId === undefined ? context.stepResults
      : context.stepResults.filter((result) => result.providerSessionId !== retainedProviderSessionId);
    const history = compactHistory(carried, this.compaction);
    const prd = context.artifacts.find((artifact) => artifact.kind === "prd");
    // A reviewer has to judge the exact change and cannot re-derive it once later steps move the tree; every other
    // role is already in the workspace, so it gets the changed paths and reads them itself.
    const diff = node.type === "review_gate" ? compactDiff(this.latestDiff(context), this.compaction) : undefined;
    return { originalTask: context.originalUserTask, currentGoal: node.label,
      ...(context.routingDecision === undefined ? {} : { routingDecision: context.routingDecision }),
      ...(prd === undefined ? {} : { prd }),
      priorStepSummaries: history.summaries,
      ...(history.changedFiles.length === 0 ? {} : { changedFiles: history.changedFiles }),
      ...(history.omittedStepCount === 0 ? {} : { omittedStepCount: history.omittedStepCount }),
      ...(diff === undefined ? {} : { currentDiff: diff }),
      ...(latestReview?.findings === undefined ? {} : { reviewFindings: latestReview.findings }),
      ...(retainedProviderSessionId === undefined ? {} : { providerSessionRetained: true }),
      // Sent whole and unabridged even on a retained session: it is the record compaction is not allowed to erode.
      ...(this.hasSharedState(context) ? { sharedState: context.sharedState } : {}),
      // Blockers stay whole even on a retained session: they are small, and they are the one thing a step must act on.
      unresolvedIssues: dedupe(context.stepResults.flatMap((result) => result.unresolvedIssues ?? [])) };
  }
  private hasSharedState(context: WorkflowContext): boolean {
    const { planItems, decisions, openQuestions } = context.sharedState;
    return planItems.length + decisions.length + openQuestions.length > 0;
  }
  private latestDiff(context: WorkflowContext): string | undefined {
    return [...context.stepResults].reverse().find((result) => result.diff !== undefined)?.diff;
  }
  private latestReview(context: WorkflowContext): ReviewResult | undefined {
    const result = [...context.stepResults].reverse().find((candidate) => candidate.reviewVerdict !== undefined);
    return result?.reviewVerdict === undefined ? undefined : { verdict: result.reviewVerdict, summary: result.summary,
      findings: result.findings ?? [], testsObserved: result.testsRun.map((test) => test.command), confidence: 1 };
  }
  private fixPacket(context: WorkflowContext) {
    const implementation = [...context.stepResults].reverse().find((result) => ["low", "medium", "high"].includes(result.role));
    const review = [...context.stepResults].reverse().find((result) => result.reviewVerdict === "fail");
    return { originalTask: context.originalUserTask,
      implementationSummary: clip(implementation?.summary ?? "", this.compaction.summaryChars),
      reviewIteration: (Object.values(context.loopState)[0]?.iteration ?? 0) + 1, findings: review?.findings ?? [],
      currentChangedFiles: dedupe(context.stepResults.flatMap((result) => result.filesChanged))
        .slice(-this.compaction.maxChangedFiles),
      // A review/fix loop reruns the same suite each pass, so only the latest outcome per command is informative.
      testsAlreadyRun: latestTestPerCommand(context.stepResults.flatMap((result) => result.testsRun)),
      ...(context.artifacts.find((artifact) => artifact.kind === "prd") === undefined ? {}
        : { prdArtifact: context.artifacts.find((artifact) => artifact.kind === "prd") }) };
  }
  private documentInput(context: WorkflowContext, node: Extract<WorkflowNode, { type: "document" }>) {
    // A router that asked for documentation may name the file and kind; a static node only knows its own defaults.
    const requested = context.latestRouterDecision?.document;
    const targetPath = requested?.targetPath ?? node.path;
    return { operation: requested?.operation ?? node.operation, kind: requested?.kind ?? node.documentKind,
      ...(targetPath === undefined ? {} : { targetPath }),
      originalTask: context.originalUserTask, ...(context.routingDecision === undefined ? {} : { routingDecision: context.routingDecision }),
      // A copy, so the document step sees the work that preceded it and never its own recorded result. A writer
      // describes what changed rather than reproducing it, so the diffs are stripped and the summaries clipped —
      // this was by far the largest packet in a run, carrying every diff the workflow had ever produced.
      stepResults: context.stepResults.slice(-this.compaction.maxSteps).map((result) => withoutDiff(result, this.compaction)),
      ...(this.latestReview(context) === undefined ? {} : { finalReview: this.latestReview(context) }) };
  }
  private node(definition: WorkflowDefinition, id: string): WorkflowNode {
    const node = definition.nodes.find((candidate) => candidate.id === id);
    if (node === undefined) throw new AgentError("WORKFLOW_INVALID", `Unknown workflow node ${id}`); return node;
  }
  private nextAlways(definition: WorkflowDefinition, id: string): WorkflowEdge {
    const candidates = definition.edges.filter((edge) => edge.from === id && (edge.condition === undefined || edge.condition.type === "always"));
    if (candidates.length !== 1) throw new AgentError("WORKFLOW_INVALID", `Node ${id} requires exactly one always edge`); return candidates[0]!;
  }
  private edgeForAction(definition: WorkflowDefinition, id: string, action: WorkflowNextActionKind): WorkflowEdge {
    const edge = definition.edges.find((candidate) => candidate.from === id && candidate.condition?.type === "router_action" && candidate.condition.action === action);
    if (edge === undefined) throw new AgentError("ROUTER_INVALID_OUTPUT", `No edge accepts router action ${action} at ${id}`); return edge;
  }
  private edgeForReview(definition: WorkflowDefinition, id: string, verdict: "pass" | "fail"): WorkflowEdge {
    const edge = definition.edges.find((candidate) => candidate.from === id && candidate.condition?.type === "review_result" && candidate.condition.result === verdict);
    if (edge === undefined) throw new AgentError("WORKFLOW_INVALID", `Review ${id} lacks a ${verdict} edge`); return edge;
  }
  private edgeByCondition(definition: WorkflowDefinition, id: string, type: "loop_remaining" | "loop_exhausted"): WorkflowEdge {
    const edge = definition.edges.find((candidate) => candidate.from === id && candidate.condition?.type === type);
    if (edge === undefined) throw new AgentError("WORKFLOW_INVALID", `Loop ${id} lacks ${type}`); return edge;
  }
  private checkpointReason(value: Extract<WorkflowNode, { type: "router" }>["checkpoint"]): RouterCheckpointReason {
    return value === "custom" ? "manual_reroute" : value;
  }
  private async transition(run: WorkflowRun, status: WorkflowRun["status"]): Promise<void> {
    run.status = status; run.updatedAt = new Date().toISOString(); await this.repository.saveRun(run);
  }
  private async takeEdge(workflowRunId: string, edge: WorkflowEdge): Promise<void> {
    await this.repository.saveEdgeTaken?.(workflowRunId, { id: edge.id, from: edge.from, to: edge.to });
  }
  private async waitWhilePaused(run: WorkflowRun): Promise<void> {
    await this.transition(run, "paused");
    this.events.publish({ type: "workflow.paused", workflowRunId: run.id, reason: "Paused by user" });
    await new Promise<void>((resolve) => { this.resumeWaiter = resolve; });
  }
  private async finishCompleted(run: WorkflowRun, context: WorkflowContext) {
    run.summary = `${context.stepResults.length} workflow steps completed; ${context.artifacts.length} artifacts produced.`;
    await this.transition(run, "completed"); await this.repository.saveContext(context);
    this.events.publish({ type: "workflow.completed", workflowRunId: run.id }); return { run, context };
  }
  private async finishCancelled(run: WorkflowRun, context: WorkflowContext) {
    await this.transition(run, "cancelled"); await this.repository.saveContext(context);
    this.events.publish({ type: "workflow.cancelled", workflowRunId: run.id }); return { run, context };
  }
}
