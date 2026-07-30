import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import type { AgentDescriptor, AgentProfile, RouterSettings } from "@waing/domain";
import type { ProviderModelSelection } from "./ModelPicker";
import { ProviderModelFields } from "./ModelPicker";

const permissions = [["read_only", "Read only"], ["ask_before_changes", "Ask changes"], ["auto_edit", "Auto edit"], ["autonomous", "Autonomous"]];

export function AgentsSettings({ profiles, router, agents, onProfilesChange, onRouterChange }: { profiles: AgentProfile[]; router: RouterSettings;
  agents: AgentDescriptor[]; onProfilesChange: (profiles: AgentProfile[]) => void; onRouterChange: (router: RouterSettings) => void }) {
  const [editing, setEditing] = useState<string>(); const [confirmDelete, setConfirmDelete] = useState<string>();
  const sorted = useMemo(() => [...profiles].sort((a, b) => a.position - b.position), [profiles]);
  function patch(id: string, update: Partial<AgentProfile>): void { onProfilesChange(profiles.map((profile) => profile.id === id ? { ...profile, ...update } : profile)); }
  function replaceExecution(id: string, selection: ProviderModelSelection): void {
    onProfilesChange(profiles.map((profile) => {
      if (profile.id !== id) return profile;
      const next = { ...profile, agentId: selection.agentId };
      delete next.modelId; delete next.effort;
      if (selection.modelId !== undefined) next.modelId = selection.modelId;
      if (selection.effort !== undefined) next.effort = selection.effort;
      return next;
    }));
  }
  function move(id: string, direction: -1 | 1): void { const items = [...sorted]; const from = items.findIndex((item) => item.id === id); const to = from + direction; if (from < 0 || to < 0 || to >= items.length) return;
    [items[from], items[to]] = [items[to]!, items[from]!]; onProfilesChange(items.map((item, position) => ({ ...item, position }))); }
  function create(): void { const base = "agent"; let id = base; let suffix = 2; while (profiles.some((profile) => profile.id === id)) id = `${base}-${suffix++}`;
    const profile: AgentProfile = { id, name: "New Agent", whereToUse: "Describe when the router should use this agent.", enabled: true,
      agentId: agents.find((agent) => agent.available)?.id ?? agents[0]?.id ?? "codex", effort: "medium", permissionProfileId: "ask_before_changes", position: profiles.length };
    onProfilesChange([...profiles, profile]); setEditing(id); }
  return <>
    <div className="settings-card router-card"><div className="router-card-heading"><strong>Router</strong><small>Chooses which agent handles the next step.</small></div>
      <ProviderModelFields label="Router" value={{ agentId: router.agentId,
        ...(router.modelId === undefined ? {} : { modelId: router.modelId }),
        ...(router.effort === undefined ? {} : { effort: router.effort }) }} agents={agents} onChange={onRouterChange} /></div>
    <div className="settings-section-heading agent-list-heading"><h3>Agents</h3><button className="primary" type="button" onClick={create}><Plus size={14}/> New agent</button></div>
    <div className="agent-list">{sorted.map((profile, index) => <div className="agent-row" key={profile.id}>
      <div><strong>{profile.name}</strong><small>{profile.whereToUse}</small></div><span>{profile.modelId ?? "Provider default"} · {agents.find((agent) => agent.id === profile.agentId)?.displayName ?? profile.agentId}</span>
      <span>{profile.effort ?? "Default"}</span><span>{permissions.find(([id]) => id === profile.permissionProfileId)?.[1] ?? "Ask changes"}</span>
      <div className="agent-actions"><button type="button" aria-label={`Move ${profile.name} up`} disabled={index === 0} onClick={() => move(profile.id, -1)}><ArrowUp size={13}/></button>
        <button type="button" aria-label={`Move ${profile.name} down`} disabled={index === sorted.length - 1} onClick={() => move(profile.id, 1)}><ArrowDown size={13}/></button>
        <button type="button" onClick={() => setEditing(editing === profile.id ? undefined : profile.id)}>Edit</button>
        {confirmDelete === profile.id ? <><button className="danger" type="button" onClick={() => onProfilesChange(profiles.filter((item) => item.id !== profile.id))}>Confirm</button><button type="button" onClick={() => setConfirmDelete(undefined)}>Cancel</button></>
          : <button type="button" onClick={() => setConfirmDelete(profile.id)}>Delete</button>}</div>
      {editing === profile.id && <div className="agent-editor">
        <label>Name<input maxLength={40} value={profile.name} onChange={(event) => patch(profile.id, { name: event.target.value })}/></label>
        <label>Where to use<input maxLength={200} value={profile.whereToUse} onChange={(event) => patch(profile.id, { whereToUse: event.target.value })}/><small>This is the only text the router reads. Keep it one line. {profile.whereToUse.length}/200</small></label>
        <label>Instructions<textarea maxLength={4000} rows={4} value={profile.instructions ?? ""} onChange={(event) => patch(profile.id, { instructions: event.target.value || undefined })}/></label>
        <ProviderModelFields label={profile.name} value={{ agentId: profile.agentId,
          ...(profile.modelId === undefined ? {} : { modelId: profile.modelId }),
          ...(profile.effort === undefined ? {} : { effort: profile.effort }) }} agents={agents} onChange={(selection) => replaceExecution(profile.id, selection)} />
        <label>Permission<select value={profile.permissionProfileId ?? "ask_before_changes"} onChange={(event) => patch(profile.id, { permissionProfileId: event.target.value })}>{permissions.map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select></label>
        <label className="agent-enabled"><input type="checkbox" checked={profile.enabled} onChange={(event) => patch(profile.id, { enabled: event.target.checked })}/> Enabled</label>
      </div>}
    </div>)}</div>
  </>;
}
