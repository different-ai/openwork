"use client";

import { Plus, UserPlus } from "lucide-react";
import { DenPageHeader } from "../../_components/ui/page-header";
import { getNewPluginRoute, getPluginRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { managedAccessStatus } from "./access-summary";
import { useDenToast } from "./den-toast";
import { ItemPage } from "./item-header";
import { ItemMenu, removeEntry, ItemPanel, ItemRow, LinkButton } from "./item-list";
import { LetterTile } from "./item-logo";
import { draftFromPluginGrants } from "./item-sharing";
import { ConnectorLogoStrip } from "./library-add-dialog";
import { usePluginAccess } from "./plugin-access-data";
import { type DenPlugin, useArchivePlugin, usePlugins } from "./plugin-data";

function PluginsEmpty({ orgSlug }: { orgSlug: string | null }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex w-full flex-col items-center gap-5 rounded-2xl border border-gray-100 bg-white px-6 pb-14 pt-16 text-center" data-testid="plugins-empty">
        <ConnectorLogoStrip size="md" />
        <div className="flex flex-col gap-1.5">
          <p className="text-[15px] font-semibold leading-5 text-gray-900">No plugins yet</p>
          <p className="text-[13px] leading-[18px] text-gray-500">Skills, commands and connectors bundled for a job. You choose which teams get each one.</p>
        </div>
        <LinkButton variant="primary" href={getNewPluginRoute(orgSlug)}>
          <Plus className="h-4 w-4" aria-hidden />
          Create a plugin
        </LinkButton>
      </div>
      <p className="text-[12px] leading-4 text-gray-400">Members can still make plugins for themselves in My Library.</p>
    </div>
  );
}

function PluginRow({ plugin }: { plugin: DenPlugin }) {
  const toast = useDenToast();
  const { orgSlug, orgContext } = useOrgDashboard();
  const access = usePluginAccess(plugin.id);
  const archive = useArchivePlugin();
  const href = getPluginRoute(orgSlug, plugin.id);
  const status = orgContext && access.data
    ? managedAccessStatus(draftFromPluginGrants(access.data), orgContext, plugin.createdByOrgMembershipId)
    : "";

  async function remove() {
    await archive.mutateAsync(plugin.id);
    toast({ title: `${plugin.name} is removed`, description: "Nobody can use it anymore." });
  }

  return (
    <div data-plugin-row={plugin.name}>
      <ItemRow
        href={href}
        logo={<LetterTile name={plugin.name} />}
        title={plugin.name}
        description={plugin.description || undefined}
        status={status}
        action={status === "Only you" ? (
          <LinkButton size="xs" href={href} aria-label={`Share ${plugin.name}`}>
            <UserPlus className="h-3.5 w-3.5" aria-hidden />
            Share
          </LinkButton>
        ) : (
          <ItemMenu
            label={`More for ${plugin.name}`}
            entries={[
              { label: "Open", href },
              removeEntry(plugin.name, remove),
            ]}
          />
        )}
      />
    </div>
  );
}

/** D1 and D6: every plugin the organization manages, and who has each one. */
export function AdminPluginsScreen() {
  const { orgSlug } = useOrgDashboard();
  const plugins = usePlugins();
  const visible = (plugins.data ?? []).filter((plugin) => plugin.status !== "archived");
  const empty = !plugins.isLoading && !plugins.error && visible.length === 0;

  return (
    <ItemPage testId="admin-plugins">
      <DenPageHeader
        title="Plugins"
        description={empty ? "Skills, commands and connectors bundled for a job." : "Skills, commands and connectors bundled for a job. You choose which teams get each one."}
        action={empty ? undefined : (
          <LinkButton variant="primary" href={getNewPluginRoute(orgSlug)}>
            <Plus className="h-4 w-4" aria-hidden />
            Create a plugin
          </LinkButton>
        )}
      />

      {plugins.error ? (
        <p className="rounded-2xl border border-gray-100 bg-white px-5 py-4 text-[13px] text-red-600">
          The list did not load. Reload the page to try again.
        </p>
      ) : null}

      {empty ? <PluginsEmpty orgSlug={orgSlug} /> : null}

      {!empty && !plugins.error ? (
        <>
          {plugins.isLoading ? <p className="text-[13px] text-gray-500">Loading plugins...</p> : null}
          {visible.length > 0 ? (
            <ItemPanel>
              {visible.map((plugin) => <PluginRow key={plugin.id} plugin={plugin} />)}
            </ItemPanel>
          ) : null}
        </>
      ) : null}
    </ItemPage>
  );
}
