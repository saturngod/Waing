import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@waing/domain";
import { AntigravityAdapter } from "./AntigravityAdapter";

const runLive = process.env.WAING_ANTIGRAVITY_INTEGRATION === "1";

describe.skipIf(!runLive)("Antigravity installed CLI integration", () => {
  it("discovers the CLI and completes a stream-json print run", async () => {
    const adapter = new AntigravityAdapter({ printTimeoutSeconds: 120, modelListTimeoutMs: 8_000 });
    const descriptor = await adapter.discover();
    expect(descriptor).toMatchObject({ installed: true, available: true });
    expect(descriptor.version).toMatch(/^\d+\./u);

    const root = await mkdtemp(join(tmpdir(), "waing-agy-live-"));
    const session = await adapter.startSession({ conversationId: "live", projectId: "live", projectRoot: root });
    const collected: AgentEvent[] = [];
    const drained = (async () => {
      for await (const event of adapter.events(session.id)) {
        collected.push(event);
        if (event.type === "run.completed" || event.type === "run.failed") break;
      }
    })();
    await adapter.send(session.id, { text: "Reply with exactly: OK", projectRoot: root, mode: "execute" });
    await drained;

    const failure = collected.find((event) => event.type === "run.failed");
    expect(failure?.type === "run.failed" ? failure.message : undefined).toBeUndefined();
    const completed = collected.find((event) => event.type === "message.completed");
    expect(completed?.type === "message.completed" && completed.text).toContain("OK");
    // The init line carries the conversation id that later turns reuse.
    expect(session.providerSessionId).toBeDefined();
    await adapter.closeSession(session.id);
  }, 180_000);
});
