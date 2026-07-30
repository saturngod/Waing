import { AgentError, agentProfileSchema } from "@waing/domain";
import type { AgentProfile } from "@waing/domain";

export class ProfileResolver {
  private readonly profiles: Map<string, AgentProfile>;
  constructor(profiles: readonly AgentProfile[]) {
    this.profiles = new Map(profiles.map((profile) => [profile.id, agentProfileSchema.parse(profile)]));
  }
  resolve(agentProfileId: string): AgentProfile {
    const profile = this.profiles.get(agentProfileId);
    if (profile === undefined || !profile.enabled) throw new AgentError("WORKFLOW_INVALID", `Agent profile ${agentProfileId} is unavailable`);
    return profile;
  }
}
