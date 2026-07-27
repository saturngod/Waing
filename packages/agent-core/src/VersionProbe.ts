import type { ProcessSupervisor } from "./ProcessSupervisor";

export async function probeVersion(
  supervisor: ProcessSupervisor,
  executable: string,
  args: readonly string[] = ["--version"],
  timeoutMs = 5_000,
): Promise<string> {
  const process = supervisor.spawn(executable, args);
  process.child.stdout.setEncoding("utf8");
  let output = "";
  process.child.stdout.on("data", (chunk: string) => { output += chunk; });
  const timeout = setTimeout(() => { void process.stop(100); }, timeoutMs);
  timeout.unref();
  try {
    await supervisor.waitForExit(process);
    return output.trim();
  } finally {
    clearTimeout(timeout);
  }
}
