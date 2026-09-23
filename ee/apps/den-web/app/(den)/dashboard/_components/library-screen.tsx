"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenPageHeader } from "../../_components/ui/page-header";
import {
  getLibraryAddConnectorRoute,
  getLibraryConnectorRoute,
  getLibraryConnectorShareRoute,
  getLibraryNewPluginRoute,
  getLibraryPluginRoute,
  getLibraryPluginShareRoute,
  getYourConnectionsRoute,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { ownedAccessStatus } from "./access-summary";
import { draftFromPluginGrants } from "./item-sharing";
import { FilterInput, ItemMenu, removeEntry, ItemPanel, ItemRow, ItemSection, ItemSectionSkeleton } from "./item-list";
import { ItemPage } from "./item-header";
import { ConnectorLogo, LetterTile } from "./item-logo";
import { LibraryAddDialog, type LibraryAddChoice, ConnectorLogoStrip } from "./library-add-dialog";
import { type LibraryItem, libraryQueryKeys, useLibrary } from "./library-data";
import {
  groupLibrary,
  isOwnedByViewer,
  LIBRARY_FILTERS,
  type LibraryFilter,
  libraryItemDescription,
  parseLibraryFilter,
  receivedStatus,
} from "./library-view";
import { type ExternalMcpConnection, useDeleteMcpConnection, useMcpConnections } from "./mcp-connections-data";
import { usePrefetchConnectorCatalog } from "./connector-catalog-screen";
import { useMemberSignIn } from "./connector-setup";
import { usePluginAccess } from "./plugin-access-data";
import { useDenToast } from "./den-toast";
import { requestJson, getRequestError } from "../../_lib/den-flow";
import { pluginQueryKeys } from "./plugin-data";

function itemHref(orgSlug: string | null, item: LibraryItem): string {
  if (item.type === "connection") return getLibraryConnectorRoute(orgSlug, item.id);
  if (item.type === "plugin") return getLibraryPluginRoute(orgSlug, item.id);
  return `/dashboard/library/workflows/${encodeURIComponent(item.id)}`;
}

function ItemLogo({ item }: { item: LibraryItem }) {
  if (item.type === "connection") return <ConnectorLogo name={item.name} url={item.url} />;
  return <LetterTile name={item.name} />;
}

function OwnedConnectionStatus({ connection }: { connection: ExternalMcpConnection | undefined }) {
  const { orgContext } = useOrgDashboard();
  if (!orgContext) return null;
  return <>{ownedAccessStatus(connection?.access ?? null, orgContext, orgContext.currentMember.id)}</>;
}

function OwnedPluginStatus({ pluginId }: { pluginId: string }) {
  const { orgContext } = useOrgDashboard();
  const access = usePluginAccess(pluginId);
  if (!orgContext || !access.data) return null;
  return <>{ownedAccessStatus(draftFromPluginGrants(access.data), orgContext, orgContext.currentMember.id)}</>;
}

function LibraryItemRow({ item, mine, ownedConnection, signIn }: {
  item: LibraryItem;
  mine: boolean;
  ownedConnection: ExternalMcpConnection | undefined;
  signIn: ReturnType<typeof useMemberSignIn>;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useDenToast();
  const { orgSlug } = useOrgDashboard();
  const deleteConnection = useDeleteMcpConnection();
  const href = itemHref(orgSlug, item);

  async function remove() {
    if (item.type === "connection") {
      await deleteConnection.mutateAsync(item.id);
    } else if (item.type === "plugin") {
      const { response, payload } = await requestJson(`/v1/plugins/${encodeURIComponent(item.id)}/archive`, { method: "POST", body: "{}" }, 15000);
      if (!response.ok) throw getRequestError(payload, response, "Could not remove it.");
      await queryClient.invalidateQueries({ queryKey: pluginQueryKeys.all });
    }
    await queryClient.invalidateQueries({ queryKey: libraryQueryKeys.items });
    toast({ title: `${item.name} is removed`, description: "Nobody can use it anymore." });
  }

  const status = mine
    ? item.type === "connection" ? <OwnedConnectionStatus connection={ownedConnection} />
      : item.type === "plugin" ? <OwnedPluginStatus pluginId={item.id} /> : "Only you"
    : receivedStatus(item.edges);

  const needsSignIn = item.type === "connection" && item.state === "needs_signin";
  const action = needsSignIn && item.type === "connection" ? (
    item.transport === "native" ? (
      <DenButton variant="secondary" size="xs" href={`${getYourConnectionsRoute(orgSlug)}?connectionId=${encodeURIComponent(item.id)}`}>Sign in</DenButton>
    ) : (
      <DenButton variant="secondary" size="xs" loading={signIn.pendingId === item.id} onClick={() => void signIn.signIn(item)}>Sign in</DenButton>
    )
  ) : (
    <ItemMenu
      label={`More for ${item.name}`}
      entries={[
        { label: "Open", onSelect: () => router.push(href) },
        ...(mine && item.type === "connection" ? [{ label: "Share", onSelect: () => router.push(getLibraryConnectorShareRoute(orgSlug, item.id)) }] : []),
        ...(mine && item.type === "plugin" ? [{ label: "Share", onSelect: () => router.push(getLibraryPluginShareRoute(orgSlug, item.id)) }] : []),
        ...(mine && item.type !== "workflow" ? [removeEntry(item.name, remove)] : []),
      ]}
    />
  );

  return (
    <div data-library-item={item.name} data-library-kind={item.type}>
      <ItemRow
        href={href}
        logo={<ItemLogo item={item} />}
        title={item.name}
        description={libraryItemDescription(item)}
        status={status}
        action={action}
      />
    </div>
  );
}

function LibraryEmpty({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex w-full flex-col items-center gap-5 rounded-2xl border border-gray-100 bg-white px-6 pb-14 pt-16 text-center" data-testid="library-empty">
        <ConnectorLogoStrip size="md" />
        <div className="flex flex-col gap-1.5">
          <p className="text-[15px] font-semibold leading-5 text-gray-900">Nothing in your Library yet</p>
          <p className="text-[13px] leading-[18px] text-gray-500">Add a connector, a skill or a plugin. Only you can use it until you share it.</p>
        </div>
        <DenButton icon={Plus} onClick={onAdd}>Add to your Library</DenButton>
      </div>
      <p className="text-[12px] leading-4 text-gray-400">Things your organization gives you show up here too.</p>
    </div>
  );
}

// The boundary useSearchParams needs for the static build sits inside this module, not the
// page: a boundary above the module would show its empty fallback while the module loads,
// and React keeps a fallback up for at least 300ms.
export function LibraryScreen() {
  return (
    <Suspense fallback={null}>
      <LibraryContent />
    </Suspense>
  );
}

function LibraryContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { orgSlug, orgContext } = useOrgDashboard();
  const library = useLibrary();
  const usable = useMcpConnections("usable");
  const signIn = useMemberSignIn();
  const prefetchCatalog = usePrefetchConnectorCatalog();
  const [addOpen, setAddOpen] = useState(searchParams.get("add") === "1");
  const [query, setQuery] = useState("");
  const filter = parseLibraryFilter(searchParams.get("show"));

  const ownedConnections = new Map((usable.data ?? []).filter((connection) => connection.access !== null).map((connection) => [connection.id, connection]));
  const viewerId = orgContext?.currentMember.id ?? null;
  const items = library.data ?? [];
  const groups = groupLibrary({
    items,
    filter,
    query,
    isMine: (item) => isOwnedByViewer(item, viewerId, new Set(ownedConnections.keys())),
  });

  function setFilter(next: LibraryFilter) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "all") params.delete("show");
    else params.set("show", next);
    const suffix = params.toString();
    router.replace(suffix ? `?${suffix}` : "?", { scroll: false });
  }

  function openAdd() {
    prefetchCatalog();
    setAddOpen(true);
  }

  function hrefFor(choice: LibraryAddChoice): string {
    if (choice === "connector") return getLibraryAddConnectorRoute(orgSlug);
    return getLibraryNewPluginRoute(orgSlug, choice === "skill" ? "skill" : undefined);
  }

  const empty = !library.isLoading && !library.error && items.length === 0;

  return (
    <ItemPage testId="library-screen">
      <DenPageHeader
        title="My Library"
        description="Connectors, skills and plugins you can use in chat."
        action={empty ? undefined : <DenButton icon={Plus} onClick={openAdd}>Add to your Library</DenButton>}
      />

      {library.error ? (
        <p className="rounded-2xl border border-gray-100 bg-white px-5 py-4 text-[13px] text-red-600">
          {library.error instanceof Error ? library.error.message : "Your Library did not load."}
        </p>
      ) : null}

      {empty ? <LibraryEmpty onAdd={openAdd} /> : null}

      {!empty && !library.error ? (
        <>
          <div className="-mt-1 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1.5" role="tablist" aria-label="Show">
              {LIBRARY_FILTERS.map((entry) => {
                const active = entry.value === filter;
                return (
                  <button
                    key={entry.value}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setFilter(entry.value)}
                    className={`h-[30px] rounded-full px-3 text-[12px] font-medium transition-colors ${active ? "bg-gray-900 text-white" : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 hover:text-gray-900"}`}
                  >
                    {entry.label}
                  </button>
                );
              })}
            </div>
            <FilterInput value={query} onChange={setQuery} className="w-[240px]" />
          </div>

          {library.isLoading ? <ItemSectionSkeleton label="Loading your Library" /> : null}

          {groups.mine.length > 0 ? (
            <ItemSection title="Added by you" testId="library-section-mine">
              <ItemPanel>
                {groups.mine.map((item) => (
                  <LibraryItemRow key={`${item.type}:${item.id}`} item={item} mine ownedConnection={ownedConnections.get(item.id)} signIn={signIn} />
                ))}
              </ItemPanel>
            </ItemSection>
          ) : null}

          {groups.received.length > 0 ? (
            <ItemSection title="From OpenWork" testId="library-section-received">
              <ItemPanel>
                {groups.received.map((item) => (
                  <LibraryItemRow key={`${item.type}:${item.id}`} item={item} mine={false} ownedConnection={undefined} signIn={signIn} />
                ))}
              </ItemPanel>
            </ItemSection>
          ) : null}

          {!library.isLoading && groups.mine.length === 0 && groups.received.length === 0 ? (
            <p className="rounded-2xl border border-gray-100 bg-white px-5 py-6 text-center text-[13px] text-gray-500">Nothing matches.</p>
          ) : null}
        </>
      ) : null}

      <LibraryAddDialog open={addOpen} onOpenChange={setAddOpen} hrefFor={hrefFor} />
    </ItemPage>
  );
}
