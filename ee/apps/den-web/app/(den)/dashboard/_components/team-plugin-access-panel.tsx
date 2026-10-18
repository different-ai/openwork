"use client";

import { getMarketplaceRoute } from "../../_lib/den-org";
import { DenNotice } from "../../_components/ui/notice";
import { DenButton } from "../../_components/ui/button";
import { ItemMenu, ItemPanel, ItemRow, ItemRowsSkeleton } from "./item-list";
import { PluginLogo } from "./item-logo";
import { TeamAccessReadError, type TeamPluginAccessItem, useRevokeTeamPluginAccess, useTeamPluginAccess } from "./team-access-data";

/** Each access path stays separate: revoking a team grant does not revoke a catalog grant. */
export function TeamPluginAccessPanel({ teamId, teamName, orgSlug, canRevoke }: {
  teamId: string;
  teamName: string;
  orgSlug: string | null;
  canRevoke: boolean;
}) {
  const access = useTeamPluginAccess(teamId);
  const revoke = useRevokeTeamPluginAccess();
  const denied = access.error instanceof TeamAccessReadError && [401, 403, 404].includes(access.error.status);
  const items = [...(!denied ? access.data ?? [] : [])].sort((a, b) => a.plugin.name.localeCompare(b.plugin.name) || a.edge.localeCompare(b.edge));
  const source = (item: TeamPluginAccessItem) => item.edge === "direct_team" ? "Shared with this team"
    : item.edge === "org_wide" ? "Shared with everyone" : `From ${item.marketplace?.name ?? "a marketplace"}`;

  if (!access.canRead) return <section aria-label="Plugins & connections" data-testid="team-plugin-access"><DenNotice tone="neutral" message="Viewing this team's access needs View any team or membership in this team. Ask the organization owner." /></section>;
  return <section aria-label="Plugins & connections" data-testid="team-plugin-access">
    <h2 className="mb-2 text-[13px] font-medium text-gray-700">Plugins & connections</h2>
    {access.error ? <DenNotice tone="error" message={access.data && !denied ? `Couldn't refresh team access. Last verified ${new Date(access.dataUpdatedAt).toLocaleString()}. Changes are blocked until verification succeeds.` : "Couldn't verify team access. Try again or ask an organization admin to check your access."} action={<DenButton variant="secondary" size="sm" loading={access.isFetching} onClick={() => void access.refetch()}>Try again</DenButton>} /> : null}
    {!access.error || access.data && !denied ? <ItemPanel>
      {access.isLoading ? <ItemRowsSkeleton label="Loading team access" /> : items.length ? items.map((item) => {
        const grantId = item.grantId;
        const accessSource = source(item);
        return <ItemRow
          key={`${item.plugin.id}-${item.edge}-${grantId ?? item.marketplace?.id ?? "org"}`}
          testId="team-plugin-access-row"
          logo={<PluginLogo name={item.plugin.name} />}
          title={item.plugin.name}
          description={item.role === "viewer" ? "Can use" : item.role === "editor" ? "Can edit" : "Can manage"}
          statusOnNarrow
          wrapStatus
          status={accessSource}
          action={<ItemMenu label={`More for ${item.plugin.name}, ${accessSource}`} entries={item.edge === "direct_team" ? [{
            label: canRevoke ? "Revoke" : "Revoke — an organization admin can change this",
            disabled: !canRevoke || !grantId || revoke.isPending || !access.isSuccess,
            destructive: true,
            confirm: {
              title: `Revoke ${item.plugin.name}?`,
              description: `Remove access to ${item.plugin.name} shared with ${teamName}. Members lose this access unless it is also shared through a marketplace or with everyone. Other teams keep their access; an admin can share it again.`,
              action: "Revoke",
            },
            onSelect: async () => { if (grantId) await revoke.mutateAsync({ teamId, pluginId: item.plugin.id, grantId }); },
          }] : item.edge === "via_catalog" && item.marketplace ? [{ label: "Open marketplace", href: getMarketplaceRoute(orgSlug, item.marketplace.id) }] : []} />}
        />;
      }) : <p className="px-5 py-4 text-[13px] text-gray-500">No plugin access yet. An organization admin can share a plugin with this team.</p>}
    </ItemPanel> : null}
  </section>;
}
