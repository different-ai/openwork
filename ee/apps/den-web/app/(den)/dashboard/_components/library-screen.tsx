"use client";

import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenPageHeader } from "../../_components/ui/page-header";
import { UnderlineTabs } from "../../_components/ui/tabs";
import {
  getLibraryAddConnectorRoute,
  getLibraryConnectorRoute,
  getLibraryConnectorShareRoute,
  getLibraryNewPluginRoute,
  getLibraryPluginRoute,
  getLibraryPluginShareRoute,
  getLibraryLlmProviderRoute,
  getLibraryRoute,
  getYourConnectionsRoute,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { FilterInput, ItemMenu, ItemPanel, removeEntry } from "./item-list";
import { ItemPage } from "./item-header";
import { ConnectorLogo } from "./item-logo";
import { LibraryAddDialog, type LibraryAddChoice } from "./library-add-dialog";
import { type LibraryItem, libraryQueryKeys, useLibrary } from "./library-data";
import {
  groupLibrary,
  isOwnedByViewer,
  LIBRARY_FILTERS,
  type LibraryFilter,
  libraryItemDescription,
  libraryFilterOf,
  libraryItemReady,
  needsViewerSignIn,
  parseLibraryFilter,
  parseNeedsSignIn,
  receivedStatus,
} from "./library-view";
import { LibraryCompactRow, LibraryCompactSection, LibraryCompactSkeleton, LibraryCompactSurface, LibraryKindIcon } from "./library-compact";
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
import { useOrgLlmProviders } from "./llm-provider-data";

/** Show the name filter once a Library holds more than this many items. */
const FILTER_AFTER = 10;

function itemHref(orgSlug: string | null, item: LibraryItem): string {
  if (item.type === "connection") return getLibraryConnectorRoute(orgSlug, item.id);
  if (item.type === "plugin") return getLibraryPluginRoute(orgSlug, item.id);
  return `/dashboard/library/workflows/${encodeURIComponent(item.id)}`;
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
  const ready = libraryItemReady(item);
  const status = ready ? "Ready" : item.type !== "plugin" && item.state === "needs_signin" ? "Sign in" : "Set up";
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
    <LibraryCompactRow
      href={href}
      kind={item.type}
      testName={item.name}
      logo={item.type === "connection"
        ? <ConnectorLogo name={item.name} url={item.url} size="xs" />
        : <LibraryKindIcon kind={item.type === "workflow" ? "workflow" : libraryFilterOf(item) === "skills" ? "skill" : "plugin"} />}
      name={item.name}
      description={item.description ? libraryItemDescription(item) : undefined}
      source={mine ? "You" : receivedStatus(item.edges)}
      action={needsSignIn ? action : ready || item.type === "plugin" ? action : <span className="text-[12px] text-[var(--dls-text-secondary)]">{status}</span>}
      revealAction={!needsSignIn && (ready || item.type === "plugin")}
    />
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
  const personal = useOrgLlmProviders(filter === "models" ? orgContext?.organization.id ?? null : null);
  const personalProviders = personal.llmProviders.filter(provider => provider.source !== "openwork" && provider.createdByOrgMembershipId === orgContext?.currentMember.id);
  const addKeyHref = `${getLibraryRoute(orgSlug)}/model-providers/new`;
  const onlyNeedsSignIn = parseNeedsSignIn(searchParams.get("status"));
  const personalRows = personalProviders.filter(provider => !onlyNeedsSignIn && provider.name.toLowerCase().includes(query.trim().toLowerCase()));

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
  const hasModels = (models.data ?? []).length > 0;
  const empty = !library.isLoading && !library.error && items.length === 0 && !models.isLoading && !hasModels && personalProviders.length === 0;
  // A short Library is read at a glance; the filter earns its place once the list runs long.
  const showFilter = items.length + (models.data ?? []).length + personalProviders.length > FILTER_AFTER || query !== "";

  // What waits on you first, then one section per kind.
  const mineKeys = new Set(groups.mine.map((item) => `${item.type}:${item.id}`));
  const visible = [...groups.mine, ...groups.received].sort((left, right) => left.name.localeCompare(right.name));
  const kindSections: { key: string; title: string; match: (item: LibraryItem) => boolean }[] = [
    { key: "connectors", title: "Connectors", match: (item) => libraryFilterOf(item) === "connectors" },
    { key: "skills", title: "Skills", match: (item) => libraryFilterOf(item) === "skills" },
    { key: "plugins", title: "Plugins", match: (item) => libraryFilterOf(item) === "plugins" },
    { key: "workflows", title: "Workflows", match: (item) => libraryFilterOf(item) === null },
  ];
  const sections = [
    { key: "attention", title: "Needs your sign-in", items: visible.filter(needsViewerSignIn), models: modelRows.filter((provider) => provider.state === "needs_signin") },
    ...kindSections.map((section) => ({ ...section, items: visible.filter((item) => !needsViewerSignIn(item) && section.match(item)), models: [] as typeof modelRows })),
    { key: "models", title: "Models", items: [] as LibraryItem[], models: modelRows.filter((provider) => provider.state !== "needs_signin") },
  ].filter((section) => section.items.length + section.models.length > 0);

  return (
    <ItemPage testId="library-screen" wide>
      <DenPageHeader
        title="My Library"
        size="compact"
        action={filter === "models" ? <DenButton size="sm" icon={Plus} href={addKeyHref}>Add key</DenButton> : !empty ? <DenButton size="sm" icon={Plus} onClick={openAdd}>Add</DenButton> : undefined}
      />

      {library.error ? (
        <p className="rounded-2xl border border-gray-100 bg-white px-5 py-4 text-[13px] text-red-600">
          {library.error instanceof Error ? library.error.message : "Your Library did not load."}
        </p>
      ) : null}

      {empty && filter !== "models" ? <LibraryEmpty onAdd={openAdd} /> : null}
      {filter === "models" && personal.error ? <p role="alert" className="text-sm text-red-600">{personal.error}</p> : null}
      {(!empty || filter === "models") && !library.error ? (
        <>
          <div className="flex flex-wrap items-end" data-testid="library-compact-toolbar">
            <UnderlineTabs tabs={LIBRARY_FILTERS} activeTab={filter} onChange={setFilter} className="min-w-0 flex-1" />
            {showFilter ? (
              <div className="w-full border-b border-gray-200 pb-2 pt-3 sm:w-auto sm:pl-4 sm:pt-0">
                <FilterInput value={query} onChange={setQuery} className="w-full sm:w-56" />
              </div>
            ) : null}
          </div>

          {library.isLoading ? <LibraryCompactSurface><LibraryCompactSkeleton label="Loading your Library" /></LibraryCompactSurface> : null}

          {filter === "models" && personalRows.length > 0 ? (
            <LibraryCompactSurface>
              <LibraryCompactSection title="Your model providers" count={personalRows.length} testId="library-personal-models">
                {personalRows.map(provider => <LibraryCompactRow key={provider.id} href={getLibraryLlmProviderRoute(orgSlug, provider.id)} kind="model" testName={provider.name}
                  logo={<KeyRound size={16} aria-hidden />} name={provider.name} source="You" />)}
              </LibraryCompactSection>
            </LibraryCompactSurface>
          ) : null}

          {sections.length > 0 ? <LibraryCompactSurface testId="library-compact-sections">
            {sections.map((section) => (
              <LibraryCompactSection key={section.key} title={section.title} count={section.items.length + section.models.length} tone={section.key === "attention" ? "attention" : "default"} testId={`library-section-${section.key}`}>
                {section.items.map((item) => (
                  <LibraryItemRow key={`${item.type}:${item.id}`} item={item} mine={mineKeys.has(`${item.type}:${item.id}`)} signIn={signIn} />
                ))}
                {section.models.map((provider) => (
                  <LibraryModelRow key={`model:${provider.id}`} provider={provider} signIn={modelSignIn} />
                ))}
              </LibraryCompactSection>
            ))}
          </LibraryCompactSurface> : null}

          {filter === "models" && models.error ? (
            <p className="rounded-2xl border border-gray-100 bg-white px-5 py-4 text-[13px] text-gray-600">
              {models.error instanceof Error ? models.error.message : "Your models did not load."}
            </p>
          ) : null}

          {filter === "models" && !models.isLoading && !models.error && !hasModels && !personal.busy && !personal.error && personalProviders.length === 0 ? (
            <p className="rounded-2xl border border-gray-100 bg-white px-5 py-6 text-center text-[13px] text-gray-500" data-testid="library-models-empty">
              Your organization hasn't given you any models yet.
            </p>
          ) : null}

          {!library.isLoading && !models.isLoading && groups.mine.length === 0 && groups.received.length === 0 && modelRows.length === 0 && personalRows.length === 0 && !(filter === "models" && (models.error || !hasModels)) ? (
            <p className="rounded-2xl border border-gray-100 bg-white px-5 py-6 text-center text-[13px] text-gray-500">Nothing matches.</p>
          ) : null}
        </>
      ) : null}

      <LibraryAddDialog open={addOpen} onOpenChange={setAddOpen} hrefFor={hrefFor} />
      <MemberApiKeyDialog target={signIn.apiKeyTarget} onClose={signIn.closeApiKey} />
    </ItemPage>
  );
}
