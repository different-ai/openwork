"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Popover } from "@base-ui/react/popover";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowDownWideNarrow, Check, ChevronDown, Plus, Search, X } from "lucide-react";
import { DenPageHeader } from "../../_components/ui/page-header";
import { getNewPluginRoute, getPluginRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { managedAccessStatus } from "./access-summary";
import { useDenToast } from "./den-toast";
import { ItemPage } from "./item-header";
import { ItemMenu, removeEntry, ItemPanel, ItemRowsSkeleton, LinkButton } from "./item-list";
import { formatAddedDate } from "./item-dates";
import { LetterTile } from "./item-logo";
import { draftFromPluginGrants } from "./item-sharing";
import { ConnectorLogoStrip } from "./library-add-dialog";
import { usePluginAccess } from "./plugin-access-data";
import { type DenPluginSummary, pluginDetailQueryOptions, useArchivePlugin, usePluginDirectory } from "./plugin-data";

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
    <div data-plugin-row={plugin.name} onPointerEnter={prefetch} onFocus={prefetch} className="grid h-full grid-cols-[minmax(0,1fr)_minmax(120px,0.6fr)_minmax(100px,0.45fr)_80px_32px] items-center gap-4 px-5 text-[13px]">
      <Link href={href} className="flex min-w-0 items-center gap-3 rounded-lg focus-visible:ring-2 focus-visible:ring-gray-300">
        <LetterTile name={plugin.name} />
        <span className="min-w-0">
          <span className="block truncate font-medium text-gray-900">{plugin.name}</span>
          {plugin.description ? <span className="block truncate text-[12px] text-gray-500">{plugin.description}</span> : null}
        </span>
      </Link>
      <div className="min-w-0" data-item-status title={sharing}>
        {sharing ? <span className="inline-block max-w-full truncate rounded bg-gray-100 px-1.5 py-0.5 text-[12px] text-gray-600">{sharing}</span> : <span className="text-gray-400">—</span>}
      </div>
      <span className="truncate text-gray-600" title={ownerName}>{ownerName}</span>
      <time dateTime={plugin.updatedAt} title={plugin.updatedAt} className="text-[12px] text-gray-500">{formatAddedDate(plugin.updatedAt) || "—"}</time>
      <ItemMenu label={`More for ${plugin.name}`} entries={[
        { label: "Open", href },
        ...(status === "Only you" ? [{ label: "Share", href }] : []),
        removeEntry(plugin.name, remove),
      ]} />
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
      <Popover.Trigger className="inline-flex h-9 max-w-[210px] items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 text-[13px] text-gray-700 hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-gray-300">
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

export function pluginDirectoryRange(scrollTop: number, viewportHeight: number, rowHeight: number, count: number) {
  return {
    start: Math.max(0, Math.floor(scrollTop / rowHeight) - 4),
    end: Math.min(count, Math.ceil((scrollTop + viewportHeight) / rowHeight) + 4),
  };
}

function DirectoryResults({ plugins, filtered }: { plugins: ReturnType<typeof usePluginDirectory>; filtered: boolean }) {
  const { orgSlug } = useOrgDashboard();
  const [scrollTop, setScrollTop] = useState(0);
  const rows = plugins.data?.pages.flatMap((page) => page.items) ?? [];
  const rowHeight = 56;
  const viewportHeight = 544;
  const { start, end } = pluginDirectoryRange(scrollTop, viewportHeight, rowHeight, rows.length);
  const total = plugins.data?.pages[0]?.total ?? rows.length;

  if (plugins.isPending) return <ItemPanel><ItemRowsSkeleton label="Loading plugins" rows={6} /></ItemPanel>;
  if (plugins.isError && rows.length === 0) return <div role="alert" className="rounded-xl border border-gray-200 bg-white p-5 text-[13px] text-gray-700">The list did not load. <button type="button" onClick={() => void plugins.refetch()} className="font-medium underline">Try again</button></div>;
  if (rows.length === 0) return filtered ? <div className="rounded-xl border border-gray-200 bg-white p-6 text-[13px] text-gray-600">No plugins match. Try another name, team, or owner.</div> : <PluginsEmpty orgSlug={orgSlug} />;

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white"><div className="min-w-[760px]">
      <div className="border-b border-gray-100 px-5 py-2.5 text-[12px] text-gray-500">{total} {total === 1 ? "plugin" : "plugins"}{plugins.hasNextPage ? ` · ${rows.length} loaded` : ""}</div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(120px,0.6fr)_minmax(100px,0.45fr)_80px_32px] gap-4 border-b border-gray-100 bg-gray-50 px-5 py-2 text-[12px] text-gray-500" data-testid="plugin-directory-columns"><span>Name</span><span>Shared with</span><span>Owner</span><span>Updated</span><span className="sr-only">Actions</span></div>
      <div data-testid="plugin-directory-scroll" className="overflow-y-auto" style={{ height: Math.min(viewportHeight, rows.length * rowHeight + (plugins.hasNextPage ? 48 : 0)) }} onScroll={(event) => {
        const target = event.currentTarget;
        setScrollTop(target.scrollTop);
        if (target.scrollHeight - target.scrollTop - target.clientHeight < 300 && plugins.hasNextPage && !plugins.isFetchingNextPage) void plugins.fetchNextPage();
      }}>
        <div className="relative" style={{ height: rows.length * rowHeight }}>
          {rows.slice(start, end).map((plugin, index) => (
            <div key={plugin.id} className="absolute inset-x-0 overflow-hidden border-b border-gray-100" style={{ top: (start + index) * rowHeight, height: rowHeight }}>
              <PluginRow plugin={plugin} />
            </div>
          ))}
        </div>
        {plugins.hasNextPage ? <button type="button" onClick={() => void plugins.fetchNextPage()} disabled={plugins.isFetchingNextPage} className="h-12 w-full text-[13px] text-gray-600 hover:bg-gray-50 disabled:opacity-50">{plugins.isFetchingNextPage ? "Loading more…" : "Load more plugins"}</button> : null}
      </div>
      </div>
      {plugins.isFetchNextPageError ? <div role="alert" className="border-t border-gray-100 px-5 py-3 text-[13px] text-red-600">More plugins did not load. Use Load more to try again.</div> : null}
    </div>
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

  return (
    <ItemPage testId="admin-plugins" wide>
      <DenPageHeader title={<>Plugins{firstPage?.total != null ? <span className="ml-2 text-[14px] font-normal tracking-normal text-gray-500" data-testid="plugin-directory-total">{firstPage.total.toLocaleString()}</span> : null}</>} action={<LinkButton variant="primary" href={getNewPluginRoute(orgSlug)}><Plus className="h-4 w-4" aria-hidden />Create a plugin</LinkButton>} />
      <div className="flex flex-wrap items-center gap-2" data-testid="plugin-directory-toolbar">
        <label className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 focus-within:ring-2 focus-within:ring-gray-300">
          <Search className="h-4 w-4 shrink-0 text-gray-400" aria-hidden />
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search plugins by name" aria-label="Search plugins by name" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none" />
        </label>
        <DirectoryFilter label="Team" title="Plugins available to a team" counts={firstPage?.teamCounts} value={teamId} options={orgContext?.teams ?? []} onChange={(id) => setFilters({ name: search.trim(), teamId: id, memberId: null, ownerId })} />
        <DirectoryFilter label="Owner" title="Plugins created by" counts={firstPage?.ownerCounts} value={ownerId} options={(orgContext?.members ?? []).map((member) => ({ id: member.id, name: member.user.name || member.user.email }))} onChange={(id) => setFilters({ name: search.trim(), teamId, memberId: null, ownerId: id })} />
        <span className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 text-[13px] text-gray-700" title="Sorted by most recently updated"><ArrowDownWideNarrow className="h-3.5 w-3.5 text-gray-500" aria-hidden />Recently updated</span>
      </div>
      {search || teamId || memberId || ownerId ? <button type="button" onClick={() => { setSearch(""); setFilters({ name: "", teamId: null, memberId: null, ownerId: null }); }} className="-mt-2 inline-flex w-fit items-center gap-1 text-[12px] text-gray-600 hover:text-gray-900"><X className="h-3.5 w-3.5" aria-hidden />Clear filters</button> : null}
      {legacyMember ? <p className="text-[13px] text-gray-600">Available to {legacyMember.user.name || legacyMember.user.email}</p> : null}
      <DirectoryResults key={`${orgId}:${q}:${teamId}:${memberId}:${ownerId}`} plugins={plugins} filtered={Boolean(q || teamId || memberId || ownerId)} />
    </ItemPage>
  );
}
