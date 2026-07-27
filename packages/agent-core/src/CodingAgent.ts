import type {
  AgentDescriptor,
  AgentEvent,
  AgentModelDescriptor,
  AgentRequest,
  AgentRun,
  AgentSession,
  PermissionDecision,
  ResumeSessionInput,
  StartSessionInput,
} from "@waing/domain";

export interface CodingAgent {
  readonly id: string;
  discover(): Promise<AgentDescriptor>;
  listModels(): Promise<AgentModelDescriptor[]>;
  startSession(input: StartSessionInput): Promise<AgentSession>;
  resumeSession(input: ResumeSessionInput): Promise<AgentSession>;
  send(sessionId: string, request: AgentRequest): Promise<AgentRun>;
  cancel(sessionId: string): Promise<void>;
  respondToPermission(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  shutdown(): Promise<void>;
  events(sessionId: string): AsyncIterable<AgentEvent>;
}
