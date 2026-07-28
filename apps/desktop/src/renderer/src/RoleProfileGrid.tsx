import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { AgentDescriptor, AgentModelDescriptor, RoleExecutionProfile, WorkflowRole } from "@waing/domain";

export const ROLE_LABELS: Record<WorkflowRole, string> = { router: "Router", planning: "Planning", low: "Low", medium: "Medium",
  high: "High", review: "Review", bugfix: "Bug Fix", document: "Document" };

type ModelOption = { id: string; label: string; searchText: string };

/** Searchable combobox used instead of a native select for providers that expose large model catalogs. */
function ModelPicker({ roleLabel, value, models, onChange }: {
  roleLabel: string; value: string | undefined; models: AgentModelDescriptor[]; onChange: (modelId: string | undefined) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const options = useMemo<ModelOption[]>(() => [{ id: "", label: "Provider default", searchText: "provider default" },
    ...models.map((model) => ({ id: model.modelId, label: model.displayName,
      searchText: `${model.displayName} ${model.modelId}`.toLocaleLowerCase() }))], [models]);
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return search.length === 0 ? options : options.filter((option) => option.searchText.includes(search));
  }, [options, query]);
  const selectedLabel = options.find((option) => option.id === (value ?? ""))?.label ?? value ?? "Provider default";

  function choose(option: ModelOption): void {
    onChange(option.id.length === 0 ? undefined : option.id);
    setQuery(""); setOpen(false); inputRef.current?.blur();
  }

  return <div className={`model-picker ${open ? "open" : ""}`}>
    <input ref={inputRef} type="text" role="combobox" aria-label={`${roleLabel} model`}
      aria-expanded={open} aria-controls={listboxId} aria-autocomplete="list"
      {...(open && filtered[activeIndex] !== undefined ? { "aria-activedescendant": `${listboxId}-${String(activeIndex)}` } : {})}
      value={open ? query : selectedLabel} disabled={models.length === 0}
      title={models.length === 0 ? "This provider reported no selectable models" : selectedLabel}
      placeholder="Search models…" autoComplete="off"
      onFocus={() => { setQuery(""); setActiveIndex(0); setOpen(true); }}
      onBlur={() => { setQuery(""); setOpen(false); }}
      onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); setOpen(true); }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true);
          setActiveIndex((current) => filtered.length === 0 ? 0 : (current + 1) % filtered.length); }
        if (event.key === "ArrowUp") { event.preventDefault(); setOpen(true);
          setActiveIndex((current) => filtered.length === 0 ? 0 : (current - 1 + filtered.length) % filtered.length); }
        if (event.key === "Enter" && open && filtered[activeIndex] !== undefined) {
          event.preventDefault(); choose(filtered[activeIndex]);
        }
        if (event.key === "Escape") { event.preventDefault(); setQuery(""); setOpen(false); inputRef.current?.blur(); }
      }} />
    {open && <div className="model-options" id={listboxId} role="listbox" aria-label={`${roleLabel} model results`}>
      {filtered.length === 0 ? <p>No models match “{query}”</p> : filtered.map((option, optionIndex) =>
        <button id={`${listboxId}-${String(optionIndex)}`} type="button" role="option" key={option.id}
          aria-selected={option.id === (value ?? "")} className={optionIndex === activeIndex ? "active" : ""}
          onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveIndex(optionIndex)}
          onClick={() => choose(option)}><span>{option.label}</span>
          {option.id === (value ?? "") && <b aria-hidden="true">✓</b>}</button>) }
    </div>}
  </div>;
}

/**
 * Shared editor for the built-in role profiles. Settings edits the saved defaults with it; the workflow builder
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
        <div className="role-field"><span>Model</span><ModelPicker roleLabel={ROLE_LABELS[profile.role]}
          value={profile.modelId} models={models} onChange={(modelId) => onChange(index, { modelId })} /></div>
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
