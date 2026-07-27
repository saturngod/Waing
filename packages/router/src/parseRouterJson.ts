import { AgentError } from "@waing/domain";

/**
 * Extracts the JSON object a routing model returned. CLIs wrap answers in fences or add a sentence around them, so the
 * outermost braces are used rather than requiring the whole reply to be valid JSON.
 */
export function parseRouterJson(output: string, routerId: string): unknown {
  const trimmed = output.trim();
  const unfenced = trimmed.startsWith("```") ? trimmed.replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "") : trimmed;
  const start = unfenced.indexOf("{"); const end = unfenced.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;
  try { return JSON.parse(candidate) as unknown; }
  catch (cause) {
    throw new AgentError("ROUTER_INVALID_OUTPUT",
      `Router ${routerId} did not return JSON: ${cause instanceof Error ? cause.message : "parse failure"}`, routerId, true);
  }
}
