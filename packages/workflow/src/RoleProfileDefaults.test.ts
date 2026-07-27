import { describe, expect, it } from "vitest";
import type { AgentDescriptor } from "@waing/domain";
import { ROLE_ORDER, buildDefaultRoleProfiles, sortRoleProfiles } from "./RoleProfileDefaults";

const capabilities = { streaming: true, persistentSessions: false, cancellation: true, concurrentRuns: false,
  nativeStructuredOutput: false, planMode: false, effortControl: false, interactivePermissions: true, diffEvents: false,
  shellEvents: false, fileEvents: false, modelSelection: false, mcp: false, customTools: false, additionalDirectories: false };

function descriptor(id: string, installed: boolean, available: boolean): AgentDescriptor {
  return { id, displayName: id, installed, available, authState: available ? "ready" : "unknown", warnings: [], capabilities };
}

describe("default role profiles", () => {
  it("seeds every role from providers that are installed and available", () => {
    const profiles = buildDefaultRoleProfiles([descriptor("codex", true, true), descriptor("claude", true, true),
      descriptor("antigravity", false, false), descriptor("opencode", false, false)]);
    expect(profiles.map((profile) => profile.role)).toEqual([...ROLE_ORDER]);
    expect(profiles.every((profile) => ["codex", "claude"].includes(profile.agentId))).toBe(true);
    expect(profiles.find((profile) => profile.role === "high")?.agentId).toBe("claude");
    expect(profiles.find((profile) => profile.role === "review")?.mode).toBe("review");
  });

  it("prefers a usable provider over one that is installed but not authenticated", () => {
    const profiles = buildDefaultRoleProfiles([descriptor("antigravity", true, false), descriptor("codex", true, true)]);
    expect(profiles.find((profile) => profile.role === "review")?.agentId).toBe("codex");
  });

  it("falls back to an installed-but-unauthenticated provider when nothing usable is present", () => {
    const profiles = buildDefaultRoleProfiles([descriptor("antigravity", true, false)]);
    expect(profiles.find((profile) => profile.role === "review")?.agentId).toBe("antigravity");
    expect(profiles.find((profile) => profile.role === "low")?.agentId).toBe("antigravity");
  });

  it("still produces a complete editable set when no provider is installed", () => {
    const profiles = buildDefaultRoleProfiles([]);
    expect(profiles).toHaveLength(ROLE_ORDER.length);
    expect(profiles.every((profile) => profile.agentId.length > 0)).toBe(true);
  });

  it("orders an arbitrary profile set into the canonical role order", () => {
    const shuffled = [...buildDefaultRoleProfiles([descriptor("codex", true, true)])].reverse();
    expect(sortRoleProfiles(shuffled).map((profile) => profile.role)).toEqual([...ROLE_ORDER]);
  });
});
