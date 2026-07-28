import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { AgentDescriptor, AgentModelDescriptor, RoleExecutionProfile, WorkflowRole } from "@waing/domain";

export const ROLE_LABELS: Record<WorkflowRole, string> = { router: "Router", planning: "Planning", low: "Low", medium: "Medium",
  high: "High", review: "Review", bugfix: "Bug Fix", document: "Document" };

/** Role names alone read as jargon, so each row states what the role is actually for. */
const ROLE_HINTS: Record<WorkflowRole, string> = {
  router: "Classifies the task and picks a role.",
  planning: "Breaks a broad task into steps before editing.",
  low: "Small, well-scoped edits.",
  medium: "Everyday feature work across a few files.",
  high: "Large or risky changes needing careful reasoning.",
  review: "Checks another role's output before it lands.",
  bugfix: "Reproduces and repairs a reported defect.",
  document: "Writes docs, comments, and changelogs.",
};

/** Grouping separates the role that dispatches from the roles it dispatches to. */
const ROLE_GROUPS: Array<{ title: string; hint: string; roles: WorkflowRole[] }> = [
  { title: "Dispatcher", hint: "Runs first on every task and decides which role below takes it.", roles: ["router"] },
  { title: "Complexity tiers", hint: "Ordinary coding work goes to one of these, chosen by how demanding the task is.",
    roles: ["low", "medium", "high"] },
  { title: "Specialists", hint: "Picked when the task calls for a particular kind of work instead of a tier.",
    roles: ["planning", "review", "bugfix", "document"] },
];

const EFFORT_OPTIONS: Array<[NonNullable<RoleExecutionProfile["effort"]>, string]> = [
  ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["max", "Max"]];
const MODE_OPTIONS: Array<[NonNullable<RoleExecutionProfile["mode"]>, string]> = [
  ["execute", "Execute"], ["plan", "Plan"], ["review", "Review"], ["investigate", "Investigate"]];
const PERMISSION_OPTIONS: Array<[string, string]> = [["read_only", "Read only"], ["ask_before_changes", "Ask changes"],
  ["auto_edit", "Auto edit"], ["autonomous", "Autonomous"]];

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
          {option.id === (value ?? "") && <Check size={15} aria-hidden="true" />}</button>) }
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
  // Profiles arrive in storage order; rows are regrouped for reading, keeping each profile's index for onChange.
  const groups = useMemo(() => {
    const pending = new Map(profiles.map((profile, index) => [profile.role, { index, profile }]));
    const known = ROLE_GROUPS.map((group) => ({ title: group.title, hint: group.hint,
      rows: group.roles.flatMap((role) => {
        const row = pending.get(role);
        if (row === undefined) return [];
        pending.delete(role); return [row];
      }) })).filter((group) => group.rows.length > 0);
    // A role added to the domain but not listed above still needs an editor rather than silently vanishing.
    return pending.size === 0 ? known
      : [...known, { title: "Other roles", hint: "Roles this build does not group yet.", rows: [...pending.values()] }];
  }, [profiles]);

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

  return <div className="role-table-wrap">
    <table className="role-table">
      {/* Stating the five field names once, above aligned columns, replaces repeating them on every role. */}
      <thead><tr><th scope="col">Role</th><th scope="col">Agent</th><th scope="col">Model</th>
        <th scope="col">Effort</th><th scope="col">Mode</th><th scope="col">Permissions</th></tr></thead>
      {groups.map((group) => <tbody key={group.title}>
        <tr className="role-group"><th colSpan={6} scope="colgroup">
          <strong>{group.title}</strong><span>{group.hint}</span></th></tr>
        {group.rows.map(({ index, profile }) => {
          const label = ROLE_LABELS[profile.role];
          const models = modelsByAgent[profile.agentId] ?? [];
          return <tr key={profile.role}>
            <th scope="row"><div><strong>{label}</strong><span>{ROLE_HINTS[profile.role]}</span></div></th>
            {/* Switching provider invalidates any model chosen for the previous one, so the model resets with it. */}
            <td data-label="Agent"><select value={profile.agentId} aria-label={`${label} agent`}
              onChange={(event) => onChange(index, { agentId: event.target.value, modelId: undefined })}>
              {agents.some((agent) => agent.id === profile.agentId) ? null : <option value={profile.agentId}>{profile.agentId} (not installed)</option>}
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.displayName}</option>)}
            </select></td>
            <td data-label="Model"><ModelPicker roleLabel={label}
              value={profile.modelId} models={models} onChange={(modelId) => onChange(index, { modelId })} /></td>
            <td data-label="Effort"><select value={profile.effort ?? "medium"} aria-label={`${label} effort`}
              onChange={(event) => onChange(index, { effort: event.target.value as RoleExecutionProfile["effort"] })}>
              {EFFORT_OPTIONS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select></td>
            <td data-label="Mode"><select value={profile.mode ?? "execute"} aria-label={`${label} mode`}
              onChange={(event) => onChange(index, { mode: event.target.value as RoleExecutionProfile["mode"] })}>
              {MODE_OPTIONS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select></td>
            <td data-label="Permissions"><select value={profile.permissionProfileId ?? "ask_before_changes"}
              aria-label={`${label} permissions`}
              onChange={(event) => onChange(index, { permissionProfileId: event.target.value })}>
              {PERMISSION_OPTIONS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select></td>
          </tr>;
        })}
      </tbody>)}
    </table>
  </div>;
}
