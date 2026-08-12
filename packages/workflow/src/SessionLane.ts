import { createHash } from "node:crypto";
import type { AgentProfile } from "@waing/domain";

/** Stable identity for a provider session lane; changing role configuration intentionally starts a new lane. */
export function profileSessionLaneKey(profile: AgentProfile): string {
  const configuration = JSON.stringify({
    profileId: profile.id,
    agentId: profile.agentId,
    modelId: profile.modelId ?? null,
    effort: profile.effort ?? null,
    instructions: profile.instructions ?? null,
    permissionProfileId: profile.permissionProfileId ?? null,
    mode: "execute",
  });
  return createHash("sha256").update(configuration).digest("hex");
}

