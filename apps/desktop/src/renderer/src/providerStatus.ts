import type { AgentDescriptor } from "@waing/domain";

/**
 * Label for a provider row. `authState` is deliberately not shown: no adapter verifies credentials yet, so every
 * installed provider reports "unknown" and every uninstalled one reports "missing" — the same thing `installed`
 * already says, only more confusingly. Show the version instead until a real sign-in probe exists.
 */
export function providerStatusLabel(agent: AgentDescriptor): string {
  if (!agent.installed) return "not installed";
  if (!agent.available) return "unavailable";
  return agent.version ?? "installed";
}

export const PROVIDER_STATUS_HINT = "Installed CLIs and detected versions. Sign-in state is not checked yet.";

/** Chat-sidebar traffic light: green ready, amber running the current task, red unusable. */
export type ProviderDotState = "ready" | "busy" | "down";
export function providerDotState(agent: AgentDescriptor, busyAgentId?: string): ProviderDotState {
  if (agent.id === busyAgentId) return "busy";
  return agent.installed && agent.available ? "ready" : "down";
}
export const PROVIDER_DOT_TITLES: Record<ProviderDotState, string> = {
  ready: "Ready", busy: "Working on this task", down: "Not installed or not ready",
};
