import { AsyncQueue } from "@waing/agent-core";
import type { WorkflowEvent } from "@waing/domain";

export class WorkflowEventBus {
  private readonly listeners = new Set<(event: WorkflowEvent) => void>();
  private readonly streams = new Set<AsyncQueue<WorkflowEvent>>();
  publish(event: WorkflowEvent): void { for (const listener of this.listeners) listener(event); for (const stream of this.streams) stream.push(event); }
  subscribe(listener: (event: WorkflowEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  events(): AsyncIterable<WorkflowEvent> {
    const queue = new AsyncQueue<WorkflowEvent>(); this.streams.add(queue); const streams = this.streams;
    return { [Symbol.asyncIterator](): AsyncIterator<WorkflowEvent> { const iterator = queue[Symbol.asyncIterator](); return {
      next: () => iterator.next(), return: async () => { streams.delete(queue); return iterator.return?.() ?? { done: true, value: undefined }; },
    }; } };
  }
}
