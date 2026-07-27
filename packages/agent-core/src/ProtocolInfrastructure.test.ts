import { describe, expect, it } from "vitest";
import { JsonlParser } from "./JsonlParser";
import { JsonRpcTransport } from "./JsonRpcTransport";
import { ProcessSupervisor } from "./ProcessSupervisor";
import { probeVersion } from "./VersionProbe";

describe("JsonlParser", () => {
  it("handles split chunks and isolates malformed lines", () => {
    const values: unknown[] = [];
    const errors: string[] = [];
    const parser = new JsonlParser((value) => values.push(value), (_error, line) => errors.push(line));
    parser.push('{"ok":');
    parser.push('true}\nnot-json\n{"second":2}');
    parser.finish();
    expect(values).toEqual([{ ok: true }, { second: 2 }]);
    expect(errors).toEqual(["not-json"]);
  });
});

const fakeRpcScript = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let parentId;
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "ping") {
    process.stdout.write("not-json\n");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { pong: message.params } }) + "\n");
  } else if (message.method === "roundtrip") {
    parentId = message.id;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "permission", params: { value: 4 } }) + "\n");
  } else if (message.id === 99) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: parentId, result: message.result }) + "\n");
  } else if (message.method === "stop") {
    process.exit(0);
  }
});
`;

const retryRpcScript = String.raw`
const readline = require("node:readline"); let attempts = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line); attempts += 1;
  if (attempts > 1) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: "retried" }) + "\n");
});
`;

describe("process and JSON-RPC infrastructure", () => {
  it("supports requests, malformed-line isolation, and server requests", async () => {
    const supervisor = new ProcessSupervisor();
    const managed = supervisor.spawn(process.execPath, ["-e", fakeRpcScript]);
    const transport = new JsonRpcTransport(managed);
    transport.handle("permission", (params) => ({ approved: true, params }));

    await expect(transport.request("ping", "hello")).resolves.toEqual({ pong: "hello" });
    expect(transport.protocolErrors).toHaveLength(1);
    await expect(transport.request("roundtrip")).resolves.toEqual({
      approved: true, params: { value: 4 },
    });
    transport.notify("stop");
    await supervisor.waitForExit(managed);
    expect(supervisor.activeCount).toBe(0);
  });

  it("turns crashes into typed failures and cleans up children", async () => {
    const supervisor = new ProcessSupervisor();
    const child = supervisor.spawn(process.execPath, ["-e", 'console.error("boom"); process.exit(7)']);
    await expect(supervisor.waitForExit(child)).rejects.toMatchObject({ code: "PROCESS_FAILED" });
    expect(child.stderr.join("")).toContain("boom");
    await supervisor.shutdown();
    expect(supervisor.activeCount).toBe(0);
  });

  it("cancels pending requests and terminates the managed process", async () => {
    const supervisor = new ProcessSupervisor();
    const child = supervisor.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    const transport = new JsonRpcTransport(child);
    const pending = transport.request("never-returns", undefined, 60_000);
    transport.close();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    await supervisor.shutdown();
    expect(supervisor.activeCount).toBe(0);
  });

  it("probes versions without shell interpolation", async () => {
    const supervisor = new ProcessSupervisor();
    await expect(probeVersion(supervisor, process.execPath, ["--version"])).resolves.toMatch(/^v\d+/);
    expect(supervisor.activeCount).toBe(0);
  });

  it("retries only when explicitly requested after a bounded timeout", async () => {
    const supervisor = new ProcessSupervisor(); const child = supervisor.spawn(process.execPath, ["-e", retryRpcScript]);
    const transport = new JsonRpcTransport(child);
    await expect(transport.requestWithRetry("safe/read", undefined, { timeoutMs: 100, retries: 1, retryDelayMs: 0 }))
      .resolves.toBe("retried");
    transport.close(); await supervisor.shutdown();
  });
});
