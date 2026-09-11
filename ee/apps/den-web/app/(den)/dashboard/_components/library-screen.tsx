"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronRight, LayoutGrid, List, Plus, RefreshCw, Search, TriangleAlert } from "lucide-react";

import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton } from "../../_components/ui/button";
import { DenChip } from "../../_components/ui/chip";
import { DenInput } from "../../_components/ui/input";
import { DenList } from "../../_components/ui/list-row";
import { UnderlineTabs } from "../../_components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../_components/ui/tooltip";
import { getLibraryPluginRoute, getOrgAccessFlags, getYourConnectionsRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { type LibraryItem, useLibrary } from "./library-data";
import { DashboardHeaderActions } from "./dashboard-header-actions";
import {
  getLibraryAddAction,
  getLibraryFocus,
  getLibraryState,
  getLibraryView,
  hasLibraryComponent,
  LIBRARY_DEFAULT_KIND,
  LIBRARY_DEFAULT_STATE,
  LIBRARY_KINDS,
  LIBRARY_LAYOUT_KEY,
  LIBRARY_STATES,
  type LibraryEmptyState,
  type LibraryKind,
  type LibraryLayout,
  type LibraryState,
  parseLibraryLayout,
} from "./library-view";

function firstName(name: string | null): string {
  if (!name) return "someone";
  return name.trim().split(/\s+/)[0] ?? "someone";
}

function getSource(item: LibraryItem, orgName: string): { label: string; isPerson: boolean } | null {
  for (const edge of item.edges) {
    if (edge.kind === "person") {
      return { label: `Shared by ${firstName(edge.sharedBy?.name ?? null)}`, isPerson: true };
    }
  }
  for (const edge of item.edges) {
    if (edge.kind === "catalog") return { label: "Catalog", isPerson: false };
  }
  for (const edge of item.edges) {
    if (edge.kind === "team") return { label: edge.team.name, isPerson: false };
  }
  for (const edge of item.edges) {
    if (edge.kind === "org_wide") return { label: orgName, isPerson: false };
  }
  return null;
}

function getGitHubOwnerAvatar(sourceRepositoryUrl: string | null): string | undefined {
  if (!sourceRepositoryUrl) return undefined;
  try {
    const url = new URL(sourceRepositoryUrl);
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return undefined;
    const owner = url.pathname.split("/").filter(Boolean)[0];
    return owner ? `https://github.com/${encodeURIComponent(owner)}.png?size=80` : undefined;
  } catch {
    return undefined;
  }
}

export function LibraryRow({ item, isFocused, orgName, orgSlug, layout }: {
  item: LibraryItem;
  isFocused: boolean;
  orgName: string;
  orgSlug: string | null;
  layout: LibraryLayout;
}) {
  const state = getLibraryState(item);
  const source = getSource(item, orgName);
  const rowHref = item.type === "plugin"
    ? getLibraryPluginRoute(orgSlug, item.id)
    : item.type === "workflow"
      ? `/dashboard/library/workflows/${encodeURIComponent(item.id)}`
      : `${getYourConnectionsRoute(orgSlug)}?connectionId=${encodeURIComponent(item.id)}`;
  const iconUrl = item.type === "connection" && item.provider === "google-workspace"
    ? "/integrations/google.svg"
    : item.type === "plugin"
      ? getGitHubOwnerAvatar(item.sourceRepositoryUrl)
      : undefined;
  const simpleIconSlug = item.type === "connection" && item.provider === "microsoft-365" ? "microsoft" : undefined;
  const serviceUrl = item.type === "connection" && item.transport === "mcp" ? item.url : undefined;
  const ready = state === "ready";
  const kindLabel = item.type === "connection" ? "MCP" : item.type === "workflow" ? "Workflow"
    : hasLibraryComponent(item, "skill") && !hasLibraryComponent(item, "mcp") ? "Skill" : "Plugin";
  const statusLabel = ready ? item.type === "connection" ? "Connected" : "Ready to use" : kindLabel;
  const nextAction = state === "needs_signin" ? "Sign in"
    : state === "needs_admin_setup" ? "Needs admin setup"
      : state === "needs_setup" ? "Ready to set up" : "View details";
  const meta = (
    <span data-library-source>
      {item.type === "connection" ? <span>{item.transport === "native" ? "Native" : "Cloud"} · </span> : null}
      {source?.label ?? orgName}
    </span>
  );
  const kindBadge = <DenChip data-library-chip="" className="!rounded-md !px-1.5 !text-[10px]">{kindLabel}</DenChip>;

  // Keep web links and Den provenance while matching Desktop's neutral card
  // anatomy. A plugin's availability must never claim its MCPs are connected.
  return (
    <Link
      href={rowHref}
      data-library-item-type={item.type}
      data-library-item-state={item.type === "connection" || item.type === "workflow" ? item.state : undefined}
      data-library-item-key={`${item.type}-${item.id}`}
      data-library-focused={isFocused ? "" : undefined}
      className={`group flex min-w-0 w-full gap-3 text-left transition-colors hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 ${layout === "grid" ? "h-full items-start rounded-xl border border-gray-200 bg-white p-4" : "items-center px-3.5 py-2"} ${isFocused ? "ring-2 ring-inset ring-blue-200" : ""}`}
    >
      <DenBrandMark
        name={item.name}
        iconUrl={iconUrl}
        simpleIconSlug={simpleIconSlug}
        serviceUrl={serviceUrl}
        className={`${layout === "grid" ? "size-10" : "size-8"} rounded-lg`}
        imageClassName={layout === "grid" ? "size-6" : "size-5"}
      />
      {layout === "grid" ? (
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="min-w-0 break-words text-sm font-semibold text-gray-900">{item.name}</h3>
            <DenChip data-library-chip="" data-library-ready={ready ? "" : undefined} tone={ready ? "success" : "neutral"} className="!rounded-md !px-1.5 !text-[10px]">
              {statusLabel}
            </DenChip>
            {ready && item.type === "workflow" ? kindBadge : null}
          </div>
          {item.description ? <p className="mt-0.5 line-clamp-2 break-words text-xs text-gray-500">{item.description}</p> : null}
          <div className="mt-1 text-[11px] text-gray-500">{meta}</div>
          <div className="mt-2 text-[11px] font-medium text-gray-900 group-hover:opacity-80">{nextAction}</div>
        </div>
      ) : (
        <>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:w-44 sm:flex-none">
            <span className="truncate text-[13px] font-medium text-gray-900">{item.name}</span>
            {ready ? <span data-library-ready="" className="size-1.5 shrink-0 rounded-full bg-emerald-600"><span className="sr-only">{statusLabel}</span></span> : null}
          </div>
          <div className="flex w-20 shrink-0">{kindBadge}</div>
          <p className="hidden min-w-0 flex-1 truncate text-xs text-gray-500 sm:block">{item.description}</p>
          <div className="hidden max-w-40 shrink-0 truncate text-[11px] text-gray-500 lg:block">{meta}</div>
          {ready ? <ChevronRight aria-hidden className="size-3.5 shrink-0 text-gray-400" /> : (
            <span className="inline-flex h-7 shrink-0 items-center rounded-lg border border-gray-200 px-3 text-xs font-medium text-gray-900">{nextAction}</span>
          )}
        </>
      )}
    </Link>
  );
}

export function LibraryAddControl({ action, label, disabledReason }: {
  action: ReturnType<typeof getLibraryAddAction>;
  label: string;
  disabledReason: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={action ? <a href={action.href} /> : <button type="button" aria-disabled="true" />}
        aria-label={action?.label ?? label}
        title={action?.label ?? disabledReason}
        className={`inline-flex size-8 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 ${action ? "" : "cursor-not-allowed opacity-70"}`}
      >
        <Plus aria-hidden className="size-5" />
      </TooltipTrigger>
      <TooltipContent>{action?.label ?? disabledReason}</TooltipContent>
    </Tooltip>
  );
}

export function LibraryEmpty({ empty, addAction, disabledReason, error, onAction, onRefresh }: {
  empty: LibraryEmptyState;
  addAction: ReturnType<typeof getLibraryAddAction>;
  disabledReason: string;
  error?: string;
  onAction: (action: LibraryEmptyState["action"]) => void;
  onRefresh: () => void;
}) {
  const actionLabel = empty.action === "clear_filters" ? "Clear filters"
    : LIBRARY_STATES.find((tab) => tab.value === empty.action)?.label;
  return (
    <div className="flex flex-col items-center gap-3 rounded-[10px] border border-dashed border-gray-200 bg-white px-6 py-12 text-center" data-library-empty={error ? "refresh" : empty.action}>
      <h2 className="text-[15px] font-medium text-gray-900">{error ? "Your Library is unavailable" : empty.title}</h2>
      <p className="max-w-md text-[13px] text-gray-500">{error ?? empty.description}</p>
      {error ? (
        <DenButton variant="secondary" onClick={onRefresh}>Refresh</DenButton>
      ) : empty.action === "add" ? addAction ? (
        <DenButton href={addAction.href} variant="secondary">{addAction.label}</DenButton>
      ) : (
        <p className="text-[13px] text-gray-500">{disabledReason}</p>
      ) : (
        <DenButton variant="secondary" onClick={() => onAction(empty.action)}>{actionLabel}</DenButton>
      )}
    </div>
  );
}

export function LibraryScreen() {
  const { orgContext, orgSlug } = useOrgDashboard();
  const { data: items = [], isLoading, isFetching, error, refetch } = useLibrary();
  const searchParams = useSearchParams();
  const [activeState, setActiveState] = useState<LibraryState>(LIBRARY_DEFAULT_STATE);
  const [activeKind, setActiveKind] = useState<LibraryKind>(LIBRARY_DEFAULT_KIND);
  const [layout, setLayout] = useState<LibraryLayout>("grid");
  const [query, setQuery] = useState("");
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const handledFocusRef = useRef<string | null>(null);
  const orgName = orgContext?.organization.name ?? "your organization";
  const requestedFocus = searchParams.get("focus");
  const access = getOrgAccessFlags(orgContext?.currentMember.role ?? "member", orgContext?.currentMember.isOwner ?? false, orgContext?.roles);
  const addAction = getLibraryAddAction({ kind: activeKind, isAdmin: access.isAdmin, mcpConnections: orgContext?.capabilities.mcpConnections === true, orgSlug });
  const addLabel = activeKind === "mcps" ? "Add MCP" : activeKind === "skills" ? "Create skill" : "Add plugin";
  const disabledReason = !orgContext ? "Loading your organization…"
    : activeKind === "mcps" && !orgContext.capabilities.mcpConnections ? "Connections are not enabled for this organization."
      : "An organization admin manages additions to this Library.";
  const errorMessage = error ? error instanceof Error ? error.message : "Failed to load library." : undefined;
  const view = getLibraryView(items, activeKind, activeState, query);

  useEffect(() => {
    try {
      setLayout(parseLibraryLayout(window.localStorage.getItem(LIBRARY_LAYOUT_KEY)));
    } catch {
      // Storage can be blocked; the default view remains usable.
    }
  }, []);

  useEffect(() => {
    if (!requestedFocus || handledFocusRef.current === requestedFocus) return;
    const focus = getLibraryFocus(items, requestedFocus);
    if (!focus) return;
    handledFocusRef.current = requestedFocus;
    setActiveState(focus.state);
    setActiveKind(focus.kind);
    setQuery("");
    setFocusedKey(focus.key);
  }, [items, requestedFocus]);

  useEffect(() => {
    if (!focusedKey) return;
    const row = [...document.querySelectorAll<HTMLElement>("[data-library-item-key]")]
      .find((candidate) => candidate.dataset.libraryItemKey === focusedKey);
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    const timeout = window.setTimeout(() => setFocusedKey(null), 2_000);
    return () => window.clearTimeout(timeout);
  }, [focusedKey]);

  function selectLayout(next: LibraryLayout) {
    setLayout(next);
    try {
      window.localStorage.setItem(LIBRARY_LAYOUT_KEY, next);
    } catch {
      // Explicit selection still works for this visit without browser storage.
    }
  }

  const rows = view.visibleItems.map((item) => (
    <LibraryRow key={`${item.type}-${item.id}`} item={item} isFocused={focusedKey === `${item.type}-${item.id}`} orgName={orgName} orgSlug={orgSlug} layout={layout} />
  ));

  return (
    <TooltipProvider>
    <div className="px-4 pb-7 pt-5 sm:px-8" data-testid="den-library" data-library-kind={activeKind} data-library-layout={layout}>
      <DashboardHeaderActions>
        <LibraryAddControl action={addAction} label={addLabel} disabledReason={disabledReason} />
      </DashboardHeaderActions>

      <div className="mb-4 flex h-12 min-w-0 items-end justify-between gap-x-7 border-b border-gray-200">
        <div className="-mb-px min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <UnderlineTabs
            className="!border-0 [&>nav]:!m-0 [&>nav]:!flex-nowrap [&>nav]:!gap-7 [&_[role=tab]]:h-12 [&_[role=tab]]:shrink-0 [&_[role=tab]]:!pb-0 [&_[role=tab]]:!text-sm [&_[role=tab]]:!leading-5 [&_[role=tab]]:focus-visible:outline-2 [&_[role=tab]]:focus-visible:outline-gray-900 [&_[role=tab][aria-selected=true]]:!border-gray-900 [&_[role=tab][aria-selected=true]]:!text-gray-900"
            tabs={view.tabs.map((tab) => ({
              ...tab,
              count: view.counts[tab.value],
              countTone: tab.value === "needs_signin" || tab.value === "needs_setup" ? "warning" : tab.value === "needs_admin_setup" ? "danger" : "neutral",
              countClassName: `!h-[22px] min-w-6 justify-center !px-1.5 !py-0 !text-xs ${view.counts[tab.value] === 0 ? "!bg-gray-100 !text-gray-500" : ""}`,
            }))}
            activeTab={view.activeState}
            onChange={setActiveState}
            showZeroCounts
          />
        </div>
        <div className="w-[min(280px,40%)] shrink-0 self-center sm:ml-auto sm:w-[280px]">
          <DenInput type="search" icon={Search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your library" aria-label="Search your library" className="!h-9 !rounded-[10px]" />
        </div>
      </div>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-2" aria-label="Library filters">
        <div className="flex items-center gap-2">
          {LIBRARY_KINDS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              aria-pressed={activeKind === filter.value}
              onClick={() => { setActiveKind(filter.value); setActiveState(LIBRARY_DEFAULT_STATE); }}
              className={`inline-flex h-[30px] items-center rounded-full border px-3 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 ${activeKind === filter.value ? "border-gray-900 bg-gray-900 text-white" : "border-gray-200 bg-white text-gray-500 hover:border-gray-400 hover:text-gray-900"}`}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="Library view">
          {([{ value: "grid", label: "Card view", icon: LayoutGrid }, { value: "list", label: "List view", icon: List }] satisfies { value: LibraryLayout; label: string; icon: typeof List }[]).map(({ value, label, icon: Icon }) => (
            <Tooltip key={value}>
              <TooltipTrigger type="button" aria-label={label} title={label} aria-pressed={layout === value} onClick={() => selectLayout(value)} className={`flex h-[30px] w-8 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 ${layout === value ? "bg-gray-100 text-gray-900" : "text-gray-500 hover:bg-gray-100"}`}>
                <Icon aria-hidden className="size-4" />
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
          <button type="button" aria-label="Refresh" title="Refresh" disabled={isFetching} onClick={() => void refetch()} className="flex h-[30px] w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50">
            <RefreshCw aria-hidden className={`size-4 ${isFetching ? "animate-spin" : ""}`} />
          </button>
          {errorMessage && items.length > 0 ? (
            <Tooltip>
              <TooltipTrigger aria-label="Library refresh failed" className="flex h-[30px] w-8 items-center justify-center rounded-lg bg-amber-50 text-amber-700 hover:bg-amber-100">
                <TriangleAlert aria-hidden className="size-4" />
              </TooltipTrigger>
              <TooltipContent>{errorMessage} Use Refresh to try again.</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </div>

      {isLoading ? (
        <div role="status" aria-label="Loading your library" className={layout === "list" ? "flex flex-col gap-2" : "grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-3"}>
          {[0, 1, 2].map((index) => <div key={index} aria-hidden className={`bg-gray-100 motion-safe:animate-pulse ${layout === "list" ? "h-[42px] rounded-lg" : "h-[104px] rounded-xl"}`} />)}
        </div>
      ) : view.visibleItems.length === 0 ? (
        <LibraryEmpty
          empty={view.empty}
          addAction={addAction}
          disabledReason={disabledReason}
          error={items.length === 0 ? errorMessage : undefined}
          onRefresh={() => void refetch()}
          onAction={(action) => {
            if (action === "clear_filters") {
              setQuery("");
              setActiveState(LIBRARY_DEFAULT_STATE);
            } else if (action !== "add") setActiveState(action);
          }}
        />
      ) : (
        <section data-library-section={view.activeState} aria-label={view.tabs.find((tab) => tab.value === view.activeState)?.label}>
          {layout === "grid" ? <div data-library-grid className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-3">{rows}</div> : <div data-library-list className="overflow-x-auto"><DenList className="min-w-[560px] !rounded-xl">{rows}</DenList></div>}
        </section>
      )}
    </div>
    </TooltipProvider>
  );
}
