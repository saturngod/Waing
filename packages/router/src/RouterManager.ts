import { AgentError, routerCheckpointInputSchema, routerOrchestrationDecisionSchema, stepAnnouncementIntentSchema } from "@waing/domain";
import type { RouterCheckpointInput, RouterOrchestrationDecision } from "@waing/domain";
import { buildOrchestrationPrompt } from "./RoutingPrompt";

const DECISION_FIELDS = ["action", "agentProfileId", "effortHint", "statusIntent", "rationale", "confidence"] as const;
function pickDecisionFields(candidate: unknown): unknown {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return candidate;
  const source = candidate as Record<string, unknown>;
  const decision = Object.fromEntries(DECISION_FIELDS.filter((field) => source[field] !== undefined).map((field) => [field, source[field]]));
  const intent = stepAnnouncementIntentSchema.safeParse(source.statusIntent);
  if (intent.success) decision.statusIntent = intent.data;
  else decision.statusIntent = { activity: source.action === "ask_user" ? "waiting_for_user" : "implementing" };
  return decision;
}
export interface RouterClient { readonly id: string; classify(prompt: string): Promise<unknown> }
export interface TaskRouter { readonly id: string; decideNext(input: RouterCheckpointInput): Promise<RouterOrchestrationDecision> }

export class RouterManager implements TaskRouter {
  readonly id: string;
  constructor(private readonly client: RouterClient, private readonly defaultTimeoutMs = 15_000) { this.id = client.id; }
  async decideNext(input: RouterCheckpointInput, timeoutMs = this.defaultTimeoutMs): Promise<RouterOrchestrationDecision> {
    const checkpoint = routerCheckpointInputSchema.parse(input);
    try {
      let issues: string | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const candidate = await this.ask(buildOrchestrationPrompt(checkpoint, issues), timeoutMs);
        const parsed = routerOrchestrationDecisionSchema.safeParse(pickDecisionFields(candidate));
        if (parsed.success) {
          if (!checkpoint.allowedActions.includes(parsed.data.action)) throw new AgentError("ROUTER_INVALID_OUTPUT", `Router action ${parsed.data.action} is not allowed at this checkpoint`, this.id, true);
          if (parsed.data.agentProfileId !== undefined && !checkpoint.availableAgents.some((agent) => agent.id === parsed.data.agentProfileId))
            throw new AgentError("ROUTER_INVALID_OUTPUT", `Router selected unavailable agent ${parsed.data.agentProfileId}`, this.id, true);
          return parsed.data;
        }
        issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
      }
      throw new AgentError("ROUTER_INVALID_OUTPUT", `Router returned invalid orchestration output: ${issues ?? "unknown validation failure"}`, this.id, true);
    } catch (cause) {
      if (cause instanceof AgentError) throw cause;
      throw new AgentError("ROUTER_FAILED", cause instanceof Error ? cause.message : "Router failed", this.id, true);
    }
  }
  private async ask(prompt: string, timeoutMs: number): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([this.client.classify(prompt), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new AgentError("TIMEOUT", `Router ${this.id} timed out`, this.id, true)), timeoutMs);
    })]); } finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
