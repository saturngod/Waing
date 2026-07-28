import type { AgentDescriptor, EffortLevel, RoleExecutionProfile, WorkflowRole } from "@waing/domain";

export const ROLE_ORDER: readonly WorkflowRole[] = ["router", "planning", "low", "medium", "high", "review", "bugfix", "document"];

/** Provider preference per role, most preferred first. Used only to seed a first-run configuration. */
const preferences: Record<WorkflowRole, readonly string[]> = {
  router: ["opencode", "codex", "claude", "antigravity"],
  planning: ["claude", "codex", "opencode", "antigravity"],
  low: ["codex", "opencode", "claude", "antigravity"],
  medium: ["codex", "claude", "antigravity", "opencode"],
  high: ["claude", "codex", "antigravity", "opencode"],
  review: ["antigravity", "claude", "codex", "opencode"],
  bugfix: ["codex", "claude", "antigravity", "opencode"],
  document: ["opencode", "claude", "codex", "antigravity"],
};

const efforts: Record<WorkflowRole, EffortLevel> = {
  router: "low", planning: "high", low: "low", medium: "medium", high: "high", review: "high", bugfix: "high", document: "medium",
};

/**
 * Builds a starting role configuration from the providers that are actually installed and available, so a first
 * launch never points a role at a provider the user does not have. When nothing is available the first preference
 * is kept as a placeholder: the role stays visible and editable in settings instead of silently disappearing.
 */
export function buildDefaultRoleProfiles(descriptors: readonly AgentDescriptor[]): RoleExecutionProfile[] {
  const usable = new Set(descriptors.filter((descriptor) => descriptor.installed && descriptor.available)
    .map((descriptor) => descriptor.id));
  const installed = new Set(descriptors.filter((descriptor) => descriptor.installed).map((descriptor) => descriptor.id));
  return ROLE_ORDER.map((role) => {
    const ranked = preferences[role];
    const agentId = ranked.find((id) => usable.has(id)) ?? ranked.find((id) => installed.has(id)) ?? ranked[0]!;
    return {
      // No mode: the workflow derives it from the node, so seeding one here could only ever disagree with the role.
      role, enabled: true, agentId, effort: efforts[role],
      permissionProfileId: "ask_before_changes", timeoutMs: 1_800_000, maxRetries: 0,
    } satisfies RoleExecutionProfile;
  });
}

/** Orders an arbitrary profile set into the canonical role order the UI and workflow engine expect. */
export function sortRoleProfiles(profiles: readonly RoleExecutionProfile[]): RoleExecutionProfile[] {
  return [...profiles].sort((left, right) => ROLE_ORDER.indexOf(left.role) - ROLE_ORDER.indexOf(right.role));
}
