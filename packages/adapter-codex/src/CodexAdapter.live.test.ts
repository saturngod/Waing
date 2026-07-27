import { describe, expect, it } from "vitest";
import { CodexAdapter } from "./CodexAdapter";

describe("CodexAdapter installed CLI integration", () => {
  it.runIf(process.env.WAING_CODEX_INTEGRATION === "1")(
    "initializes the installed app-server and enumerates models",
    async () => {
      const adapter = new CodexAdapter();
      try {
        const descriptor = await adapter.discover();
        expect(descriptor).toMatchObject({ installed: true, available: true });
        expect((await adapter.listModels()).length).toBeGreaterThan(0);
      } finally {
        await adapter.shutdown();
      }
    },
    30_000,
  );
});
