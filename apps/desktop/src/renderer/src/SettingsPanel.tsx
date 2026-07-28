import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowLeft, Search, Server, Settings2, Workflow } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AgentDescriptor, RoleExecutionProfile } from "@waing/domain";
import { RoleProfileGrid } from "./RoleProfileGrid";
import { PROVIDER_STATUS_HINT, providerDotState, providerStatusLabel } from "./providerStatus";

type SettingsSection = "general" | "routing" | "providers" | "diagnostics";

const SETTINGS_SECTIONS: Array<{ id: SettingsSection; label: string; icon: LucideIcon; keywords: string }> = [
  { id: "general", label: "General", icon: Settings2, keywords: "theme appearance updates" },
  // Permissions are set per role here, so a search for them lands on this page rather than a screen of its own.
  { id: "routing", label: "Roles & routing", icon: Workflow, keywords: "agents models effort mode workflow auto permissions access approvals" },
  { id: "providers", label: "Providers", icon: Server, keywords: "codex claude opencode antigravity status health" },
  { id: "diagnostics", label: "Diagnostics", icon: Activity, keywords: "events logs export troubleshooting" },
];

export function SettingsPanel({ agents, eventCount, theme, onThemeChange, onRolesSaved, onBack }: {
  agents: AgentDescriptor[]; eventCount: number; theme: "system" | "dark" | "light";
  onThemeChange: (theme: "system" | "dark" | "light") => void;
  onRolesSaved: (needsReview: boolean) => void; onBack: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>("general");
  const [search, setSearch] = useState("");
  const [exportedPath, setExportedPath] = useState<string>();
  const [profiles, setProfiles] = useState<RoleExecutionProfile[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveAttempt, setSaveAttempt] = useState(0);
  const [error, setError] = useState<string>();
  const saveRevision = useRef(0);
  const visibleSections = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return query.length === 0 ? SETTINGS_SECTIONS : SETTINGS_SECTIONS.filter((item) =>
      `${item.label} ${item.keywords}`.toLocaleLowerCase().includes(query));
  }, [search]);

  useEffect(() => {
    void window.waing.settings.roles().then((view) => setProfiles(view.profiles))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load role settings"));
  }, []);

  useEffect(() => {
    if (!dirty || profiles.length === 0) return;
    const revision = ++saveRevision.current;
    const timeout = window.setTimeout(() => {
      setSaving(true); setError(undefined);
      void window.waing.settings.saveRoles(profiles).then((view) => {
        if (revision !== saveRevision.current) return;
        setProfiles(view.profiles); setDirty(false); setSaving(false); onRolesSaved(view.needsReview);
      }).catch((reason: unknown) => {
        if (revision !== saveRevision.current) return;
        setSaving(false);
        setError(reason instanceof Error ? reason.message : "Could not save role settings");
      });
    }, 400);
    return () => window.clearTimeout(timeout);
  }, [dirty, onRolesSaved, profiles, saveAttempt]);

  function update(index: number, patch: Partial<RoleExecutionProfile>): void {
    setDirty(true); setError(undefined);
    setProfiles((current) => current.map((profile, item) => item === index ? { ...profile, ...patch } : profile));
  }
  async function exportDiagnostics(): Promise<void> {
    const path = await window.waing.diagnostics.export(); if (path !== null) setExportedPath(path);
  }
  function navigate(next: SettingsSection): void { setSection(next); setSearch(""); }

  return <section className="settings-panel" aria-label="Settings">
    <aside className="settings-sidebar">
      <button className="settings-back" type="button" onClick={onBack}><ArrowLeft size={16} /> Back to app</button>
      <label className="settings-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label="Search settings"
        placeholder="Search settings…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <p className="settings-group-label">Waing</p>
      <nav aria-label="Settings categories">{visibleSections.map((item) => <button type="button" key={item.id}
        className={section === item.id && search.length === 0 ? "active" : ""} onClick={() => navigate(item.id)}>
        <item.icon size={16} aria-hidden="true" />{item.label}</button>)}</nav>
      {visibleSections.length === 0 && <p className="settings-no-results">No settings found</p>}
    </aside>
    <div className="settings-page">
      {section === "general" && <><header><p>Settings</p><h2>General</h2></header>
        <div className="settings-section"><h3>Appearance</h3><div className="settings-card settings-rows">
          <label><span><strong>Theme</strong><small>Choose how Waing looks on this device.</small></span>
            <select aria-label="Theme" value={theme} onChange={(event) =>
              onThemeChange(event.target.value as "system" | "dark" | "light")}>
              <option>system</option><option>dark</option><option>light</option></select></label>
          <label><span><strong>Updates</strong><small>Control how application updates are announced.</small></span>
            <select defaultValue="manual"><option>manual</option><option>notify</option></select></label>
        </div></div></>}

      {section === "routing" && <><header className="wide"><p>Settings</p><h2>Roles & routing</h2>
        <span>Choose which provider and model handles each kind of work.</span></header>
        <div className="settings-section routing-settings"><div className="settings-section-heading"><h3>Role assignments</h3>
          <span className="settings-save-status" role="status" aria-live="polite">{saving ? "Saving…" : ""}</span></div>
          {profiles.length === 0 ? <p>Loading roles…</p> : <RoleProfileGrid profiles={profiles} agents={agents} onChange={update} />}
          {error !== undefined && <div className="settings-save-error" role="alert"><p>{error}</p>
            {dirty && <button type="button" onClick={() => setSaveAttempt((attempt) => attempt + 1)}>Retry</button>}</div>}
        </div></>}

      {section === "providers" && <><header><p>Settings</p><h2>Providers</h2><span>Installed coding agents and their current availability.</span></header>
        <div className="settings-section"><h3 title={PROVIDER_STATUS_HINT}>Provider status</h3><div className="settings-card provider-settings">
          {agents.map((agent) => <div key={agent.id}><span className={`provider-dot ${providerDotState(agent)}`}/>
            <strong>{agent.displayName}</strong><small>{providerStatusLabel(agent)}</small>
            {agent.warnings.map((warning) => <em key={warning}>{warning}</em>)}</div>)}</div></div></>}

      {section === "diagnostics" && <><header><p>Settings</p><h2>Diagnostics</h2><span>Inspect and export provider-neutral troubleshooting data.</span></header>
        <div className="settings-section"><h3>Session diagnostics</h3><div className="settings-card settings-rows">
          <div><span><strong>Normalized events</strong><small>Events received during this app session.</small></span><b>{eventCount}</b></div>
          <div><span><strong>Redacted export</strong><small>Create a diagnostics file with known secrets removed.</small></span>
            <button type="button" onClick={() => void exportDiagnostics()}>Export diagnostics</button></div>
        </div>{exportedPath !== undefined && <p className="settings-exported">Saved to {exportedPath}</p>}</div></>}
    </div>
  </section>;
}
