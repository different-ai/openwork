"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
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
  orgFeatureEnabled,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { FilterInput, ItemMenu, ItemPanel, ItemRow, removeEntry, ItemSection, ItemSectionSkeleton } from "./item-list";
import { ItemPage } from "./item-header";
import { ConnectorLogo, PluginLogo } from "./item-logo";
import { LibraryAddDialog, type LibraryAddChoice } from "./library-add-dialog";
import { type LibraryItem, libraryQueryKeys, useLibrary } from "./library-data";
import {
  groupLibrary,
  isOwnedByViewer,
  isSingleSkill,
  LIBRARY_FILTERS,
  type LibraryFilter,
  libraryItemDescription,
  libraryItemReady,
  NEEDS_SIGN_IN_STATUS,
  needsViewerSignIn,
  parseLibraryFilter,
  parseNeedsSignIn,
} from "./library-view";
import { useDeleteMcpConnection, useMcpConnections } from "./mcp-connections-data";
import { usePrefetchConnectorCatalog } from "./connector-catalog-screen";
import { useMemberSignIn } from "./connector-setup";
import { matchesModelQuery } from "./library-models";
import { useLibraryModels, useModelSignIn } from "./library-models-data";
import { LibraryModelRow } from "./library-models-ui";
import { MemberApiKeyDialog } from "./member-api-key-dialog";
import { useDenToast } from "./den-toast";
import { requestJson, getRequestError } from "../../_lib/den-flow";
import { pluginQueryKeys } from "./plugin-data";
import { LibraryPluginSkills } from "./library-plugin-skills";

function itemHref(orgSlug: string | null, item: LibraryItem): string {
  if (item.type === "connection") return getLibraryConnectorRoute(orgSlug, item.id);
  if (item.type === "plugin") return getLibraryPluginRoute(orgSlug, item.id);
  return `/dashboard/library/workflows/${encodeURIComponent(item.id)}`;
}

function ItemLogo({ item }: { item: LibraryItem }) {
  if (item.type === "connection") return <ConnectorLogo name={item.name} url={item.url} />;
  return <PluginLogo name={item.name} />;
}

function LibraryItemRow({ item, mine, signIn }: {
  item: LibraryItem;
  mine: boolean;
  signIn: ReturnType<typeof useMemberSignIn>;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useDenToast();
  const { orgSlug, orgContext } = useOrgDashboard();
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

  const needsSignIn = item.type === "connection" && item.state === "needs_signin";
  const apiKeyStatus = item.type === "connection" ? signIn.apiKeyStatus(item.id) : null;
  const action = needsSignIn && item.type === "connection" ? (
    item.transport === "native" ? (
      <DenButton variant="secondary" size="xs" aria-label="Sign in" href={`${getYourConnectionsRoute(orgSlug)}?connectionId=${encodeURIComponent(item.id)}`}>Sign in</DenButton>
    ) : (
      <DenButton variant="secondary" size="xs" aria-label={apiKeyStatus === "reconnect_required" ? "Replace key" : apiKeyStatus === "missing" ? "Add key" : "Sign in"} loading={signIn.pendingId === item.id} onClick={() => void signIn.signIn(item)}>
        {apiKeyStatus === "reconnect_required" ? "Replace key" : apiKeyStatus === "missing" ? "Add key" : "Sign in"}
      </DenButton>
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
    <div data-library-item={item.name} data-library-kind={item.type} title={libraryItemDescription(item)}>
      <ItemRow
        compact
        wideAction={needsSignIn}
        href={href}
        logo={<ItemLogo item={item} />}
        title={item.name}
        description={libraryItemDescription(item)}
        status={needsSignIn ? undefined : libraryItemReady(item) ? "Ready" : item.type !== "plugin" && item.state === "needs_signin" ? "Sign in" : "Set up"}
        action={action}
      />
      {item.type === "plugin" && item.componentKinds.some((kind) => kind.toLowerCase() === "skill") && orgFeatureEnabled(orgContext, "libraryConnectorNavigation") ? (
        <LibraryPluginSkills
          pluginId={item.id}
          name={item.name}
          single={isSingleSkill(item)}
          knownCount={item.componentKinds.every((kind) => kind.toLowerCase() === "skill") ? item.componentCount : null}
        />
      ) : null}
    </div>
  );
}

function LibraryEmpty({ onAdd }: { onAdd: () => void }) {
  return (
    <ItemPanel>
      <div className="flex flex-col items-center gap-3 px-5 py-8 text-center" data-testid="library-empty">
        <h2 className="text-sm font-medium text-[var(--dls-text-primary)]">Nothing in your Library yet</h2>
        <p className="text-[13px] text-[var(--dls-text-secondary)]">Add a connector, skill or plugin.</p>
        <DenButton icon={Plus} onClick={onAdd}>Add to library</DenButton>
        <p className="text-xs text-[var(--dls-text-secondary)]">Only you can use it until you share it.</p>
      </div>
    </ItemPanel>
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
  const models = useLibraryModels();
  const modelSignIn = useModelSignIn();
  const [addOpen, setAddOpen] = useState(searchParams.get("add") === "1");
  const [query, setQuery] = useState("");
  const filter = parseLibraryFilter(searchParams.get("show"));
  const onlyNeedsSignIn = parseNeedsSignIn(searchParams.get("status"));

  const ownedConnections = new Map((usable.data ?? []).filter((connection) => connection.access !== null).map((connection) => [connection.id, connection]));
  const viewerId = orgContext?.currentMember.id ?? null;
  const items = library.data ?? [];
  const groups = groupLibrary({
    items,
    filter,
    query,
    isMine: (item) => isOwnedByViewer(item, viewerId, new Set(ownedConnections.keys())),
    needsSignIn: onlyNeedsSignIn,
  });

  function setFilter(next: LibraryFilter) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "all") params.delete("show");
    else params.set("show", next);
    const suffix = params.toString();
    router.replace(suffix ? `?${suffix}` : "?", { scroll: false });
  }

  function toggleNeedsSignIn() {
    const params = new URLSearchParams(searchParams.toString());
    if (onlyNeedsSignIn) params.delete("status");
    else params.set("status", NEEDS_SIGN_IN_STATUS);
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

  const showModels = filter === "all" || filter === "models";
  const modelRows = showModels
    ? (models.data ?? []).filter((provider) => matchesModelQuery(provider, query) && (!onlyNeedsSignIn || provider.state === "needs_signin"))
    : [];
  const needsSignInCount = items.filter(needsViewerSignIn).length
    + (models.data ?? []).filter((provider) => provider.state === "needs_signin").length;
  const hasModels = (models.data ?? []).length > 0;
  const empty = !library.isLoading && !library.error && items.length === 0 && !models.isLoading && !hasModels;

  return (
    <ItemPage testId="library-screen">
      <DenPageHeader
        title="My Library"
        size="compact"
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
            <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Show">
              {LIBRARY_FILTERS.map((entry) => {
                const active = entry.value === filter;
                return (
                  <button
                    key={entry.value}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setFilter(entry.value)}
                    className={`h-7 rounded-full px-3 text-[12px] transition-colors ${active ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200/70"}`}
                  >
                    {entry.label}
                  </button>
                );
              })}
              {needsSignInCount > 0 || onlyNeedsSignIn ? (
                <>
                  <span className="mx-1 h-4 w-px bg-gray-200" aria-hidden="true" />
                  <button
                    type="button"
                    aria-pressed={onlyNeedsSignIn}
                    onClick={toggleNeedsSignIn}
                    data-testid="library-needs-sign-in-filter"
                    className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] transition-colors ${onlyNeedsSignIn ? "bg-gray-900 text-white" : "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50"}`}
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                    Needs sign-in
                    <span className={onlyNeedsSignIn ? "text-white/70" : "text-gray-500"}>{needsSignInCount}</span>
                  </button>
                </>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <FilterInput value={query} onChange={setQuery} className="w-[200px] max-w-full" />
              <DenButton size="sm" icon={Plus} onClick={openAdd}>Add to library</DenButton>
            </div>
          </div>

          {library.isLoading ? <ItemSectionSkeleton label="Loading your Library" /> : null}

          {groups.mine.length > 0 ? (
            <ItemSection title="Added by you" testId="library-section-mine" variant="rule">
              <ItemPanel>
                {groups.mine.map((item) => (
                  <LibraryItemRow key={`${item.type}:${item.id}`} item={item} mine signIn={signIn} />
                ))}
              </ItemPanel>
            </ItemSection>
          ) : null}

          {groups.received.length > 0 || modelRows.length > 0 ? (
            <ItemSection title="From OpenWork" testId="library-section-received" variant="rule">
              <ItemPanel>
                {groups.received.map((item) => (
                  <LibraryItemRow key={`${item.type}:${item.id}`} item={item} mine={false} signIn={signIn} />
                ))}
                {modelRows.map((provider) => (
                  <LibraryModelRow key={`model:${provider.id}`} provider={provider} signIn={modelSignIn} />
                ))}
              </ItemPanel>
            </ItemSection>
          ) : null}

          {filter === "models" && models.error ? (
            <p className="rounded-2xl border border-gray-100 bg-white px-5 py-4 text-[13px] text-gray-600">
              {models.error instanceof Error ? models.error.message : "Your models did not load."}
            </p>
          ) : null}

          {filter === "models" && !models.isLoading && !models.error && !hasModels ? (
            <p className="rounded-2xl border border-gray-100 bg-white px-5 py-6 text-center text-[13px] text-gray-500" data-testid="library-models-empty">
              Your organization hasn't given you any models yet.
            </p>
          ) : null}

          {!library.isLoading && !models.isLoading && groups.mine.length === 0 && groups.received.length === 0 && modelRows.length === 0 && !(filter === "models" && (models.error || !hasModels)) ? (
            <p className="rounded-2xl border border-gray-100 bg-white px-5 py-6 text-center text-[13px] text-gray-500">Nothing matches.</p>
          ) : null}
        </>
      ) : null}

      <LibraryAddDialog open={addOpen} onOpenChange={setAddOpen} hrefFor={hrefFor} />
      <MemberApiKeyDialog target={signIn.apiKeyTarget} onClose={signIn.closeApiKey} />
    </ItemPage>
  );
}
