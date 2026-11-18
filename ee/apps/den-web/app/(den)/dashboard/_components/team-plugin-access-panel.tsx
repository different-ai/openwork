"use client";

import { getMarketplaceRoute } from "../../_lib/den-org";
import { DenNotice } from "../../_components/ui/notice";
import { FeatureIntroGate } from "../_features/feature-intros";
import { ItemMenu, ItemPanel, ItemRow, ItemRowsSkeleton } from "./item-list";
import { PluginLogo } from "./item-logo";
import { type TeamPluginAccessItem, useRevokeTeamPluginAccess, useTeamPluginAccess } from "./team-access-data";

/** Each access path stays separate: revoking a team grant does not revoke a catalog grant. */
export function TeamPluginAccessPanel({ teamId, teamName, orgSlug, canRevoke }: {
  teamId: string;
  teamName: string;
  orgSlug: string | null;
  canRevoke: boolean;
}) {
  const access = useTeamPluginAccess(teamId);
  const revoke = useRevokeTeamPluginAccess();
  const items = [...(access.data ?? [])].sort((a, b) => a.plugin.name.localeCompare(b.plugin.name) || a.edge.localeCompare(b.edge));
  const rolesVary = new Set(items.map((item) => item.role)).size > 1;
  const source = (item: TeamPluginAccessItem) => item.edge === "direct_team" ? "This team"
    : item.edge === "org_wide" ? "Everyone" : `Through ${item.marketplace?.name}`;

  // With feature intros on, the Access intro replaces "No plugin access yet" (DESIGN.md I1); null while loading or failed.
  const introFacts = access.data && !access.error ? { plugins: items.length } : null;

  return <FeatureIntroGate introKey="team-detail.access" facts={introFacts}><section aria-label="Plugins & connections" data-testid="team-plugin-access">
    <h2 className="mb-2 text-[13px] font-medium text-gray-700">Plugins & connections</h2>
    {access.error ? <DenNotice tone="error" message={access.data ? "Could not refresh team access. Showing the last loaded access; reload to try again." : "Could not load team access. Reload to try again."} /> : null}
    {!access.error || access.data ? <ItemPanel>
      {access.isLoading ? <ItemRowsSkeleton label="Loading team access" /> : items.length ? items.map((item) => {
        const grantId = item.grantId;
        const accessSource = source(item);
        return <ItemRow
          key={`${item.plugin.id}-${item.edge}-${grantId ?? item.marketplace?.id ?? "org"}`}
          testId="team-plugin-access-row"
          logo={<PluginLogo name={item.plugin.name} />}
          title={item.plugin.name}
          description={`${item.plugin.componentCount} ${item.plugin.componentCount === 1 ? "component" : "components"}${rolesVary ? ` · ${item.role === "viewer" ? "Can use" : item.role === "editor" ? "Can edit" : "Can manage"}` : ""}`}
          statusOnNarrow
          status={<span title={accessSource}>{accessSource}</span>}
          action={<ItemMenu label={`More for ${item.plugin.name}, ${accessSource}`} entries={item.edge === "direct_team" ? [{
            label: canRevoke ? "Revoke" : "Revoke — an organization admin can change this",
            disabled: !canRevoke || !grantId || revoke.isPending,
            destructive: true,
            confirm: {
              title: `Revoke ${item.plugin.name}?`,
              description: `Remove ${teamName}'s direct access to ${item.plugin.name} and its ${item.plugin.componentCount} ${item.plugin.componentCount === 1 ? "component" : "components"}. Members lose this access unless another grant applies. Other teams and catalog access stay unchanged; an admin can grant access again.`,
              action: "Revoke",
            },
            onSelect: async () => { if (grantId) await revoke.mutateAsync({ teamId, pluginId: item.plugin.id, grantId }); },
          }] : item.edge === "via_catalog" && item.marketplace ? [{ label: "Open catalog", href: getMarketplaceRoute(orgSlug, item.marketplace.id) }] : []} />}
        />;
      }) : <p className="px-5 py-4 text-[13px] text-gray-500">No plugin access yet. An organization admin can share a plugin with this team.</p>}
    </ItemPanel> : null}
  </section></FeatureIntroGate>;
}
