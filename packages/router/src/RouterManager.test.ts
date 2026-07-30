import { describe, expect, it, vi } from "vitest";
import type { RouterCheckpointInput } from "@waing/domain";
import { RouterManager } from "./RouterManager";

const checkpoint: RouterCheckpointInput = { checkpointReason: "initial", originalUserTask: "add tests", priorStepSummaries: [],
  availableAgents: [{ id: "test-writer", name: "Test Writer", whereToUse: "Write tests" }],
  allowedActions: ["delegate", "ask_user", "complete"] };
const decision = { action: "delegate", agentProfileId: "test-writer", statusIntent: { activity: "testing" }, rationale: "Tests are needed", confidence: .9 };

describe("RouterManager", () => {
  it("delegates only to an available agent", async () => {
    const client = { id: "router", classify: vi.fn().mockResolvedValue(decision) };
    await expect(new RouterManager(client).decideNext(checkpoint)).resolves.toEqual(decision);
    expect(client.classify.mock.calls[0]?.[0]).toContain("id=test-writer | Test Writer | use when: Write tests");
  });
  it("rejects an id outside the roster", async () => {
    const client = { id: "router", classify: vi.fn().mockResolvedValue({ ...decision, agentProfileId: "intruder" }) };
    await expect(new RouterManager(client).decideNext(checkpoint)).rejects.toMatchObject({ code: "ROUTER_INVALID_OUTPUT" });
  });
  it("retries malformed output once", async () => {
    const client = { id: "router", classify: vi.fn().mockResolvedValueOnce({ action: "delegate" }).mockResolvedValueOnce(decision) };
    await expect(new RouterManager(client).decideNext(checkpoint)).resolves.toEqual(decision);
    expect(client.classify).toHaveBeenCalledTimes(2);
  });
  it("falls back when status intent is malformed presentation metadata", async () => {
    const client = { id: "router", classify: vi.fn().mockResolvedValue({ ...decision, statusIntent: "testing" }) };
    await expect(new RouterManager(client).decideNext(checkpoint)).resolves.toEqual({
      ...decision, statusIntent: { activity: "implementing" },
    });
    expect(client.classify).toHaveBeenCalledTimes(1);
  });
  it("uses the waiting activity when an ask-user status intent is missing", async () => {
    const client = { id: "router", classify: vi.fn().mockResolvedValue({
      action: "ask_user", rationale: "More information is required", confidence: .8,
    }) };
    await expect(new RouterManager(client).decideNext(checkpoint)).resolves.toMatchObject({
      action: "ask_user", statusIntent: { activity: "waiting_for_user" },
    });
  });
});
