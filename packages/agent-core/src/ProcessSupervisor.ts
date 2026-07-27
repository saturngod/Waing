import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { AgentError } from "@waing/domain";

export interface ManagedProcess {
  readonly id: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly stderr: readonly string[];
  stop(graceMs?: number): Promise<void>;
}

export class ProcessSupervisor {
  private readonly processes = new Map<string, ManagedProcess>();
  private nextId = 0;

  spawn(executable: string, args: readonly string[], options: SpawnOptionsWithoutStdio = {}): ManagedProcess {
    const id = `process-${++this.nextId}`;
    const stderr: string[] = [];
    const child = spawn(executable, [...args], { ...options, shell: false, stdio: "pipe" });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderr.push(chunk));

    let stopPromise: Promise<void> | undefined;
    const managed: ManagedProcess = {
      id,
      child,
      stderr,
      stop: async (graceMs = 2_000) => {
        if (child.exitCode !== null) return;
        if (stopPromise !== undefined) return stopPromise;
        stopPromise = new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
          }, graceMs);
          timer.unref();
          child.once("exit", () => { clearTimeout(timer); resolve(); });
          child.kill("SIGTERM");
        });
        return stopPromise;
      },
    };
    this.processes.set(id, managed);
    child.once("exit", () => this.processes.delete(id));
    child.once("error", () => this.processes.delete(id));
    return managed;
  }

  async waitForExit(process: ManagedProcess): Promise<number> {
    if (process.child.exitCode !== null) return process.child.exitCode;
    return new Promise((resolve, reject) => {
      process.child.once("error", (cause) => reject(new AgentError(
        "PROCESS_FAILED", `Failed to start child process: ${cause.message}`, undefined, true,
      )));
      process.child.once("exit", (code, signal) => {
        if (code === 0) resolve(code);
        else reject(new AgentError(
          "PROCESS_FAILED", `Child process exited with ${code ?? signal ?? "unknown status"}`, undefined, true,
        ));
      });
    });
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.processes.values()].map((process) => process.stop()));
  }

  get activeCount(): number { return this.processes.size; }
}
