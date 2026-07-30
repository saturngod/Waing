import type { AgentProfile, WorkflowDefinition, WorkflowEdge, WorkflowNode } from "@waing/domain";

export class WorkflowCompiler {
  compileAdaptive(profiles: readonly AgentProfile[]): WorkflowDefinition {
    const enabled = [...profiles].filter((profile) => profile.enabled)
      .sort((left, right) => left.position - right.position || left.name.localeCompare(right.name));
    if (enabled.length === 0) throw new Error("At least one enabled agent is required");
    const now = new Date().toISOString();
    const nodes: WorkflowNode[] = [
      { id: "router", label: "Router", enabled: true, type: "router", checkpoint: "initial", allowedActions: ["delegate", "ask_user", "complete"] },
      ...enabled.map((profile) => ({ id: profile.id, label: profile.name, enabled: true, type: "role_task" as const, agentProfileId: profile.id })),
      { id: "work-loop", label: "Work loop", enabled: true, type: "loop", loopId: "adaptive-work", bodyEntryNodeId: "route-next",
        exitNodeId: "complete", maxIterations: 20, stopCondition: "condition_true", onExhausted: "continue_with_warning" },
      { id: "route-next", label: "Route next", enabled: true, type: "router", checkpoint: "after_execution", allowedActions: ["delegate", "ask_user", "complete"] },
      { id: "complete", label: "Complete", enabled: true, type: "complete" },
    ];
    const edges: WorkflowEdge[] = [
      ...["router", "route-next"].flatMap((routerId) => enabled.map((profile) => ({ id: `${routerId}-${profile.id}`,
        from: routerId, to: profile.id, condition: { type: "router_agent" as const, agentProfileId: profile.id } }))),
      { id: "router-complete", from: "router", to: "complete", condition: { type: "router_action", action: "complete" } },
      { id: "route-next-complete", from: "route-next", to: "complete", condition: { type: "router_action", action: "complete" } },
      ...enabled.map((profile) => ({ id: `${profile.id}-work-loop`, from: profile.id, to: "work-loop", condition: { type: "always" as const } })),
      { id: "work-loop-next", from: "work-loop", to: "route-next", loopId: "adaptive-work", condition: { type: "loop_remaining" } },
      { id: "work-loop-exhausted", from: "work-loop", to: "complete", loopId: "adaptive-work", condition: { type: "loop_exhausted" } },
    ];
    return { id: "adaptive", name: "Adaptive agents", version: 1, entryNodeId: "router", nodes, edges, createdAt: now, updatedAt: now };
  }
}
