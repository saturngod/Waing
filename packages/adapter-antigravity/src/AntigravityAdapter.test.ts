import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@waing/domain";
import { AntigravityAdapter } from "./AntigravityAdapter";

/** Writes a stand-in `agy` that records its argv and replays a scripted stdout/exit code. */
async function fakeCli(body: string): Promise<{ path: string; argsFile: string }> {
  const directory = await mkdtemp(join(tmpdir(), "waing-antigravity-"));
  const argsFile = join(directory, "args.txt");
  const path = join(directory, "agy");
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${argsFile}\n${body}\n`, "utf8");
  await chmod(path, 0o755);
  return { path, argsFile };
}

/** One JSONL line per stream event, quoted for the fake CLI's `printf`. */
function streamScript(lines: object[]): string {
  const payload = lines.map((line) => JSON.stringify(line).replaceAll("'", "'\\''")).join("\n");
  return `case "$1" in --version) echo "1.1.7";; models) printf 'gemini-3.6-flash-high\\nclaude-sonnet-4-6\\n';; *) printf '%s\\n' '${payload}';; esac`;
}

const RUN_STREAM = [
  { event: "init", conversation_id: "conv-1", init: { cwd: "/tmp", permission_mode: "request-review", tools: ["write_to_file"] } },
  { event: "step_update", step_update: { step_index: 0, state: "DONE", step_type: "user_input" } },
  { event: "step_update", step_update: { step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "Working on it. " } },
  { event: "step_update", step_update: { step_index: 3, state: "ACTIVE", step_type: "tool", tool_name: "write_to_file",
    tool_info: { name: "write_to_file", parameters: { TargetFile: "/tmp/site/index.html" } } } },
  { event: "step_update", step_update: { step_index: 3, state: "DONE", step_type: "tool", tool_name: "write_to_file",
    tool_info: { name: "write_to_file", parameters: { TargetFile: "/tmp/site/index.html" } } } },
  { event: "step_update", step_update: { step_index: 5, state: "DONE", step_type: "agent_response", text_delta: "Done." } },
  { event: "result", result: { conversation_id: "conv-1", status: "SUCCESS", response: "Working on it. Done.",
    usage: { input_tokens: 12_192, output_tokens: 468, total_tokens: 12_660 } } },
];

/**
 * Collects events until `runs` runs have finished. Breaking out of the iteration ends the underlying queue, so a
 * multi-turn assertion has to keep one iteration open across both turns.
 */
async function drain(events: AsyncIterable<AgentEvent>, runs = 1): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  let finished = 0;
  for await (const event of events) {
    collected.push(event);
    if (event.type === "run.completed" || event.type === "run.failed") { finished += 1; if (finished === runs) break; }
  }
  return collected;
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the fake CLI");
}

describe("AntigravityAdapter", () => {
  it("reports the CLI version and warns that print mode approves its own tools", async () => {
    const { path } = await fakeCli(`case "$1" in --version) echo "1.1.7";; esac`);
    const descriptor = await new AntigravityAdapter({ executable: path }).discover();
    expect(descriptor).toMatchObject({ id: "antigravity", installed: true, available: true, version: "1.1.7" });
    expect(descriptor.capabilities).toMatchObject({ planMode: true, effortControl: true, modelSelection: true,
      persistentSessions: true, interactivePermissions: false });
    expect(descriptor.warnings[0]).toMatch(/approves its own tool calls/u);
  });

  it("lists the CLI's models and marks the first as the default", async () => {
    const { path } = await fakeCli(streamScript([]));
    const models = await new AntigravityAdapter({ executable: path }).listModels();
    expect(models.map((model) => model.modelId)).toEqual(["gemini-3.6-flash-high", "claude-sonnet-4-6"]);
    expect(models[0]).toMatchObject({ isDefault: true, effortLevels: ["low", "medium", "high"] });
  });

  it("falls back to the provider default when `agy models` stalls", async () => {
    const { path } = await fakeCli(`case "$1" in --version) echo "1.1.7";; models) sleep 30;; esac`);
    const models = await new AntigravityAdapter({ executable: path, modelListTimeoutMs: 300 }).listModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ modelId: "default", isDefault: true });
    expect(models[0]?.warnings?.[0]).toMatch(/agy models/u);
  });

  it("normalizes the stream-json protocol into message, tool, file, and usage events", async () => {
    const { path, argsFile } = await fakeCli(streamScript(RUN_STREAM));
    const adapter = new AntigravityAdapter({ executable: path });
    const session = await adapter.startSession({ conversationId: "c1", projectId: "p1", projectRoot: tmpdir() });
    const events = drain(adapter.events(session.id));
    await adapter.send(session.id, { text: "Build the site", projectRoot: tmpdir(), mode: "plan",
      model: "gemini-3.6-flash-high", effort: "max" });
    const collected = await events;

    expect(collected.map((event) => event.type)).toEqual(["run.started", "message.delta", "tool.started",
      "file.changed", "tool.completed", "message.delta", "usage.updated", "message.completed", "run.completed"]);
    expect(collected.find((event) => event.type === "file.changed")).toMatchObject({ path: "/tmp/site/index.html", change: "updated" });
    expect(collected.find((event) => event.type === "usage.updated")).toMatchObject({ inputTokens: 12_192, outputTokens: 468 });
    expect(collected.find((event) => event.type === "message.completed")).toMatchObject({ text: "Working on it. Done." });

    // The args file also holds the `--version` probe, so the run's own argv starts at its stream-json flag.
    const recorded = (await readFile(argsFile, "utf8")).trim().split("\n");
    const argv = recorded.slice(recorded.lastIndexOf("--output-format"));
    expect(argv.slice(0, 6)).toEqual(["--output-format", "stream-json", "--print", "Build the site", "--add-dir", tmpdir()]);
    // Waing's `max` has no CLI equivalent, and plan is the only mode the CLI models directly.
    expect(argv[argv.indexOf("--effort") + 1]).toBe("high");
    expect(argv[argv.indexOf("--mode") + 1]).toBe("plan");
    expect(argv[argv.indexOf("--model") + 1]).toBe("gemini-3.6-flash-high");
    await adapter.closeSession(session.id);
  });

  it("reuses the conversation id so a second turn keeps its context", async () => {
    const { path, argsFile } = await fakeCli(streamScript(RUN_STREAM));
    const adapter = new AntigravityAdapter({ executable: path });
    const session = await adapter.startSession({ conversationId: "c1", projectId: "p1", projectRoot: tmpdir() });
    const bothRuns = drain(adapter.events(session.id), 2);
    await adapter.send(session.id, { text: "First", projectRoot: tmpdir(), mode: "execute" });
    await waitFor(async () => (await readFile(argsFile, "utf8")).includes("First"));
    await adapter.send(session.id, { text: "Second", projectRoot: tmpdir(), mode: "execute" });
    await bothRuns;
    const argv = (await readFile(argsFile, "utf8")).trim().split("\n");
    expect(argv.filter((value) => value === "--conversation")).toHaveLength(1);
    expect(argv[argv.lastIndexOf("--conversation") + 1]).toBe("conv-1");
    await adapter.closeSession(session.id);
  });

  it("maps a non-success result to a typed failure", async () => {
    const { path } = await fakeCli(streamScript([
      { event: "init", conversation_id: "conv-2" },
      { event: "result", result: { status: "ERROR", error: "quota exhausted" } },
    ]));
    const adapter = new AntigravityAdapter({ executable: path });
    const session = await adapter.startSession({ conversationId: "c1", projectId: "p1", projectRoot: tmpdir() });
    const events = drain(adapter.events(session.id));
    await adapter.send(session.id, { text: "Build", projectRoot: tmpdir(), mode: "execute" });
    const failure = (await events).at(-1);
    expect(failure).toMatchObject({ type: "run.failed", code: "PROCESS_FAILED", message: "quota exhausted" });
    await adapter.closeSession(session.id);
  });

  it("surfaces the CLI's own stderr when the process dies without a result", async () => {
    const { path } = await fakeCli(`case "$1" in --version) echo "1.1.7";; *) echo "auth expired" >&2; exit 3;; esac`);
    const adapter = new AntigravityAdapter({ executable: path });
    const session = await adapter.startSession({ conversationId: "c1", projectId: "p1", projectRoot: tmpdir() });
    const events = drain(adapter.events(session.id));
    await adapter.send(session.id, { text: "Build", projectRoot: tmpdir(), mode: "execute" });
    const failure = (await events).at(-1);
    expect(failure?.type === "run.failed" && failure.message).toMatch(/auth expired/u);
    await adapter.closeSession(session.id);
  });

  it("reports a missing CLI as not installed instead of throwing", async () => {
    const descriptor = await new AntigravityAdapter({ executable: "/nonexistent/agy" }).discover();
    expect(descriptor).toMatchObject({ installed: false, available: false, authState: "missing" });
  });
});
