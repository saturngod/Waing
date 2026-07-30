import { describe, expect, it } from "vitest";
import { agentSettingsInputSchema } from "./index";

const profile = { id: "coder", name: "Coder", whereToUse: "Write code", enabled: true,
  agentId: "codex", position: 0 };

describe("agentSettingsInputSchema", () => {
  it("rejects a roster with no enabled agent", () => {
    expect(() => agentSettingsInputSchema.parse({ profiles: [{ ...profile, enabled: false }], router: { agentId: "codex" } })).toThrow("At least one agent");
  });
  it("rejects duplicate profile ids", () => {
    expect(() => agentSettingsInputSchema.parse({ profiles: [profile, { ...profile, name: "Other", position: 1 }], router: { agentId: "codex" } })).toThrow("unique");
  });
});
