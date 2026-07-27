import { useEffect, useMemo, useRef, useState } from "react";
import type { AppInfo, SessionSendResult } from "@waing/ipc-contracts";
import type { AgentDescriptor, AgentEvent, AppConversation, AutoSelection, PermissionRequest, Project, StepAnnouncement } from "@waing/domain";
import { ActivityTimeline } from "./ActivityTimeline";
import type { TimelineStep } from "./ActivityTimeline";
import { RoutingDecisionCard } from "./RoutingDecisionCard";
import { SettingsPanel } from "./SettingsPanel";
import { PROVIDER_DOT_TITLES, providerDotState } from "./providerStatus";

type View = "chat" | "settings";

const tokenFormat = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const compactTokens = (value: number): string => tokenFormat.format(value);

/** Turns the newest still-pending step into its resolved form, so a router chip is not duplicated. */
function replaceLast(steps: TimelineStep[], state: TimelineStep["state"], resolved: TimelineStep): TimelineStep[] {
  const index = steps.map((step) => step.state).lastIndexOf(state);
  if (index < 0) return [...steps, resolved];
  return steps.map((step, position) => position === index ? resolved : step);
}

export function App() {
  const [info, setInfo] = useState<AppInfo>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [conversations, setConversations] = useState<AppConversation[]>([]);
  const [error, setError] = useState<string>();
  const [permission, setPermission] = useState<PermissionRequest>();
  const [lastEvent, setLastEvent] = useState<AgentEvent["type"]>();
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [agents, setAgents] = useState<AgentDescriptor[]>([]);
  const [task, setTask] = useState("");
  const [prompt, setPrompt] = useState<string>();
  const [routing, setRouting] = useState<AutoSelection>();
  const [routingBusy, setRoutingBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [resolvedAgentId, setResolvedAgentId] = useState<string>();
  const [resolvedModel, setResolvedModel] = useState<string>();
  const [resolvedEffort, setResolvedEffort] = useState<string>();
  const [routerStep, setRouterStep] = useState<"idle" | "running" | "failed">("idle");
  const [routedBy, setRoutedBy] = useState<SessionSendResult["routing"]>();
  const [workflowSteps, setWorkflowSteps] = useState<TimelineStep[]>([]);
  const [agentMeta, setAgentMeta] = useState<Record<string, string>>({});
  const [activeStep, setActiveStep] = useState<StepAnnouncement>();
  const [openConversationId, setOpenConversationId] = useState<string>();
  const [replayText, setReplayText] = useState<string>();
  const [menuFor, setMenuFor] = useState<{ id: string; x: number; y: number }>();
  const [view, setView] = useState<View>("chat");
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [routingNeedsReview, setRoutingNeedsReview] = useState(false);

  useEffect(() => {
    void window.waing.app.info().then(setInfo).catch(reportError);
    void window.waing.agents.list().then(setAgents).catch(reportError);
    void window.waing.projects.list().then((existing) => { setProjects(existing); setProject(existing[0] ?? null); }).catch(reportError);
    void window.waing.settings.roles().then((view) => setRoutingNeedsReview(view.needsReview)).catch(reportError);
    const unsubscribeSession = window.waing.sessions.onEvent((event) => {
      setLastEvent(event.type);
      setEvents((current) => [...current, event]);
      if (event.type === "permission.requested") setPermission(event.request);
      if (event.type === "permission.resolved") setPermission(undefined);
      // A workflow keeps running past a single step's terminal event, so only its own events clear the busy state.
      if ((event.type === "run.completed" || event.type === "run.failed") && event.workflowRunId === undefined) setSendBusy(false);
    });
    const unsubscribeWorkflow = window.waing.workflows.onEvent((event) => {
      if (event.type === "workflow.started") { setActiveSessionId(event.workflowRunId); setRouterStep("idle"); }
      if (event.type === "workflow.router.started") {
        setWorkflowSteps((current) => [...current, { id: `router-${String(current.length)}`, title: "Routing",
          detail: "Deciding the next step…", state: "pending" }]);
      }
      if (event.type === "workflow.router.decided") {
        const { decision, resolvedRole, resolvedAgentId: nextAgentId, resolvedModelId } = event.record;
        setWorkflowSteps((current) => replaceLast(current, "pending", { id: `router-${String(current.length)}`,
          title: decision.action === "complete" ? "Router: done" : `Router: ${decision.action.replaceAll("_", " ")}`, state: "done",
          detail: [resolvedRole, nextAgentId, resolvedModelId, `${String(Math.round(decision.confidence * 100))}%`]
            .filter((part) => part !== undefined).join(" · ") }));
      }
      if (event.type === "workflow.step.announced") {
        const { announcement } = event; setActiveStep(announcement);
        if (announcement.role !== "router") {
          setAgentMeta((current) => ({ ...current, [announcement.agentId]:
            [announcement.modelDisplayName ?? announcement.modelId, announcement.effort].filter((part) => part !== undefined).join(" · ") }));
          setWorkflowSteps((current) => [...current, { id: announcement.stepRunId, title: announcement.message,
            detail: [announcement.agentDisplayName, announcement.modelDisplayName ?? announcement.modelId, announcement.effort]
              .filter((part) => part !== undefined).join(" · "), state: "pending" }]);
        }
      }
      if (event.type === "workflow.node.completed") {
        setWorkflowSteps((current) => current.map((step) => step.id === event.stepRunId ? { ...step, state: "done" } : step));
      }
      if (event.type === "workflow.review.completed") {
        setWorkflowSteps((current) => [...current, { id: `review-${String(current.length)}`,
          title: `Review ${event.verdict === "pass" ? "passed" : "found issues"}`, state: event.verdict === "pass" ? "done" : "failed" }]);
      }
      if (event.type === "workflow.paused") {
        setWorkflowSteps((current) => [...current, { id: `paused-${String(current.length)}`, title: "Paused", detail: event.reason, state: "failed" }]);
      }
      if (event.type === "workflow.failed") {
        setWorkflowSteps((current) => [...current, { id: `failed-${String(current.length)}`, title: "Workflow failed", detail: event.message, state: "failed" }]);
      }
      if (event.type === "workflow.completed" || event.type === "workflow.failed" || event.type === "workflow.cancelled"
        || event.type === "workflow.paused") { setSendBusy(false); setActiveStep(undefined); }
    });
    return () => { unsubscribeSession(); unsubscribeWorkflow(); };
  }, []);

  useEffect(() => {
    setConfirmingRemoval(false);
    if (project === null) { setConversations([]); return; }
    void window.waing.conversations.list(project.id).then(setConversations).catch(reportError);
  }, [project]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  // Streaming appends to the bottom of the transcript, so follow it unless the user scrolled away.
  useEffect(() => {
    const node = scrollRef.current;
    if (node !== null && followRef.current) node.scrollTop = node.scrollHeight;
  }, [events, prompt]);

  const selectedAgent = agents.find((agent) => agent.id === resolvedAgentId);
  const latestDiff = useMemo(() => [...events].reverse().find((event) => event.type === "diff.updated"), [events]);
  // Totals are cumulative within a session, so only each session's newest tick counts — one session per workflow step.
  const usage = useMemo(() => {
    const perSession = new Map<string, { input: number; output: number }>();
    for (const event of events) {
      if (event.type === "usage.updated") perSession.set(event.sessionId, { input: event.inputTokens, output: event.outputTokens });
    }
    return [...perSession.values()].reduce((total, entry) => ({ input: total.input + entry.input, output: total.output + entry.output }),
      { input: 0, output: 0 });
  }, [events]);
  // Everything the inspector shows comes from the running step, or from what the finished run resolved to.
  const modelLabel = activeStep?.modelDisplayName ?? activeStep?.modelId ?? resolvedModel;
  const effortLabel = activeStep?.effort ?? resolvedEffort;
  const providerLabel = activeStep?.agentDisplayName ?? selectedAgent?.displayName ?? "Auto";
  const busyAgentId = sendBusy ? activeStep?.agentId ?? resolvedAgentId : undefined;

  const steps: TimelineStep[] = [...workflowSteps];
  if (routerStep === "running" && workflowSteps.length === 0) steps.push({ id: "router", title: "Routing", detail: "Choosing the role for this task…", state: "pending" });
  if (routerStep === "failed") steps.push({ id: "router-failed", title: "Routing failed", state: "failed" });
  if (routedBy !== undefined) {
    steps.push({ id: "routed", title: `Routed to ${routedBy.role}`, state: "done",
      detail: `${routedBy.routerModelId ?? routedBy.routerAgentId} · ${routedBy.decision.complexity} ${routedBy.decision.taskType} · ${String(Math.round(routedBy.decision.confidence * 100))}%` });
    if (resolvedAgentId !== undefined) steps.push({ id: "picked", title: "Agent", state: "done",
      detail: [selectedAgent?.displayName ?? resolvedAgentId, modelLabel, effortLabel].filter((part) => part !== undefined).join(" · ") });
  }

  function reportError(reason: unknown): void {
    setError(reason instanceof Error ? reason.message : "An unexpected error occurred");
  }

  async function chooseProject(): Promise<void> {
    setError(undefined);
    try {
      const selected = await window.waing.projects.choose();
      if (selected !== null) {
        setProject(selected);
        setProjects((current) => current.some((item) => item.id === selected.id) ? current : [selected, ...current]);
      }
    } catch (reason) {
      reportError(reason);
    }
  }

  function closeProject(): void {
    setProject(null); setConfirmingRemoval(false); setEvents([]); setPrompt(undefined);
    setRouting(undefined); setPermission(undefined); setActiveSessionId(undefined); setResolvedAgentId(undefined);
  }

  async function removeProject(): Promise<void> {
    if (project === null) return;
    setError(undefined);
    try {
      const remaining = await window.waing.projects.remove(project.id);
      setProjects(remaining);
      setConfirmingRemoval(false);
      setProject(remaining[0] ?? null);
      setEvents([]); setRouting(undefined); setPermission(undefined); setPrompt(undefined);
      setActiveSessionId(undefined); setResolvedAgentId(undefined);
    } catch (reason) { setConfirmingRemoval(false); reportError(reason); }
  }

  async function answerPermission(decision: "allow_once" | "allow_session" | "deny"): Promise<void> {
    if (permission === undefined) return;
    try {
      await window.waing.permissions.respond(permission.sessionId, permission.id, decision);
    } catch (reason) { reportError(reason); }
  }

  function clearTranscript(): void {
    setEvents([]); setPrompt(undefined); setWorkflowSteps([]); setAgentMeta({}); setActiveStep(undefined);
    setRouting(undefined); setRoutedBy(undefined); setPermission(undefined); setResolvedAgentId(undefined);
    setResolvedModel(undefined); setResolvedEffort(undefined); setActiveSessionId(undefined); setOpenConversationId(undefined);
  }

  async function openConversation(conversationId: string): Promise<void> {
    if (sendBusy) return;
    setError(undefined); setMenuFor(undefined);
    try {
      const history = await window.waing.conversations.history(conversationId);
      clearTranscript();
      setOpenConversationId(conversationId);
      // Deltas were never persisted, so the replay leans on message.completed events and the stored message rows.
      setPrompt(history.messages.find((message) => message.role === "user")?.content ?? history.conversation.title);
      const replay = history.events.filter((event) => event.type !== "permission.requested");
      setEvents(replay);
      if (!replay.some((event) => event.type === "message.completed")) {
        setReplayText(history.messages.filter((message) => message.role === "assistant").map((message) => message.content).join("\n\n"));
      } else setReplayText(undefined);
      followRef.current = true;
    } catch (reason) { reportError(reason); }
  }

  async function removeConversation(conversationId: string): Promise<void> {
    if (project === null) return;
    setError(undefined); setMenuFor(undefined);
    try {
      setConversations(await window.waing.conversations.remove(conversationId, project.id));
      if (openConversationId === conversationId) { clearTranscript(); setReplayText(undefined); }
    } catch (reason) { reportError(reason); }
  }

  async function previewRoute(): Promise<void> {
    if (project === null || task.trim().length === 0) return;
    setError(undefined); setRoutingBusy(true);
    try { setRouting(await window.waing.router.preview(task.trim(), project.id)); }
    catch (reason) { reportError(reason); }
    finally { setRoutingBusy(false); }
  }

  async function sendTask(): Promise<void> {
    if (project === null || task.trim().length === 0) return;
    const text = task.trim();
    setError(undefined); setRouting(undefined); setEvents([]); setPermission(undefined); setSendBusy(true);
    setPrompt(text); setTask(""); setRoutedBy(undefined); setResolvedAgentId(undefined);
    setResolvedModel(undefined); setResolvedEffort(undefined);
    setWorkflowSteps([]); setAgentMeta({}); setActiveStep(undefined); setActiveSessionId(undefined);
    // Routing happens inside the send call, so the step is shown as running until the reply names the routed role.
    setRouterStep("running");
    try {
      // Always Auto: the router picks the role, and that role's saved profile supplies provider, model, and effort.
      const result = await window.waing.sessions.send({ projectId: project.id, text, agentId: "auto", mode: "execute" });
      if (result.session !== undefined) setActiveSessionId(result.session.id);
      setResolvedAgentId(result.resolvedAgentId);
      setResolvedModel(result.resolvedModel); setResolvedEffort(result.resolvedEffort);
      setRoutedBy(result.routing); setRouterStep("idle");
      // A workflow reports its own terminal event; a single agent run is already finished when send resolves.
      if (result.workflowRunId !== undefined) setSendBusy(false);
      setConversations((current) => [result.conversation, ...current.filter((item) => item.id !== result.conversation.id)]);
    } catch (reason) {
      setSendBusy(false); setPrompt(undefined); setTask(text);
      setRouterStep((current) => current === "running" ? "failed" : "idle");
      reportError(reason);
    }
  }

  async function cancelRun(): Promise<void> {
    if (activeSessionId === undefined) return;
    try { await window.waing.sessions.cancel(activeSessionId); }
    catch (reason) { reportError(reason); }
  }

  return (
    <main className={`app-shell ${view === "settings" ? "settings" : ""}`}>
      <aside className="rail">
        <div className="brand">W</div>
        <nav aria-label="Primary navigation">
          <button className={`nav-item ${view === "chat" ? "active" : ""}`} aria-label="Workspace" onClick={() => setView("chat")}>⌂</button>
          <button className={`nav-item ${view === "settings" ? "active" : ""}`} aria-label="Settings" onClick={() => setView("settings")}>⚙</button>
        </nav>
      </aside>
      {/* Settings are global, so the project and conversation rail is hidden there rather than implying a scope. */}
      {view === "chat" && <aside className="context-sidebar">
        <div className="app-title"><h1>Waing</h1><span data-testid="version">{info === undefined ? "…" : `v${info.version}`}</span></div>
        <button className="project-picker" type="button" onClick={() => void chooseProject()}>
          <span className="project-glyph">{project?.name.slice(0, 1).toUpperCase() ?? "+"}</span>
          <span><strong>{project?.name ?? "Open project"}</strong><small>{project?.root ?? "Choose a local repository"}</small></span><b>⌄</b>
        </button>
        {projects.length > 1 && <select className="project-select" aria-label="Current project" value={project?.id ?? ""}
          onChange={(event) => setProject(projects.find((item) => item.id === event.target.value) ?? null)}>
          {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>}
        {project !== null && <div className="project-actions">
          {confirmingRemoval ? <>
            <span>Remove {project.name} and its local history?</span>
            <button type="button" onClick={() => setConfirmingRemoval(false)}>Cancel</button>
            <button className="danger" type="button" onClick={() => void removeProject()}>Confirm remove</button>
          </> : <>
            <button type="button" onClick={closeProject}>Close project</button>
            <button type="button" disabled={sendBusy} title={sendBusy ? "Stop the running task first" : undefined}
              onClick={() => setConfirmingRemoval(true)}>Remove…</button>
          </>}
        </div>}
        <div className="sidebar-heading"><span>Conversations</span><button type="button" aria-label="New conversation"
          onClick={() => { clearTranscript(); setReplayText(undefined); setTask(""); }}>＋</button></div>
        <div className="conversation-list">{conversations.length === 0 ? <p>No conversations yet</p> : conversations.map((conversation) =>
          <button type="button" key={conversation.id} className={openConversationId === conversation.id ? "active" : ""}
            disabled={sendBusy} title={sendBusy ? "Stop the running task first" : conversation.title}
            onClick={() => void openConversation(conversation.id)}
            onContextMenu={(event) => { event.preventDefault(); setMenuFor({ id: conversation.id, x: event.clientX, y: event.clientY }); }}>
            <span>{conversation.title}</span><small>{new Date(conversation.updatedAt).toLocaleDateString()}</small></button>)}</div>
        {menuFor !== undefined && <>
          <div className="menu-backdrop" onClick={() => setMenuFor(undefined)} onContextMenu={(event) => { event.preventDefault(); setMenuFor(undefined); }} />
          <div className="context-menu" style={{ left: menuFor.x, top: menuFor.y }} role="menu" aria-label="Conversation actions">
            <button type="button" role="menuitem" className="danger" onClick={() => void removeConversation(menuFor.id)}>Delete conversation</button>
          </div>
        </>}
        <div className="sidebar-version">{info === undefined ? "Starting…" : `${info.name} · ${info.platform}`}</div>
      </aside>}
      <section className="workspace">
        <header className="topbar">
          {view === "chat"
            ? <div><p className="eyebrow">Agent workspace</p><h2>{project?.name ?? "No project selected"}</h2></div>
            : <div><p className="eyebrow">Applies to every project</p><h2>Settings</h2></div>}
          {/* No per-send agent/model/mode pickers: routing always decides, and Settings owns each role's provider. */}
          {/* A run keeps going while Settings is open, so its state and Stop stay reachable from here. */}
          {view === "settings" && <div className="run-strip">
            {permission !== undefined && <>
              {/* An unanswered approval blocks the provider, and the card itself only exists in the chat view. */}
              <span className="run-pill waiting">Permission needed · {permission.title}</span>
              <button className="primary" type="button" onClick={() => setView("chat")}>Review</button>
            </>}
            {permission === undefined && sendBusy && <>
              <span className="run-pill"><span className="provider-dot busy" />{activeStep?.message ?? "Task running"}</span>
              <button className="stop" type="button" onClick={() => void cancelRun()}>Stop</button>
              <button type="button" onClick={() => setView("chat")}>Open chat</button>
            </>}
          </div>}
        </header>
        {routingNeedsReview && <div className="routing-banner" role="status">
          <span>Auto routing is using defaults built from your installed providers.</span>
          <button type="button" onClick={() => { setView("settings"); }}>Review setup</button>
          <button className="dismiss" type="button" aria-label="Dismiss routing setup notice"
            onClick={() => { setRoutingNeedsReview(false); void window.waing.settings.acknowledgeRouting().catch(reportError); }}>✕</button>
        </div>}
        <div className="content-scroll" ref={scrollRef} onScroll={(event) => {
          const node = event.currentTarget;
          followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}>
          {view === "settings" ? <SettingsPanel agents={agents} eventCount={events.length}
            onRolesSaved={(needsReview) => setRoutingNeedsReview(needsReview)} /> :
            <><ActivityTimeline events={events} steps={steps} agentMeta={agentMeta} {...(prompt === undefined ? {} : { prompt })}
              {...(replayText === undefined || replayText.length === 0 ? {} : { replayText })}
              {...(modelLabel === undefined ? {} : { model: modelLabel })} {...(effortLabel === undefined ? {} : { effort: effortLabel })} />
              {routing !== undefined && <RoutingDecisionCard selection={routing} />}
              {permission !== undefined && <section className={`permission-card ${permission.risk}`} aria-label="Permission request">
                <div className="permission-heading"><span className={`risk ${permission.risk}`}>{permission.risk} risk</span><span>{permission.agentId}</span></div>
                <h3>{permission.title}</h3><p>{permission.detail}</p>
                {permission.kind === "destructive" && <p className="destructive-warning">This action may be irreversible. Review every target before allowing it.</p>}
                {permission.command !== undefined && <code>{permission.command.join(" ")}</code>}
                {permission.paths?.map((path) => <code key={path}>{path}</code>)}
                <div className="permission-actions"><button type="button" onClick={() => void answerPermission("deny")}>Deny</button>
                  <button type="button" onClick={() => void answerPermission("allow_once")}>Allow once</button>
                  {permission.kind !== "destructive" && <button type="button" onClick={() => void answerPermission("allow_session")}>Allow for session</button>}</div>
              </section>}</>}
          {error !== undefined && <p className="error" role="alert">{error}</p>}
          {lastEvent !== undefined && <output data-testid="last-event">{lastEvent}</output>}
        </div>
        {view === "chat" && <div className="composer-wrap">
          <div className="composer"><textarea aria-label="Message" value={task} onChange={(event) => setTask(event.target.value)}
            placeholder="Ask an agent to inspect, explain, or change this project…" rows={3}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void sendTask(); }} />
            <div><span>{project?.root ?? "Choose a project to begin"}</span><div className="composer-actions">
              <button type="button" disabled={routingBusy || project === null || task.trim().length === 0} onClick={() => void previewRoute()}>{routingBusy ? "Routing…" : "Preview route"}</button>
              {sendBusy ? <button className="stop" type="button" onClick={() => void cancelRun()}>Stop</button> :
                <button className="send" type="button" disabled={project === null || task.trim().length === 0} onClick={() => void sendTask()}>Send ↵</button>}
            </div></div></div>
        </div>}
      </section>
      {view === "chat" && <aside className="inspector">
        <section><p className="eyebrow">Run details</p><dl><div><dt>Status</dt><dd>{sendBusy ? "Running" : lastEvent === undefined ? "Ready" : lastEvent}</dd></div>
          <div><dt>Provider</dt><dd>{providerLabel}</dd></div>
          <div><dt>Model</dt><dd>{modelLabel ?? "Provider default"}</dd></div>
          <div><dt>Effort</dt><dd>{effortLabel ?? "—"}</dd></div>
          {(activeStep?.role ?? routedBy?.role) !== undefined && <div><dt>Role</dt><dd>{activeStep?.role ?? routedBy?.role}</dd></div>}
          {usage.input + usage.output > 0 && <div><dt>Tokens</dt>
            <dd title={`${usage.input.toLocaleString()} in · ${usage.output.toLocaleString()} out`}>
              {compactTokens(usage.input)} in · {compactTokens(usage.output)} out</dd></div>}</dl></section>
        {/* Traffic lights only; versions and detected status live in Settings. */}
        <section><p className="eyebrow">Providers</p><div className="provider-list">{agents.map((agent) => {
          const state = providerDotState(agent, busyAgentId);
          return <div key={agent.id} title={[PROVIDER_DOT_TITLES[state], ...agent.warnings].join("\n")}>
            <span className={`provider-dot ${state}`} aria-label={PROVIDER_DOT_TITLES[state]} role="img" />
            <strong>{agent.displayName}</strong></div>;
        })}</div></section>
        <section className="diff-view"><p className="eyebrow">Latest diff{latestDiff?.type === "diff.updated" &&
          ` · ${String(latestDiff.diff.split("\n").length)} lines`}</p>
          {latestDiff?.type === "diff.updated" ? <pre>{latestDiff.diff}</pre> : <p>No file changes yet.</p>}</section>
      </aside>}
    </main>
  );
}
