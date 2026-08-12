import type { AgentDescriptor, AgentProfile, EffortLevel, RouterSettings } from "@waing/domain";

const definitions: Array<{ id: string; name: string; whereToUse: string; instructions: string; effort: EffortLevel; permissionProfileId: string; preferences: string[]; codexModelId: string; codexEffort: EffortLevel }> = [
  { id: "planner", name: "Planner", whereToUse: "Break a broad or unclear request into concrete steps before any code is written.",
    instructions: "Plan the work. Do not edit files.", effort: "high", permissionProfileId: "read_only", preferences: ["claude", "codex", "opencode", "antigravity"], codexModelId: "gpt-5.6-sol", codexEffort: "high" },
  { id: "coder", name: "Coder", whereToUse: "Write and change code — the default for ordinary implementation work.",
    instructions: "Implement the requested change and verify it.", effort: "medium", permissionProfileId: "auto_edit", preferences: ["codex", "claude", "opencode", "antigravity"], codexModelId: "gpt-5.6-luna", codexEffort: "max" },
  { id: "architect", name: "Architect", whereToUse: "Large, risky, or cross-cutting changes needing careful reasoning.",
    instructions: "Reason carefully about architecture and make only approved changes.", effort: "high", permissionProfileId: "ask_before_changes", preferences: ["claude", "codex", "opencode", "antigravity"], codexModelId: "gpt-5.6-sol", codexEffort: "high" },
  { id: "reviewer", name: "Reviewer", whereToUse: "Check finished work for bugs, regressions, security issues, and missing tests.",
    instructions: "Review the current changes. Report concrete findings and do not edit files.", effort: "high", permissionProfileId: "read_only", preferences: ["claude", "codex", "opencode", "antigravity"], codexModelId: "gpt-5.6-sol", codexEffort: "high" },
  { id: "doc-writer", name: "Doc Writer", whereToUse: "Write or update README, PRD, changelog, or architecture notes.",
    instructions: "Write clear documentation that matches the implementation.", effort: "medium", permissionProfileId: "auto_edit", preferences: ["opencode", "claude", "codex", "antigravity"], codexModelId: "gpt-5.6-luna", codexEffort: "medium" },
];

function installed(descriptors: readonly AgentDescriptor[]): AgentDescriptor[] {
  return descriptors.filter((descriptor) => descriptor.installed && descriptor.available);
}

export function buildStarterAgentProfiles(descriptors: readonly AgentDescriptor[]): AgentProfile[] {
  const available = installed(descriptors);
  return definitions.map((definition, position) => {
    const agentId = definition.preferences.find((id) => available.some((agent) => agent.id === id))
      ?? available[0]?.id ?? descriptors[0]?.id ?? "codex";
    return { id: definition.id, name: definition.name, whereToUse: definition.whereToUse,
      instructions: definition.instructions, effort: definition.effort, permissionProfileId: definition.permissionProfileId,
      agentId, enabled: true, position, codex: { modelId: definition.codexModelId, effort: definition.codexEffort } };
  });
}

export function sortAgentProfiles(profiles: readonly AgentProfile[]): AgentProfile[] {
  return [...profiles].sort((left, right) => left.position - right.position || left.name.localeCompare(right.name));
}

export function buildDefaultRouterSettings(descriptors: readonly AgentDescriptor[]): RouterSettings {
  const available = installed(descriptors);
  const agentId = ["opencode", "codex", "claude", "antigravity"].find((id) => available.some((agent) => agent.id === id))
    ?? available[0]?.id ?? descriptors[0]?.id ?? "codex";
  return { agentId, effort: "low", codex: { modelId: "gpt-5.6-luna", effort: "medium" } };
}
