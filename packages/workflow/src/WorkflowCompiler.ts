import { randomUUID } from "node:crypto";
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from "@waing/domain";
import { WorkflowValidator } from "./WorkflowValidator";

export type WorkflowPresetKind = "standard" | "review_loop" | "review_documentation" | "prd_driven" | "adaptive";

export class WorkflowCompiler {
  constructor(private readonly validator = new WorkflowValidator()) {}

  compilePreset(kind: WorkflowPresetKind, name = this.label(kind)): WorkflowDefinition {
    const now = new Date().toISOString();
    const nodes: WorkflowNode[] = [
      { id: "router", label: "Router", enabled: true, type: "router", role: "router", checkpoint: "initial",
        allowedActions: kind === "prd_driven" ? ["create_prd"] : ["execute_low", "execute_medium", "execute_high"] },
      ...this.routedNodes(),
    ];
    const edges: WorkflowEdge[] = [
      { id: "route-low", from: "router", to: "low", condition: { type: "router_action", action: "execute_low" } },
      { id: "route-medium", from: "router", to: "medium", condition: { type: "router_action", action: "execute_medium" } },
      { id: "route-high", from: "router", to: "high", condition: { type: "router_action", action: "execute_high" } },
    ];
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
   * Chat preset: the router picks the implementing role, then decides after each stage whether the work still needs a
   * review or a document before completing. Review and document are optional gates, so a plain question can finish
   * right after the task step while a build can add docs and a review pass without a second user prompt.
   */
  private addAdaptiveFlow(nodes: WorkflowNode[], edges: WorkflowEdge[]): void {
    nodes.push(
      { id: "route-next", label: "Route after task", enabled: true, type: "router", role: "router",
        checkpoint: "after_execution", allowedActions: ["review", "write_documentation", "complete"] },
      { id: "review", label: "Review", enabled: true, type: "review_gate", role: "review", optional: true,
        passEdge: "review-pass", failEdge: "review-fail" },
      { id: "fix", label: "Bug Fix", enabled: true, type: "role_task", role: "bugfix" },
      { id: "review-loop", label: "Review loop", enabled: true, type: "loop", loopId: "review-fix",
        bodyEntryNodeId: "review", exitNodeId: "route-after-review", maxIterations: 3, stopCondition: "review_passed",
        onExhausted: "continue_with_warning" },
      { id: "route-after-review", label: "Route after review", enabled: true, type: "router", role: "router",
        checkpoint: "after_review", allowedActions: ["write_documentation", "complete"] },
      { id: "document", label: "Write Documentation", enabled: true, type: "document", role: "document",
        operation: "create", documentKind: "custom", optional: true },
      { id: "complete", label: "Complete", enabled: true, type: "complete" },
    );
    for (const id of ["low", "medium", "high"]) edges.push({ id: `${id}-next`, from: id, to: "route-next", condition: { type: "always" } });
    edges.push(
      { id: "next-review", from: "route-next", to: "review", condition: { type: "router_action", action: "review" } },
      { id: "next-document", from: "route-next", to: "document", condition: { type: "router_action", action: "write_documentation" } },
      { id: "next-complete", from: "route-next", to: "complete", condition: { type: "router_action", action: "complete" } },
      { id: "review-pass", from: "review", to: "route-after-review", condition: { type: "review_result", result: "pass" } },
      { id: "review-fail", from: "review", to: "fix", condition: { type: "review_result", result: "fail" } },
      { id: "fix-loop", from: "fix", to: "review-loop", condition: { type: "always" } },
      { id: "loop-review", from: "review-loop", to: "review", loopId: "review-fix", condition: { type: "loop_remaining" } },
      { id: "loop-exhausted", from: "review-loop", to: "route-after-review", condition: { type: "loop_exhausted" } },
      { id: "after-review-document", from: "route-after-review", to: "document", condition: { type: "router_action", action: "write_documentation" } },
      { id: "after-review-complete", from: "route-after-review", to: "complete", condition: { type: "router_action", action: "complete" } },
      { id: "document-complete", from: "document", to: "complete", condition: { type: "always" } },
    );
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
