import { AgentError } from "@waing/domain";
import type { CodingAgent } from "./CodingAgent";

export class AgentRegistry {
  private readonly agents = new Map<string, CodingAgent>();

  register(agent: CodingAgent): void {
    if (this.agents.has(agent.id)) throw new Error(`Agent already registered: ${agent.id}`);
    this.agents.set(agent.id, agent);
  }

  get(agentId: string): CodingAgent {
    const agent = this.agents.get(agentId);
    if (agent === undefined) throw new AgentError("NOT_INSTALLED", `Agent is not registered: ${agentId}`, agentId);
    return agent;
  }

  list(): CodingAgent[] {
    return [...this.agents.values()];
  }
}
