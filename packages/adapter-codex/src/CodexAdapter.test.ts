import { describe, expect, it } from "vitest";
import { JsonRpcTransport, ProcessSupervisor } from "@waing/agent-core";
import type { AgentEvent } from "@waing/domain";
import { CodexAdapter } from "./CodexAdapter";

const fakeCodexScript = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake" } });
  else if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thread-1" } } });
  else if (message.method === "model/list") send({ id: message.id, result: { data: [{
    id: "model-1", model: "codex-test", displayName: "Codex Test", hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: "high" }], isDefault: true
  }], nextCursor: null } });
  else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
    send({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: {
      type: "commandExecution", id: "command-1", command: "npm test", cwd: "/tmp", processId: null,
      source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null,
      exitCode: null, durationMs: null
    } } });
    send({ method: "item/commandExecution/outputDelta", params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "command-1", delta: "passing"
    } });
    send({ method: "item/fileChange/patchUpdated", params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "file-1",
      changes: [{ path: "src/index.ts", kind: { type: "update", move_path: null }, diff: "+ok" }]
    } });
    send({ method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff: "+ok" } });
    send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "command-1", command: "npm test"
    } });
  } else if (message.id === "approval-1") {
    send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: {
      type: "commandExecution", id: "command-1", command: "npm test", cwd: "/tmp", processId: null,
      source: "agent", status: "completed", commandActions: [], aggregatedOutput: "passing",
      exitCode: 0, durationMs: 10
    } } });
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: {
      id: "turn-1", status: "completed", error: null
    } } });
  } else if (message.method === "thread/unsubscribe") send({ id: message.id, result: {} });
  else if (message.method === "turn/interrupt") send({ id: message.id, result: {} });
});
`;

describe("CodexAdapter", () => {
  it("maps the version-matched app-server protocol into normalized events and approvals", async () => {
    const supervisor = new ProcessSupervisor();
    const child = supervisor.spawn(process.execPath, ["-e", fakeCodexScript]);
    const transport = new JsonRpcTransport(child, false);
    const adapter = new CodexAdapter({ supervisor, transportFactory: () => Promise.resolve({ transport, process: child }) });

    const session = await adapter.startSession({
      conversationId: "conversation-1", projectId: "project-1", projectRoot: "/tmp/project",
    });
    const models = await adapter.listModels();
    expect(models).toMatchObject([{ modelId: "codex-test", effortLevels: ["high"] }]);
    const iterator = adapter.events(session.id)[Symbol.asyncIterator]();
    const run = await adapter.send(session.id, {
      text: "test it", projectRoot: "/tmp/project", mode: "execute", effort: "high",
    });
    expect(run.id).toBe("turn-1");

    const events: AgentEvent[] = [];
    while (!events.some((event) => event.type === "permission.requested")) {
      const next = await iterator.next();
      if (!next.done) events.push(next.value);
    }
    await adapter.respondToPermission(session.id, "command-1", "allow_once");
    while (!events.some((event) => event.type === "run.completed")) {
      const next = await iterator.next();
      if (!next.done) events.push(next.value);
    }
    expect(events.map((event) => event.type)).toEqual([
      "run.started", "command.started", "command.output", "file.changed", "diff.updated",
      "permission.requested", "permission.resolved", "command.completed", "run.completed",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    await adapter.closeSession(session.id);
    await adapter.shutdown();
    expect(supervisor.activeCount).toBe(0);
  });

  it("reports a missing executable without throwing discovery errors", async () => {
    const adapter = new CodexAdapter({ executable: "/definitely/missing/codex" });
    await expect(adapter.discover()).resolves.toMatchObject({ installed: false, available: false });
  });
});
