export const AGENT_ERROR_CODES = [
  "NOT_INSTALLED", "UNSUPPORTED_VERSION", "AUTH_REQUIRED", "AUTH_FAILED", "PROCESS_FAILED",
  "PROTOCOL_ERROR", "SESSION_NOT_FOUND", "PERMISSION_DENIED", "CAPABILITY_UNSUPPORTED", "TIMEOUT",
  "CANCELLED", "ROUTER_FAILED", "ROUTER_INVALID_OUTPUT", "WORKFLOW_INVALID", "WORKFLOW_OSCILLATION",
  "WORKFLOW_LOOP_EXHAUSTED", "PROFILE_UNENFORCEABLE", "LOCAL_SERVER_FAILED",
] as const;
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

export class AgentError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    readonly providerId?: string,
    readonly retryable = false,
    readonly partialWorkPossible = false,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export class AgentCapabilityError extends AgentError {
  constructor(providerId: string, capability: string) {
    super("CAPABILITY_UNSUPPORTED", `${providerId} does not support ${capability}`, providerId);
    this.name = "AgentCapabilityError";
  }
}
