"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { DenPageHeader } from "../../_components/ui/page-header";
import { getAddConnectorRoute, getMcpConnectionRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { managedAccessStatus } from "./access-summary";
import { usePrefetchConnectorCatalog } from "./connector-catalog-screen";
import { connectorAccountReady } from "./connector-detail";
import { useDenToast } from "./den-toast";
import { ItemPage } from "./item-header";
import { FilterInput, ItemMenu, removeEntry, ItemPanel, ItemRow, ItemRowsSkeleton, LinkButton } from "./item-list";
import { ConnectorLogo } from "./item-logo";
import { ConnectorLogoStrip } from "./library-add-dialog";
import { connectorSetupUnfinished, finishSetupHref } from "./admin-connectors";
import { type ExternalMcpConnection, useDeleteMcpConnection, useMcpConnections } from "./mcp-connections-data";

function ConnectorsEmpty({ orgSlug }: { orgSlug: string | null }) {
  const prefetchCatalog = usePrefetchConnectorCatalog();
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex w-full flex-col items-center gap-5 rounded-2xl border border-gray-100 bg-white px-6 pb-14 pt-16 text-center" data-testid="connectors-empty">
        <ConnectorLogoStrip size="md" />
        <div className="flex flex-col gap-1.5">
          <p className="text-[15px] font-semibold leading-5 text-gray-900">No connectors yet</p>
          <p className="text-[13px] leading-[18px] text-gray-500">Apps your organization&apos;s AI can use. You choose who gets each one.</p>
        </div>
        <LinkButton variant="primary" href={getAddConnectorRoute(orgSlug)} onPointerEnter={prefetchCatalog} onFocus={prefetchCatalog}>
          <Plus className="h-4 w-4" aria-hidden />
          Add connector
        </LinkButton>
      </div>
      <p className="text-[12px] leading-4 text-gray-400">Members can still add apps for themselves in My Library.</p>
    </div>
  );
}

/** C1 and C5: every connector the organization manages, and who has each one. */
export function AdminConnectorsScreen() {
  const toast = useDenToast();
  const { orgSlug, orgContext } = useOrgDashboard();
  const connections = useMcpConnections("manageable");
  const deleteConnection = useDeleteMcpConnection();
  const prefetchCatalog = usePrefetchConnectorCatalog();
  const [query, setQuery] = useState("");
  const viewerId = orgContext?.currentMember.id ?? null;
  const all = connections.data ?? [];
  const needle = query.trim().toLowerCase();
  const visible = needle ? all.filter((connection) => connection.name.toLowerCase().includes(needle)) : all;
  const empty = !connections.isLoading && !connections.error && all.length === 0;

  async function remove(connection: ExternalMcpConnection) {
    await deleteConnection.mutateAsync(connection.id);
    toast({ title: `${connection.name} is removed`, description: "Nobody can use it anymore." });
  }

  return (
    <ItemPage testId="admin-connectors">
      <DenPageHeader
        title="Connectors"
        description="Apps your organization's AI can use."
        action={empty ? undefined : (
          <LinkButton variant="primary" href={getAddConnectorRoute(orgSlug)} onPointerEnter={prefetchCatalog} onFocus={prefetchCatalog}>
            <Plus className="h-4 w-4" aria-hidden />
            Add connector
          </LinkButton>
        )}
      />

      {connections.error ? (
        <p className="rounded-2xl border border-gray-100 bg-white px-5 py-4 text-[13px] text-red-600">
          {connections.error instanceof Error ? connections.error.message : "Connectors did not load."}
        </p>
      ) : null}

      {empty ? <ConnectorsEmpty orgSlug={orgSlug} /> : null}

      {!empty && !connections.error ? (
        <>
          <div className="-mt-1 flex justify-end">
            <FilterInput value={query} onChange={setQuery} className="w-[240px]" />
          </div>
          {connections.isLoading ? <ItemPanel><ItemRowsSkeleton label="Loading connectors" /></ItemPanel> : null}
          {visible.length > 0 ? (
            <ItemPanel>
              {visible.map((connection) => {
                const href = getMcpConnectionRoute(orgSlug, connection.id);
                const unfinished = connectorSetupUnfinished(connection);
                const status = unfinished
                  ? "Setup not finished"
                  : orgContext ? managedAccessStatus(connection.access, orgContext, viewerId) : "";
                const signInNote = connection.credentialMode === "per_member" && connection.authType === "oauth"
                  ? "Each person signs in"
                  : connection.authType === "none" ? "No sign-in needed" : connectorAccountReady(connection) ? "One account for everyone" : undefined;
                return (
                  <div key={connection.id} data-connector-row={connection.name}>
                    <ItemRow
                      href={href}
                      logo={<ConnectorLogo name={connection.name} url={connection.url} />}
                      title={connection.name}
                      description={signInNote}
                      status={status}
                      action={unfinished ? (
                        <LinkButton size="xs" href={finishSetupHref(orgSlug, connection)}>Finish</LinkButton>
                      ) : (
                        <ItemMenu
                          label={`More for ${connection.name}`}
                          entries={[
                            { label: "Open", href },
                            removeEntry(connection.name, () => remove(connection)),
                          ]}
                        />
                      )}
                    />
                  </div>
                );
              })}
            </ItemPanel>
          ) : null}
          {!connections.isLoading && visible.length === 0 ? (
            <p className="rounded-2xl border border-gray-100 bg-white px-5 py-6 text-center text-[13px] text-gray-500">Nothing matches.</p>
          ) : null}
        </>
      ) : null}
    </ItemPage>
  );
}
