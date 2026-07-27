import { AgentError } from "@waing/domain";
import type { WorkflowContext, WorkflowRun } from "@waing/domain";
import type { WorkflowEngine, WorkflowStartInput } from "./WorkflowEngine";
import type { WorkflowRepository } from "./WorkflowRepository";

export class WorkflowRunCoordinator {
  private active?: WorkflowEngine;
  constructor(private readonly repository: WorkflowRepository, private readonly engineFactory: () => WorkflowEngine) {}

  async start(input: WorkflowStartInput): Promise<{ run: WorkflowRun; context: WorkflowContext }> {
    if (this.active !== undefined) throw new AgentError("PROTOCOL_ERROR", "A workflow run is already active");
    const engine = this.engineFactory(); this.active = engine;
    try { return await engine.run(input); } finally { delete this.active; }
  }
  pause(): void { this.requireActive().pause(); }
  resume(): void { this.requireActive().resume(); }
  async cancel(): Promise<void> { await this.requireActive().cancel(); }
  async recoverSnapshot(runId: string): Promise<{ run: WorkflowRun; context: WorkflowContext }> {
    const snapshot = await this.repository.loadRun(runId);
    if (snapshot === undefined) throw new AgentError("SESSION_NOT_FOUND", `Unknown workflow run ${runId}`);
    return snapshot;
  }
  private requireActive(): WorkflowEngine {
    if (this.active === undefined) throw new AgentError("SESSION_NOT_FOUND", "No active workflow run"); return this.active;
  }
}
