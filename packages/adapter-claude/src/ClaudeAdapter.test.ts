import { describe, expect, it, vi } from "vitest";
import type { Options, PermissionResult, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@waing/domain";
import { ClaudeAdapter } from "./ClaudeAdapter";

function fakeQueryFactory(captured: Options[]) {
  return ({ options = {} }: { prompt: string; options?: Options }): Query => {
    captured.push(options);
    const generator = (async function* (): AsyncGenerator<SDKMessage> {
      yield { type: "system", subtype: "init", session_id: "claude-session-1" } as SDKMessage;
      yield { type: "stream_event", session_id: "claude-session-1",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Working" } } } as SDKMessage;
      yield { type: "assistant", session_id: "claude-session-1", message: { content: [
        { type: "text", text: "Working" },
        { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "npm test" } },
      ] } } as SDKMessage;
      const permission = await options.canUseTool?.("Bash", { command: "npm test" }, {
        signal: new AbortController().signal, toolUseID: "tool-1", requestId: "request-1",
        title: "Run npm test", suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }],
          behavior: "allow", destination: "session" }],
      });
      expect(permission?.behavior).toBe("allow");
      if (permission?.behavior === "allow") expect(permission.updatedPermissions).toHaveLength(1);
      yield { type: "result", subtype: "success", session_id: "claude-session-1",
        result: "done", usage: { input_tokens: 12, output_tokens: 7 } } as SDKMessage;
    })();
    return Object.assign(generator, {
      interrupt: vi.fn(() => Promise.resolve(undefined)),
      close: vi.fn(), setPermissionMode: vi.fn(), setModel: vi.fn(),
      setMcpPermissionModeOverride: vi.fn(), setMaxThinkingTokens: vi.fn(),
      setThinking: vi.fn(), setEffort: vi.fn(), supportedModels: vi.fn(),
      supportedCommands: vi.fn(), mcpServerStatus: vi.fn(), accountInfo: vi.fn(),
      rewindFiles: vi.fn(), setMaxBudgetUsd: vi.fn(), setBetas: vi.fn(),
    }) as unknown as Query;
  };
}

describe("ClaudeAdapter", () => {
  it("normalizes SDK streaming, tool activity, permission callbacks, usage, and completion", async () => {
    const captured: Options[] = [];
    const adapter = new ClaudeAdapter(fakeQueryFactory(captured));
    const session = await adapter.resumeSession({ conversationId: "conversation-1", projectId: "project-1",
      projectRoot: "/tmp/project", providerSessionId: "previous-session" });
    const iterator = adapter.events(session.id)[Symbol.asyncIterator]();
    await adapter.send(session.id, { text: "test", projectRoot: "/tmp/project", mode: "plan",
      effort: "high", model: "opus" });

    const events: AgentEvent[] = [];
    while (!events.some((event) => event.type === "permission.requested")) {
      const next = await iterator.next(); if (!next.done) events.push(next.value);
    }
    await adapter.respondToPermission(session.id, "tool-1", "allow_session");
    while (!events.some((event) => event.type === "run.completed")) {
      const next = await iterator.next(); if (!next.done) events.push(next.value);
    }
    expect(captured[0]).toMatchObject({ permissionMode: "plan", effort: "high", model: "opus", resume: "previous-session" });
    expect(events.map((event) => event.type)).toEqual([
      "run.started", "message.delta", "message.completed", "command.started",
      "permission.requested", "permission.resolved", "usage.updated", "run.completed",
    ]);
    expect(session.providerSessionId).toBe("claude-session-1");
    await adapter.shutdown();
  });

  it("surfaces AskUserQuestion as a question and returns the answer as the tool result", async () => {
    let toolResult: PermissionResult | null | undefined;
    const factory = ({ options = {} }: { prompt: string; options?: Options }): Query => {
      const generator = (async function* (): AsyncGenerator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: "claude-session-2" } as SDKMessage;
        toolResult = await options.canUseTool?.("AskUserQuestion", { questions: [{
          question: "Which cache backend should we use?", header: "Cache", multiSelect: false,
          options: [{ label: "In-memory", description: "No extra service." }, { label: "Redis", description: "Shared." }],
        }] }, { signal: new AbortController().signal, toolUseID: "tool-q", requestId: "request-q" });
        yield { type: "result", subtype: "success", session_id: "claude-session-2",
          result: "done", usage: { input_tokens: 1, output_tokens: 1 } } as SDKMessage;
      })();
      return Object.assign(generator, { interrupt: vi.fn(() => Promise.resolve(undefined)), close: vi.fn(),
        setPermissionMode: vi.fn(), setModel: vi.fn(), setMcpPermissionModeOverride: vi.fn(),
        setMaxThinkingTokens: vi.fn(), setThinking: vi.fn(), setEffort: vi.fn(), supportedModels: vi.fn(),
        supportedCommands: vi.fn(), mcpServerStatus: vi.fn(), accountInfo: vi.fn(), rewindFiles: vi.fn(),
        setMaxBudgetUsd: vi.fn(), setBetas: vi.fn() }) as unknown as Query;
    };
    const adapter = new ClaudeAdapter(factory);
    const session = await adapter.startSession({ conversationId: "conversation-2", projectId: "project-1", projectRoot: "/tmp/project" });
    const iterator = adapter.events(session.id)[Symbol.asyncIterator]();
    await adapter.send(session.id, { text: "add a cache", projectRoot: "/tmp/project", mode: "execute" });

    const events: AgentEvent[] = [];
    while (!events.some((event) => event.type === "question.requested")) {
      const next = await iterator.next(); if (!next.done) events.push(next.value);
    }
    const asked = events.find((event) => event.type === "question.requested");
    expect(asked?.type === "question.requested" && asked.question.questions[0]).toMatchObject({
      question: "Which cache backend should we use?", header: "Cache",
      options: [{ label: "In-memory" }, { label: "Redis" }],
    });
    await adapter.respondToQuestion(session.id, "tool-q", [{ header: "Cache", values: ["Redis"] }]);
    while (!events.some((event) => event.type === "run.completed")) {
      const next = await iterator.next(); if (!next.done) events.push(next.value);
    }
    // The CLI cannot hand an answer to a tool it is running, so the answer rides back on the refusal message.
    expect(toolResult).toEqual({ behavior: "deny", message: "Cache: Redis" });
    expect(events.map((event) => event.type)).toEqual([
      "run.started", "question.requested", "question.resolved", "usage.updated", "run.completed",
    ]);
    await adapter.shutdown();
  });

  it("releases a parked question when the session is cancelled", async () => {
    let toolResult: PermissionResult | null | undefined;
    let asked: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => { asked = resolve; });
    const factory = ({ options = {} }: { prompt: string; options?: Options }): Query => {
      const generator = (async function* (): AsyncGenerator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: "claude-session-3" } as SDKMessage;
        const pending = options.canUseTool?.("AskUserQuestion", { questions: [{ question: "Pick one?", header: "Pick",
          options: [{ label: "A", description: "" }, { label: "B", description: "" }] }] },
        { signal: new AbortController().signal, toolUseID: "tool-q", requestId: "request-q" });
        asked?.();
        toolResult = await pending;
      })();
      return Object.assign(generator, { interrupt: vi.fn(() => Promise.resolve(undefined)), close: vi.fn(),
        setPermissionMode: vi.fn(), setModel: vi.fn(), setMcpPermissionModeOverride: vi.fn(),
        setMaxThinkingTokens: vi.fn(), setThinking: vi.fn(), setEffort: vi.fn(), supportedModels: vi.fn(),
        supportedCommands: vi.fn(), mcpServerStatus: vi.fn(), accountInfo: vi.fn(), rewindFiles: vi.fn(),
        setMaxBudgetUsd: vi.fn(), setBetas: vi.fn() }) as unknown as Query;
    };
    const adapter = new ClaudeAdapter(factory);
    const session = await adapter.startSession({ conversationId: "conversation-3", projectId: "project-1", projectRoot: "/tmp/project" });
    void adapter.events(session.id)[Symbol.asyncIterator]().next();
    await adapter.send(session.id, { text: "pick", projectRoot: "/tmp/project", mode: "execute" });
    await reached;
    await adapter.cancel(session.id);
    await vi.waitFor(() => { expect(toolResult).toEqual({ behavior: "deny", message: "The user did not answer the questions." }); });
    await adapter.shutdown();
  });

  it("exposes provider-owned model aliases and capabilities", async () => {
    const adapter = new ClaudeAdapter(fakeQueryFactory([]));
    expect((await adapter.listModels())[0]).toMatchObject(
      { modelId: "sonnet", effortLevels: ["low", "medium", "high", "max"] },
    );
    await expect(adapter.discover()).resolves.toMatchObject({
      installed: true, capabilities: { planMode: true, interactivePermissions: true },
    });
  });
});
