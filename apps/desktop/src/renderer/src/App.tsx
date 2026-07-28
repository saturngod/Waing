import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Clock, CornerDownLeft, FileText, Folder, FolderOpen, Image, MoreHorizontal, PanelLeft, PanelRight,
  Paperclip, Plus, Settings, SquarePen, Trash2, X } from "lucide-react";
import type { AppInfo, AttachmentChoice, ConversationHistory, SessionSendResult } from "@waing/ipc-contracts";
import type { AgentDescriptor, AgentEvent, AgentQuestion, AgentQuestionResponse, AppConversation, PermissionRequest,
  Project, StepAnnouncement, WorkflowSharedState } from "@waing/domain";
import { ActivityTimeline } from "./ActivityTimeline";
import type { TimelineStep } from "./ActivityTimeline";
import { FileMentionList, useFileMentions } from "./FileMentions";
import { QuestionCard } from "./QuestionCard";
import { SettingsPanel } from "./SettingsPanel";
import { PROVIDER_DOT_TITLES, providerDotState } from "./providerStatus";

type View = "chat" | "settings";
type ThemePreference = "system" | "dark" | "light";

const THEME_STORAGE_KEY = "waing.theme";
function savedTheme(): ThemePreference {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === "dark" || value === "light" || value === "system" ? value : "system";
  } catch { return "system"; }
}

const tokenFormat = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const compactTokens = (value: number): string => tokenFormat.format(value);
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
type HistoryMessage = { id: string; role: "user" | "assistant"; content: string };
/** A composed message with nowhere to run yet: either sent immediately, or held until the project's run ends. */
type QueuedMessage = { id: string; text: string; attachments: AttachmentChoice[] };

function visibleHistoryMessages(messages: ConversationHistory["messages"]): HistoryMessage[] {
  return messages.flatMap((message, index) => message.role === "user" || message.role === "assistant"
    ? [{ id: `${message.createdAt}-${message.role}-${String(index)}`, role: message.role, content: message.content }]
    : []);
}

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
  const [conversationsByProject, setConversationsByProject] = useState<Record<string, AppConversation[]>>({});
  const [runningProjectIds, setRunningProjectIds] = useState<Set<string>>(() => new Set());
  const [activeRunByProject, setActiveRunByProject] = useState<Record<string, string>>({});
  const [permissionsByProject, setPermissionsByProject] = useState<Record<string, PermissionRequest>>({});
  const [activeStepByProject, setActiveStepByProject] = useState<Record<string, StepAnnouncement>>({});
  const [error, setError] = useState<string>();
  const [permission, setPermission] = useState<PermissionRequest>();
  const [questionsByProject, setQuestionsByProject] = useState<Record<string, AgentQuestion>>({});
  const [question, setQuestion] = useState<AgentQuestion>();
  const [lastEvent, setLastEvent] = useState<AgentEvent["type"]>();
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [agents, setAgents] = useState<AgentDescriptor[]>([]);
  const [task, setTask] = useState("");
  const [attachments, setAttachments] = useState<AttachmentChoice[]>([]);
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const [queuedByProject, setQueuedByProject] = useState<Record<string, QueuedMessage[]>>({});
  const [prompt, setPrompt] = useState<string>();
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [resolvedAgentId, setResolvedAgentId] = useState<string>();
  const [resolvedModel, setResolvedModel] = useState<string>();
  const [resolvedEffort, setResolvedEffort] = useState<string>();
  const [routerStep, setRouterStep] = useState<"idle" | "running" | "failed">("idle");
  const [routedBy, setRoutedBy] = useState<SessionSendResult["routing"]>();
  const [workflowSteps, setWorkflowSteps] = useState<TimelineStep[]>([]);
  const [agentMeta, setAgentMeta] = useState<Record<string, string>>({});
  const [activeStep, setActiveStep] = useState<StepAnnouncement>();
  // Each project keeps its own plan: a run started while the user was elsewhere must still show its plan on return.
  const [sharedStateByProject, setSharedStateByProject] = useState<Record<string, WorkflowSharedState>>({});
  const [openConversationId, setOpenConversationId] = useState<string>();
  const [historyMessages, setHistoryMessages] = useState<HistoryMessage[]>([]);
  const [replayText, setReplayText] = useState<string>();
  const [menuFor, setMenuFor] = useState<{ id: string; x: number; y: number }>();
  const [projectMenuFor, setProjectMenuFor] = useState<{ id: string; x: number; y: number }>();
  const [view, setView] = useState<View>("chat");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(true);
  const [theme, setTheme] = useState<ThemePreference>(savedTheme);
  const [confirmingRemoval, setConfirmingRemoval] = useState<string>();
  const [routingNeedsReview, setRoutingNeedsReview] = useState(false);
  const selectedProjectIdRef = useRef<string | undefined>(undefined);
  const workflowProjectRef = useRef(new Map<string, string>());
  const pendingTaskTitleRef = useRef(new Map<string, string>());
  const sendBusy = project !== null && runningProjectIds.has(project.id);
  const composerDraft = task.trim().length > 0 || attachments.length > 0;
  const queued = project === null ? [] : queuedByProject[project.id] ?? [];

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      const resolved = theme === "system" ? media.matches ? "dark" : "light" : theme;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };
    apply();
    if (theme === "system") media.addEventListener("change", apply);
    try { window.localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* preference stays session-local */ }
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    void window.waing.app.info().then(setInfo).catch(reportError);
    void window.waing.agents.list().then(setAgents).catch(reportError);
    void window.waing.projects.list().then(async (existing) => {
      setProjects(existing); setProject(existing[0] ?? null);
      const entries = await Promise.all(existing.map(async (item) => [item.id, await window.waing.conversations.list(item.id)] as const));
      setConversationsByProject(Object.fromEntries(entries));
      setConversations(entries[0]?.[1] ?? []);
    }).catch(reportError);
    void window.waing.settings.roles().then((view) => setRoutingNeedsReview(view.needsReview)).catch(reportError);
    const unsubscribeSession = window.waing.sessions.onEvent((event) => {
      if (event.workflowRunId !== undefined) {
        const eventProjectId = workflowProjectRef.current.get(event.workflowRunId);
        if (eventProjectId !== undefined) {
          if (event.type === "permission.requested") {
            setPermissionsByProject((current) => ({ ...current, [eventProjectId]: event.request }));
          } else if (event.type === "permission.resolved") {
            setPermissionsByProject((current) => { const next = { ...current }; delete next[eventProjectId]; return next; });
          } else if (event.type === "question.requested") {
            setQuestionsByProject((current) => ({ ...current, [eventProjectId]: event.question }));
          } else if (event.type === "question.resolved") {
            setQuestionsByProject((current) => { const next = { ...current }; delete next[eventProjectId]; return next; });
          }
          if (eventProjectId !== selectedProjectIdRef.current) return;
        }
      }
      setLastEvent(event.type);
      setEvents((current) => [...current, event]);
      if (event.type === "permission.requested") setPermission(event.request);
      if (event.type === "permission.resolved") setPermission(undefined);
      if (event.type === "question.requested") setQuestion(event.question);
      if (event.type === "question.resolved") setQuestion(undefined);
      // A workflow keeps running past a single step's terminal event, so only its own events clear the busy state.
    });
    const unsubscribeWorkflow = window.waing.workflows.onEvent((event) => {
      workflowProjectRef.current.set(event.workflowRunId, event.projectId);
      if (event.type === "workflow.started") {
        setSharedStateByProject((current) => { const next = { ...current }; delete next[event.projectId]; return next; });
        setRunningProjectIds((current) => new Set(current).add(event.projectId));
        setActiveRunByProject((current) => ({ ...current, [event.projectId]: event.workflowRunId }));
        const now = new Date().toISOString();
        const runningConversation: AppConversation = { id: event.conversationId, projectId: event.projectId,
          title: pendingTaskTitleRef.current.get(event.projectId) ?? "Running task", createdAt: now, updatedAt: now };
        setConversationsByProject((current) => ({ ...current, [event.projectId]: [runningConversation,
          ...(current[event.projectId] ?? []).filter((item) => item.id !== event.conversationId)] }));
        if (event.projectId === selectedProjectIdRef.current) {
          setConversations((current) => [runningConversation, ...current.filter((item) => item.id !== event.conversationId)]);
          setActiveSessionId(event.workflowRunId); setOpenConversationId(event.conversationId); setRouterStep("idle");
        }
      }
      // The inspector reads the running step, so every project keeps its own: coming back to a run started while the
      // user was elsewhere must show that step's provider and model instead of falling back to "Auto".
      if (event.type === "workflow.step.announced") {
        setActiveStepByProject((current) => ({ ...current, [event.projectId]: event.announcement }));
      }
      // Plan, decisions, and open questions belong to the run, not to a step, so they survive every step boundary.
      if (event.type === "workflow.state.updated") {
        setSharedStateByProject((current) => ({ ...current, [event.projectId]: event.sharedState }));
      }
      if (event.type === "workflow.completed" || event.type === "workflow.failed" || event.type === "workflow.cancelled"
        || event.type === "workflow.paused") {
        setActiveStepByProject((current) => { const next = { ...current }; delete next[event.projectId]; return next; });
      }
      const selected = event.projectId === selectedProjectIdRef.current;
      if (!selected) {
        if (event.type === "workflow.completed" || event.type === "workflow.failed" || event.type === "workflow.cancelled"
          || event.type === "workflow.paused") {
          setRunningProjectIds((current) => { const next = new Set(current); next.delete(event.projectId); return next; });
          setActiveRunByProject((current) => { const next = { ...current }; delete next[event.projectId]; return next; });
          void window.waing.conversations.list(event.projectId).then((items) =>
            setConversationsByProject((current) => ({ ...current, [event.projectId]: items }))).catch(reportError);
        }
        return;
      }
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
            `Model: ${announcement.modelDisplayName ?? announcement.modelId ?? "Provider default"} · Effort: ${announcement.effort ?? "Provider default"}` }));
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
        || event.type === "workflow.paused") {
        // The engine only publishes node.completed for a step that succeeded, so a failed or cancelled step leaves
        // its announcement pending forever — and the transcript keeps spinning "Working" long after the run ended.
        setWorkflowSteps((current) => current.map((step) => step.state !== "pending" ? step
          : { ...step, state: event.type === "workflow.completed" ? "done" : "failed" }));
        setRunningProjectIds((current) => { const next = new Set(current); next.delete(event.projectId); return next; });
        setActiveRunByProject((current) => { const next = { ...current }; delete next[event.projectId]; return next; });
        setActiveStep(undefined);
      }
    });
    return () => { unsubscribeSession(); unsubscribeWorkflow(); };
  }, []);

  useEffect(() => {
    selectedProjectIdRef.current = project?.id;
    setConfirmingRemoval(undefined); setProjectMenuFor(undefined);
    if (project === null) { setConversations([]); return; }
    void window.waing.conversations.list(project.id).then((items) => {
      setConversations(items);
      setConversationsByProject((current) => ({ ...current, [project.id]: items }));
    }).catch(reportError);
  }, [project]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const mentions = useFileMentions(project?.id, composerRef, setTask);
  const followRef = useRef(true);
  const runTaskRef = useRef<(target: Project, message: QueuedMessage) => Promise<void>>(null);

  // A queued message runs the moment its project goes idle. Only the selected project drains, because a run
  // writes into the transcript the user is looking at; a background project keeps its queue until reopened.
  useEffect(() => {
    if (project === null || sendBusy) return;
    const [next] = queuedByProject[project.id] ?? [];
    if (next === undefined) return;
    setQueuedByProject((current) => ({ ...current,
      [project.id]: (current[project.id] ?? []).filter((item) => item.id !== next.id) }));
    void runTaskRef.current?.(project, next);
  }, [project, sendBusy, queuedByProject]);

  // Streaming appends to the bottom of the transcript, so follow it unless the user scrolled away.
  useEffect(() => {
    const node = scrollRef.current;
    if (node !== null && followRef.current) node.scrollTop = node.scrollHeight;
  }, [events, prompt]);

  const selectedAgent = agents.find((agent) => agent.id === resolvedAgentId);
  const sharedState = project === null ? undefined : sharedStateByProject[project.id];
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

  function selectProject(nextProject: Project): void {
    if (nextProject.id === project?.id) return;
    clearTranscript(); setReplayText(undefined); setTask(""); setAttachments([]);
    setConversations(conversationsByProject[nextProject.id] ?? []);
    setActiveSessionId(activeRunByProject[nextProject.id]);
    setOpenConversationId(activeRunByProject[nextProject.id]);
    setPermission(permissionsByProject[nextProject.id]);
    setQuestion(questionsByProject[nextProject.id]);
    setActiveStep(activeStepByProject[nextProject.id]);
    setProject(nextProject);
  }

  async function chooseProject(): Promise<Project | null> {
    setError(undefined);
    try {
      const selected = await window.waing.projects.choose();
      if (selected !== null) {
        selectProject(selected);
        setProjects((current) => current.some((item) => item.id === selected.id) ? current : [selected, ...current]);
        const items = await window.waing.conversations.list(selected.id);
        setConversations(items);
        setConversationsByProject((current) => ({ ...current, [selected.id]: items }));
      }
      return selected;
    } catch (reason) {
      reportError(reason);
      return null;
    }
  }

  async function beginNewTask(forProject?: Project): Promise<void> {
    if (forProject !== undefined ? runningProjectIds.has(forProject.id) : sendBusy) return;
    const target = forProject ?? project ?? await chooseProject();
    if (target === null) return;
    setProjectMenuFor(undefined); setConfirmingRemoval(undefined);
    if (target.id !== project?.id) selectProject(target);
    setSharedStateByProject((current) => { const next = { ...current }; delete next[target.id]; return next; });
    clearTranscript(); setReplayText(undefined); setTask(""); setAttachments([]); setError(undefined);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  async function chooseAttachments(): Promise<void> {
    setError(undefined);
    try {
      const choices = await window.waing.attachments.choose();
      setAttachments((current) => [...current, ...choices].slice(0, 10));
      window.requestAnimationFrame(() => composerRef.current?.focus());
    } catch (reason) { reportError(reason); }
  }

  async function addAttachmentFiles(files: readonly File[]): Promise<void> {
    const availableSlots = 10 - attachments.length;
    if (availableSlots <= 0) { setError("A task can include at most 10 attachments"); return; }
    const selected = files.slice(0, availableSlots);
    const oversized = selected.find((file) => file.size > MAX_ATTACHMENT_BYTES);
    if (oversized !== undefined) { setError(`${oversized.name || "Image"} is larger than 20 MB`); return; }
    if (selected.length === 0) return;
    setError(undefined);
    try {
      const uploads = await Promise.all(selected.map(async (file, index) => ({
        name: file.name || `pasted-image-${String(index + 1)}.png`,
        mimeType: file.type || "application/octet-stream",
        bytes: new Uint8Array(await file.arrayBuffer()),
      })));
      const choices = await window.waing.attachments.add(uploads);
      setAttachments((current) => [...current, ...choices].slice(0, 10));
    } catch (reason) { reportError(reason); }
  }

  async function revealProject(projectId: string): Promise<void> {
    setProjectMenuFor(undefined); setMenuFor(undefined); setError(undefined);
    try { await window.waing.projects.reveal(projectId); }
    catch (reason) { reportError(reason); }
  }

  async function removeProject(projectId: string): Promise<void> {
    const removed = projects.find((item) => item.id === projectId);
    if (removed === undefined) return;
    setError(undefined);
    try {
      const remaining = await window.waing.projects.remove(projectId);
      setProjects(remaining);
      setConversationsByProject((current) => { const next = { ...current }; delete next[projectId]; return next; });
      setConfirmingRemoval(undefined); setProjectMenuFor(undefined);
      if (project?.id === projectId) {
        setProject(remaining[0] ?? null);
        setEvents([]); setPermission(undefined); setPrompt(undefined);
        setActiveSessionId(undefined); setResolvedAgentId(undefined);
      }
    } catch (reason) { setConfirmingRemoval(undefined); reportError(reason); }
  }

  async function answerQuestion(answers: AgentQuestionResponse): Promise<void> {
    if (question === undefined) return;
    // The card closes on the provider's question.resolved event, so a failed response keeps it on screen.
    try { await window.waing.questions.respond(question.sessionId, question.id, answers); }
    catch (reason) { reportError(reason); }
  }

  async function answerPermission(decision: "allow_once" | "allow_session" | "deny"): Promise<void> {
    if (permission === undefined) return;
    try {
      await window.waing.permissions.respond(permission.sessionId, permission.id, decision);
    } catch (reason) { reportError(reason); }
  }

  function clearTranscript(): void {
    setEvents([]); setPrompt(undefined); setWorkflowSteps([]); setAgentMeta({}); setActiveStep(undefined);
    setRoutedBy(undefined); setPermission(undefined); setQuestion(undefined); setResolvedAgentId(undefined);
    setResolvedModel(undefined); setResolvedEffort(undefined); setActiveSessionId(undefined); setOpenConversationId(undefined);
    setHistoryMessages([]);
  }

  async function openConversation(conversationId: string): Promise<void> {
    if (sendBusy) return;
    setError(undefined); setMenuFor(undefined);
    try {
      const history = await window.waing.conversations.history(conversationId);
      clearTranscript();
      // The plan belongs to the run that produced it; a replayed conversation carries no state events to rebuild one.
      if (project !== null) setSharedStateByProject((current) => { const next = { ...current }; delete next[project.id]; return next; });
      setOpenConversationId(conversationId);
      setHistoryMessages(visibleHistoryMessages(history.messages));
      const replay = history.events.filter((event) => event.type !== "permission.requested"
        && event.type !== "message.delta" && event.type !== "message.completed");
      setEvents(replay);
      setAgentMeta(Object.fromEntries(history.announcements.filter((announcement) => announcement.role !== "router")
        .map((announcement) => [announcement.agentId,
          `Model: ${announcement.modelDisplayName ?? announcement.modelId ?? "Provider default"} · Effort: ${announcement.effort ?? "Provider default"}`])));
      setReplayText(undefined); setPrompt(undefined);
      followRef.current = true;
    } catch (reason) { reportError(reason); }
  }

  async function removeConversation(conversationId: string): Promise<void> {
    if (project === null) return;
    setError(undefined); setMenuFor(undefined);
    try {
      const items = await window.waing.conversations.remove(conversationId, project.id);
      setConversations(items);
      setConversationsByProject((current) => ({ ...current, [project.id]: items }));
      if (openConversationId === conversationId) { clearTranscript(); setReplayText(undefined); }
    } catch (reason) { reportError(reason); }
  }

  /** Send now when the project is idle; otherwise hold the message and let the run that owns the project finish. */
  async function sendTask(): Promise<void> {
    if (project === null || !composerDraft) return;
    const message: QueuedMessage = { id: crypto.randomUUID(), text: task.trim(), attachments };
    setTask(""); setAttachments([]);
    if (runningProjectIds.has(project.id)) {
      setQueuedByProject((current) => ({ ...current, [project.id]: [...(current[project.id] ?? []), message] }));
      return;
    }
    await runTask(project, message);
  }

  // The drain effect reaches the current closure through a ref, so it never restarts on every render.
  runTaskRef.current = runTask;

  async function runTask(target: Project, message: QueuedMessage): Promise<void> {
    const text = message.text.length === 0 ? "Please review the attached files." : message.text;
    const selectedAttachments = message.attachments;
    const continuingConversationId = openConversationId;
    if (continuingConversationId !== undefined) {
      try {
        const history = await window.waing.conversations.history(continuingConversationId);
        setHistoryMessages(visibleHistoryMessages(history.messages));
      } catch (reason) { reportError(reason); return; }
    }
    setError(undefined); setEvents([]); setPermission(undefined); setQuestion(undefined);
    setRunningProjectIds((current) => new Set(current).add(target.id));
    pendingTaskTitleRef.current.set(target.id,
      conversations.find((conversation) => conversation.id === continuingConversationId)?.title ?? text.slice(0, 80));
    setPrompt(text); setRoutedBy(undefined); setResolvedAgentId(undefined);
    setResolvedModel(undefined); setResolvedEffort(undefined);
    setWorkflowSteps([]); setAgentMeta({}); setActiveStep(undefined); setActiveSessionId(undefined);
    // Routing happens inside the send call, so the step is shown as running until the reply names the routed role.
    setRouterStep("running");
    try {
      // Always Auto: the router picks the role, and that role's saved profile supplies provider, model, and effort.
      const result = await window.waing.sessions.send({ projectId: target.id, text, agentId: "auto", mode: "execute",
        ...(continuingConversationId === undefined ? {} : { conversationId: continuingConversationId }),
        ...(selectedAttachments.length === 0 ? {} : { attachmentIds: selectedAttachments.map((item) => item.id) }) });
      if (result.session !== undefined) setActiveSessionId(result.session.id);
      setResolvedAgentId(result.resolvedAgentId);
      setResolvedModel(result.resolvedModel); setResolvedEffort(result.resolvedEffort);
      setRoutedBy(result.routing); setRouterStep("idle");
      setOpenConversationId(result.conversation.id);
      // A workflow reports its own terminal event; a single agent run is already finished when send resolves.
      if (result.workflowRunId === undefined) {
        setRunningProjectIds((current) => { const next = new Set(current); next.delete(target.id); return next; });
      }
      pendingTaskTitleRef.current.delete(target.id);
      setConversations((current) => [result.conversation, ...current.filter((item) => item.id !== result.conversation.id)]);
      setConversationsByProject((current) => ({ ...current,
        [target.id]: [result.conversation, ...(current[target.id] ?? []).filter((item) => item.id !== result.conversation.id)] }));
    } catch (reason) {
      setRunningProjectIds((current) => { const next = new Set(current); next.delete(target.id); return next; });
      pendingTaskTitleRef.current.delete(target.id);
      setPrompt(undefined); setTask(message.text); setAttachments(selectedAttachments);
      setRouterStep((current) => current === "running" ? "failed" : "idle");
      reportError(reason);
    }
  }

  /** Stop halts the whole thread of work, so anything still queued returns to the composer instead of
   * starting a run the user just asked to end. */
  async function cancelRun(): Promise<void> {
    if (project !== null && queued.length > 0) {
      setQueuedByProject((current) => ({ ...current, [project.id]: [] }));
      setTask((current) => [...queued.map((item) => item.text), current]
        .filter((value) => value.trim().length > 0).join("\n\n"));
      setAttachments((current) => [...queued.flatMap((item) => item.attachments), ...current]
        .filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index).slice(0, 10));
    }
    if (activeSessionId === undefined) return;
    try { await window.waing.sessions.cancel(activeSessionId); }
    catch (reason) { reportError(reason); }
  }

  return (
    <main className={`app-shell platform-${info?.platform ?? "unknown"} ${view === "settings" ? "settings" : [
      sidebarOpen ? "" : "sidebar-collapsed", rightSidebarOpen ? "" : "right-sidebar-collapsed",
    ].filter(Boolean).join(" ")}`}>
      {/* Settings are global, so the project and conversation rail is hidden there rather than implying a scope. */}
      {view === "chat" && sidebarOpen && <aside className="context-sidebar">
        <div className="sidebar-chrome"><span className="traffic-light-space" aria-hidden="true" />
          <button className="sidebar-toggle" type="button" aria-label="Hide sidebar" title="Hide sidebar"
            onClick={() => setSidebarOpen(false)}><PanelLeft size={18} aria-hidden="true" /></button></div>
        <div className="app-title"><h1>Waing</h1><button type="button" aria-label="Open project" title="Open project"
          onClick={() => void chooseProject()}><Plus size={17} /></button><span data-testid="version">{info === undefined ? "…" : `v${info.version}`}</span></div>
        <button className="new-task-button" type="button" disabled={sendBusy}
          title={sendBusy ? "Stop the running task first" : project === null ? "Choose a project and start a task" : "Start a new task"}
          onClick={() => void beginNewTask()}><SquarePen size={17} aria-hidden="true" /> New task</button>
        <div className="sidebar-heading"><span>Projects</span></div>
        <div className="project-tree">{projects.length === 0 ?
          <button className="empty-project" type="button" onClick={() => void chooseProject()}>Open your first project</button> :
          projects.map((item) => {
            const active = item.id === project?.id;
            const running = runningProjectIds.has(item.id);
            const items = active ? conversations : conversationsByProject[item.id] ?? [];
            return <section className={`project-group ${active ? "active" : ""}`} key={item.id}>
              <div className="project-row-wrap">
                <button className="project-row" type="button" aria-expanded={active} title={item.root}
                  onClick={() => { setProjectMenuFor(undefined); selectProject(item); }}
                  onContextMenu={(event) => { event.preventDefault(); setMenuFor(undefined); setConfirmingRemoval(undefined);
                    setProjectMenuFor({ id: item.id, x: event.clientX, y: event.clientY }); }}>
                  <Folder size={16} className="folder-icon" aria-hidden="true" />
                  <strong>{item.name}</strong>
                  {running && <span className={`task-running ${permissionsByProject[item.id] === undefined ? "" : "attention"}`}
                    title={permissionsByProject[item.id] === undefined ? "Task running" : "Permission needed"} />}
                </button>
                <button className="project-menu-trigger" type="button" aria-label={`Project actions for ${item.name}`} title="Project actions"
                  onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); setMenuFor(undefined);
                    setConfirmingRemoval(undefined); setProjectMenuFor({ id: item.id, x: Math.max(8, bounds.right - 190), y: bounds.bottom + 3 }); }}><MoreHorizontal size={16} /></button>
              </div>
              {active && <div className="conversation-list">{items.length === 0 ? <p>No tasks yet</p> : items.map((conversation) =>
                <button type="button" key={conversation.id} className={openConversationId === conversation.id ? "active" : ""}
                  disabled={sendBusy} title={sendBusy ? "Stop the running task first" : conversation.title}
                  onClick={() => void openConversation(conversation.id)}
                  onContextMenu={(event) => { event.preventDefault(); setProjectMenuFor(undefined);
                    setMenuFor({ id: conversation.id, x: event.clientX, y: event.clientY }); }}>
                  <span>{conversation.title}</span>{conversation.id === activeSessionId && <i className="task-running" title="Running" />}
                </button>)}</div>}
            </section>;
          })}</div>
        {projectMenuFor !== undefined && <>
          <div className="menu-backdrop" onClick={() => { setProjectMenuFor(undefined); setConfirmingRemoval(undefined); }}
            onContextMenu={(event) => { event.preventDefault(); setProjectMenuFor(undefined); setConfirmingRemoval(undefined); }} />
          <div className="context-menu project-context-menu" style={{ left: projectMenuFor.x, top: projectMenuFor.y }}
            role="menu" aria-label="Project actions">
            {confirmingRemoval === projectMenuFor.id ? <div className="project-remove-confirm">
              <p>Remove this project and its local chat history?</p><div>
                <button type="button" onClick={() => setConfirmingRemoval(undefined)}>Cancel</button>
                <button type="button" className="danger" onClick={() => void removeProject(projectMenuFor.id)}>Remove</button>
              </div></div> : <>
              <button type="button" role="menuitem" disabled={runningProjectIds.has(projectMenuFor.id)}
                title={runningProjectIds.has(projectMenuFor.id) ? "Stop this project's running task first" : undefined} onClick={() => {
                const target = projects.find((item) => item.id === projectMenuFor.id);
                if (target !== undefined) void beginNewTask(target);
              }}><Plus size={16} aria-hidden="true" />New chat</button>
              <button type="button" role="menuitem" onClick={() => void revealProject(projectMenuFor.id)}>
                <FolderOpen size={16} aria-hidden="true" />Reveal in Finder</button>
              <button type="button" role="menuitem" className="danger" disabled={runningProjectIds.has(projectMenuFor.id)}
                title={runningProjectIds.has(projectMenuFor.id) ? "Stop the running task first" : undefined}
                onClick={() => setConfirmingRemoval(projectMenuFor.id)}><Trash2 size={16} aria-hidden="true" />Remove</button>
            </>}
          </div>
        </>}
        {menuFor !== undefined && <>
          <div className="menu-backdrop" onClick={() => setMenuFor(undefined)} onContextMenu={(event) => { event.preventDefault(); setMenuFor(undefined); }} />
          <div className="context-menu" style={{ left: menuFor.x, top: menuFor.y }} role="menu" aria-label="Conversation actions">
            <button type="button" role="menuitem" onClick={() => project !== null && void revealProject(project.id)}>Reveal in Finder</button>
            <button type="button" role="menuitem" className="danger" onClick={() => void removeConversation(menuFor.id)}>Delete conversation</button>
          </div>
        </>}
        <div className="sidebar-footer"><button type="button" aria-label="Settings" onClick={() => setView("settings")}>
          <Settings size={18} aria-hidden="true" /> Settings</button></div>
      </aside>}
      <section className="workspace">
        <header className="topbar">
          {view === "chat"
            ? <div className="topbar-leading">{!sidebarOpen && <button className="sidebar-toggle reveal" type="button"
                aria-label="Show sidebar" title="Show sidebar" onClick={() => setSidebarOpen(true)}>
                <PanelLeft size={18} aria-hidden="true" /></button>}
              <div><p className="eyebrow">Agent workspace</p><h2>{project?.name ?? "No project selected"}</h2></div></div>
            : <div><p className="eyebrow">Applies to every project</p><h2>Settings</h2></div>}
          {/* No per-send agent/model/mode pickers: routing always decides, and Settings owns each role's provider. */}
          {/* A run keeps going while Settings is open, so its state and Stop stay reachable from here. */}
          {view === "settings" && <div className="run-strip">
            {permission !== undefined && <>
              {/* An unanswered approval blocks the provider, and the card itself only exists in the chat view. */}
              <span className="run-pill waiting">Permission needed · {permission.title}</span>
              <button className="primary" type="button" onClick={() => setView("chat")}>Review</button>
            </>}
            {permission === undefined && question !== undefined && <>
              {/* The question card is a chat-view element too, so Settings only reports that one is waiting. */}
              <span className="run-pill waiting">Question · {question.questions[0]?.header ?? "waiting"}</span>
              <button className="primary" type="button" onClick={() => setView("chat")}>Answer</button>
            </>}
            {permission === undefined && question === undefined && sendBusy && <>
              <span className="run-pill"><span className="provider-dot busy" />{activeStep?.message ?? "Task running"}</span>
              <button className="stop" type="button" onClick={() => void cancelRun()}>Stop</button>
              <button type="button" onClick={() => setView("chat")}>Open chat</button>
            </>}
          </div>}
          {view === "chat" && <button className="sidebar-toggle right-sidebar-toggle" type="button"
            aria-label={rightSidebarOpen ? "Hide right sidebar" : "Show right sidebar"}
            title={rightSidebarOpen ? "Hide right sidebar" : "Show right sidebar"}
            aria-expanded={rightSidebarOpen} aria-controls="run-inspector"
            onClick={() => setRightSidebarOpen((open) => !open)}>
            <PanelRight size={18} aria-hidden="true" />
          </button>}
        </header>
        {routingNeedsReview && <div className="routing-banner" role="status">
          <span>Auto routing is using defaults built from your installed providers.</span>
          <button type="button" onClick={() => { setView("settings"); }}>Review setup</button>
          <button className="dismiss" type="button" aria-label="Dismiss routing setup notice"
            onClick={() => { setRoutingNeedsReview(false); void window.waing.settings.acknowledgeRouting().catch(reportError); }}><X size={15} /></button>
        </div>}
        <div className="content-scroll" ref={scrollRef} onScroll={(event) => {
          const node = event.currentTarget;
          followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}>
          {view === "settings" ? <SettingsPanel agents={agents} eventCount={events.length}
            theme={theme} onThemeChange={setTheme}
            onRolesSaved={(needsReview) => setRoutingNeedsReview(needsReview)} onBack={() => setView("chat")} /> :
            <><ActivityTimeline events={events} steps={steps} agentMeta={agentMeta} historyMessages={historyMessages}
              {...(project === null ? {} : { projectId: project.id })} {...(prompt === undefined ? {} : { prompt })}
              {...(replayText === undefined || replayText.length === 0 ? {} : { replayText })}
              {...(modelLabel === undefined ? {} : { model: modelLabel })} {...(effortLabel === undefined ? {} : { effort: effortLabel })} />
              {question !== undefined && <QuestionCard key={question.id} question={question}
                onAnswer={(answers) => void answerQuestion(answers)} onDismiss={() => void answerQuestion([])} />}
              {permission !== undefined && <section className={`permission-card ${permission.risk}`} aria-label="Permission request">
                <div className="permission-heading"><span className={`risk ${permission.risk}`}>{permission.risk} risk</span><span>{permission.agentId}</span></div>
                <h3>{permission.title}</h3><p>{permission.detail}</p>
                {permission.kind === "destructive" && <p className="destructive-warning">This action may be irreversible. Review every target before allowing it.</p>}
                {permission.command !== undefined && <code>{permission.command.join(" ")}</code>}
                {permission.paths?.map((path) => <code key={path}>{path}</code>)}
                <div className="permission-actions"><button className="deny" type="button" onClick={() => void answerPermission("deny")}>Deny</button>
                  <button className={permission.kind === "destructive" ? "primary" : ""} type="button"
                    onClick={() => void answerPermission("allow_once")}>Allow once</button>
                  {permission.kind !== "destructive" && <button className="primary" type="button"
                    onClick={() => void answerPermission("allow_session")}>Allow for session</button>}</div>
              </section>}</>}
          {error !== undefined && <p className="error" role="alert">{error}</p>}
          {lastEvent !== undefined && <output className="event-probe" data-testid="last-event">{lastEvent}</output>}
        </div>
        {view === "chat" && <div className="composer-wrap">
          {/* Outside .composer because that box clips its overflow, which would cut the popover in half. */}
          <FileMentionList mentions={mentions} />
          <div className={`composer${attachmentDragActive ? " attachment-drag-active" : ""}`}
            onDragEnter={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setAttachmentDragActive(true); } }}
            onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAttachmentDragActive(false); }}
            onDrop={(event) => { event.preventDefault(); setAttachmentDragActive(false); void addAttachmentFiles([...event.dataTransfer.files]); }}>
            {project !== null && queued.length > 0 && <ul className="composer-queue" aria-label="Queued messages">
            {queued.map((item, index) => <li key={item.id}><Clock size={14} aria-hidden="true" />
              <span title={item.text}>{item.text.length === 0 ? "Attached files" : item.text}</span>
              <button type="button" aria-label={`Remove queued message ${String(index + 1)}`}
                onClick={() => setQueuedByProject((current) => ({ ...current,
                  [project.id]: (current[project.id] ?? []).filter((entry) => entry.id !== item.id) }))}><X size={14} /></button></li>)}</ul>}
            {attachments.length > 0 && <ul className="composer-attachments" aria-label="Attached files">
            {attachments.map((attachment) => <li key={attachment.id}>{attachment.kind === "image"
              ? <Image size={15} aria-hidden="true" /> : <FileText size={15} aria-hidden="true" />}
              <span title={attachment.name}>{attachment.name}</span><button type="button" aria-label={`Remove ${attachment.name}`}
                onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}><X size={14} /></button></li>)}</ul>}
            <textarea ref={composerRef} aria-label="Message" value={task}
            onChange={(event) => { setTask(event.target.value); mentions.refresh(); }}
            placeholder="Ask an agent to inspect, explain, or change this project… Type @ to reference a file"
            rows={3}
            onPaste={(event) => { const files = [...event.clipboardData.files]; if (files.length > 0) { event.preventDefault(); void addAttachmentFiles(files); } }}
            onClick={() => mentions.refresh()} onBlur={() => mentions.dismiss()}
            onKeyUp={(event) => { if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") mentions.refresh(); }}
            onKeyDown={(event) => {
              // The picker owns its navigation keys first, so Enter completes a mention instead of adding a newline.
              if (mentions.handleKeyDown(event)) { event.preventDefault(); return; }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void sendTask();
            }} />
            <div><div className="composer-context"><button className="attach-button" type="button" aria-label="Attach files and images"
              title="Attach files and images" onClick={() => void chooseAttachments()}><Paperclip size={16} /></button>
              <span>{project?.root ?? "Choose a project to begin"}</span></div><div className="composer-actions">
              {/* Stop stays reachable for the whole run: queueing a follow-up must never be the reason the user
                  can no longer halt the work they are watching. Send sits beside it and queues the draft. */}
              {sendBusy && <button className="stop" type="button" onClick={() => void cancelRun()}>Stop</button>}
              <button className="send" type="button" disabled={project === null || !composerDraft}
                title={sendBusy ? "Queued until the running task finishes" : undefined}
                onClick={() => void sendTask()}>Send <CornerDownLeft size={14} aria-hidden="true" /></button>
            </div></div></div>
        </div>}
      </section>
      {view === "chat" && rightSidebarOpen && <aside className="inspector" id="run-inspector">
        <section><p className="eyebrow">Run details</p><dl><div><dt>Status</dt><dd>{sendBusy ? "Running" : lastEvent === undefined ? "Ready" : lastEvent}</dd></div>
          <div><dt>Provider</dt><dd>{providerLabel}</dd></div>
          <div><dt>Model</dt><dd>{modelLabel ?? "Provider default"}</dd></div>
          <div><dt>Effort</dt><dd>{effortLabel ?? "—"}</dd></div>
          {(activeStep?.role ?? routedBy?.role) !== undefined && <div><dt>Role</dt><dd>{activeStep?.role ?? routedBy?.role}</dd></div>}
          {usage.input + usage.output > 0 && <div><dt>Tokens</dt>
            <dd title={`${usage.input.toLocaleString()} in · ${usage.output.toLocaleString()} out`}>
              {compactTokens(usage.input)} in · {compactTokens(usage.output)} out</dd></div>}</dl></section>
        {/* The run's plan, as the steps amend it — the structured form of the state block they end their messages with. */}
        {sharedState !== undefined && sharedState.planItems.length > 0 && <section className="plan-panel">
          <p className="eyebrow">Plan · {sharedState.planItems.filter((item) => item.status === "done").length}/{
            sharedState.planItems.filter((item) => item.status !== "dropped").length}</p>
          <ol className="plan-list">{sharedState.planItems.map((item) => <li key={item.id} className={`plan-item ${item.status}`}>
            <span className="plan-mark" aria-hidden="true">{item.status === "done" ? <Check size={11} strokeWidth={3.5} />
              : item.status === "dropped" ? <X size={11} strokeWidth={3.5} /> : null}</span>
            <span className="plan-title" title={item.title}>{item.title}</span></li>)}</ol>
          {sharedState.decisions.length > 0 && <>
            <p className="eyebrow plan-sub">Decisions</p>
            <ul className="plan-notes">{sharedState.decisions.map((decision) => <li key={decision}>{decision}</li>)}</ul></>}
          {sharedState.openQuestions.length > 0 && <>
            <p className="eyebrow plan-sub">Open questions</p>
            <ul className="plan-notes">{sharedState.openQuestions.map((item) => <li key={item}>{item}</li>)}</ul></>}
        </section>}
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
