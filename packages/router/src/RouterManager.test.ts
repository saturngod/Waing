import { describe, expect, it, vi } from "vitest";
import type { RoutingDecision, RoutingPolicy } from "@waing/domain";
import { OpenCodeRouterClient } from "./OpenCodeRouterClient";
import type { OpenCodeRouterTransport } from "./OpenCodeRouterClient";
import { AutoSelector, RouterManager } from "./RouterManager";

const decision: RoutingDecision = {
  complexity: "medium", taskType: "feature", mode: "execute", effort: "medium",
  confidence: 0.9, rationale: "Touches several components",
};
const policy: RoutingPolicy = {
  defaultRole: "medium",
  rules: [
    { id: "complexity-medium", enabled: true, match: { complexity: "medium" }, targetRole: "medium", priority: 10 },
    { id: "feature-specific", enabled: true, match: { taskType: "feature" }, targetRole: "high", priority: 20 },
    { id: "disabled", enabled: false, match: {}, targetRole: "low", priority: 100 },
    { id: "high-safe", enabled: true, match: { complexity: "high" }, targetRole: "review", priority: 30 },
  ],
};

describe("RouterManager", () => {
  it("validates classification and deterministically resolves the highest-priority matching role", async () => {
    const client = { id: "test-router", classify: vi.fn().mockResolvedValue(decision) };
    const manager = new RouterManager(client);
    const result = await manager.route({ task: "Add a searchable dashboard" }, policy);
    expect(result).toEqual({ status: "resolved", resolution: {
      routingDecision: decision, role: "high", matchedRuleId: "feature-specific",
    } });
    expect(client.classify).toHaveBeenCalledWith(expect.stringContaining("do not execute the task"));
  });

  it("rejects unknown fields such as provider or permission overrides", async () => {
    const manager = new RouterManager({ id: "unsafe", classify: () => Promise.resolve({ ...decision,
      agent: "unapproved-provider", permission: "yolo" }) });
    await expect(manager.classify({ task: "test" })).rejects.toMatchObject({ code: "ROUTER_INVALID_OUTPUT" });
  });

  it("applies all low-confidence policies without allowing model output to pick a provider", async () => {
    const lowConfidence = { ...decision, confidence: 0.4 };
    const manager = new RouterManager({ id: "uncertain", classify: () => Promise.resolve(lowConfidence) });
    await expect(manager.route({ task: "ambiguous" }, policy, { confidenceFallback: "use_default_role" }))
      .resolves.toMatchObject({ status: "resolved", resolution: { role: "medium" }, confidenceFallbackApplied: "use_default_role" });
    await expect(manager.route({ task: "ambiguous" }, policy, { confidenceFallback: "use_safest_route" }))
      .resolves.toMatchObject({ status: "resolved", resolution: { role: "review" }, confidenceFallbackApplied: "use_safest_route" });
    await expect(manager.route({ task: "ambiguous" }, policy, { confidenceFallback: "ask_user" }))
      .resolves.toMatchObject({ status: "needs_confirmation", suggestedRole: "medium" });
  });

  it("times out failed routers with a typed retryable error", async () => {
    const manager = new RouterManager({ id: "slow", classify: () => new Promise(() => undefined) });
    await expect(manager.classify({ task: "test" }, 5)).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
  });

  it("validates re-entrant orchestration decisions against the checkpoint allowlist", async () => {
    const candidate = { action: "review", statusIntent: { activity: "reviewing" }, rationale: "Implementation is ready",
      confidence: 0.91 };
    const manager = new RouterManager({ id: "checkpoint", classify: () => Promise.resolve(candidate) });
    const input = { checkpointReason: "after_execution" as const, originalUserTask: "build", priorStepSummaries: [],
      artifacts: [], unresolvedIssues: [], allowedActions: ["review" as const] };
    await expect(manager.decideNext(input)).resolves.toEqual(candidate);
    await expect(manager.decideNext({ ...input, allowedActions: ["complete"] }))
      .rejects.toMatchObject({ code: "ROUTER_INVALID_OUTPUT" });
  });

  it("states the orchestration output contract and ignores chatty extra fields", async () => {
    const classify = vi.fn().mockResolvedValue({ action: "complete", statusIntent: { activity: "waiting_for_user" },
      rationale: "The request is satisfied", confidence: 0.8, reason: "duplicate of rationale", notes: ["chatty"] });
    const manager = new RouterManager({ id: "chatty", classify });
    await expect(manager.decideNext({ checkpointReason: "after_execution", originalUserTask: "build",
      priorStepSummaries: [], artifacts: [], unresolvedIssues: [], allowedActions: ["complete"] }))
      .resolves.toMatchObject({ action: "complete" });
    expect(classify).toHaveBeenCalledTimes(1);
    const prompt = classify.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("statusIntent");
    expect(prompt).toContain("allowedActions");
  });

  it("feeds validation errors back once before failing an unusable orchestration answer", async () => {
    const classify = vi.fn()
      .mockResolvedValueOnce({ action: "write_documentation" })
      .mockResolvedValueOnce({ action: "write_documentation", statusIntent: { activity: "writing_docs" },
        document: { operation: "create", kind: "readme", targetPath: "final_document.md" },
        rationale: "The user asked for a document", confidence: 0.77 });
    const manager = new RouterManager({ id: "retry", classify });
    await expect(manager.decideNext({ checkpointReason: "after_execution", originalUserTask: "build",
      priorStepSummaries: [], artifacts: [], unresolvedIssues: [], allowedActions: ["write_documentation"] }))
      .resolves.toMatchObject({ action: "write_documentation", document: { targetPath: "final_document.md" } });
    expect(classify).toHaveBeenCalledTimes(2);
    expect(classify.mock.calls[1]?.[0]).toContain("rejected by the schema");

    const alwaysBad = vi.fn().mockResolvedValue({ action: "complete" });
    await expect(new RouterManager({ id: "bad", classify: alwaysBad }).decideNext({ checkpointReason: "after_execution",
      originalUserTask: "build", priorStepSummaries: [], artifacts: [], unresolvedIssues: [], allowedActions: ["complete"] }))
      .rejects.toMatchObject({ code: "ROUTER_INVALID_OUTPUT" });
    expect(alwaysBad).toHaveBeenCalledTimes(2);
  });

  it("bypasses routing for an explicitly selected agent", async () => {
    const classify = vi.fn().mockResolvedValue(decision);
    const selector = new AutoSelector(new RouterManager({ id: "router", classify }));
    await expect(selector.select({ type: "agent", agentId: "codex" }, { task: "fix" }, policy))
      .resolves.toEqual({ type: "direct", agentId: "codex" });
    expect(classify).not.toHaveBeenCalled();
  });
});

describe("OpenCodeRouterClient", () => {
  it("creates an isolated routing session, disables every advertised tool, parses JSON, and deletes the session", async () => {
    const calls: string[] = [];
    let promptInput: Parameters<OpenCodeRouterTransport["prompt"]>[0] | undefined;
    const transport: OpenCodeRouterTransport = {
      listToolIds: () => Promise.resolve(["bash", "edit", "read", "webfetch"]),
      createSession: () => { calls.push("create"); return Promise.resolve("ses-router"); },
      prompt: (input) => { calls.push("prompt"); promptInput = input; return Promise.resolve(`\`\`\`json\n${JSON.stringify(decision)}\n\`\`\``); },
      deleteSession: () => { calls.push("delete"); return Promise.resolve(); },
    };
    const handle = { baseUrl: "http://127.0.0.1:1234", password: "secret", version: "1.18.5",
      close: () => Promise.resolve() };
    const client = new OpenCodeRouterClient({ projectRoot: "/tmp/project", model: "provider/model",
      serverFactory: () => Promise.resolve(handle), transportFactory: () => transport });
    await expect(client.classify("classify this")).resolves.toEqual(decision);
    expect(promptInput).toMatchObject({ sessionId: "ses-router", model: "provider/model",
      disabledTools: { bash: false, edit: false, read: false, webfetch: false } });
    expect(calls).toEqual(["create", "prompt", "delete"]);
    await client.shutdown();
  });
});
