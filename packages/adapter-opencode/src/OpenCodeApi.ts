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
    this.client = createOpencodeClient({ baseUrl, fetch: this.fetchImpl });
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
    const url = new URL(`/permission/${encodeURIComponent(requestId)}/reply`, this.baseUrl);
    url.searchParams.set("directory", root);
    const response = await this.fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ reply }) });
    if (!response.ok) throw new Error(`OpenCode permission response failed with HTTP ${String(response.status)}`);
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
