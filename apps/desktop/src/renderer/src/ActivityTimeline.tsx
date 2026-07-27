import type { AgentEvent } from "@waing/domain";
import { Markdown } from "./Markdown";

/** Pre-run steps (routing, provider selection) the renderer knows about before any provider event arrives. */
export interface TimelineStep { id: string; title: string; detail?: string; state?: "pending" | "done" | "failed" }

type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; agentId: string; text: string; streaming: boolean }
  | { kind: "output"; id: string; agentId: string; text: string }
  | { kind: "event"; id: string; event: AgentEvent; repeats: number };

/**
 * Token counters and diffs are cumulative: a provider re-emits them after every tool call, so in the transcript they
 * read as dozens of near-identical rows. Both have a single live home in the inspector instead.
 */
const SUPPRESSED: ReadonlySet<AgentEvent["type"]> = new Set(["usage.updated", "diff.updated"]);

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
  let output: Extract<ChatItem, { kind: "output" }> | undefined;
  for (const event of events) {
    if (event.type === "message.delta" || event.type === "message.completed") {
      output = undefined;
      if (bubble === undefined) { bubble = { kind: "assistant", id: event.id, agentId: event.agentId, text: "", streaming: true }; items.push(bubble); }
      if (event.type === "message.delta") bubble.text += event.text;
      else { if (event.text.length > 0) bubble.text = event.text; bubble.streaming = false; bubble = undefined; }
      continue;
    }
    if (event.type === "command.output") {
      bubble = undefined;
      if (output === undefined) { output = { kind: "output", id: event.id, agentId: event.agentId, text: "" }; items.push(output); }
      output.text += event.text;
      continue;
    }
    // Suppressed ticks arrive mid-stream, so they must not split the message they interleave with either.
    if (SUPPRESSED.has(event.type)) continue;
    bubble = undefined; output = undefined;
    const previous = items.at(-1);
    if (previous?.kind === "event" && sameActivity(previous.event, event)) { previous.repeats += 1; continue; }
    items.push({ kind: "event", id: event.id, event, repeats: 1 });
  }
  return items;
}

/** Providers often report the same file write or command twice; identical neighbours collapse into one row. */
function sameActivity(left: AgentEvent, right: AgentEvent): boolean {
  if (left.type !== right.type) return false;
  const a = activityText(left); const b = activityText(right);
  return a.title === b.title && a.detail === b.detail;
}

export function ActivityTimeline({ events, prompt, steps = [], model, effort, agentMeta = {}, replayText }: {
  events: AgentEvent[]; prompt?: string; steps?: TimelineStep[]; model?: string; effort?: string;
  agentMeta?: Record<string, string>; replayText?: string;
}) {
  const items = buildChat(events, prompt);
  const fallbackLabel = [model, effort].filter((part) => part !== undefined && part.length > 0).join(" · ");

  const renderItem = (item: ChatItem) => {
    if (item.kind === "user") return <article className="chat-turn user" key={item.id}><div className="bubble">{item.text}</div></article>;
    if (item.kind === "assistant") {
      // Each workflow step can run a different provider, so prefer the model and effort announced for that agent.
      const label = agentMeta[item.agentId] ?? fallbackLabel;
      return <article className="chat-turn agent" key={item.id}>
        <div className="chat-author">{item.agentId}{label.length > 0 && <span className="chat-meta">{label}</span>}</div>
        {/* Mid-stream text is often half a fence or table row, so it stays literal until the message settles. */}
        <div className="chat-text">{item.streaming
          ? <>{item.text}<span className="caret" aria-label="Streaming" /></>
          : <Markdown text={item.text} />}</div>
      </article>;
    }
    if (item.kind === "output") return <details className="chat-output" key={item.id}>
      <summary>Command output</summary><pre>{item.text}</pre>
    </details>;
    const content = activityText(item.event);
    const state = item.event.type.includes("failed") ? "failed" : item.event.type.includes("completed") ? "done" : "";
    return <div className={`chat-activity ${state}`} key={item.id}>
      <span className="chat-dot">{state === "failed" ? "!" : state === "done" ? "✓" : "·"}</span>
      <span className="chat-activity-title">{content.title}</span>
      {content.detail !== undefined && <span className="chat-activity-detail">{content.detail}</span>}
      {item.repeats > 1 && <span className="chat-activity-count">×{item.repeats}</span>}
    </div>;
  };

  return <section className="timeline" aria-label="Conversation">
    {items.length === 0 && steps.length === 0 && <div className="empty-state"><strong>Ready for a task</strong><p>Messages, plans, tools, commands, and files appear here.</p></div>}
    {items.filter((item) => item.kind === "user").map(renderItem)}
    {/* Routing runs before the provider starts, so its steps sit between the prompt and the first provider event. */}
    {steps.map((step) => <div className={`chat-activity ${step.state ?? ""}`} key={step.id}>
      <span className="chat-dot">{step.state === "failed" ? "!" : step.state === "done" ? "✓" : "◇"}</span>
      <span className="chat-activity-title">{step.title}</span>
      {step.detail !== undefined && <span className="chat-activity-detail">{step.detail}</span>}
    </div>)}
    {/* Older runs stored only a summary message, with no message event to rebuild a bubble from. */}
    {replayText !== undefined && <article className="chat-turn agent"><div className="chat-author">summary</div>
      <div className="chat-text"><Markdown text={replayText} /></div></article>}
    {items.filter((item) => item.kind !== "user").map(renderItem)}
  </section>;
}
