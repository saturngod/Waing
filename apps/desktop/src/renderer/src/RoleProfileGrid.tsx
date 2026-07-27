import { useEffect, useMemo, useState } from "react";
import type { AgentDescriptor, AgentModelDescriptor, RoleExecutionProfile, WorkflowRole } from "@waing/domain";

export const ROLE_LABELS: Record<WorkflowRole, string> = { router: "Router", low: "Low", medium: "Medium",
  high: "High", review: "Review", bugfix: "Bug Fix", document: "Document" };

/**
 * Shared editor for the seven role profiles. Settings edits the saved defaults with it; the workflow builder
 * edits a per-run copy. Model identifiers are provider-specific, so each selected agent contributes its own list.
 */
export function RoleProfileGrid({ profiles, agents, onChange }: {
  profiles: RoleExecutionProfile[];
  agents: AgentDescriptor[];
  onChange: (index: number, patch: Partial<RoleExecutionProfile>) => void;
}) {
  const [modelsByAgent, setModelsByAgent] = useState<Record<string, AgentModelDescriptor[]>>({});
  const selectedAgentIds = useMemo(() => [...new Set(profiles.map((profile) => profile.agentId))].sort().join(","), [profiles]);

  useEffect(() => {
    for (const agentId of selectedAgentIds.split(",").filter((id) => id.length > 0)) {
      setModelsByAgent((current) => {
        if (agentId in current) return current;
        void window.waing.agents.models(agentId)
          .then((available) => setModelsByAgent((latest) => ({ ...latest, [agentId]: available })))
          .catch(() => setModelsByAgent((latest) => ({ ...latest, [agentId]: [] })));
        return { ...current, [agentId]: [] };
      });
    }
  }, [selectedAgentIds]);

  return <div className="role-grid">
    {profiles.map((profile, index) => {
      const models = modelsByAgent[profile.agentId] ?? [];
      return <article className="role-card" key={profile.role}>
        <strong>{ROLE_LABELS[profile.role]}</strong>
        {/* Switching provider invalidates any model chosen for the previous one, so the model resets with it. */}
        <label>Agent<select value={profile.agentId} aria-label={`${ROLE_LABELS[profile.role]} agent`}
          onChange={(event) => onChange(index, { agentId: event.target.value, modelId: undefined })}>
          {agents.some((agent) => agent.id === profile.agentId) ? null : <option value={profile.agentId}>{profile.agentId} (not installed)</option>}
          {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.displayName}</option>)}
        </select></label>
        <label>Model<select value={profile.modelId ?? ""} disabled={models.length === 0}
          aria-label={`${ROLE_LABELS[profile.role]} model`}
          title={models.length === 0 ? "This provider reported no selectable models" : undefined}
          onChange={(event) => onChange(index, event.target.value === "" ? { modelId: undefined } : { modelId: event.target.value })}>
          <option value="">Provider default</option>
          {models.map((item) => <option key={item.modelId} value={item.modelId}>{item.displayName}</option>)}
        </select></label>
        <label>Effort<select value={profile.effort ?? "medium"} aria-label={`${ROLE_LABELS[profile.role]} effort`}
          onChange={(event) => onChange(index, { effort: event.target.value as RoleExecutionProfile["effort"] })}>
          <option>low</option><option>medium</option><option>high</option><option>max</option>
        </select></label>
        <label>Mode<select value={profile.mode ?? "execute"} aria-label={`${ROLE_LABELS[profile.role]} mode`}
          onChange={(event) => onChange(index, { mode: event.target.value as RoleExecutionProfile["mode"] })}>
          <option>execute</option><option>plan</option><option>review</option><option>investigate</option>
        </select></label>
        <label>Permissions<select value={profile.permissionProfileId ?? "ask_before_changes"}
          aria-label={`${ROLE_LABELS[profile.role]} permissions`}
          onChange={(event) => onChange(index, { permissionProfileId: event.target.value })}>
          <option value="read_only">Read only</option><option value="ask_before_changes">Ask changes</option>
          <option value="auto_edit">Auto edit</option><option value="autonomous">Autonomous</option>
        </select></label>
      </article>;
    })}
  </div>;
}
