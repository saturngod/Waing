import { randomUUID } from "node:crypto";
import type { WorkflowDefinition, WorkflowEdge, WorkflowNextActionKind, WorkflowNode } from "@waing/domain";
import { WorkflowValidator } from "./WorkflowValidator";

export type WorkflowPresetKind = "standard" | "review_loop" | "review_documentation" | "prd_driven" | "adaptive";

/** Declares the chat loop's cycles as guarded, and bounds how many times the router may send work back around. */
const ADAPTIVE_LOOP_ID = "chat-work";
/** Kept below the engine's router decision budget so a long run ends at the loop's graceful exit, not on an error. */
export const ADAPTIVE_MAX_ITERATIONS = 20;
/**
 * The chat loop asks the router once per step, so the default budget of a fixed pipeline would fail a long run
 * partway through. `work-loop` is what actually stops it; this only has to stay above the loop's own ceiling.
 */
export const ADAPTIVE_ROUTER_POLICY = { maxRouterDecisions: ADAPTIVE_MAX_ITERATIONS + 4,
  maxSameActionWithoutStateChange: 2, onExhausted: "ask_user" } as const;
const ADAPTIVE_ROUTES: ReadonlyArray<readonly [WorkflowNextActionKind, string]> = [["plan", "planning"],
  ["execute_low", "low"], ["execute_medium", "medium"], ["execute_high", "high"], ["review", "review"],
  ["fix", "fix"], ["write_documentation", "document"]];

export class WorkflowCompiler {
  constructor(private readonly validator = new WorkflowValidator()) {}

  compilePreset(kind: WorkflowPresetKind, name = this.label(kind)): WorkflowDefinition {
    const now = new Date().toISOString();
    const nodes: WorkflowNode[] = [
      { id: "router", label: "Router", enabled: true, type: "router", role: "router", checkpoint: "initial",
        allowedActions: kind === "prd_driven" ? ["create_prd"]
          : kind === "adaptive" ? ["plan", "execute_low", "execute_medium", "execute_high"]
          : ["execute_low", "execute_medium", "execute_high"] },
      ...this.routedNodes(),
    ];
    if (kind === "adaptive") nodes.push(
      { id: "planning", label: "Planning", enabled: true, type: "role_task", role: "planning" },
    );
    const edges: WorkflowEdge[] = [
      { id: "route-low", from: "router", to: "low", condition: { type: "router_action", action: "execute_low" } },
      { id: "route-medium", from: "router", to: "medium", condition: { type: "router_action", action: "execute_medium" } },
      { id: "route-high", from: "router", to: "high", condition: { type: "router_action", action: "execute_high" } },
    ];
    if (kind === "adaptive") edges.push(
      { id: "route-planning", from: "router", to: "planning", condition: { type: "router_action", action: "plan" } },
    );
    if (kind === "standard") this.addCompletion(nodes, edges, ["low", "medium", "high"]);
    else if (kind === "adaptive") this.addAdaptiveFlow(nodes, edges);
    else if (kind === "review_loop" || kind === "review_documentation") {
      this.addReviewLoop(nodes, edges, kind === "review_documentation");
    } else this.addPrdFlow(nodes, edges);
    return this.validator.validate({ id: randomUUID(), name, version: 1, entryNodeId: "router", nodes, edges,
      createdAt: now, updatedAt: now });
  }

  private routedNodes(): WorkflowNode[] { return [
    { id: "low", label: "Low Level Task", enabled: true, type: "role_task", role: "low" },
    { id: "medium", label: "Medium Level Task", enabled: true, type: "role_task", role: "medium" },
    { id: "high", label: "High Level Task", enabled: true, type: "role_task", role: "high" },
  ]; }
  private addCompletion(nodes: WorkflowNode[], edges: WorkflowEdge[], from: string[]): void {
    nodes.push({ id: "complete", label: "Complete", enabled: true, type: "complete" });
    for (const id of from) edges.push({ id: `${id}-complete`, from: id, to: "complete", condition: { type: "always" } });
  }
  /**
   * Chat preset: one router loop rather than a fixed pipeline. Every role returns to the same checkpoint, where the
   * router answers the only question it ever has to answer — is there more work, and which role does it? — and keeps
   * answering it until it says "complete". So a plan is handed to an implementer, an implementation can be reviewed,
   * a failed review can be fixed and reviewed again, and a one-line question still finishes after a single step,
   * without any of that order being hard-coded here.
   *
   * `work-loop` is the budget. It sits on the way back to the checkpoint and counts the trips, so a router that keeps
   * finding more to do still terminates instead of running until the decision budget fails the whole workflow.
   */
  private addAdaptiveFlow(nodes: WorkflowNode[], edges: WorkflowEdge[]): void {
    nodes.push(
      { id: "route-next", label: "Route next step", enabled: true, type: "router", role: "router",
        checkpoint: "after_execution", allowedActions: ["plan", "execute_low", "execute_medium", "execute_high",
          "review", "fix", "write_documentation", "complete"] },
      { id: "review", label: "Review", enabled: true, type: "review_gate", role: "review", optional: true,
        passEdge: "review-pass", failEdge: "review-fail" },
      { id: "fix", label: "Bug Fix", enabled: true, type: "role_task", role: "bugfix" },
      { id: "document", label: "Write Documentation", enabled: true, type: "document", role: "document",
        operation: "create", documentKind: "custom", optional: true },
      { id: "work-loop", label: "Work loop", enabled: true, type: "loop", loopId: ADAPTIVE_LOOP_ID,
        bodyEntryNodeId: "route-next", exitNodeId: "complete", maxIterations: ADAPTIVE_MAX_ITERATIONS,
        stopCondition: "condition_true", onExhausted: "continue_with_warning" },
      { id: "complete", label: "Complete", enabled: true, type: "complete" },
    );
    // Every role ends in the same place — back at the loop, which decides whether the router gets another turn.
    for (const id of ["planning", "low", "medium", "high", "fix", "document"]) {
      edges.push({ id: `${id}-next`, from: id, to: "work-loop", loopId: ADAPTIVE_LOOP_ID, condition: { type: "always" } });
    }
    // A verdict no longer picks the next node by itself: it travels to the checkpoint as part of the run's state, and
    // the router decides whether it means fix, review again, or done.
    edges.push(
      { id: "review-pass", from: "review", to: "work-loop", loopId: ADAPTIVE_LOOP_ID, condition: { type: "review_result", result: "pass" } },
      { id: "review-fail", from: "review", to: "work-loop", loopId: ADAPTIVE_LOOP_ID, condition: { type: "review_result", result: "fail" } },
      { id: "loop-continue", from: "work-loop", to: "route-next", loopId: ADAPTIVE_LOOP_ID, condition: { type: "loop_remaining" } },
      { id: "loop-exhausted", from: "work-loop", to: "complete", condition: { type: "loop_exhausted" } },
      { id: "next-complete", from: "route-next", to: "complete", condition: { type: "router_action", action: "complete" } },
    );
    for (const [action, to] of ADAPTIVE_ROUTES) {
      edges.push({ id: `next-${to}`, from: "route-next", to, loopId: ADAPTIVE_LOOP_ID, condition: { type: "router_action", action } });
    }
  }

  private addReviewLoop(nodes: WorkflowNode[], edges: WorkflowEdge[], docs: boolean): void {
    nodes.push(
      { id: "review", label: "Review", enabled: true, type: "review_gate", role: "review", passEdge: "review-pass", failEdge: "review-fail" },
      { id: "fix", label: "Bug Fix", enabled: true, type: "role_task", role: "bugfix" },
      { id: "review-loop", label: "Review loop", enabled: true, type: "loop", loopId: "review-fix", bodyEntryNodeId: "review",
        exitNodeId: docs ? "document" : "complete", maxIterations: 3, stopCondition: "review_passed", onExhausted: "ask_user" },
    );
    if (docs) nodes.push({ id: "document", label: "Write Documentation", enabled: true, type: "document", role: "document",
      operation: "update", documentKind: "readme" });
    nodes.push({ id: "complete", label: "Complete", enabled: true, type: "complete" });
    for (const id of ["low", "medium", "high"]) edges.push({ id: `${id}-review`, from: id, to: "review", condition: { type: "always" } });
    edges.push(
      { id: "review-pass", from: "review", to: docs ? "document" : "complete", condition: { type: "review_result", result: "pass" } },
      { id: "review-fail", from: "review", to: "fix", condition: { type: "review_result", result: "fail" } },
      { id: "fix-loop", from: "fix", to: "review-loop", condition: { type: "always" } },
      { id: "loop-review", from: "review-loop", to: "review", loopId: "review-fix", condition: { type: "loop_remaining" } },
      { id: "loop-exhausted", from: "review-loop", to: docs ? "document" : "complete", condition: { type: "loop_exhausted" } },
    );
    if (docs) edges.push({ id: "document-complete", from: "document", to: "complete", condition: { type: "always" } });
  }
  private addPrdFlow(nodes: WorkflowNode[], edges: WorkflowEdge[]): void {
    edges.splice(0, edges.length, { id: "route-create-prd", from: "router", to: "create-prd",
      condition: { type: "router_action", action: "create_prd" } });
    nodes.push(
      { id: "create-prd", label: "Create PRD", enabled: true, type: "document", role: "document", operation: "create", documentKind: "prd" },
      { id: "route-execution", label: "Route implementation", enabled: true, type: "router", role: "router", checkpoint: "after_document",
        allowedActions: ["execute_low", "execute_medium", "execute_high"] },
      { id: "route-after-execution", label: "Route after implementation", enabled: true, type: "router", role: "router", checkpoint: "after_execution",
        allowedActions: ["review"] },
      { id: "review", label: "Review", enabled: true, type: "review_gate", role: "review", passEdge: "review-pass", failEdge: "review-fail" },
      { id: "route-after-review", label: "Route after review", enabled: true, type: "router", role: "router", checkpoint: "after_review",
        allowedActions: ["fix", "update_prd"] },
      { id: "fix", label: "Bug Fix", enabled: true, type: "role_task", role: "bugfix" },
      { id: "route-after-fix", label: "Route after fix", enabled: true, type: "router", role: "router", checkpoint: "after_fix",
        allowedActions: ["review"] },
      { id: "review-loop", label: "Review loop", enabled: true, type: "loop", loopId: "review-fix", bodyEntryNodeId: "review",
        exitNodeId: "update-prd", maxIterations: 3, stopCondition: "review_passed", onExhausted: "ask_user" },
      { id: "update-prd", label: "Update PRD", enabled: true, type: "document", role: "document", operation: "update", documentKind: "prd" },
      { id: "route-complete", label: "Route completion", enabled: true, type: "router", role: "router", checkpoint: "before_completion",
        allowedActions: ["complete"] },
      { id: "complete", label: "Complete", enabled: true, type: "complete" },
    );
    edges.push({ id: "create-route", from: "create-prd", to: "route-execution", condition: { type: "always" } });
    for (const role of ["low", "medium", "high"] as const) {
      edges.push({ id: `route-${role}`, from: "route-execution", to: role,
        condition: { type: "router_action", action: `execute_${role}` } });
      edges.push({ id: `${role}-route-after-execution`, from: role, to: "route-after-execution", condition: { type: "always" } });
    }
    edges.push(
      { id: "after-execution-review", from: "route-after-execution", to: "review", condition: { type: "router_action", action: "review" } },
      { id: "review-pass", from: "review", to: "route-after-review", condition: { type: "review_result", result: "pass" } },
      { id: "review-fail", from: "review", to: "route-after-review", condition: { type: "review_result", result: "fail" } },
      { id: "after-review-fix", from: "route-after-review", to: "fix", condition: { type: "router_action", action: "fix" } },
      { id: "after-review-update", from: "route-after-review", to: "update-prd", condition: { type: "router_action", action: "update_prd" } },
      { id: "fix-route", from: "fix", to: "route-after-fix", condition: { type: "always" } },
      { id: "after-fix-review", from: "route-after-fix", to: "review-loop", condition: { type: "router_action", action: "review" } },
      { id: "loop-review", from: "review-loop", to: "review", loopId: "review-fix", condition: { type: "loop_remaining" } },
      { id: "loop-exhausted", from: "review-loop", to: "update-prd", condition: { type: "loop_exhausted" } },
      { id: "update-route-complete", from: "update-prd", to: "route-complete", condition: { type: "always" } },
      { id: "route-complete-edge", from: "route-complete", to: "complete", condition: { type: "router_action", action: "complete" } },
    );
  }
  private label(kind: WorkflowPresetKind): string { return ({ standard: "Standard", review_loop: "Review Loop",
    review_documentation: "Review + Documentation", prd_driven: "PRD Driven Development", adaptive: "Adaptive Chat" })[kind]; }
}
