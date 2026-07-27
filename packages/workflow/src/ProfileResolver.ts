import { AgentError, roleExecutionProfileSchema, stepExecutionOverrideSchema } from "@waing/domain";
import type { RoleExecutionProfile, StepExecutionOverride, WorkflowDefinition, WorkflowNode, WorkflowRole } from "@waing/domain";

export type GlobalRoleProfiles = Record<WorkflowRole, RoleExecutionProfile>;

export class ProfileResolver {
  constructor(private readonly globalProfiles: GlobalRoleProfiles) {}

  resolve(role: WorkflowRole, workflow: WorkflowDefinition, step?: StepExecutionOverride): RoleExecutionProfile {
    const global = this.globalProfiles[role];
    if (global === undefined) throw new AgentError("WORKFLOW_INVALID", `No global profile is configured for ${role}`);
    const workflowOverride = workflow.roleOverrides?.[role] ?? {};
    const validatedStep = stepExecutionOverrideSchema.parse(step ?? {});
    const resolved = roleExecutionProfileSchema.parse({ ...global, ...workflowOverride, ...validatedStep, role });
    if (!resolved.enabled) throw new AgentError("WORKFLOW_INVALID", `The ${role} role is disabled`);
    return resolved;
  }

  resolveNode(node: WorkflowNode, workflow: WorkflowDefinition): RoleExecutionProfile {
    if (node.type === "loop" || node.type === "complete") throw new AgentError("WORKFLOW_INVALID", `${node.type} is not executable`);
    return this.resolve(node.role, workflow, "execution" in node ? node.execution : undefined);
  }
}
