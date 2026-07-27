import { describe, expect, it } from "vitest";
import { OpenCodeServer } from "./OpenCodeServer";

const runLive = process.env.WAING_OPENCODE_INTEGRATION === "1";

describe.skipIf(!runLive)("OpenCode installed CLI integration", () => {
  it("starts an authenticated random-port loopback server and passes health validation", async () => {
    const server = new OpenCodeServer();
    const handle = await server.start();
    try {
      expect(handle.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(handle.password.length).toBeGreaterThan(32);
      expect(handle.version).toMatch(/^1\./);
    } finally {
      await handle.close();
    }
  }, 15_000);
});
