export interface RestartPolicyOptions { maxAttempts: number; baseDelayMs: number; maxDelayMs: number }

export class RestartPolicy {
  constructor(private readonly options: RestartPolicyOptions = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 4_000 }) {}
  canRetry(failedAttempts: number): boolean { return failedAttempts < this.options.maxAttempts; }
  delayMs(failedAttempts: number): number {
    return Math.min(this.options.baseDelayMs * 2 ** Math.max(0, failedAttempts - 1), this.options.maxDelayMs);
  }
}
