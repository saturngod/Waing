import { describe, expect, it } from "vitest";
import { agentDescriptorSchema } from "./index";

describe("agentDescriptorSchema", () => {
  it("rejects incomplete capability declarations", () => {
    expect(() =>
      agentDescriptorSchema.parse({
        id: "codex",
        displayName: "Codex",
        installed: false,
        available: false,
        capabilities: {},
        authState: "unknown",
        warnings: [],
      }),
    ).toThrow();
  });
});
