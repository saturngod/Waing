import { AgentError, routerCheckpointInputSchema, routerOrchestrationDecisionSchema, routingDecisionSchema, routingInputSchema, routingPolicySchema } from "@waing/domain";
import type {
  AutoSelection, ConfidenceFallback, ExecutionWorkflowRole, RouteResolution, RouterCheckpointInput,
  RouterOrchestrationDecision, RoutingDecision, RoutingInput, RoutingPolicy,
} from "@waing/domain";
import { buildOrchestrationPrompt, buildRoutingPrompt } from "./RoutingPrompt";

const DECISION_FIELDS = ["action", "complexity", "taskType", "effortHint", "document", "statusIntent", "rationale",
  "confidence"] as const;

/**
 * Drops keys the strict decision schema would reject. A chatty extra field ("reason", "notes") is a formatting slip,
 * not a routing error, so it must not fail a run; anything required is still validated afterwards.
 */
function pickDecisionFields(candidate: unknown): unknown {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return candidate;
  const source = candidate as Record<string, unknown>;
  return Object.fromEntries(DECISION_FIELDS.filter((field) => source[field] !== undefined)
    .map((field) => [field, source[field]]));
}

export interface RouterClient {
  readonly id: string;
  classify(prompt: string): Promise<unknown>;
}

export interface TaskRouter {
  readonly id: string;
  classify(input: RoutingInput): Promise<RoutingDecision>;
  decideNext(input: RouterCheckpointInput): Promise<RouterOrchestrationDecision>;
}

export interface RouteOptions {
  confidenceThreshold?: number;
  confidenceFallback?: ConfidenceFallback;
  timeoutMs?: number;
}

export class RouterManager implements TaskRouter {
  readonly id: string;
  constructor(private readonly client: RouterClient, private readonly defaultTimeoutMs = 15_000) { this.id = client.id; }

  async classify(input: RoutingInput, timeoutMs = this.defaultTimeoutMs): Promise<RoutingDecision> {
    const validatedInput = routingInputSchema.parse(input);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const candidate = await Promise.race([
        this.client.classify(buildRoutingPrompt(validatedInput)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new AgentError("TIMEOUT", `Router ${this.id} timed out`, this.id, true)), timeoutMs);
        }),
      ]);
      const parsed = routingDecisionSchema.safeParse(candidate);
      if (!parsed.success) throw new AgentError("ROUTER_INVALID_OUTPUT",
        `Router returned invalid output: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`, this.id, true);
      return parsed.data;
    } catch (cause) {
      if (cause instanceof AgentError) throw cause;
      throw new AgentError("ROUTER_FAILED", cause instanceof Error ? cause.message : "Router failed", this.id, true);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async decideNext(input: RouterCheckpointInput, timeoutMs = this.defaultTimeoutMs): Promise<RouterOrchestrationDecision> {
    const checkpoint = routerCheckpointInputSchema.parse(input);
    try {
      // Models routinely add a stray field or drop statusIntent, so the first rejection is fed back once as a
      // correction before the run is failed. Both attempts share the per-call timeout budget.
      let issues: string | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const candidate = await this.ask(buildOrchestrationPrompt(checkpoint, issues), timeoutMs);
        const parsed = routerOrchestrationDecisionSchema.safeParse(pickDecisionFields(candidate));
        if (parsed.success) {
          if (!checkpoint.allowedActions.includes(parsed.data.action)) throw new AgentError("ROUTER_INVALID_OUTPUT",
            `Router action ${parsed.data.action} is not allowed at this checkpoint`, this.id, true);
          return parsed.data;
        }
        issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
      }
      throw new AgentError("ROUTER_INVALID_OUTPUT",
        `Router returned invalid orchestration output: ${issues ?? "unknown validation failure"}`, this.id, true);
    } catch (cause) {
      if (cause instanceof AgentError) throw cause;
      throw new AgentError("ROUTER_FAILED", cause instanceof Error ? cause.message : "Router failed", this.id, true);
    }
  }

  private async ask(prompt: string, timeoutMs: number): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.client.classify(prompt), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AgentError("TIMEOUT", `Router ${this.id} timed out`, this.id, true)), timeoutMs);
      })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  resolve(decision: RoutingDecision, policy: RoutingPolicy): RouteResolution {
    const validated = routingDecisionSchema.parse(decision);
    const validatedPolicy = routingPolicySchema.parse(policy);
    const matching = validatedPolicy.rules.filter((rule) => rule.enabled &&
      (rule.match.complexity === undefined || rule.match.complexity === validated.complexity) &&
      (rule.match.taskType === undefined || rule.match.taskType === validated.taskType) &&
      (rule.match.mode === undefined || rule.match.mode === validated.mode))
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
    const rule = matching[0];
    return { routingDecision: validated, role: rule?.targetRole ?? validatedPolicy.defaultRole,
      ...(rule === undefined ? {} : { matchedRuleId: rule.id }) };
  }

  async route(input: RoutingInput, policy: RoutingPolicy, options: RouteOptions = {}): Promise<AutoSelection> {
    const decision = await this.classify(input, options.timeoutMs);
    const threshold = options.confidenceThreshold ?? 0.65;
    if (decision.confidence >= threshold) return { status: "resolved", resolution: this.resolve(decision, policy) };
    const fallback = options.confidenceFallback ?? "use_default_role";
    if (fallback === "ask_user") return { status: "needs_confirmation", decision, suggestedRole: policy.defaultRole };
    const role: ExecutionWorkflowRole = fallback === "use_safest_route" ? this.safestRole(policy) : policy.defaultRole;
    return { status: "resolved", resolution: { routingDecision: decision, role }, confidenceFallbackApplied: fallback };
  }

  private safestRole(policy: RoutingPolicy): ExecutionWorkflowRole {
    const highRule = policy.rules.filter((rule) => rule.enabled && rule.match.complexity === "high")
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))[0];
    return highRule?.targetRole ?? "high";
  }
}

export type AgentSelection = { type: "auto" } | { type: "agent"; agentId: string };
export type SelectionResult = { type: "direct"; agentId: string } | { type: "routed"; selection: AutoSelection };

export class AutoSelector {
  constructor(private readonly router: RouterManager) {}
  async select(selection: AgentSelection, input: RoutingInput, policy: RoutingPolicy, options?: RouteOptions): Promise<SelectionResult> {
    if (selection.type === "agent") return { type: "direct", agentId: selection.agentId };
    return { type: "routed", selection: await this.router.route(input, policy, options) };
  }
}
