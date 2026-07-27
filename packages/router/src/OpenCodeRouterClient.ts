import { createOpencodeClient } from "@opencode-ai/sdk";
import { OpenCodeServer } from "@waing/adapter-opencode";
import type { OpenCodeServerHandle } from "@waing/adapter-opencode";
import { parseRouterJson } from "./parseRouterJson";
import type { RouterClient } from "./RouterManager";

export interface OpenCodeRouterTransport {
  listToolIds(root: string): Promise<string[]>;
  createSession(root: string): Promise<string>;
  prompt(input: { root: string; sessionId: string; prompt: string; disabledTools: Record<string, false>; model?: string }): Promise<string>;
  deleteSession(root: string, sessionId: string): Promise<void>;
}

class SdkRouterTransport implements OpenCodeRouterTransport {
  private readonly client;
  constructor(baseUrl: string, password: string) {
    const authorization = `Basic ${Buffer.from(`waing:${password}`).toString("base64")}`;
    this.client = createOpencodeClient({ baseUrl, fetch: (input: Request) => {
      const request = new Request(input); request.headers.set("authorization", authorization); return fetch(request);
    } });
  }
  async listToolIds(root: string): Promise<string[]> {
    const response = await this.client.tool.ids({ query: { directory: root }, throwOnError: true });
    return response.data;
  }
  async createSession(root: string): Promise<string> {
    const response = await this.client.session.create({ query: { directory: root },
      body: { title: "Waing routing-only classification" }, throwOnError: true });
    return response.data.id;
  }
  async prompt(input: {
    root: string; sessionId: string; prompt: string; disabledTools: Record<string, false>; model?: string;
  }): Promise<string> {
    const separator = input.model?.indexOf("/") ?? -1;
    const model = separator > 0 && input.model !== undefined
      ? { providerID: input.model.slice(0, separator), modelID: input.model.slice(separator + 1) } : undefined;
    const response = await this.client.session.prompt({ path: { id: input.sessionId }, query: { directory: input.root }, body: {
      parts: [{ type: "text", text: input.prompt }], tools: input.disabledTools, agent: "plan",
      ...(model === undefined ? {} : { model }),
      system: "Routing-only request. Do not call tools, inspect files, edit files, run commands, or access the network. Return JSON only.",
    }, throwOnError: true });
    return response.data.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
  }
  async deleteSession(root: string, sessionId: string): Promise<void> {
    await this.client.session.delete({ path: { id: sessionId }, query: { directory: root }, throwOnError: true });
  }
}

export interface OpenCodeRouterClientOptions {
  projectRoot: string;
  model?: string;
  executable?: string;
  serverFactory?: () => Promise<OpenCodeServerHandle>;
  transportFactory?: (handle: OpenCodeServerHandle) => OpenCodeRouterTransport;
}

export class OpenCodeRouterClient implements RouterClient {
  readonly id = "opencode-router";
  private readonly server: OpenCodeServer;
  private handle?: OpenCodeServerHandle;
  private transport?: OpenCodeRouterTransport;

  constructor(private readonly options: OpenCodeRouterClientOptions) {
    this.server = new OpenCodeServer(options.executable);
  }

  async classify(prompt: string): Promise<unknown> {
    const transport = await this.ensureTransport();
    const sessionId = await transport.createSession(this.options.projectRoot);
    try {
      const tools = await transport.listToolIds(this.options.projectRoot);
      const disabledTools = Object.fromEntries(tools.map((tool) => [tool, false])) as Record<string, false>;
      const output = await transport.prompt({ root: this.options.projectRoot, sessionId, prompt, disabledTools,
        ...(this.options.model === undefined ? {} : { model: this.options.model }) });
      return this.parseJson(output);
    } finally {
      await transport.deleteSession(this.options.projectRoot, sessionId).catch(() => undefined);
    }
  }

  async shutdown(): Promise<void> {
    await this.handle?.close(); delete this.handle; delete this.transport;
  }

  private async ensureTransport(): Promise<OpenCodeRouterTransport> {
    if (this.transport !== undefined) return this.transport;
    this.handle = this.options.serverFactory === undefined ? await this.server.start() : await this.options.serverFactory();
    this.transport = this.options.transportFactory?.(this.handle)
      ?? new SdkRouterTransport(this.handle.baseUrl, this.handle.password);
    return this.transport;
  }

  private parseJson(output: string): unknown { return parseRouterJson(output, this.id); }
}
