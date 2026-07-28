import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { AgentError } from "@waing/domain";
import { ProcessSupervisor, probeVersion, resolveExecutable } from "@waing/agent-core";
import type { ManagedProcess } from "@waing/agent-core";

export interface OpenCodeServerHandle {
  baseUrl: string;
  password: string;
  version: string;
  /** False once the process has exited. A dead server still answers every cached reference, so callers ask first. */
  isAlive?(): boolean;
  /** Exit status plus the tail of stderr — the only record of why the server went away. */
  exitReason?(): string | undefined;
  close(): Promise<void>;
}

export async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(); reject(new Error("Failed to allocate a loopback port")); return;
      }
      server.close((error) => error === undefined ? resolve(address.port) : reject(error));
    });
  });
}

/**
 * A crashed server is indistinguishable from a closed connection at the HTTP layer, so its exit status and last words
 * are the only thing that tells the user whether OpenCode died and why.
 */
function exitReason(managed: ManagedProcess): string | undefined {
  const { exitCode, signalCode } = managed.child;
  if (exitCode === null && signalCode === null) return undefined;
  const tail = managed.stderr.join("").trim().split("\n").slice(-3).join(" ").slice(0, 300);
  return `exited with ${signalCode ?? `code ${String(exitCode)}`}${tail.length === 0 ? "" : `: ${tail}`}`;
}

export class OpenCodeServer {
  private process?: ManagedProcess;

  constructor(
    private readonly executable = "opencode",
    private readonly supervisor = new ProcessSupervisor(),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly portAllocator: () => Promise<number> = allocateLoopbackPort,
  ) {}

  async discover(): Promise<{ path: string; version: string }> {
    const path = await resolveExecutable(this.executable);
    return { path, version: await probeVersion(this.supervisor, path, ["--version"]) };
  }

  async start(): Promise<OpenCodeServerHandle> {
    const discovered = await this.discover();
    const port = await this.portAllocator();
    const password = randomBytes(32).toString("base64url");
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    const managed = this.supervisor.spawn(discovered.path,
      ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
        env: { ...process.env, OPENCODE_SERVER_USERNAME: "waing", OPENCODE_SERVER_PASSWORD: password },
      });
    this.process = managed;
    const authorization = `Basic ${Buffer.from(`waing:${password}`).toString("base64")}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (managed.child.exitCode !== null) break;
      try {
        const response = await this.fetchImpl(`${baseUrl}/global/health`, {
          headers: { authorization }, signal: AbortSignal.timeout(250),
        });
        if (response.ok) {
          const health = await response.json() as { healthy?: unknown; version?: unknown };
          if (health.healthy === true && typeof health.version === "string") return {
            baseUrl, password, version: health.version,
            isAlive: () => managed.child.exitCode === null && managed.child.signalCode === null,
            exitReason: () => exitReason(managed),
            close: () => this.stop(),
          };
        }
      } catch (error) { lastError = error; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await this.stop();
    throw new AgentError("PROCESS_FAILED", `OpenCode server failed its health check${
      lastError instanceof Error ? `: ${lastError.message}` : ""}`, "opencode", true);
  }

  async stop(): Promise<void> { await this.process?.stop(); delete this.process; }
}
