/**
 * Shapes emitted by `agy --output-format stream-json`, kept in this package so raw CLI payloads never leak outward.
 * One JSON object per line: an `init` header, a `step_update` per step transition, then a final `result`.
 */
export interface AntigravityUsage { input_tokens?: number; output_tokens?: number; total_tokens?: number }
export interface AntigravityStepUpdate {
  conversation_id?: string; step_index?: number; state?: string; step_type?: string; text_delta?: string;
  tool_name?: string; tool_info?: { name?: string; parameters?: Record<string, unknown> }; usage?: AntigravityUsage;
}
export interface AntigravityResult {
  conversation_id?: string; status?: string; response?: string; usage?: AntigravityUsage; error?: string;
}
export type AntigravityStreamLine =
  | { event: "init"; conversation_id?: string; init?: { cwd?: string; permission_mode?: string; tools?: string[] } }
  | { event: "step_update"; step_update?: AntigravityStepUpdate }
  | { event: "result"; result?: AntigravityResult }
  | { event: string };

export function parseAntigravityLine(line: string): AntigravityStreamLine | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as AntigravityStreamLine;
    return typeof parsed.event === "string" ? parsed : undefined;
  } catch { return undefined; }
}

/** Tool names whose parameters name a file the run touched, so file events can be derived from tool steps. */
const READ_TOOLS = new Set(["view_file", "read_url_content", "notebook_execution"]);
const WRITE_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit"]);
const PATH_KEYS = ["TargetFile", "target_file", "AbsolutePath", "path", "file"];
const COMMAND_KEYS = ["CommandLine", "Command", "command"];

export function toolPath(parameters: Record<string, unknown> | undefined): string | undefined {
  for (const key of PATH_KEYS) { const value = parameters?.[key]; if (typeof value === "string" && value.length > 0) return value; }
  return undefined;
}
export function toolCommand(parameters: Record<string, unknown> | undefined): string | undefined {
  for (const key of COMMAND_KEYS) { const value = parameters?.[key]; if (typeof value === "string" && value.length > 0) return value; }
  return undefined;
}
export const isReadTool = (tool: string): boolean => READ_TOOLS.has(tool);
export const isWriteTool = (tool: string): boolean => WRITE_TOOLS.has(tool);
export const isCommandTool = (tool: string): boolean => tool === "run_command";
