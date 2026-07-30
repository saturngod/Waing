import { useEffect, useMemo, useState } from "react";
import type { AgentDescriptor, AgentModelDescriptor, EffortLevel } from "@waing/domain";

export interface ProviderModelSelection { agentId: string; modelId?: string; effort?: EffortLevel }
const modelRequests = new Map<string, Promise<AgentModelDescriptor[]>>();
export function loadAgentModels(agentId: string): Promise<AgentModelDescriptor[]> {
  const existing = modelRequests.get(agentId);
  if (existing !== undefined) return existing;
  const request = window.waing.agents.models(agentId).catch(() => []);
  modelRequests.set(agentId, request); return request;
}

export function ProviderModelFields({ label, value, agents, onChange }: {
  label: string; value: ProviderModelSelection; agents: AgentDescriptor[];
  onChange: (value: ProviderModelSelection) => void;
}) {
  const [models, setModels] = useState<AgentModelDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true; setLoading(true); setModels([]);
    void loadAgentModels(value.agentId).then((items) => { if (active) { setModels(items); setLoading(false); } });
    return () => { active = false; };
  }, [value.agentId]);
  const descriptor = agents.find((agent) => agent.id === value.agentId);
  const selectableModels = useMemo(() => models.filter((model) =>
    !(value.agentId === "antigravity" && model.modelId === "default")), [models, value.agentId]);
  const selectedModel = value.modelId === undefined ? selectableModels.find((model) => model.isDefault)
    : selectableModels.find((model) => model.modelId === value.modelId);
  const efforts: readonly EffortLevel[] = selectedModel?.effortLevels ?? ["low", "medium", "high", "max"];
  const effortEnabled = descriptor?.capabilities.effortControl === true && efforts.length > 0;
  const effort = efforts.includes(value.effort ?? "medium") ? value.effort ?? "medium" : efforts[0];

  return <div className="provider-model-fields">
    <label><span>Provider</span><select aria-label={`${label} provider`} value={value.agentId} onChange={(event) => {
      const next = agents.find((agent) => agent.id === event.target.value);
      onChange({ agentId: event.target.value, ...(next?.capabilities.effortControl === true ? { effort: "medium" } : {}) });
    }}>
      {!agents.some((agent) => agent.id === value.agentId) && <option value={value.agentId}>{value.agentId} (not installed)</option>}
      {agents.map((agent) => <option key={agent.id} value={agent.id} disabled={!agent.available}>{agent.displayName}</option>)}
    </select></label>
    <label><span>Model</span><select aria-label={`${label} model`} value={value.modelId ?? ""} disabled={loading}
      onChange={(event) => {
        const model = event.target.value === "" ? selectableModels.find((candidate) => candidate.isDefault)
          : selectableModels.find((candidate) => candidate.modelId === event.target.value);
        const nextEfforts: readonly EffortLevel[] = model?.effortLevels ?? ["low", "medium", "high", "max"];
        const nextEffort = nextEfforts.includes(value.effort ?? "medium") ? value.effort ?? "medium" : nextEfforts[0];
        onChange({ agentId: value.agentId, ...(event.target.value === "" ? {} : { modelId: event.target.value }),
          ...(descriptor?.capabilities.effortControl === true && nextEffort !== undefined ? { effort: nextEffort } : {}) });
      }}>
      <option value="">{loading ? "Loading models…" : "Provider default"}</option>
      {selectableModels.map((model) => <option key={model.modelId} value={model.modelId} disabled={!model.available}>
        {model.displayName}{model.warnings?.[0] === undefined ? "" : ` — ${model.warnings[0]}`}</option>)}
    </select></label>
    <label><span>Effort</span><select aria-label={`${label} effort`} value={effort ?? ""} disabled={!effortEnabled}
      title={!effortEnabled ? "The selected provider or model does not expose effort control" : undefined}
      onChange={(event) => onChange({ agentId: value.agentId, ...(value.modelId === undefined ? {} : { modelId: value.modelId }),
        effort: event.target.value as EffortLevel })}>
      {efforts.map((option) => <option key={option} value={option}>{option.charAt(0).toLocaleUpperCase()}{option.slice(1)}</option>)}
    </select></label>
  </div>;
}
