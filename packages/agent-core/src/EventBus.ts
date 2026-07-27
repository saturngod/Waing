import type { AgentEvent } from "@waing/domain";
import { AsyncQueue } from "./AsyncQueue";

export type EventListener = (event: AgentEvent) => void;

export class EventBus {
  private readonly listeners = new Set<EventListener>();
  private readonly streams = new Set<AsyncQueue<AgentEvent>>();

  publish(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
    for (const stream of this.streams) stream.push(event);
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  events(): AsyncIterable<AgentEvent> {
    const queue = new AsyncQueue<AgentEvent>();
    this.streams.add(queue);
    const streams = this.streams;
    return {
      [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        const iterator = queue[Symbol.asyncIterator]();
        return {
          next: () => iterator.next(),
          return: async () => {
            streams.delete(queue);
            return iterator.return?.() ?? { value: undefined, done: true };
          },
        };
      },
    };
  }
}
