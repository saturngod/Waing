import { useEffect, useState } from "react";
import type { AgentDescriptor, RoleExecutionProfile } from "@waing/domain";
import { RoleProfileGrid } from "./RoleProfileGrid";
import { PROVIDER_STATUS_HINT, providerDotState, providerStatusLabel } from "./providerStatus";

export function SettingsPanel({ agents, eventCount, onRolesSaved }: {
  agents: AgentDescriptor[]; eventCount: number; onRolesSaved: (needsReview: boolean) => void;
}) {
  const [exportedPath, setExportedPath] = useState<string>();
  const [profiles, setProfiles] = useState<RoleExecutionProfile[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void window.waing.settings.roles().then((view) => setProfiles(view.profiles))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load role settings"));
  }, []);

  function update(index: number, patch: Partial<RoleExecutionProfile>): void {
    setDirty(true); setSaved(false);
    setProfiles((current) => current.map((profile, item) => item === index ? { ...profile, ...patch } : profile));
  }
  async function save(): Promise<void> {
    setError(undefined);
    try {
      const view = await window.waing.settings.saveRoles(profiles);
      setProfiles(view.profiles); setDirty(false); setSaved(true); onRolesSaved(view.needsReview);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save role settings"); }
  }
  async function exportDiagnostics(): Promise<void> {
    const path = await window.waing.diagnostics.export(); if (path !== null) setExportedPath(path);
  }

  // The page title lives in the workspace topbar, so the panel starts straight at its first card.
  return <section className="settings-panel" aria-label="Settings">
    <article className="roles-settings" aria-label="Role routing">
      <div className="roles-heading">
        <div><h3>Roles & routing</h3>
          <p>Auto routing classifies each task, then runs it with the provider you assign to that role here.</p></div>
        <div className="roles-actions">
          {saved && !dirty && <span>Saved</span>}
          <button className="primary" type="button" disabled={!dirty || profiles.length === 0} onClick={() => void save()}>
            {dirty ? "Save routing" : "Saved"}
          </button>
        </div>
      </div>
      {profiles.length === 0 ? <p>Loading roles…</p> : <RoleProfileGrid profiles={profiles} agents={agents} onChange={update} />}
      {error !== undefined && <p className="error" role="alert">{error}</p>}
    </article>
    <div className="settings-grid">
      <article><h3>General</h3><label>Theme<select defaultValue="system"><option>system</option><option>dark</option><option>light</option></select></label>
        <label>Updates<select defaultValue="manual"><option>manual</option><option>notify</option></select></label></article>
      <article className="provider-settings"><h3 title={PROVIDER_STATUS_HINT}>Provider status</h3>{agents.map((agent) => <div key={agent.id}>
        <span className={`provider-dot ${providerDotState(agent)}`}/><strong>{agent.displayName}</strong>
        <small>{providerStatusLabel(agent)}</small>
        {agent.warnings.map((warning) => <em key={warning}>{warning}</em>)}
      </div>)}</article>
      <article><h3>Permissions</h3><p>Default: Ask before changes</p><button type="button">Clear remembered permissions</button></article>
      <article><h3>Diagnostics</h3><p>Normalized events this session: {eventCount}</p><p>Protocol trace: Off</p>
        <button type="button" onClick={() => void exportDiagnostics()}>Export redacted diagnostics</button>
        {exportedPath !== undefined && <p>Saved to {exportedPath}</p>}</article>
    </div>
  </section>;
}
