import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  RoleExecutionProfile, RouterCheckpointInput, RouterOrchestrationDecision, WorkflowArtifactRef, WorkflowRole,
  WorkflowDefinition, WorkflowStepResult,
} from "@waing/domain";
import { ProfileResolver } from "./ProfileResolver";
import type { GlobalRoleProfiles } from "./ProfileResolver";
import type { StepExecutionInput, WorkflowStepExecutor } from "./StepExecutor";
import { WorkflowCompiler } from "./WorkflowCompiler";
import { WorkflowEngine } from "./WorkflowEngine";
import type { WorkflowRouter } from "./WorkflowEngine";
import { InMemoryWorkflowRepository } from "./WorkflowRepository";
import { WorkflowRunCoordinator } from "./WorkflowRunCoordinator";
import { WorkflowValidator } from "./WorkflowValidator";

const profiles = Object.fromEntries((["router", "planning", "low", "medium", "high", "review", "bugfix", "document"] as WorkflowRole[])
  .map((role) => [role, { role, enabled: true, agentId: role === "high" ? "claude" : role === "review" ? "antigravity"
    : role === "document" || role === "router" ? "opencode" : "codex", modelId: `${role}-model`,
    effort: role === "low" || role === "router" ? "low" : "medium", mode: role === "review" ? "review" : role === "planning" ? "plan" : "execute",
    permissionProfileId: "ask", timeoutMs: 10_000, maxRetries: 0 } satisfies RoleExecutionProfile])) as GlobalRoleProfiles;

class QueueRouter implements WorkflowRouter {
  readonly inputs: RouterCheckpointInput[] = [];
  constructor(private readonly decisions: RouterOrchestrationDecision[]) {}
  decideNext(input: RouterCheckpointInput): Promise<unknown> {
    this.inputs.push(input); const decision = this.decisions.shift();
    if (decision === undefined) throw new Error("No queued router decision"); return Promise.resolve(decision);
  }
}

const decision = (action: RouterOrchestrationDecision["action"]): RouterOrchestrationDecision => ({
  action, ...(action === "create_prd" || action === "update_prd" ? {
    document: { operation: action === "create_prd" ? "create" : "update", kind: "prd" } as const,
  } : action === "write_documentation" ? {
    document: { operation: "create", kind: "readme", targetPath: "final_document.md" } as const,
  } : {}),
  statusIntent: { activity: action === "create_prd" ? "creating_prd" : action === "review" ? "reviewing" : "implementing" },
  rationale: `Choose ${action}`, confidence: 0.95,
});

class FakeStepExecutor implements WorkflowStepExecutor {
  readonly calls: StepExecutionInput[] = [];
  constructor(private readonly reviews: Array<"pass" | "fail"> = []) {}
  describe(profile: RoleExecutionProfile): Promise<{ agentDisplayName: string; modelDisplayName?: string }> {
    return Promise.resolve({ agentDisplayName: profile.agentId.toUpperCase(),
      ...(profile.modelId === undefined ? {} : { modelDisplayName: profile.modelId }) });
  }
  execute(input: StepExecutionInput): Promise<WorkflowStepResult> {
    this.calls.push(input);
    const verdict = input.node.type === "review_gate" ? this.reviews.shift() ?? "pass" : undefined;
    const artifacts: WorkflowArtifactRef[] = input.node.type === "document" ? [{ id: randomUUID(), kind: input.node.documentKind,
      path: input.node.path ?? "docs/prd.md", createdByStepRunId: input.stepRunId }] : [];
    return Promise.resolve({ stepRunId: input.stepRunId, nodeId: input.node.id, role: input.node.role,
      agentId: input.profile.agentId, ...(input.profile.modelId === undefined ? {} : { modelId: input.profile.modelId }),
      status: "completed", summary: `${input.node.label} done`, filesRead: [], filesChanged: input.node.type === "document" ? [artifacts[0]!.path] : ["src/index.ts"],
      commandsRun: [], testsRun: [], artifacts,
      ...(verdict === undefined ? {} : { reviewVerdict: verdict, findings: verdict === "fail" ? [{ id: `finding-${this.calls.length}`,
        severity: "high", category: "correctness", title: "Broken behavior", description: "Fix it" }] : [],
        unresolvedIssues: verdict === "fail" ? ["Broken behavior"] : [] }) });
  }
}

/** Emits a diff on implementation steps so handoff propagation can be asserted. */
class DiffStepExecutor extends FakeStepExecutor {
  override async execute(input: StepExecutionInput): Promise<WorkflowStepResult> {
    const result = await super.execute(input);
    return input.node.type === "role_task" ? { ...result, diff: "--- a/src/index.ts\n+++ b/src/index.ts\n+added" } : result;
  }
}

describe("WorkflowValidator and compiler", () => {
  it("ships five valid graph presets with finite loops and reachable completion", () => {
    const compiler = new WorkflowCompiler(); const validator = new WorkflowValidator();
    for (const kind of ["standard", "review_loop", "review_documentation", "prd_driven", "adaptive"] as const) {
      expect(() => validator.validate(compiler.compilePreset(kind), profiles)).not.toThrow();
    }
  });

  it("rejects duplicate IDs, ambiguous edges, missing review edges, unreachable nodes, and unguarded cycles", () => {
    const workflow = new WorkflowCompiler().compilePreset("review_loop");
    workflow.nodes.push({ ...workflow.nodes[0]!, label: "Duplicate" });
    workflow.edges.push({ id: "ambiguous", from: "low", to: "review", condition: { type: "always" } });
    const review = workflow.nodes.find((node) => node.type === "review_gate");
    if (review?.type === "review_gate") review.passEdge = "missing";
    workflow.edges.find((edge) => edge.id === "loop-review")!.loopId = undefined;
    workflow.nodes.push({ id: "orphan", label: "Orphan", enabled: true, type: "role_task", role: "low" });
    expect(() => new WorkflowValidator().validate(workflow)).toThrow(/Duplicate node ID|ambiguous|PASS|unreachable|not guarded/u);
  });
});

describe("ProfileResolver", () => {
  it("applies step override → workflow override → global profile precedence", () => {
    const workflow = new WorkflowCompiler().compilePreset("standard");
    workflow.roleOverrides = { medium: { agentId: "antigravity", modelId: "workflow-model", effort: "high" } };
    const resolved = new ProfileResolver(profiles).resolve("medium", workflow, { modelId: "step-model", mode: "plan" });
    expect(resolved).toMatchObject({ agentId: "antigravity", modelId: "step-model", effort: "high", mode: "plan",
      permissionProfileId: "ask" });
  });
});

describe("WorkflowEngine", () => {
  it("takes exactly one routed complexity branch and persists a recoverable completed snapshot", async () => {
    const repository = new InMemoryWorkflowRepository(); const router = new QueueRouter([decision("execute_medium")]);
    const executor = new FakeStepExecutor(); const engine = new WorkflowEngine(repository, executor, router);
    const eventTypes: string[] = []; engine.events.subscribe((event) => eventTypes.push(event.type));
    const definition = new WorkflowCompiler().compilePreset("standard"); await repository.saveDefinition(definition);
    const result = await engine.run({ definition, profiles, projectId: "project", projectRoot: "/tmp/project", task: "Build it" });
    expect(result.run.status).toBe("completed");
    expect(executor.calls.map((call) => call.node.id)).toEqual(["medium"]);
    expect(result.context.stateVersion).toBe(1);
    expect(eventTypes.slice(0, 4)).toEqual(["workflow.started", "workflow.step.announced", "workflow.router.started", "workflow.router.decided"]);
    expect(eventTypes.indexOf("workflow.step.announced")).toBeLessThan(eventTypes.indexOf("workflow.node.started"));
    const coordinator = new WorkflowRunCoordinator(repository, () => engine);
    await expect(coordinator.recoverSnapshot(result.run.id)).resolves.toMatchObject({ run: { workflowVersion: 1, status: "completed" },
      context: { completedNodeIds: ["medium"] } });
  });

  it("runs the review PASS path without a bug-fix step", async () => {
    const executor = new FakeStepExecutor(["pass"]);
    const result = await new WorkflowEngine(new InMemoryWorkflowRepository(), executor,
      new QueueRouter([decision("execute_low")])).run({ definition: new WorkflowCompiler().compilePreset("review_loop"),
      profiles, projectId: "p", projectRoot: "/tmp", task: "Small change" });
    expect(result.run.status).toBe("completed");
    expect(executor.calls.map((call) => call.node.id)).toEqual(["low", "review"]);
  });

  it("hands review findings to Fix and loops back to Review until PASS", async () => {
    const executor = new FakeStepExecutor(["fail", "pass"]);
    const result = await new WorkflowEngine(new InMemoryWorkflowRepository(), executor,
      new QueueRouter([decision("execute_high")])).run({ definition: new WorkflowCompiler().compilePreset("review_loop"),
      profiles, projectId: "p", projectRoot: "/tmp", task: "Risky change" });
    expect(result.run.status).toBe("completed");
    expect(executor.calls.map((call) => call.node.id)).toEqual(["high", "review", "fix", "review"]);
    expect(executor.calls.find((call) => call.node.id === "fix")?.handoff.reviewFindings).toMatchObject([{ id: "finding-2" }]);
  });

  it("pauses visibly when the finite review/fix loop is exhausted", async () => {
    const executor = new FakeStepExecutor(["fail", "fail", "fail"]); const eventTypes: string[] = [];
    const engine = new WorkflowEngine(new InMemoryWorkflowRepository(), executor, new QueueRouter([decision("execute_medium")]));
    engine.events.subscribe((event) => eventTypes.push(event.type));
    const result = await engine.run({ definition: new WorkflowCompiler().compilePreset("review_loop"), profiles,
      projectId: "p", projectRoot: "/tmp", task: "Never passes" });
    expect(result.run.status).toBe("paused");
    expect(executor.calls.filter((call) => call.node.id === "review")).toHaveLength(3);
    expect(eventTypes).toContain("workflow.loop.exhausted");
  });

  it("runs PRD create → re-route → execute → review → PRD update and preserves artifacts in handoffs", async () => {
    const router = new QueueRouter([decision("create_prd"), decision("execute_high"), decision("review"),
      decision("update_prd"), decision("complete")]); const executor = new FakeStepExecutor(["pass"]);
    const result = await new WorkflowEngine(new InMemoryWorkflowRepository(), executor, router).run({
      definition: new WorkflowCompiler().compilePreset("prd_driven"), profiles, projectId: "p", projectRoot: "/tmp", task: "Team workspaces" });
    expect(result.run.status).toBe("completed");
    expect(executor.calls.map((call) => call.node.id)).toEqual(["create-prd", "high", "review", "update-prd"]);
    expect(router.inputs.map((input) => input.checkpointReason)).toEqual([
      "initial", "after_document", "after_execution", "after_review", "before_completion",
    ]);
    expect(router.inputs[1]?.artifacts).toMatchObject([{ kind: "prd", path: "docs/prd.md" }]);
    expect(executor.calls.find((call) => call.node.id === "high")?.handoff.prd).toMatchObject({ kind: "prd" });
  });

  it("re-enters Router after a failed review and after Fix before reviewing again", async () => {
    const router = new QueueRouter([decision("create_prd"), decision("execute_medium"), decision("review"), decision("fix"),
      decision("review"), decision("update_prd"), decision("complete")]);
    const executor = new FakeStepExecutor(["fail", "pass"]);
    const result = await new WorkflowEngine(new InMemoryWorkflowRepository(), executor, router).run({
      definition: new WorkflowCompiler().compilePreset("prd_driven"), profiles, projectId: "p", projectRoot: "/tmp", task: "PRD fix loop" });
    expect(result.run.status).toBe("completed");
    expect(executor.calls.map((call) => call.node.id)).toEqual(["create-prd", "medium", "review", "fix", "review", "update-prd"]);
    expect(router.inputs.map((input) => input.checkpointReason)).toEqual([
      "initial", "after_document", "after_execution", "after_review", "after_fix", "after_review", "before_completion",
    ]);
  });

  it("runs the adaptive chat preset task → document → complete and hands the prior work to each step", async () => {
    const router = new QueueRouter([decision("execute_medium"), decision("write_documentation")]);
    const executor = new FakeStepExecutor();
    const result = await new WorkflowEngine(new InMemoryWorkflowRepository(), executor, router).run({
      definition: new WorkflowCompiler().compilePreset("adaptive"), profiles, projectId: "p", projectRoot: "/tmp",
      task: "Build the site then write final_document.md" });
    expect(result.run.status).toBe("completed");
    expect(executor.calls.map((call) => call.node.id)).toEqual(["medium", "document"]);
    const documentStep = executor.calls.find((call) => call.node.id === "document");
    expect(documentStep?.handoff.priorStepSummaries).toMatchObject([{ role: "medium", summary: "Medium Level Task done",
      filesChanged: ["src/index.ts"] }]);
    expect(documentStep?.documentInput?.stepResults).toHaveLength(1);
    expect(documentStep?.documentInput).toMatchObject({ operation: "create", kind: "readme", targetPath: "final_document.md" });
    // Documentation is the last stage, so it flows straight to completion without another router call.
    expect(router.inputs.map((input) => input.checkpointReason)).toEqual(["initial", "after_execution"]);
  });

  it("lets the adaptive preset complete without the optional review or document gate", async () => {
    const executor = new FakeStepExecutor();
    const result = await new WorkflowEngine(new InMemoryWorkflowRepository(), executor,
      new QueueRouter([decision("execute_low"), decision("complete")])).run({
      definition: new WorkflowCompiler().compilePreset("adaptive"), profiles, projectId: "p", projectRoot: "/tmp",
      task: "Explain this function" });
    expect(result.run.status).toBe("completed");
    expect(executor.calls.map((call) => call.node.id)).toEqual(["low"]);
  });

  it("routes plan-only requests through the Planning role", async () => {
    const executor = new FakeStepExecutor();
    const result = await new WorkflowEngine(new InMemoryWorkflowRepository(), executor,
      new QueueRouter([decision("plan"), decision("complete")])).run({
      definition: new WorkflowCompiler().compilePreset("adaptive"), profiles, projectId: "p", projectRoot: "/tmp",
      task: "Create an implementation plan without changing files" });
    expect(result.run.status).toBe("completed");
    expect(executor.calls.map((call) => call.node.id)).toEqual(["planning"]);
    expect(executor.calls[0]?.profile).toMatchObject({ role: "planning", mode: "plan" });
  });

  it("gives the adaptive reviewer the implementation diff and loops through bugfix on FAIL", async () => {
    const executor = new DiffStepExecutor(["fail", "pass"]);
    const result = await new WorkflowEngine(new InMemoryWorkflowRepository(), executor,
      new QueueRouter([decision("execute_medium"), decision("review"), decision("complete")])).run({
      definition: new WorkflowCompiler().compilePreset("adaptive"), profiles, projectId: "p", projectRoot: "/tmp",
      task: "Risky change" });
    expect(result.run.status).toBe("completed");
    expect(executor.calls.map((call) => call.node.id)).toEqual(["medium", "review", "fix", "review"]);
    expect(executor.calls.find((call) => call.node.id === "review")?.handoff.currentDiff).toContain("src/index.ts");
    expect(executor.calls.find((call) => call.node.id === "fix")?.handoff.currentDiff).toContain("src/index.ts");
  });

  it("rejects a router action outside the node allowlist and bounds repeated decisions without state change", async () => {
    const invalid = new QueueRouter([decision("fix")]);
    const result = await new WorkflowEngine(new InMemoryWorkflowRepository(), new FakeStepExecutor(), invalid).run({
      definition: new WorkflowCompiler().compilePreset("standard"), profiles, projectId: "p", projectRoot: "/tmp", task: "test" });
    expect(result.run.status).toBe("failed");
  });

  it("detects repeated router actions with no state change", async () => {
    const now = new Date().toISOString();
    const definition: WorkflowDefinition = { id: "oscillating", name: "Oscillating", version: 1, entryNodeId: "r1", createdAt: now, updatedAt: now,
      nodes: [
        { id: "r1", label: "Router 1", enabled: true, type: "router", role: "router", checkpoint: "initial", allowedActions: ["execute_low"] },
        { id: "r2", label: "Router 2", enabled: true, type: "router", role: "router", checkpoint: "after_execution", allowedActions: ["execute_low", "complete"] },
        { id: "guard", label: "Guard declaration", enabled: false, type: "loop", loopId: "router-loop", bodyEntryNodeId: "r1",
          exitNodeId: "complete", maxIterations: 3, stopCondition: "condition_true", onExhausted: "fail_workflow" },
        { id: "complete", label: "Complete", enabled: true, type: "complete" },
      ], edges: [
        { id: "r1-r2", from: "r1", to: "r2", condition: { type: "router_action", action: "execute_low" } },
        { id: "r2-r1", from: "r2", to: "r1", loopId: "router-loop", condition: { type: "router_action", action: "execute_low" } },
        { id: "r2-complete", from: "r2", to: "complete", condition: { type: "router_action", action: "complete" } },
        { id: "guard-body", from: "guard", to: "r1", condition: { type: "loop_remaining" } },
        { id: "guard-exit", from: "guard", to: "complete", condition: { type: "loop_exhausted" } },
      ] };
    const router = new QueueRouter([decision("execute_low"), decision("execute_low"), decision("execute_low")]);
    const result = await new WorkflowEngine(new InMemoryWorkflowRepository(), new FakeStepExecutor(), router).run({
      definition, profiles, projectId: "p", projectRoot: "/tmp", task: "oscillate" });
    expect(result.run.status).toBe("failed");
    expect(result.context.routerDecisionCount).toBe(2);
  });

  it("cancels an active workflow step and records a cancelled run", async () => {
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const executor: WorkflowStepExecutor = {
      describe: () => Promise.resolve({ agentDisplayName: "Fake" }),
      execute: (input) => new Promise((resolve) => {
        started?.(); input.signal.addEventListener("abort", () => resolve({ stepRunId: input.stepRunId, nodeId: input.node.id,
          role: input.node.role, agentId: input.profile.agentId, status: "cancelled", summary: "Cancelled", filesRead: [],
          filesChanged: [], commandsRun: [], testsRun: [], artifacts: [] }), { once: true });
      }),
    };
    const engine = new WorkflowEngine(new InMemoryWorkflowRepository(), executor, new QueueRouter([decision("execute_low")]));
    const running = engine.run({ definition: new WorkflowCompiler().compilePreset("standard"), profiles,
      projectId: "p", projectRoot: "/tmp", task: "cancel" });
    await startedPromise; await engine.cancel();
    await expect(running).resolves.toMatchObject({ run: { status: "cancelled" } });
  });
});
