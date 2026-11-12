"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Popover } from "@base-ui/react/popover";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Plus, Search, X } from "lucide-react";
import { DenPageHeader } from "../../_components/ui/page-header";
import { DenButton } from "../../_components/ui/button";
import { getNewPluginRoute, getOrgAccessFlags, getPluginRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { FeatureIntroGate } from "../_features/feature-intros";
import { visibleCountFact } from "../_features/feature-intros/model";
import { managedAccessStatus } from "./access-summary";
import { useDenToast } from "./den-toast";
import { ItemPage } from "./item-header";
import { FilterInput, ItemMenu, removeEntry, ItemPanel, ItemRowsSkeleton, LinkButton } from "./item-list";
import { LibraryCompactRow } from "./library-compact";
import { PluginLogo } from "./item-logo";
import { draftFromPluginGrants } from "./item-sharing";
import { usePluginAccess } from "./plugin-access-data";
import { pluginsSetUpById } from "./plugins-intro-facts";
import { isDirectoryScrollOverflow, pluginDirectoryRange, shouldAutoLoadPluginPage } from "./plugin-directory-window";
import { type DenPluginSummary, pluginDetailQueryOptions, useArchivePlugin, usePluginDirectory } from "./plugin-data";

function PluginsEmpty({ orgSlug }: { orgSlug: string | null }) {
  return (
    <ItemPanel>
      <div className="flex flex-col items-center gap-3 px-5 py-8 text-center" data-testid="plugins-empty">
        <h2 className="text-sm font-medium text-[var(--dls-text-primary)]">No plugins yet</h2>
        <p className="text-[13px] text-[var(--dls-text-secondary)]">Create a plugin to share skills with your team.</p>
        <DenButton size="sm" variant="secondary" icon={Plus} href={getNewPluginRoute(orgSlug)}>Create a plugin</DenButton>
        <p className="text-xs text-[var(--dls-text-secondary)]">Only you can use it until you choose who gets access.</p>
      </div>
    </ItemPanel>
  );
}

function PluginRow({ plugin }: { plugin: DenPluginSummary }) {
  const toast = useDenToast();
  const queryClient = useQueryClient();
  const { orgSlug, orgContext } = useOrgDashboard();
  const access = usePluginAccess(plugin.id, { enabled: !plugin.accessIncluded });
  const archive = useArchivePlugin();
  const href = getPluginRoute(orgSlug, plugin.id);
  const owner = orgContext?.members.find((member) => member.id === plugin.createdByOrgMembershipId);
  const ownerName = owner?.user.name || owner?.user.email || "Former member";
  const status = orgContext && access.data
    ? managedAccessStatus(draftFromPluginGrants(access.data), orgContext, plugin.createdByOrgMembershipId)
    : "";
  const sharing = status === "Only you" ? (plugin.createdByOrgMembershipId === orgContext?.currentMember.id ? "Only you" : `Only ${ownerName}`) : status;

  async function remove() {
    await archive.mutateAsync(plugin.id);
    toast({ title: `${plugin.name} is removed`, description: "Nobody can use it anymore." });
  }

  function prefetch() {
    void queryClient.prefetchQuery(pluginDetailQueryOptions(plugin.id));
  }

  return (
    <div data-plugin-row={plugin.name} data-plugin-access={sharing} onPointerEnter={prefetch} onFocus={prefetch}>
      <LibraryCompactRow href={href} kind="plugin" testName={plugin.name} logo={<PluginLogo name={plugin.name} />} name={plugin.name} description={plugin.description || "Plugin"}
        source={status ? status === "Only you" ? "Private" : "Shared" : "Unknown"}
        action={<ItemMenu label={`More for ${plugin.name}`} entries={[
          { label: "Open", href },
          ...(status === "Only you" ? [{ label: "Share", href }] : []),
          removeEntry(plugin.name, remove),
        ]} />} />
    </div>
  );
}

function DirectoryFilter({ label, title, value, options, counts, onChange }: {
  label: string;
  title: string;
  counts?: Record<string, number>;
  value: string | null;
  options: { id: string; name: string }[];
  onChange: (value: string | null) => void;
}) {
  const [search, setSearch] = useState("");
  const selected = options.find((option) => option.id === value);
  const matches = options.filter((option) => option.name.toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <Popover.Root onOpenChange={(open) => { if (!open) setSearch(""); }}>
      <Popover.Trigger className={`inline-flex h-8 max-w-[210px] items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 text-[13px] text-gray-700 hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-gray-300`}>
        <span className="truncate">{selected ? `${label}: ${selected.name}` : label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-50">
          <Popover.Popup className="w-[280px] rounded-xl border border-gray-200 bg-white p-2 shadow-lg outline-none">
            <Popover.Title className="px-2 pb-2 pt-1 text-[12px] font-medium text-gray-700">{title}</Popover.Title>
            <label className="flex h-9 items-center gap-2 rounded-lg border border-gray-200 px-2 focus-within:ring-2 focus-within:ring-gray-300">
              <Search className="h-4 w-4 text-gray-400" aria-hidden />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={label === "Owner" ? "Find an owner" : "Find a team"} className="min-w-0 flex-1 bg-transparent text-[13px] outline-none" />
            </label>
            <div className="mt-1 max-h-60 overflow-y-auto">
              <Popover.Close render={<button type="button" onClick={() => onChange(null)} className="flex w-full items-center rounded-lg px-3 py-2 text-left text-[13px] hover:bg-gray-50" />}>All {label.toLowerCase()}s</Popover.Close>
              {matches.map((option) => (
                <Popover.Close key={option.id} render={<button type="button" aria-label={option.name} onClick={() => onChange(option.id)} className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-[13px] hover:bg-gray-50" />}>
                  <span className="min-w-0 flex-1 truncate">{option.name}</span>{counts ? <span className="text-[12px] tabular-nums text-gray-400" aria-label={`${counts[option.id] ?? 0} plugins`}>{counts[option.id] ?? 0}</span> : null}{value === option.id ? <Check className="h-4 w-4 shrink-0" aria-hidden /> : null}
                </Popover.Close>
              ))}
              {matches.length === 0 ? <p className="px-3 py-3 text-[13px] text-gray-500">No matches.</p> : null}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The nearest ancestor that scrolls up and down (the dashboard's main column), or null for the window. */
function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (isDirectoryScrollOverflow(overflow)) return parent;
  }
  return null;
}

function DirectoryResults({ plugins, filtered }: { plugins: ReturnType<typeof usePluginDirectory>; filtered: boolean }) {
  const { orgSlug } = useOrgDashboard();
  const rows = plugins.data?.pages.flatMap((page) => page.items) ?? [];
  // A row is as tall as every other list's (48px and its hairline).
  const rowHeight = 49;
  // The page scrolls, as on every other list; only the rows near the window are drawn.
  const listRef = useRef<HTMLDivElement>(null);
  const resetScroll = useRef(true);
  const loadingPage = useRef(false);
  const [view, setView] = useState({ top: 0, height: 900 });
  const listed = rows.length > 0;
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = plugins;
  useEffect(() => {
    const list = listRef.current;
    if (!listed || !list) return;
    const scroller = scrollParent(list);
    // DirectoryResults is keyed by all filters. Reset once per filter, not when
    // another page arrives, even when the next result has the same row count.
    if (resetScroll.current) {
      resetScroll.current = false;
      const top = scroller ? scroller.getBoundingClientRect().top + scroller.clientTop : 0;
      const offset = list.getBoundingClientRect().top - top;
      if (offset < 0) {
        if (scroller) scroller.scrollTop += offset;
        else window.scrollBy(0, offset);
      }
    }
    const measure = () => {
      const box = list.getBoundingClientRect();
      const top = scroller ? scroller.getBoundingClientRect().top + scroller.clientTop : 0;
      const height = scroller ? scroller.clientHeight : window.innerHeight;
      const nextTop = Math.max(0, top - box.top);
      setView((current) => current.top === nextTop && current.height === height ? current : { top: nextTop, height });
      // A failed page waits for the explicit retry button. The ref also guards
      // multiple scroll/resize events before Query publishes its fetching state.
      if (!loadingPage.current && shouldAutoLoadPluginPage({ listBottom: box.bottom, viewportTop: top, viewportHeight: height, hasNextPage, isFetchingNextPage, isFetchNextPageError })) {
        loadingPage.current = true;
        void fetchNextPage().catch(() => { /* Query displays the retry state. */ }).finally(() => { loadingPage.current = false; });
      }
    };
    measure();
    const target = scroller ?? window;
    target.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const resize = new ResizeObserver(measure);
    resize.observe(list);
    if (scroller) resize.observe(scroller);
    return () => {
      target.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      resize.disconnect();
    };
  }, [listed, rows.length, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
  const { start, end } = pluginDirectoryRange(view.top, view.height, rowHeight, rows.length);

  if (plugins.isPending) return <ItemPanel><ItemRowsSkeleton label="Loading plugins" rows={6} /></ItemPanel>;
  if (plugins.isError && rows.length === 0) return <div role="alert" className="border-y border-[var(--den-list-line)] py-4 text-[13px] text-[var(--dls-text-secondary)]">The list did not load. <button type="button" onClick={() => void plugins.refetch()} className="font-medium underline">Try again</button></div>;
  if (rows.length === 0) return filtered ? <p className="border-y border-[var(--den-list-line)] py-4 text-[13px] text-[var(--dls-text-secondary)]">No plugins match. Try another name, team, or owner.</p> : <PluginsEmpty orgSlug={orgSlug} />;

  return (
    <ItemPanel className="overflow-hidden [&>*]:border-b-0"><div className="min-w-0">
      <div ref={listRef} data-testid="plugin-directory-scroll">
        <div className="relative" style={{ height: rows.length * rowHeight }}>
          {rows.slice(start, end).map((plugin, index) => (
            <div key={plugin.id} className="absolute inset-x-0 overflow-hidden" style={{ top: (start + index) * rowHeight, height: rowHeight }}>
              <PluginRow plugin={plugin} />
            </div>
          ))}
        </div>
        {plugins.hasNextPage ? <button type="button" onClick={() => void plugins.fetchNextPage()} disabled={plugins.isFetchingNextPage} className="h-12 w-full text-[13px] text-gray-600 hover:bg-gray-50 disabled:opacity-50">{plugins.isFetchingNextPage ? "Loading more…" : "Load more plugins"}</button> : null}
      </div>
      </div>
      {plugins.isFetchNextPageError ? <div role="alert" className="py-3 text-[13px] text-[var(--ow-danger)]">More plugins did not load. Use Load more to try again.</div> : null}
    </ItemPanel>
  );
}

export function pluginDirectoryUrlParams(current: string, filters: { name: string; teamId: string | null; memberId: string | null; ownerId?: string | null }) {
  const params = new URLSearchParams(current);
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  return params.toString();
}

export function AdminPluginsScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { orgSlug, orgId, orgContext } = useOrgDashboard();
  const q = searchParams.get("name") ?? "";
  const [search, setSearch] = useState(q);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const teamParam = searchParams.get("teamId");
  const memberParam = searchParams.get("memberId");
  const teamId = orgContext?.teams.some((team) => team.id === teamParam) ? teamParam : null;
  const memberId = orgContext?.members.some((member) => member.id === memberParam) ? memberParam : null;
  const ownerParam = searchParams.get("ownerId");
  const ownerId = orgContext?.members.some((member) => member.id === ownerParam) ? ownerParam : null;
  const plugins = usePluginDirectory({ q, teamId, memberId, ownerId });
  const firstPage = plugins.data?.pages[0];
  const legacyMember = orgContext?.members.find((member) => member.id === memberId);
  const empty = firstPage?.total === 0 && !q && !teamId && !memberId && !ownerId;
  const filtered = Boolean(q || teamId || memberId || ownerId);
  // Feature intros (flag `featureIntros`): section facts from the unfiltered first page; a filtered list says nothing about setup.
  // Built-in OpenWork extensions every org gets don't count as the team setting up plugins.
  const teamPlugins = firstPage ? firstPage.items.filter((item) => !item.builtIn) : [];
  const builtInCount = firstPage ? firstPage.items.length - teamPlugins.length : 0;
  const setUpById = firstPage ? pluginsSetUpById(teamPlugins, orgContext?.currentMember.id ?? null) : null;
  const setUpByMember = setUpById ? orgContext?.members.find((member) => member.id === setUpById) : undefined;
  // Without `sharing.manage_all` the list holds only plugins shared with this person, so an empty one
  // doesn't mean the organization has none (a teammate's private plugins are hidden).
  const seesAllPlugins = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.currentMember.permissions,
  ).canManageAllShared;
  const introFacts = !firstPage ? null : filtered ? {} : {
    plugins: visibleCountFact(Math.max(0, (firstPage.total ?? firstPage.items.length) - builtInCount), seesAllPlugins),
    setUpBy: setUpByMember ? setUpByMember.user.name || setUpByMember.user.email : null,
  };
  const createAction = <LinkButton variant="secondary" size="sm" href={getNewPluginRoute(orgSlug)}><Plus className="h-4 w-4" aria-hidden />Create a plugin</LinkButton>;

  function setFilters(next: { name: string; teamId: string | null; memberId: string | null; ownerId?: string | null }) {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = null;
    const params = pluginDirectoryUrlParams(searchParams.toString(), next);
    router.replace(params ? `?${params}` : "?", { scroll: false });
  }

  useEffect(() => {
    if (search.trim() === q) return;
    searchTimer.current = setTimeout(() => {
      searchTimer.current = null;
      const params = pluginDirectoryUrlParams(searchParams.toString(), { name: search.trim(), teamId, memberId, ownerId });
      router.replace(params ? `?${params}` : "?", { scroll: false });
    }, 250);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [search, q, teamId, memberId, ownerId, router, searchParams]);

  const page = (
    <ItemPage testId="admin-plugins" wide>
      {/* The create action sits in the header, as on every other page. */}
      <DenPageHeader size="compact" title="Plugins" action={empty ? undefined : createAction} />
      {!empty ? <div className="flex flex-wrap items-center gap-2" data-testid="plugin-directory-toolbar">
        <FilterInput value={search} onChange={setSearch} className="w-64 max-w-full" />
        <DirectoryFilter label="Team" title="Plugins available to a team" counts={firstPage?.teamCounts} value={teamId} options={orgContext?.teams ?? []} onChange={(id) => setFilters({ name: search.trim(), teamId: id, memberId: null, ownerId })} />
        <DirectoryFilter label="Owner" title="Plugins created by" counts={firstPage?.ownerCounts} value={ownerId} options={(orgContext?.members ?? []).map((member) => ({ id: member.id, name: member.user.name || member.user.email }))} onChange={(id) => setFilters({ name: search.trim(), teamId, memberId: null, ownerId: id })} />
      </div> : null}
      {search || teamId || memberId || ownerId ? <button type="button" onClick={() => { setSearch(""); setFilters({ name: "", teamId: null, memberId: null, ownerId: null }); }} className="-mt-2 inline-flex w-fit items-center gap-1 text-[12px] text-gray-600 hover:text-gray-900"><X className="h-3.5 w-3.5" aria-hidden />Clear filters</button> : null}
      {legacyMember ? <p className="text-[13px] text-gray-600">Available to {legacyMember.user.name || legacyMember.user.email}</p> : null}
      <DirectoryResults key={`${orgId}:${q}:${teamId}:${memberId}:${ownerId}`} plugins={plugins} filtered={filtered} />
    </ItemPage>
  );

  // With feature intros on, the Plugins intro replaces the whole page while there are none (DESIGN.md I1, I2);
  // with the flag off, the page and PluginsEmpty render as before.
  return <FeatureIntroGate introKey="plugins" facts={introFacts}>{page}</FeatureIntroGate>;
}
