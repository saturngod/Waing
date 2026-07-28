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

const fakeQuestionScript = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake" } });
  else if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thread-1" } } });
  else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
    send({ id: "ask-1", method: "item/tool/requestUserInput", params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "input-1", autoResolutionMs: null,
      questions: [{ id: "q-1", header: "Cache", question: "Which cache backend?", isOther: false, isSecret: false,
        options: [{ label: "Redis", description: "Shared." }, { label: "In-memory", description: "Simple." }] }]
    } });
  } else if (message.id === "ask-1") {
    // The turn only completes when the answer came back keyed by the question's id, in Codex's own shape.
    const expected = JSON.stringify({ answers: { "q-1": { answers: ["Redis"] } } });
    const ok = JSON.stringify(message.result) === expected;
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: {
      id: "turn-1", status: ok ? "completed" : "failed",
      error: ok ? null : { message: "unexpected answers " + JSON.stringify(message.result) }
    } } });
  } else if (message.method === "thread/unsubscribe") send({ id: message.id, result: {} });
  else if (message.method === "turn/interrupt") send({ id: message.id, result: {} });
});
`;

/**
 * Every server request Codex sends blocks its turn until the client answers. This script fires the ones the adapter
 * does not turn into UI — a permission widening, an MCP form, and the legacy v1 approval — and only completes the
 * turn once all three have a well-formed reply.
 */
const fakeBlockingScript = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const replies = {};
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake" } });
  else if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thread-1" } } });
  else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
    send({ id: "elicit-1", method: "mcpServer/elicitation/request", params: {
      threadId: "thread-1", turnId: "turn-1", serverName: "pencil", mode: "form",
      message: "Pick a canvas", requestedSchema: {}, _meta: null } });
    send({ id: "perm-1", method: "item/permissions/requestApproval", params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "perm-1", startedAtMs: 1, cwd: "/tmp/project",
      reason: "Fetch the design tokens", permissions: { network: { enabled: true }, fileSystem: null } } });
    send({ id: "legacy-1", method: "execCommandApproval", params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "legacy-1", command: "npm test" } });
  } else if (message.id !== undefined && message.result !== undefined) {
    replies[message.id] = message.result;
    if (replies["elicit-1"] && replies["perm-1"] && replies["legacy-1"]) {
      const ok = replies["elicit-1"].action === "decline"
        && JSON.stringify(replies["perm-1"]) === JSON.stringify({ permissions: { network: { enabled: true } }, scope: "session" })
        && replies["legacy-1"].decision === "decline";
      send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1",
        status: ok ? "completed" : "failed",
        error: ok ? null : { message: "unexpected replies " + JSON.stringify(replies) } } } });
    }
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

  it("surfaces request_user_input as a question and answers it by question id", async () => {
    const supervisor = new ProcessSupervisor();
    const child = supervisor.spawn(process.execPath, ["-e", fakeQuestionScript]);
    const transport = new JsonRpcTransport(child, false);
    const adapter = new CodexAdapter({ supervisor, transportFactory: () => Promise.resolve({ transport, process: child }) });
    const session = await adapter.startSession({
      conversationId: "conversation-2", projectId: "project-1", projectRoot: "/tmp/project",
    });
    const iterator = adapter.events(session.id)[Symbol.asyncIterator]();
    await adapter.send(session.id, { text: "add a cache", projectRoot: "/tmp/project", mode: "execute" });

    const events: AgentEvent[] = [];
    while (!events.some((event) => event.type === "question.requested")) {
      const next = await iterator.next(); if (!next.done) events.push(next.value);
    }
    const asked = events.find((event) => event.type === "question.requested");
    expect(asked?.type === "question.requested" && asked.question.questions[0]).toMatchObject({
      question: "Which cache backend?", header: "Cache",
      options: [{ label: "Redis", description: "Shared." }, { label: "In-memory", description: "Simple." }],
    });
    await adapter.respondToQuestion(session.id, "input-1", [{ header: "Cache", values: ["Redis"] }]);
    while (!events.some((event) => event.type === "run.completed")) {
      const next = await iterator.next(); if (!next.done) events.push(next.value);
    }
    // Codex keys answers by the question's own id, not by the header the app answers with.
    expect(events.map((event) => event.type)).toEqual([
      "run.started", "question.requested", "question.resolved", "run.completed",
    ]);
    await adapter.closeSession(session.id);
    await adapter.shutdown();
    expect(supervisor.activeCount).toBe(0);
  });

  it("answers every blocking server request so none of them can stall a turn", async () => {
    const supervisor = new ProcessSupervisor();
    const child = supervisor.spawn(process.execPath, ["-e", fakeBlockingScript]);
    const transport = new JsonRpcTransport(child, false);
    const adapter = new CodexAdapter({ supervisor, transportFactory: () => Promise.resolve({ transport, process: child }) });
    const session = await adapter.startSession({
      conversationId: "conversation-3", projectId: "project-1", projectRoot: "/tmp/project",
    });
    const iterator = adapter.events(session.id)[Symbol.asyncIterator]();
    await adapter.send(session.id, { text: "ship it", projectRoot: "/tmp/project", mode: "execute" });

    const events: AgentEvent[] = [];
    // Two approvals reach the user: the permission widening and the legacy command approval. The MCP form does not.
    while (events.filter((event) => event.type === "permission.requested").length < 2) {
      const next = await iterator.next(); if (!next.done) events.push(next.value);
    }
    const widening = events.find((event) => event.type === "permission.requested");
    expect(widening?.type === "permission.requested" && widening.request).toMatchObject({
      id: "perm-1", kind: "network", title: "Access the network", risk: "high", detail: "Fetch the design tokens",
    });
    await adapter.respondToPermission(session.id, "perm-1", "allow_session");
    await adapter.respondToPermission(session.id, "legacy-1", "deny");
    while (!events.some((event) => event.type === "run.completed" || event.type === "run.failed")) {
      const next = await iterator.next(); if (!next.done) events.push(next.value);
    }
    const failure = events.find((event) => event.type === "run.failed");
    expect(failure?.type === "run.failed" ? failure.message : "completed").toBe("completed");
    await adapter.closeSession(session.id);
    await adapter.shutdown();
  });

  it("reports a missing executable without throwing discovery errors", async () => {
    const adapter = new CodexAdapter({ executable: "/definitely/missing/codex" });
    await expect(adapter.discover()).resolves.toMatchObject({ installed: false, available: false });
  });
});
