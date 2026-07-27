import { randomUUID } from "node:crypto";
import type { AgentManager } from "@waing/agent-core";
import { AgentError } from "@waing/domain";
import type { AgentEvent } from "@waing/domain";
import { parseRouterJson } from "./parseRouterJson";
import type { RouterClient } from "./RouterManager";

export interface AgentRouterClientOptions {
  agents: AgentManager;
  /** Provider that runs the routing prompt — whatever the Router role profile points at. */
  agentId: string;
  projectId: string;
  projectRoot: string;
  model?: string;
  /** Called with each routing session id so the host can keep router chatter out of the chat transcript. */
  onSession?: (sessionId: string) => void;
}

/**
 * Runs routing through any registered provider instead of assuming OpenCode. The prompt forbids tool use, but unlike
 * `OpenCodeRouterClient` this cannot switch tools off at the protocol level, so it is the general fallback for
 * providers that expose no such control.
 */
export class AgentRouterClient implements RouterClient {
  readonly id: string;
  private readonly sessionIds = new Set<string>();

  constructor(private readonly options: AgentRouterClientOptions) { this.id = `${options.agentId}-router`; }

  async classify(prompt: string): Promise<unknown> {
    const agent = this.options.agents.registry.get(this.options.agentId);
    const { capabilities } = await agent.discover();
    const session = await this.options.agents.startSession(this.options.agentId, {
      conversationId: `router-${randomUUID()}`, projectId: this.options.projectId, projectRoot: this.options.projectRoot });
    this.sessionIds.add(session.id);
    this.options.onSession?.(session.id);
    let text = "";
    let settle: ((event: AgentEvent) => void) | undefined;
    const terminal = new Promise<AgentEvent>((resolve) => { settle = resolve; });
    const unsubscribe = this.options.agents.eventBus.subscribe((event) => {
      if (event.sessionId !== session.id) return;
      if (event.type === "message.delta") text += event.text;
      if (event.type === "message.completed") text = event.text;
      if (event.type === "run.completed" || event.type === "run.failed") settle?.(event);
    });
    try {
      await this.options.agents.send(session.id, { text: prompt, projectRoot: this.options.projectRoot,
        // Plan mode keeps a capable provider read-only; anything without it is held to the prompt's own restrictions.
        mode: capabilities.planMode ? "plan" : "execute",
        ...(capabilities.modelSelection && this.options.model !== undefined ? { model: this.options.model } : {}) });
      const event = await terminal;
      if (event.type === "run.failed") throw new AgentError("ROUTER_FAILED", event.message, this.id, event.retryable);
      return parseRouterJson(text, this.id);
    } finally {
      unsubscribe();
      await this.closeSession(session.id);
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessionIds].map((sessionId) => this.closeSession(sessionId)));
  }

  private async closeSession(sessionId: string): Promise<void> {
    this.sessionIds.delete(sessionId);
    try { await this.options.agents.registry.get(this.options.agentId).closeSession(sessionId); }
    catch { /* a routing session that never opened cannot block the workflow */ }
  }
}
