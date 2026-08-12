import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowLeft, Bot, Search, Server, Settings2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AgentDescriptor, AgentProfile, OrchestrationMode, RouterSettings } from "@waing/domain";
import { AgentsSettings } from "./AgentsSettings";
import { PROVIDER_STATUS_HINT, providerDotState, providerStatusLabel } from "./providerStatus";

type SettingsSection = "general" | "agents" | "providers" | "diagnostics";

const SETTINGS_SECTIONS: Array<{ id: SettingsSection; label: string; icon: LucideIcon; keywords: string }> = [
  { id: "general", label: "General", icon: Settings2, keywords: "theme appearance updates" },
  // Permissions are set per role here, so a search for them lands on this page rather than a screen of its own.
  { id: "agents", label: "Agents", icon: Bot, keywords: "agents router models effort workflow auto permissions instructions" },
  { id: "providers", label: "Providers", icon: Server, keywords: "codex claude opencode antigravity status health" },
  { id: "diagnostics", label: "Diagnostics", icon: Activity, keywords: "events logs export troubleshooting" },
];

export function SettingsPanel({ agents, eventCount, theme, orchestrationMode, onThemeChange, onOrchestrationModeChange,
  onRolesSaved, onBack }: {
  agents: AgentDescriptor[]; eventCount: number; theme: "system" | "dark" | "light";
  orchestrationMode: OrchestrationMode;
  onThemeChange: (theme: "system" | "dark" | "light") => void;
  onOrchestrationModeChange: (mode: OrchestrationMode) => void;
  onRolesSaved: (needsReview: boolean) => void; onBack: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>("general");
  const [search, setSearch] = useState("");
  const [exportedPath, setExportedPath] = useState<string>();
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [router, setRouter] = useState<RouterSettings>();
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
    void window.waing.settings.agents().then((view) => { setProfiles(view.profiles); setRouter(view.router); })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load agent settings"));
  }, []);

  useEffect(() => {
    if (!dirty || profiles.length === 0 || router === undefined) return;
    const revision = ++saveRevision.current;
    const timeout = window.setTimeout(() => {
      setSaving(true); setError(undefined);
      void window.waing.settings.saveAgents(profiles, router).then((view) => {
        if (revision !== saveRevision.current) return;
        setProfiles(view.profiles); setRouter(view.router); setDirty(false); setSaving(false); onRolesSaved(view.needsReview);
      }).catch((reason: unknown) => {
        if (revision !== saveRevision.current) return;
        setSaving(false);
        setError(reason instanceof Error ? reason.message : "Could not save agent settings");
      });
    }, 400);
    return () => window.clearTimeout(timeout);
  }, [dirty, onRolesSaved, profiles, router, saveAttempt]);

  function updateProfiles(next: AgentProfile[]): void { setDirty(true); setError(undefined); setProfiles(next); }
  function updateRouter(next: RouterSettings): void { setDirty(true); setError(undefined); setRouter(next); }
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

      {section === "agents" && <><header className="wide"><p>Settings</p><h2>Agents</h2>
        <span>Create the roster the router can delegate work to.</span></header>
        <div className="settings-section routing-settings"><div className="settings-section-heading"><h3>Routing</h3>
          <span className="settings-save-status" role="status" aria-live="polite">{saving ? "Saving…" : ""}</span></div>
          {profiles.length === 0 || router === undefined ? <p>Loading agents…</p> : <AgentsSettings profiles={profiles} router={router}
            agents={agents} mode={orchestrationMode} onModeChange={onOrchestrationModeChange}
            onProfilesChange={updateProfiles} onRouterChange={updateRouter} />}
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
