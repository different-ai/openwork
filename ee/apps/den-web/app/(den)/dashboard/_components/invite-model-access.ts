import type { GatewayAccessProvider } from "./gateway-subject-access-data";

export type InviteModelAccess = {
  key: string;
  providerName: string;
  groupName: string;
  modelIds: string[];
  modelNames: Array<string | null>;
  source: "everyone" | "team";
  state: "shared_configured" | "member_sign_in" | "member_setup" | "setup_required" | "selection_unverified";
};

export function inviteModelAccess(providers: GatewayAccessProvider[], teamId: string | null): InviteModelAccess[] {
  return providers.flatMap((provider) => {
    if (provider.status !== "active") return [];
    const rows = new Map<string, InviteModelAccess>();
    for (const grant of provider.accessGrants) {
      const source = grant.audience.type === "organization" ? "everyone"
        : grant.audience.type === "team" && teamId !== null && grant.audience.teamId === teamId ? "team" : null;
      if (!source) continue;
      const group = provider.modelGroups.find((entry) => entry.id === grant.modelGroupId);
      const credential = provider.credentialSets.find((entry) => entry.id === grant.credentialSetId);
      if (!group || !credential || group.status !== "active" || credential.status !== "active" || !group.modelIds.length) continue;
      const universe = provider.modelIds;
      const universeKnown = Array.isArray(universe);
      const modelIds = Array.isArray(universe) ? [...new Set(group.modelIds)].filter((id) => universe.length === 0 || universe.includes(id)) : [];
      if (universeKnown && modelIds.length === 0) continue;
      const key = `${provider.id}:${group.id}:${credential.id}`;
      if (rows.get(key)?.source === "everyone") continue;
      rows.set(key, {
        key, providerName: provider.name, groupName: group.name,
        modelIds,
        modelNames: modelIds.map((id) => provider.models.find((model) => (model.upstreamModelId ?? model.id) === id)?.name.trim() || null),
        source,
        state: !universeKnown ? "selection_unverified" : credential.credentialMode === "member"
          ? credential.configured ? "member_sign_in" : "member_setup"
          : credential.configured && credential.credentialStatus === "ready" ? "shared_configured" : "setup_required",
      });
    }
    return [...rows.values()];
  });
}

export function inviteModelAccessStateLabel(state: InviteModelAccess["state"]): string {
  switch (state) {
    case "shared_configured": return "Shared key added";
    case "member_sign_in": return "Each person signs in";
    case "member_setup": return "Needs admin setup";
    case "setup_required": return "Needs admin setup";
    case "selection_unverified": return "Couldn't verify models";
  }
}
