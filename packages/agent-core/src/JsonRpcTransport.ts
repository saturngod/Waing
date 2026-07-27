import type { ManagedProcess } from "./ProcessSupervisor";
import { AgentError } from "@waing/domain";
import { JsonlParser } from "./JsonlParser";

type JsonRpcId = string | number;
interface JsonRpcMessage { jsonrpc?: "2.0"; id?: JsonRpcId; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown }; }
type JsonRpcResult = null | boolean | number | string | readonly unknown[] | Record<string, unknown> | undefined;
type RequestHandler = (params: unknown) => JsonRpcResult | Promise<JsonRpcResult>;
type NotificationHandler = (params: unknown) => void;

export class JsonRpcTransport {
  readonly protocolErrors: Error[] = [];
  private nextId = 0;
  private readonly pending = new Map<JsonRpcId, {
    resolve: (value: unknown) => void; reject: (reason: unknown) => void; timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private readonly parser: JsonlParser;

  constructor(
    private readonly process: ManagedProcess,
    private readonly includeJsonrpcHeader = true,
  ) {
    this.parser = new JsonlParser(
      (value) => { void this.receive(value); },
      (error) => this.protocolErrors.push(error),
    );
    process.child.stdout.on("data", (chunk: Buffer | string) => this.parser.push(chunk));
    process.child.once("exit", (code) => this.failAll(new AgentError(
      "PROCESS_FAILED", `JSON-RPC process exited with code ${String(code)}`, undefined, true,
    )));
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 10_000): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentError("TIMEOUT", `JSON-RPC request timed out: ${method}`, undefined, true));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.write({ id, method, params });
    });
  }

  async requestWithRetry<T = unknown>(method: string, params?: unknown,
    options: { timeoutMs?: number; retries?: number; retryDelayMs?: number } = {}): Promise<T> {
    const retries = options.retries ?? 1;
    for (let attempt = 0; ; attempt += 1) {
      try { return await this.request<T>(method, params, options.timeoutMs); }
      catch (cause) {
        if (attempt >= retries || !(cause instanceof AgentError) || (cause.code !== "TIMEOUT" && cause.code !== "PROCESS_FAILED")) throw cause;
        await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 100));
      }
    }
  }

  notify(method: string, params?: unknown): void { this.write({ method, params }); }
  handle(method: string, handler: RequestHandler): void { this.requestHandlers.set(method, handler); }
  onNotification(method: string, handler: NotificationHandler): () => void {
    const handlers = this.notificationHandlers.get(method) ?? new Set();
    handlers.add(handler); this.notificationHandlers.set(method, handlers);
    return () => handlers.delete(handler);
  }

  close(): void {
    this.failAll(new AgentError("CANCELLED", "JSON-RPC transport closed"));
    void this.process.stop();
  }

  private write(message: JsonRpcMessage): void {
    const wireMessage = this.includeJsonrpcHeader ? { jsonrpc: "2.0", ...message } : message;
    this.process.child.stdin.write(`${JSON.stringify(wireMessage)}\n`);
  }

  private async receive(value: unknown): Promise<void> {
    if (typeof value !== "object" || value === null) return;
    const message = value as JsonRpcMessage;
    if (this.includeJsonrpcHeader && message.jsonrpc !== "2.0") return;
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new AgentError("PROTOCOL_ERROR", message.error.message, undefined, true));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === undefined) return;
    if (message.id === undefined) {
      for (const handler of this.notificationHandlers.get(message.method) ?? []) handler(message.params);
      return;
    }
    const handler = this.requestHandlers.get(message.method);
    if (handler === undefined) {
      this.write({ id: message.id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    try {
      this.write({ id: message.id, result: await handler(message.params) });
    } catch (cause) {
      this.write({ id: message.id, error: { code: -32000,
        message: cause instanceof Error ? cause.message : "Server request failed" } });
    }
  }

  private failAll(error: AgentError): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}
