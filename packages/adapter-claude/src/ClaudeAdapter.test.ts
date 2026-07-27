import { describe, expect, it, vi } from "vitest";
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
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
