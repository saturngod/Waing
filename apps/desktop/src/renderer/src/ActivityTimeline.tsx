import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Dot, X } from "lucide-react";
import type { AgentEvent } from "@waing/domain";
import { Markdown } from "./Markdown";

/** Pre-run steps (routing, provider selection) the renderer knows about before any provider event arrives. */
export interface TimelineStep { id: string; title: string; detail?: string; state?: "pending" | "done" | "failed" }

type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; agentId: string; text: string; streaming: boolean }
  | { kind: "activity"; id: string; entries: ActivityEntry[]; pending: boolean };

type ActivityEntry =
  | { kind: "output"; id: string; text: string }
  | { kind: "event"; id: string; event: AgentEvent; repeats: number };

/**
 * Token counters and diffs are cumulative: a provider re-emits them after every tool call, so in the transcript they
 * read as dozens of near-identical rows. Both have a single live home in the inspector instead.
 */
const SUPPRESSED: ReadonlySet<AgentEvent["type"]> = new Set(["usage.updated", "diff.updated"]);

/**
 * Workflow steps end their message with a shared-state amendment. The engine parses it out of the stored summary, but
 * the live message events reach the transcript untouched, so the block is dropped here too — the plan it carries is
 * shown as a plan in the inspector, never as raw JSON in the conversation.
 */
// Closed fence, then the two half-written forms a stream passes through: an open fence, and a bare object. The block
// always ends the message, so an unterminated one runs to the end of what has arrived so far.
//
// The bare-object form also swallows a fence the model opened around it — providers routinely label the block
// ```json, or leave it unlabelled, instead of ```waing-state. Without that, stripping the object took the closing
// fence with it and left the opening one behind, which renders as an empty code block at the end of the message.
const STATE_BLOCK = /```waing-state[\s\S]*?```|```waing-state[\s\S]*$|(?:```[\w-]*[^\S\r\n]*\r?\n\s*)?\{\s*"(?:planItems|decisions|openQuestions)"[\s\S]*$/gu;
export function withoutStateBlock(text: string): string { return text.replace(STATE_BLOCK, "").trim(); }

/** Compact, stable elapsed time for the transcript status (1s, 1m, 12m, 2h). */
export function formatProcessDuration(milliseconds: number): string {
  const seconds = Math.max(1, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  return `${String(Math.floor(minutes / 60))}h`;
}

function activityText(event: AgentEvent): { title: string; detail?: string } {
  switch (event.type) {
    case "run.started": return { title: "Run started" };
    case "plan.updated": return { title: "Plan", detail: event.text };
    case "file.read": return { title: "Read", detail: event.path };
    case "file.changed": return { title: event.change === "created" ? "Created" : event.change === "deleted" ? "Deleted" : "Edited", detail: event.path };
    case "diff.updated": return { title: "Diff updated", detail: `${event.diff.split("\n").length} lines` };
    case "command.started": return { title: "Ran", detail: event.command.join(" ") };
    case "command.completed": return { title: "Command finished", detail: `Exit ${String(event.exitCode)}` };
    case "tool.started": return { title: `Using ${event.tool}` };
    case "tool.progress": return { title: event.tool, detail: event.detail };
    case "tool.completed": return { title: `Finished ${event.tool}` };
    case "permission.requested": return { title: "Permission requested", detail: event.request.title };
    case "permission.resolved": return { title: "Permission", detail: event.decision.replaceAll("_", " ") };
    case "question.requested": return { title: "Question", detail: event.question.questions[0]?.question ?? "" };
    case "question.resolved": return { title: "Answered", detail: event.answers.length === 0 ? "Dismissed"
      : event.answers.map((answer) => answer.values.join(", ")).join(" · ") };
    case "usage.updated": return { title: "Usage", detail: `${event.inputTokens} in · ${event.outputTokens} out` };
    case "run.completed": return event.summary === undefined ? { title: "Run completed" } : { title: "Run completed", detail: event.summary };
    case "run.failed": return { title: "Run failed", detail: event.message };
    // These never reach here; they are folded into assistant bubbles and output blocks.
    case "message.delta": case "message.completed": return { title: "Agent message", detail: event.text };
    case "command.output": return { title: `${event.stream} output`, detail: event.text };
  }
}

// Streaming providers emit one event per token, so consecutive message and command-output
// events are merged into a single bubble instead of a card each.
function buildChat(events: AgentEvent[], prompt: string | undefined): ChatItem[] {
  const items: ChatItem[] = [];
  if (prompt !== undefined && prompt.length > 0) items.push({ kind: "user", id: "prompt", text: prompt });
  let bubble: Extract<ChatItem, { kind: "assistant" }> | undefined;
  let activity: Extract<ChatItem, { kind: "activity" }> | undefined;
  for (const event of events) {
    if (event.type === "message.delta" || event.type === "message.completed") {
      if (activity !== undefined) activity.pending = false;
      activity = undefined;
      if (bubble === undefined) { bubble = { kind: "assistant", id: event.id, agentId: event.agentId, text: "", streaming: true }; items.push(bubble); }
      if (event.type === "message.delta") bubble.text += event.text;
      else { if (event.text.length > 0) bubble.text = event.text; bubble.streaming = false; bubble = undefined; }
      continue;
    }
    // Suppressed ticks arrive mid-stream, so they must not split the message they interleave with either.
    if (SUPPRESSED.has(event.type)) continue;
    // Not every provider ends a message with `message.completed` (OpenCode only streams deltas), so the next
    // non-message event — a tool call, or `run.completed` — is what settles the bubble into rendered Markdown.
    if (bubble !== undefined) { bubble.streaming = false; bubble = undefined; }
    if (activity === undefined) { activity = { kind: "activity", id: `activity-${event.id}`, entries: [], pending: true }; items.push(activity); }
    const previous = activity.entries.at(-1);
    if (event.type === "command.output") {
      if (previous?.kind === "output") previous.text += event.text;
      else activity.entries.push({ kind: "output", id: event.id, text: event.text });
      continue;
    }
    if (previous?.kind === "event" && sameActivity(previous.event, event)) { previous.repeats += 1; continue; }
    activity.entries.push({ kind: "event", id: event.id, event, repeats: 1 });
    if (event.type === "run.completed" || event.type === "run.failed") activity.pending = false;
  }
  return items;
}

function activitySummary(item: Extract<ChatItem, { kind: "activity" }>, completedElapsed?: string): string {
  if (completedElapsed !== undefined) return `Worked for ${completedElapsed}`;
  const events = item.entries.flatMap((entry) => entry.kind === "event" ? [entry.event] : []);
  const latestCommand = [...events].reverse().find((event) => event.type === "command.started");
  if (item.pending) return latestCommand?.type === "command.started" ? `Running ${latestCommand.command.join(" ")}` : "Working…";
  const started = events[0]?.timestamp; const finished = events.at(-1)?.timestamp;
  const seconds = started === undefined || finished === undefined ? 0
    : Math.max(0, Math.round((Date.parse(finished) - Date.parse(started)) / 1_000));
  const duration = seconds > 0 ? ` in ${String(seconds)}s` : "";
  if (latestCommand?.type === "command.started" && events.filter((event) => event.type === "command.started").length === 1) {
    return `Ran ${latestCommand.command.join(" ")}${duration}`;
  }
  return `${String(item.entries.length)} activities${duration}`;
}

/** Providers often report the same file write or command twice; identical neighbours collapse into one row. */
function sameActivity(left: AgentEvent, right: AgentEvent): boolean {
  if (left.type !== right.type) return false;
  const a = activityText(left); const b = activityText(right);
  return a.title === b.title && a.detail === b.detail;
}

export function ActivityTimeline({ events, prompt, steps = [], model, effort, agentMeta = {}, replayText, projectId,
  historyMessages = [] }: {
  events: AgentEvent[]; prompt?: string; steps?: TimelineStep[]; model?: string; effort?: string;
  agentMeta?: Record<string, string>; replayText?: string; projectId?: string;
  historyMessages?: Array<{ id: string; role: "user" | "assistant"; content: string }>;
}) {
  const items = buildChat(events, prompt);
  const fallbackLabel = `Model: ${model ?? "Provider default"} · Effort: ${effort ?? "Provider default"}`;
  // A message can finish while the run continues into another tool call, so activity-group pending state is not a
  // reliable run clock. The absence of a terminal event is; routing steps cover the brief pre-provider interval.
  const currentRunId = events.at(-1)?.runId;
  const runEvents = currentRunId === undefined ? [] : events.filter((event) => event.runId === currentRunId);
  const terminalEvent = [...runEvents].reverse().find((event) => event.type === "run.completed" || event.type === "run.failed");
  const working = terminalEvent === undefined && (runEvents.length > 0 || steps.some((step) => step.state === "pending"));
  const provisionalStart = useRef<number | undefined>(undefined);
  if (working && provisionalStart.current === undefined) provisionalStart.current = Date.now();
  if (!working) provisionalStart.current = undefined;
  const eventStartedAt = runEvents.find((event) => event.type === "run.started")?.timestamp ?? runEvents[0]?.timestamp;
  const startedAt = eventStartedAt === undefined ? provisionalStart.current : Date.parse(eventStartedAt);
  const finishedAt = terminalEvent === undefined ? undefined : Date.parse(terminalEvent.timestamp);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!working) return;
    setNow(Date.now());
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1_000);
    return () => { window.clearInterval(timer); };
  }, [working, currentRunId]);

  const elapsed = startedAt === undefined ? undefined
    : formatProcessDuration(Math.max(0, (finishedAt ?? now) - startedAt));
  const finalActivityId = [...items].reverse().find((item) => item.kind === "activity")?.id;

  const renderItem = (item: ChatItem) => {
    if (item.kind === "user") return <article className="chat-turn user" key={item.id}><div className="bubble">{item.text}</div></article>;
    if (item.kind === "assistant") {
      // Each workflow step can run a different provider, so prefer the model and effort announced for that agent.
      const label = agentMeta[item.agentId] ?? fallbackLabel;
      const text = withoutStateBlock(item.text);
      if (text.length === 0 && !item.streaming) return null;
      return <article className="chat-turn agent" key={item.id}>
        <div className="chat-author">{item.agentId}<span className="chat-meta">{label}</span></div>
        {/* Mid-stream text is often half a fence or table row, so it stays literal until the message settles. */}
        <div className="chat-text">{item.streaming
          ? <>{text}<span className="caret" aria-label="Streaming" /></>
          : <Markdown text={text} {...(projectId === undefined ? {} : { projectId })} />}</div>
      </article>;
    }
    const completedElapsed = !working && item.id === finalActivityId ? elapsed : undefined;
    return <details className={`activity-group ${item.pending ? "pending" : "done"}`} key={item.id}>
      <summary><span className="activity-spinner" aria-hidden="true" /><span>{activitySummary(item, completedElapsed)}</span><ChevronDown className="activity-chevron" size={16} /></summary>
      <div className="activity-group-items">{item.entries.map((entry) => {
        if (entry.kind === "output") return <pre className="activity-output" key={entry.id}>{entry.text}</pre>;
        const content = activityText(entry.event);
        const state = entry.event.type.includes("failed") ? "failed" : entry.event.type.includes("completed") ? "done" : "";
        return <div className={`chat-activity ${state}`} key={entry.id}>
          <span className="chat-dot">{state === "failed" ? <X size={9} strokeWidth={3.5} />
            : state === "done" ? <Check size={9} strokeWidth={3.5} /> : <Dot size={9} strokeWidth={3.5} />}</span>
          <span className="chat-activity-title">{content.title}</span>
          {content.detail !== undefined && <span className="chat-activity-detail">{content.detail}</span>}
          {entry.repeats > 1 && <span className="chat-activity-count">×{entry.repeats}</span>}
        </div>;
      })}</div>
    </details>;
  };

  return <section className="timeline" aria-label="Conversation">
    {items.length === 0 && steps.length === 0 && historyMessages.length === 0
      && <div className="empty-state"><strong>Ready for a task</strong><p>Messages, plans, tools, commands, and files appear here.</p></div>}
    {historyMessages.map((message) => message.role === "user"
      ? <article className="chat-turn user" key={message.id}><div className="bubble">{message.content}</div></article>
      : <article className="chat-turn agent" key={message.id}><div className="chat-author">assistant</div>
        <div className="chat-text"><Markdown text={withoutStateBlock(message.content)} {...(projectId === undefined ? {} : { projectId })} /></div></article>)}
    {items.filter((item) => item.kind === "user").map(renderItem)}
    {/* Routing runs before the provider starts, so its steps sit between the prompt and the first provider event. */}
    {steps.map((step) => <div className={`chat-activity ${step.state ?? ""}`} key={step.id}>
      <span className="chat-dot">{step.state === "failed" ? <X size={9} strokeWidth={3.5} />
        : step.state === "done" ? <Check size={9} strokeWidth={3.5} /> : null}</span>
      <span className="chat-activity-title">{step.title}</span>
      {step.detail !== undefined && <span className="chat-activity-detail">{step.detail}</span>}
    </div>)}
    {/* Older runs stored only a summary message, with no message event to rebuild a bubble from. */}
    {replayText !== undefined && <article className="chat-turn agent"><div className="chat-author">summary</div>
      <div className="chat-text"><Markdown text={withoutStateBlock(replayText)} {...(projectId === undefined ? {} : { projectId })} /></div></article>}
    {items.filter((item) => item.kind !== "user").map(renderItem)}
    {working && elapsed !== undefined && <div className="task-loading working" role="status" aria-label="Agent is working">
      <span className="task-loading-spinner" aria-hidden="true" />
      <span>Working {elapsed}</span>
    </div>}
  </section>;
}
