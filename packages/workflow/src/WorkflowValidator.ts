import { AgentError, workflowDefinitionSchema } from "@waing/domain";
import type { AgentProfile, WorkflowDefinition } from "@waing/domain";

export class WorkflowValidator {
  validate(raw: unknown, profiles?: readonly AgentProfile[]): WorkflowDefinition {
    const parsed = workflowDefinitionSchema.safeParse(raw);
    if (!parsed.success) throw new AgentError("WORKFLOW_INVALID", parsed.error.issues.map((issue) => issue.message).join("; "));
    const workflow = parsed.data;
    const nodeIds = new Set(workflow.nodes.map((node) => node.id));
    if (nodeIds.size !== workflow.nodes.length || !nodeIds.has(workflow.entryNodeId)) throw new AgentError("WORKFLOW_INVALID", "Workflow node ids must be unique and include the entry node");
    for (const edge of workflow.edges) if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) throw new AgentError("WORKFLOW_INVALID", `Edge ${edge.id} references an unknown node`);
    if (profiles !== undefined) {
      const ids = new Set(profiles.filter((profile) => profile.enabled).map((profile) => profile.id));
      for (const node of workflow.nodes) if (node.type === "role_task" && !ids.has(node.agentProfileId))
        throw new AgentError("WORKFLOW_INVALID", `Node ${node.id} references unavailable agent ${node.agentProfileId}`);
    }
    return workflow;
  }
}
