import type {
  DenLibraryAccessEdge,
  DenLibraryAccessGrant,
  DenLibraryOrgDirectory,
  DenLibraryPluginItem,
} from "../../../app/lib/den-library";
import { t } from "../../../i18n";
import type { ExtensionTaxonomy } from "./extension-taxonomy";

/** Where a Library row sits: on this computer, added by the member, or shared by OpenWork. */
export type LibrarySection = "mac" | "mine" | "openwork";

export type LibraryAudience = {
  orgWide: boolean;
  teams: Array<{ id: string; name: string; peopleCount: number; grantId: string | null }>;
  people: Array<{ id: string; name: string; grantId: string | null }>;
};

export const emptyLibraryAudience: LibraryAudience = { orgWide: false, teams: [], people: [] };

/** Everyone the owner shared with, read from the plugin's live access grants. */
export function libraryAudienceFromGrants(
  grants: DenLibraryAccessGrant[],
  directory: DenLibraryOrgDirectory | null,
): LibraryAudience {
  const teamsById = new Map((directory?.teams ?? []).map((team) => [team.id, team]));
  const membersById = new Map((directory?.members ?? []).map((member) => [member.id, member]));
  const audience: LibraryAudience = { orgWide: false, teams: [], people: [] };
  for (const grant of grants) {
    if (grant.orgWide) {
      audience.orgWide = true;
    } else if (grant.teamId) {
      const team = teamsById.get(grant.teamId);
      audience.teams.push({
        id: grant.teamId,
        name: team?.name ?? t("extensions.share_unknown_team"),
        peopleCount: team?.memberIds.length ?? 0,
        grantId: grant.id,
      });
    } else if (grant.orgMembershipId && grant.orgMembershipId !== directory?.currentMemberId) {
      audience.people.push({
        id: grant.orgMembershipId,
        name: membersById.get(grant.orgMembershipId)?.name ?? t("extensions.share_unknown_person"),
        grantId: grant.id,
      });
    }
  }
  return audience;
}

export function isLibraryAudienceShared(audience: LibraryAudience) {
  return audience.orgWide || audience.teams.length > 0 || audience.people.length > 0;
}

/** Names the audience the way the row and toasts say it: Support, Support and Ana, everyone. */
export function libraryAudienceName(audience: LibraryAudience): string {
  if (audience.orgWide) return t("extensions.share_audience_everyone");
  const names = [...audience.teams.map((team) => team.name), ...audience.people.map((person) => person.name)];
  if (names.length === 0) return t("extensions.share_audience_just_me");
  if (names.length === 1) return names[0] ?? "";
  if (names.length === 2) return t("extensions.share_audience_two", { first: names[0] ?? "", second: names[1] ?? "" });
  return t("extensions.share_audience_many", { first: names[0] ?? "", count: String(names.length - 1) });
}

/** How many people besides the owner get it. Teams can overlap, so this counts distinct members. */
export function libraryAudiencePeopleCount(audience: LibraryAudience, directory: DenLibraryOrgDirectory | null): number {
  if (audience.orgWide) return Math.max(0, (directory?.members.length ?? 1) - 1);
  const ids = new Set<string>();
  const teamsById = new Map((directory?.teams ?? []).map((team) => [team.id, team]));
  for (const team of audience.teams) {
    for (const memberId of teamsById.get(team.id)?.memberIds ?? []) ids.add(memberId);
  }
  for (const person of audience.people) ids.add(person.id);
  if (directory?.currentMemberId) ids.delete(directory.currentMemberId);
  return ids.size;
}

/** The right-hand row caption for something the member made. */
export function libraryOwnedCaption(audience: LibraryAudience, changedJustNow: boolean): string {
  if (changedJustNow) {
    return isLibraryAudienceShared(audience)
      ? t("extensions.row_changed_just_now_shared", { audience: libraryAudienceName(audience) })
      : t("extensions.row_changed_just_now");
  }
  return isLibraryAudienceShared(audience)
    ? t("extensions.row_owned_shared", { audience: libraryAudienceName(audience) })
    : t("extensions.row_owned_just_me");
}

/** A cloud plugin with a single skill or MCP reads as that thing, not as a plugin. */
export function libraryCloudItemTaxonomy(kinds: string[], componentCount: number): ExtensionTaxonomy {
  const unique = [...new Set(kinds.map((kind) => kind.toLowerCase()))];
  if (unique.length === 1 && componentCount === 1) {
    if (unique[0] === "skill") return "skill";
    if (unique[0] === "mcp") return "connection";
  }
  return "plugin";
}

export function isOwnedLibraryPlugin(item: Pick<DenLibraryPluginItem, "role" | "edges">) {
  return item.role === "owner" || item.edges.some((edge) => edge.kind === "mine");
}

/** Who shared an item with the member, for the From OpenWork caption. */
export function librarySharedByCaption(item: Pick<DenLibraryPluginItem, "edges">, organizationName: string): string {
  for (const edge of item.edges) {
    if (edge.kind === "person" && edge.sharedByName) return t("extensions.row_shared_by", { name: edge.sharedByName });
    if (edge.kind === "team") return t("extensions.row_cloud_from", { source: edge.teamName });
    if (edge.kind === "catalog" && edge.marketplaceName) return t("extensions.row_cloud_from", { source: edge.marketplaceName });
  }
  return t("extensions.row_cloud_from", { source: organizationName });
}

/** Who else can use a connection, read from how it reached the member. */
export function libraryConnectionAudience(edges: DenLibraryAccessEdge[], organizationName: string): string {
  if (edges.some((edge) => edge.kind === "org_wide")) return t("extensions.detail_who_everyone", { org: organizationName });
  const team = edges.find((edge) => edge.kind === "team");
  if (team?.kind === "team") return t("extensions.detail_who_team", { team: team.teamName });
  const catalog = edges.find((edge) => edge.kind === "catalog");
  if (catalog?.kind === "catalog" && catalog.marketplaceName) return t("extensions.detail_who_team", { team: catalog.marketplaceName });
  return t("extensions.detail_who_you");
}
