import { describe, expect, it } from "vitest";
import type { AgentDescriptor } from "@waing/domain";
import { buildDefaultRouterSettings, buildStarterAgentProfiles } from "./AgentProfileDefaults";

const caps = { streaming: true, persistentSessions: true, cancellation: true, concurrentRuns: false, nativeStructuredOutput: false,
  planMode: true, effortControl: true, interactivePermissions: true, diffEvents: true, shellEvents: true, fileEvents: true,
  modelSelection: true, mcp: false, customTools: false, additionalDirectories: false };
const descriptor = (id: string, available = true): AgentDescriptor => ({ id, displayName: id, installed: available, available,
  capabilities: caps, authState: "unknown", warnings: [] });

describe("starter agents", () => {
  it("seeds five job-based profiles using installed CLIs only", () => {
    const profiles = buildStarterAgentProfiles([descriptor("codex"), descriptor("claude"), descriptor("missing", false)]);
    expect(profiles.map((profile) => profile.name)).toEqual(["Planner", "Coder", "Architect", "Reviewer", "Doc Writer"]);
    expect(profiles.every((profile) => ["codex", "claude"].includes(profile.agentId))).toBe(true);
  });
  it("prefers OpenCode for the router", () => expect(buildDefaultRouterSettings([descriptor("codex"), descriptor("opencode")])).toEqual({ agentId: "opencode", effort: "low" }));
});
