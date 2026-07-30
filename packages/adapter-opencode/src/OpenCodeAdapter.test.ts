import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { AsyncQueue, ProcessSupervisor, RestartPolicy } from "@waing/agent-core";
import type { AgentEvent, AgentRequest, PermissionDecision } from "@waing/domain";
import { OpenCodeAdapter } from "./OpenCodeAdapter";
import { SdkOpenCodeApi } from "./OpenCodeApi";
import type { OpenCodeApi, OpenCodeModel } from "./OpenCodeApi";
import { OpenCodeServer } from "./OpenCodeServer";

class FakeApi implements OpenCodeApi {
  readonly stream = new AsyncQueue<unknown>();
  readonly permissionResponses: Array<{ requestId: string; decision: PermissionDecision }> = [];
  readonly questionAnswers: Array<{ requestId: string; answers: string[][] }> = [];
  readonly questionRejections: string[] = [];
  prompts: AgentRequest[] = [];
  aborts = 0;

  createSession(): Promise<{ id: string }> { return Promise.resolve({ id: "ses-1" }); }
  loadSession(_root: string, id: string): Promise<{ id: string }> { return Promise.resolve({ id }); }
  prompt(_root: string, _id: string, request: AgentRequest): Promise<void> { this.prompts.push(request); return Promise.resolve(); }
  abort(): Promise<void> { this.aborts += 1; return Promise.resolve(); }
  respondToPermission(_root: string, _sessionId: string, requestId: string, decision: PermissionDecision): Promise<void> {
    this.permissionResponses.push({ requestId, decision }); return Promise.resolve();
  }
  respondToQuestion(_root: string, requestId: string, answers: string[][]): Promise<void> {
    this.questionAnswers.push({ requestId, answers }); return Promise.resolve();
  }
  rejectQuestion(_root: string, requestId: string): Promise<void> {
    this.questionRejections.push(requestId); return Promise.resolve();
  }
  events(_root: string, signal: AbortSignal): AsyncIterable<unknown> {
    signal.addEventListener("abort", () => this.stream.end(), { once: true }); return this.stream;
  }
  listModels(): Promise<OpenCodeModel[]> {
    return Promise.resolve([{ providerId: "openai", modelId: "gpt-test", displayName: "OpenAI · GPT Test" }]);
  }
}

class ReconnectingFakeApi extends FakeApi {
  attempts = 0;
  override events(root: string, signal: AbortSignal): AsyncIterable<unknown> {
    this.attempts += 1;
    if (this.attempts === 1) return { [Symbol.asyncIterator]: () => ({
      next: () => Promise.reject(new Error("temporary SSE disconnect")),
    }) };
    return super.events(root, signal);
  }
}

async function nextUntil(iterator: AsyncIterator<AgentEvent>, type: AgentEvent["type"]): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  while (!events.some((event) => event.type === type)) {
    const next = await iterator.next();
    if (next.done) throw new Error(`Event stream ended before ${type}`);
    events.push(next.value);
  }
  return events;
}

function testAdapter(api: FakeApi, version = "1.18.5", onClose: () => void = () => undefined): OpenCodeAdapter {
  return new OpenCodeAdapter({
    serverFactory: () => Promise.resolve({ baseUrl: "http://127.0.0.1:12345", password: "secret", version,
      close: () => { onClose(); return Promise.resolve(); } }),
    apiFactory: () => api,
  });
}

describe("OpenCodeAdapter", () => {
  it("normalizes SDK/SSE sessions, tools, permissions, diffs, usage, and completion", async () => {
    const api = new FakeApi();
    const adapter = testAdapter(api);
    const session = await adapter.startSession({ conversationId: "conversation-1", projectId: "project-1", projectRoot: "/tmp/project" });
    const iterator = adapter.events(session.id)[Symbol.asyncIterator]();
    await adapter.send(session.id, { text: "build it", projectRoot: "/tmp/project", mode: "execute", model: "openai/gpt-test" });
    api.stream.push({ type: "message.updated", properties: { info: { id: "msg-1", sessionID: "ses-1", role: "assistant" } } });
    api.stream.push({ type: "message.part.updated", properties: { delta: "hello", part: {
      id: "part-1", sessionID: "ses-1", messageID: "msg-1", type: "text", text: "hello",
    } } });
    api.stream.push({ type: "message.part.updated", properties: { part: {
      id: "tool-1", sessionID: "ses-1", messageID: "msg-1", type: "tool", tool: "bash",
      state: { status: "pending", input: { command: "npm test" } },
    } } });
    api.stream.push({ type: "message.part.updated", properties: { part: {
      id: "tool-1", sessionID: "ses-1", messageID: "msg-1", type: "tool", tool: "bash",
      state: { status: "running", title: "Running tests" },
    } } });
    api.stream.push({ type: "permission.asked", properties: { id: "per-1", sessionID: "ses-1",
      permission: "bash", title: "Run npm test", metadata: { command: "npm test" } } });
    const beforePermission = await nextUntil(iterator, "permission.requested");
    expect(beforePermission.map((event) => event.type)).toEqual([
      "run.started", "message.delta", "tool.started", "tool.progress", "permission.requested",
    ]);
    await adapter.respondToPermission(session.id, "per-1", "allow_once");
    expect(api.permissionResponses).toEqual([{ requestId: "per-1", decision: "allow_once" }]);
    api.stream.push({ type: "message.part.updated", properties: { part: {
      id: "tool-1", sessionID: "ses-1", messageID: "msg-1", type: "tool", tool: "bash",
      state: { status: "completed", output: "passed" },
    } } });
    api.stream.push({ type: "session.diff", properties: { sessionID: "ses-1", diff: [{ file: "src/a.ts",
      before: "const value = 1;\n", after: "const value = 2;\n", additions: 1, deletions: 1 }] } });
    api.stream.push({ type: "message.part.updated", properties: { part: {
      id: "step-1", sessionID: "ses-1", messageID: "msg-1", type: "step-finish", tokens: { input: 20, output: 5 },
    } } });
    api.stream.push({ type: "session.idle", properties: { sessionID: "ses-1" } });
    const afterPermission = await nextUntil(iterator, "run.completed");
    expect(afterPermission.map((event) => event.type)).toEqual([
      "permission.resolved", "tool.completed", "diff.updated", "usage.updated", "run.completed",
    ]);
    const diffEvent = afterPermission.find((event) => event.type === "diff.updated");
    expect(diffEvent?.type).toBe("diff.updated");
    if (diffEvent?.type === "diff.updated") expect(diffEvent.diff).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect([...beforePermission, ...afterPermission].map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(api.prompts).toHaveLength(1);
    await adapter.shutdown();
  });

  it("loads sessions, lists models, cancels, and shuts down the server", async () => {
    const api = new FakeApi(); let closed = false;
    const adapter = testAdapter(api, "1.18.5", () => { closed = true; });
    const session = await adapter.resumeSession({ conversationId: "c", projectId: "p", projectRoot: "/tmp/project",
      providerSessionId: "ses-resumed" });
    await expect(adapter.listModels()).resolves.toMatchObject([{ modelId: "openai/gpt-test" }]);
    await adapter.cancel(session.id);
    expect(api.aborts).toBe(1);
    await adapter.shutdown();
    expect(closed).toBe(true);
  });

  it("rejects an incompatible server before creating an API client", async () => {
    const api = new FakeApi(); let closed = false;
    const adapter = testAdapter(api, "2.0.0", () => { closed = true; });
    await expect(adapter.startSession({ conversationId: "c", projectId: "p", projectRoot: "/tmp" }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_VERSION" });
    expect(closed).toBe(true);
  });

  it("reports a missing executable during discovery", async () => {
    const adapter = new OpenCodeAdapter({ executable: "/definitely/missing/opencode" });
    await expect(adapter.discover()).resolves.toMatchObject({ installed: false, available: false });
  });

  it("reconnects the SSE stream with bounded backoff", async () => {
    const api = new ReconnectingFakeApi();
    const adapter = new OpenCodeAdapter({
      serverFactory: () => Promise.resolve({ baseUrl: "http://127.0.0.1:12345", password: "secret", version: "1.18.5",
        close: () => Promise.resolve() }),
      apiFactory: () => api,
      restartPolicy: new RestartPolicy({ maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 }),
    });
    await adapter.startSession({ conversationId: "c", projectId: "p", projectRoot: "/tmp" });
    for (let attempt = 0; attempt < 20 && api.attempts < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(api.attempts).toBe(2);
    await adapter.shutdown();
  });

  it("surfaces the question tool and answers it in the order OpenCode asked", async () => {
    const api = new FakeApi();
    const adapter = testAdapter(api);
    const session = await adapter.startSession({ conversationId: "c", projectId: "p", projectRoot: "/tmp/project" });
    const iterator = adapter.events(session.id)[Symbol.asyncIterator]();
    await adapter.send(session.id, { text: "plan it", projectRoot: "/tmp/project", mode: "plan" });
    api.stream.push({ type: "question.asked", properties: { id: "que-1", sessionID: "ses-1", questions: [
      { question: "Which theme?", header: "Theme", options: [{ label: "Dark", description: "Dark background" },
        { label: "Light", description: "Light background" }] },
      { question: "Which stack?", header: "Stack", multiple: true, options: [{ label: "Static", description: "No build" }] },
    ] } });
    const events = await nextUntil(iterator, "question.requested");
    expect(events.at(-1)).toMatchObject({ type: "question.requested", question: { id: "que-1", questions: [
      { header: "Theme", options: [{ label: "Dark" }, { label: "Light" }] },
      { header: "Stack", multiSelect: true },
    ] } });
    // The user answers only the second question; the first still needs a slot so the answers stay aligned.
    await adapter.respondToQuestion(session.id, "que-1", [{ header: "Stack", values: ["Static"] }]);
    expect(api.questionAnswers).toEqual([{ requestId: "que-1", answers: [[], ["Static"]] }]);
    api.stream.push({ type: "session.idle", properties: { sessionID: "ses-1" } });
    expect((await nextUntil(iterator, "run.completed")).map((event) => event.type))
      .toEqual(["question.resolved", "run.completed"]);
    await adapter.shutdown();
  });

  it("rejects a question it cannot show so the run is never left waiting on it", async () => {
    const api = new FakeApi();
    const adapter = testAdapter(api);
    const session = await adapter.startSession({ conversationId: "c", projectId: "p", projectRoot: "/tmp/project" });
    await adapter.send(session.id, { text: "plan it", projectRoot: "/tmp/project", mode: "plan" });
    // No options at all: nothing the card could render, and the provider is blocked until it hears back.
    api.stream.push({ type: "question.asked", properties: { id: "que-2", sessionID: "ses-1",
      questions: [{ question: "Pick one", header: "Pick", options: [] }] } });
    for (let attempt = 0; attempt < 50 && api.questionRejections.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(api.questionRejections).toEqual(["que-2"]);
    await adapter.shutdown();
  });

  it("names the server's exit reason instead of reporting a closed stream, and starts a fresh server after", async () => {
    const api = new FakeApi();
    // One flag per spawned server: a process that has exited never comes back, so only a new handle can be alive.
    const spawned: Array<{ alive: boolean }> = [];
    const adapter = new OpenCodeAdapter({
      serverFactory: () => {
        const server = { alive: true }; spawned.push(server);
        return Promise.resolve({ baseUrl: "http://127.0.0.1:12345", password: "secret", version: "1.18.5",
          isAlive: () => server.alive, close: () => Promise.resolve(),
          exitReason: () => server.alive ? undefined : "exited with code 1: out of memory" });
      },
      apiFactory: () => api,
      restartPolicy: new RestartPolicy({ maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 }),
    });
    const session = await adapter.startSession({ conversationId: "c", projectId: "p", projectRoot: "/tmp" });
    const iterator = adapter.events(session.id)[Symbol.asyncIterator]();
    await adapter.send(session.id, { text: "build it", projectRoot: "/tmp", mode: "execute" });
    // The SDK ends the stream cleanly when the process dies, which is exactly what a crash looks like from here.
    spawned[0]!.alive = false; api.stream.end();
    const events = await nextUntil(iterator, "run.failed");
    expect(events.at(-1)).toMatchObject({ type: "run.failed", code: "LOCAL_SERVER_FAILED",
      message: "OpenCode server exited with code 1: out of memory" });
    // A dead server is never handed out again, so the next session starts a working one.
    await adapter.startSession({ conversationId: "c2", projectId: "p", projectRoot: "/tmp" });
    expect(spawned).toHaveLength(2);
    await adapter.shutdown();
  });
});

describe("SdkOpenCodeApi", () => {
  it("authorizes the event stream, which the SDK opens outside the configured fetch", async () => {
    const authHeaders: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      authHeaders.push(request.headers.authorization);
      // The real server answers 401 without credentials, and the SDK turns that into a stream that quietly ends.
      if (request.headers.authorization === undefined) { response.writeHead(401); response.end(); return; }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
    });
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const { port } = server.address() as AddressInfo;
    const abort = new AbortController();
    try {
      const api = new SdkOpenCodeApi(`http://127.0.0.1:${String(port)}`, "secret");
      for await (const event of api.events("/tmp/project", abort.signal)) {
        expect(event).toMatchObject({ type: "server.connected" });
        break;
      }
      expect(authHeaders).toEqual([`Basic ${Buffer.from("waing:secret").toString("base64")}`]);
    } finally {
      abort.abort(); server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    }
  }, 10_000);
});

describe("OpenCodeServer", () => {
  it("uses a random password, loopback-only args, health validation, and supervised shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "waing-opencode-server-"));
    const executable = join(root, "fake-opencode");
    const capture = join(root, "capture.json");
    await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "--version") { console.log("1.18.5"); process.exit(0); }
fs.writeFileSync(process.env.WAING_CAPTURE, JSON.stringify({ args: process.argv.slice(2), username: process.env.OPENCODE_SERVER_USERNAME,
  password: process.env.OPENCODE_SERVER_PASSWORD }));
setInterval(() => {}, 1000);
`, "utf8");
    await chmod(executable, 0o755);
    const previousCapture = process.env.WAING_CAPTURE;
    process.env.WAING_CAPTURE = capture;
    const supervisor = new ProcessSupervisor();
    let auth = "";
    const server = new OpenCodeServer(executable, supervisor, (_input, init) => {
      auth = new Headers(init?.headers).get("authorization") ?? "";
      return Promise.resolve(new Response(JSON.stringify({ healthy: true, version: "1.18.5" }), { status: 200 }));
    }, () => Promise.resolve(48765));
    try {
      const handle = await server.start();
      expect(handle.baseUrl).toBe("http://127.0.0.1:48765");
      expect(handle.password).toHaveLength(43);
      expect(auth).toBe(`Basic ${Buffer.from(`waing:${handle.password}`).toString("base64")}`);
      let captured: { args: string[]; username: string; password: string } | undefined;
      for (let attempt = 0; attempt < 20 && captured === undefined; attempt += 1) {
        try { captured = JSON.parse(await readFile(capture, "utf8")) as typeof captured; }
        catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
      }
      expect(captured).toMatchObject({ args: ["serve", "--hostname", "127.0.0.1", "--port", "48765"],
        username: "waing", password: handle.password });
      await handle.close();
      expect(supervisor.activeCount).toBe(0);
    } finally {
      if (previousCapture === undefined) delete process.env.WAING_CAPTURE;
      else process.env.WAING_CAPTURE = previousCapture;
      await supervisor.shutdown();
    }
  });
});
