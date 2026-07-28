import { createOpencodeClient } from "@opencode-ai/sdk";
import type { Event } from "@opencode-ai/sdk";
import type { AgentRequest, PermissionDecision } from "@waing/domain";

export interface OpenCodeModel {
  providerId: string;
  modelId: string;
  displayName: string;
}

export interface OpenCodeApi {
  createSession(root: string, title: string): Promise<{ id: string }>;
  loadSession(root: string, id: string): Promise<{ id: string }>;
  prompt(root: string, id: string, request: AgentRequest): Promise<void>;
  abort(root: string, id: string): Promise<void>;
  respondToPermission(root: string, sessionId: string, requestId: string, decision: PermissionDecision): Promise<void>;
  /** One entry per asked question, in the order they were asked, each holding the labels the user chose. */
  respondToQuestion(root: string, requestId: string, answers: string[][]): Promise<void>;
  rejectQuestion(root: string, requestId: string): Promise<void>;
  events(root: string, signal: AbortSignal): AsyncIterable<unknown>;
  listModels(root?: string): Promise<OpenCodeModel[]>;
}

function authorization(password: string): string {
  return `Basic ${Buffer.from(`waing:${password}`).toString("base64")}`;
}

export class SdkOpenCodeApi implements OpenCodeApi {
  private readonly client;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly baseUrl: string, private readonly password: string) {
    this.fetchImpl = (input, init) => {
      const request = new Request(input, init);
      request.headers.set("authorization", authorization(password));
      return fetch(request);
    };
    // The SDK's SSE client calls the global fetch directly, so a custom fetch never sees the event stream and the
    // subscription is rejected with 401 — which surfaces as a stream that closes on its own. Configured headers do
    // reach it, so authorization is declared here as well as wrapped in the fetch the plain requests use.
    this.client = createOpencodeClient({ baseUrl, fetch: this.fetchImpl,
      headers: { authorization: authorization(password) } });
  }

  async createSession(root: string, title: string): Promise<{ id: string }> {
    const response = await this.client.session.create({ query: { directory: root }, body: { title }, throwOnError: true });
    return { id: response.data.id };
  }

  async loadSession(root: string, id: string): Promise<{ id: string }> {
    const response = await this.client.session.get({ path: { id }, query: { directory: root }, throwOnError: true });
    return { id: response.data.id };
  }

  async prompt(root: string, id: string, request: AgentRequest): Promise<void> {
    const model = request.model?.includes("/") === true
      ? { providerID: request.model.slice(0, request.model.indexOf("/")), modelID: request.model.slice(request.model.indexOf("/") + 1) }
      : undefined;
    await this.client.session.promptAsync({ path: { id }, query: { directory: root }, body: {
      parts: [{ type: "text", text: request.text }],
      ...(model === undefined ? {} : { model }),
      agent: request.mode === "plan" ? "plan" : "build",
    }, throwOnError: true });
  }

  async abort(root: string, id: string): Promise<void> {
    await this.client.session.abort({ path: { id }, query: { directory: root }, throwOnError: true });
  }

  async respondToPermission(
    root: string, _sessionId: string, requestId: string, decision: PermissionDecision,
  ): Promise<void> {
    const reply = decision === "deny" ? "reject" : decision === "allow_session" ? "always" : "once";
    await this.post(`/permission/${encodeURIComponent(requestId)}/reply`, root, "permission response", { reply });
  }

  // The pinned SDK has no question client — the ask-the-user tool is newer than it — so these two are posted directly.
  async respondToQuestion(root: string, requestId: string, answers: string[][]): Promise<void> {
    await this.post(`/question/${encodeURIComponent(requestId)}/reply`, root, "question answer", { answers });
  }

  async rejectQuestion(root: string, requestId: string): Promise<void> {
    await this.post(`/question/${encodeURIComponent(requestId)}/reject`, root, "question rejection");
  }

  private async post(path: string, root: string, label: string, body?: unknown): Promise<void> {
    const url = new URL(path, this.baseUrl);
    url.searchParams.set("directory", root);
    const response = await this.fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`OpenCode ${label} failed with HTTP ${String(response.status)}`);
  }

  async *events(root: string, signal: AbortSignal): AsyncIterable<Event> {
    const subscription = await this.client.event.subscribe({ query: { directory: root }, signal,
      sseMaxRetryAttempts: 2 });
    for await (const event of subscription.stream) yield event;
  }

  async listModels(root?: string): Promise<OpenCodeModel[]> {
    const response = await this.client.config.providers({
      ...(root === undefined ? {} : { query: { directory: root } }), throwOnError: true,
    });
    const data = response.data as { providers: Array<{ id: string; name?: string; models: Record<string, { name?: string }> }> };
    return data.providers.flatMap((provider) => Object.entries(provider.models).map(([modelId, model]) => ({
      providerId: provider.id, modelId, displayName: `${provider.name ?? provider.id} · ${model.name ?? modelId}`,
    })));
  }
}
