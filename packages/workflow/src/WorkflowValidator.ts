import { AgentError, workflowDefinitionSchema } from "@waing/domain";
import type { WorkflowDefinition, WorkflowEdge } from "@waing/domain";
import type { GlobalRoleProfiles } from "./ProfileResolver";
import { ProfileResolver } from "./ProfileResolver";

export class WorkflowValidator {
  validate(raw: unknown, profiles?: GlobalRoleProfiles): WorkflowDefinition {
    const workflow = workflowDefinitionSchema.parse(raw);
    const errors: string[] = [];
    const nodes = new Map<string, WorkflowDefinition["nodes"][number]>();
    for (const node of workflow.nodes) {
      if (nodes.has(node.id)) errors.push(`Duplicate node ID: ${node.id}`);
      nodes.set(node.id, node);
    }
    const edgeIds = new Set<string>();
    for (const edge of workflow.edges) {
      if (edgeIds.has(edge.id)) errors.push(`Duplicate edge ID: ${edge.id}`);
      edgeIds.add(edge.id);
      if (!nodes.has(edge.from)) errors.push(`Edge ${edge.id} has unknown source ${edge.from}`);
      if (!nodes.has(edge.to)) errors.push(`Edge ${edge.id} has unknown target ${edge.to}`);
    }
    if (!nodes.has(workflow.entryNodeId)) errors.push(`Entry node ${workflow.entryNodeId} does not exist`);
    this.validateOutgoing(workflow, errors);
    this.validateReviewGates(workflow, errors);
    this.validateLoops(workflow, nodes, errors);
    const reachable = this.reachable(workflow);
    for (const node of workflow.nodes) if (node.enabled && !reachable.has(node.id)) errors.push(`Enabled node ${node.id} is unreachable`);
    if (!workflow.nodes.some((node) => node.type === "complete" && reachable.has(node.id))) errors.push("No reachable Complete node");
    if (profiles !== undefined) {
      const resolver = new ProfileResolver(profiles);
      for (const node of workflow.nodes) if (node.enabled && node.type !== "loop" && node.type !== "complete") {
        try { resolver.resolveNode(node, workflow); } catch (cause) { errors.push(cause instanceof Error ? cause.message : "Profile resolution failed"); }
      }
    }
    if (errors.length > 0) throw new AgentError("WORKFLOW_INVALID", errors.join("; "));
    return workflow;
  }

  private validateOutgoing(workflow: WorkflowDefinition, errors: string[]): void {
    for (const node of workflow.nodes) {
      const outgoing = workflow.edges.filter((edge) => edge.from === node.id);
      const keys = new Set<string>();
      for (const edge of outgoing) {
        const key = this.conditionKey(edge);
        if (keys.has(key)) errors.push(`Node ${node.id} has ambiguous duplicate condition ${key}`);
        keys.add(key);
      }
      if (node.type !== "complete" && node.enabled && outgoing.length === 0) errors.push(`Node ${node.id} has no outgoing edge`);
    }
  }

  private validateReviewGates(workflow: WorkflowDefinition, errors: string[]): void {
    for (const node of workflow.nodes.filter((candidate) => candidate.type === "review_gate")) {
      const pass = workflow.edges.find((edge) => edge.id === node.passEdge);
      const fail = workflow.edges.find((edge) => edge.id === node.failEdge);
      if (pass?.from !== node.id || pass.condition?.type !== "review_result" || pass.condition.result !== "pass") {
        errors.push(`Review gate ${node.id} has an invalid PASS edge`);
      }
      if (fail?.from !== node.id || fail.condition?.type !== "review_result" || fail.condition.result !== "fail") {
        errors.push(`Review gate ${node.id} has an invalid FAIL edge`);
      }
    }
  }

  private validateLoops(workflow: WorkflowDefinition, nodes: Map<string, WorkflowDefinition["nodes"][number]>, errors: string[]): void {
    const loops = new Map(workflow.nodes.filter((node) => node.type === "loop").map((node) => [node.loopId, node]));
    for (const loop of loops.values()) {
      if (!nodes.has(loop.bodyEntryNodeId) || !nodes.has(loop.exitNodeId)) errors.push(`Loop ${loop.loopId} references an unknown node`);
      const outgoing = workflow.edges.filter((edge) => edge.from === loop.id);
      if (!outgoing.some((edge) => edge.condition?.type === "loop_remaining" && edge.to === loop.bodyEntryNodeId)) errors.push(`Loop ${loop.loopId} lacks its remaining edge`);
      if (!outgoing.some((edge) => edge.condition?.type === "loop_exhausted" && edge.to === loop.exitNodeId)) errors.push(`Loop ${loop.loopId} lacks its exhausted edge`);
    }
    const visiting = new Set<string>(); const visited = new Set<string>();
    const visit = (id: string): void => {
      visiting.add(id);
      for (const edge of workflow.edges.filter((candidate) => candidate.from === id)) {
        if (visiting.has(edge.to) && (edge.loopId === undefined || !loops.has(edge.loopId))) errors.push(`Cycle edge ${edge.id} is not guarded by a declared loop`);
        else if (!visited.has(edge.to) && !visiting.has(edge.to)) visit(edge.to);
      }
      visiting.delete(id); visited.add(id);
    };
    if (nodes.has(workflow.entryNodeId)) visit(workflow.entryNodeId);
  }

  private reachable(workflow: WorkflowDefinition): Set<string> {
    const result = new Set<string>(); const pending = [workflow.entryNodeId];
    while (pending.length > 0) {
      const id = pending.pop(); if (id === undefined || result.has(id)) continue;
      result.add(id); for (const edge of workflow.edges) if (edge.from === id) pending.push(edge.to);
    }
    return result;
  }
  private conditionKey(edge: WorkflowEdge): string {
    const condition = edge.condition ?? { type: "always" as const };
    if (condition.type === "router_role") return `${condition.type}:${condition.role}`;
    if (condition.type === "router_action") return `${condition.type}:${condition.action}`;
    if (condition.type === "document_operation") return `${condition.type}:${condition.operation}`;
    if (condition.type === "review_result") return `${condition.type}:${condition.result}`;
    return condition.type;
  }
}
