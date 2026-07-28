import { describe, expect, it } from "vitest";
import type { PermissionRequest } from "@waing/domain";
import { PermissionManager } from "./PermissionManager";

const request = (id: string, projectSession = "session-1"): PermissionRequest => ({
  id, sessionId: projectSession, runId: "run-1", agentId: "codex", kind: "shell",
  title: "Run tests", detail: "npm test", risk: "medium", command: ["npm", "test"],
});

describe("PermissionManager", () => {
  it("supports allow once and keeps an audit trail", async () => {
    const manager = new PermissionManager();
    const decision = manager.request("project-1", request("request-1"));
    manager.respond("request-1", "allow_once");
    await expect(decision).resolves.toBe("allow_once");
    expect(manager.history).toMatchObject([{ projectId: "project-1", decision: "allow_once", source: "user" }]);
  });

  it("remembers rules only for the same project and session", async () => {
    const manager = new PermissionManager();
    const first = manager.request("project-1", request("request-1"));
    manager.respond("request-1", "allow_session");
    await first;
    await expect(manager.request("project-1", request("request-2"))).resolves.toBe("allow_session");

    const otherProject = manager.request("project-2", request("request-3"));
    expect(manager.pendingCount).toBe(1);
    manager.respond("request-3", "deny");
    await expect(otherProject).resolves.toBe("deny");
  });

  it("fails closed when a session is closed with prompts pending", async () => {
    const manager = new PermissionManager();
    const decision = manager.request("project-1", request("request-1"));
    manager.closeSession("session-1");
    await expect(decision).resolves.toBe("deny");
    expect(manager.history.at(-1)).toMatchObject({ decision: "deny", source: "session_closed" });
  });

  it("answers from the role's saved profile instead of prompting", async () => {
    const manager = new PermissionManager();
    const write: PermissionRequest = { ...request("request-1"), kind: "file_write", paths: ["src/index.ts"] };
    await expect(manager.request("project-1", write, { profile: "auto_edit" })).resolves.toBe("allow_once");
    await expect(manager.request("project-1", request("request-2"), { profile: "autonomous" })).resolves.toBe("allow_once");
    await expect(manager.request("project-1", request("request-3"), { profile: "read_only" })).resolves.toBe("deny");
    expect(manager.pendingCount).toBe(0);
    expect(manager.history.map((entry) => entry.source)).toEqual(["profile", "profile", "profile"]);
  });

  it("still prompts under auto_edit for anything that is not a file write", async () => {
    const manager = new PermissionManager();
    // A shell command can do far more than the edit it claims to, so auto_edit must not cover it.
    const pending = manager.request("project-1", request("request-1"), { profile: "auto_edit" });
    expect(manager.pendingCount).toBe(1);
    manager.respond("request-1", "allow_once");
    await expect(pending).resolves.toBe("allow_once");
  });

  it("remembers an allowed rule across the sessions of one conversation", async () => {
    const manager = new PermissionManager();
    // A workflow runs each role in its own provider session; the user approved the command, not the step.
    const first = manager.request("project-1", request("request-1", "step-session-1"), { scopeId: "conversation-1" });
    manager.respond("request-1", "allow_session");
    await first;
    await expect(manager.request("project-1", request("request-2", "step-session-2"), { scopeId: "conversation-1" }))
      .resolves.toBe("allow_session");
    // A different conversation in the same project is a different scope and must ask again.
    void manager.request("project-1", request("request-3", "step-session-3"), { scopeId: "conversation-2" });
    expect(manager.pendingCount).toBe(1);
  });

  it("rejects permission responses that try to cross session ownership", async () => {
    const manager = new PermissionManager();
    const pending = manager.request("project-1", request("request-1", "session-1"));
    expect(() => manager.respond("request-1", "allow_once", "session-2")).toThrow(/does not belong/);
    manager.respond("request-1", "deny", "session-1");
    await expect(pending).resolves.toBe("deny");
  });
});
