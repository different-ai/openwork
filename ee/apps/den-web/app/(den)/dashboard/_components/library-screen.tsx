"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronRight, LayoutGrid, List, Plus, RefreshCw, Search } from "lucide-react";

import { DenBrandMark } from "../../_components/ui/brand-mark";
import { buttonVariants, DenButton } from "../../_components/ui/button";
import { DenChip } from "../../_components/ui/chip";
import { DenInput } from "../../_components/ui/input";
import { DenList, DenListRow } from "../../_components/ui/list-row";
import { DenNotice } from "../../_components/ui/notice";
import { UnderlineTabs } from "../../_components/ui/tabs";
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
  const connectionHref = item.type === "connection"
    ? `${getYourConnectionsRoute(orgSlug)}?connectionId=${encodeURIComponent(item.id)}`
    : undefined;
  const rowHref = item.type === "plugin"
    ? getLibraryPluginRoute(orgSlug, item.id)
    : item.type === "workflow"
      ? `/dashboard/library/workflows/${encodeURIComponent(item.id)}`
      : connectionHref;
  const iconUrl = item.type === "connection" && item.provider === "google-workspace"
    ? "/integrations/google.svg"
    : item.type === "plugin"
      ? getGitHubOwnerAvatar(item.sourceRepositoryUrl)
      : undefined;
  const simpleIconSlug = item.type === "connection" && item.provider === "microsoft-365" ? "microsoft" : undefined;
  const serviceUrl = item.type === "connection" && item.transport === "mcp" ? item.url : undefined;
  const nonPersonSource = source && !source.isPerson ? source : null;

  return (
    <DenListRow
      layout={layout}
      leading={(
        <DenBrandMark
          name={item.name}
          iconUrl={iconUrl}
          simpleIconSlug={simpleIconSlug}
          serviceUrl={serviceUrl}
          className="h-10 w-10 shrink-0 rounded-[12px] border border-gray-100 bg-white"
        />
      )}
      title={item.name}
      chips={(
        <>
          <DenChip data-library-chip="" tone={item.type === "connection" ? "info" : "neutral"}>
            {item.type === "connection" ? "MCP" : item.type === "workflow" ? "Workflow" : hasLibraryComponent(item, "skill") && !hasLibraryComponent(item, "mcp") ? "Skill" : "Plugin"}
          </DenChip>
          {item.type === "connection" ? (
            <DenChip data-library-chip="" tone={item.transport === "mcp" ? "neutral" : "teal"}>
              {item.transport === "mcp" ? "Cloud" : "Native"}
            </DenChip>
          ) : null}
          {state !== "ready" ? (
            <DenChip data-library-chip="" tone="warning">
              {state === "needs_signin" ? "Connect your account" : state === "needs_admin_setup" ? "Waiting on your admin" : "Needs setup"}
            </DenChip>
          ) : null}
          {source?.isPerson ? <DenChip data-library-chip="" data-library-source="" tone="info">{source.label}</DenChip> : null}
        </>
      )}
      meta={item.description || nonPersonSource ? (
        <>
          {item.description}
          {nonPersonSource ? (
            <>
              {item.description ? <span aria-hidden> · </span> : null}
              <span data-library-source>{nonPersonSource.label}</span>
            </>
          ) : null}
        </>
      ) : undefined}
      action={state !== "ready" && connectionHref ? (
        <span className={buttonVariants({ size: "xs", variant: state === "needs_signin" ? "primary" : "ghost" })}>
          {state === "needs_signin" ? "Sign in" : "Details"}
        </span>
      ) : <ChevronRight aria-hidden className="h-4 w-4 text-gray-400" />}
      href={rowHref}
      focused={isFocused}
      dataAttributes={{
        "data-library-item-type": item.type,
        "data-library-item-state": item.type === "connection" || item.type === "workflow" ? item.state : undefined,
        "data-library-item-key": `${item.type}-${item.id}`,
        "data-library-focused": isFocused ? "" : undefined,
      }}
    />
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
    <div className="px-4 pb-7 pt-5 sm:px-8" data-testid="den-library" data-library-kind={activeKind} data-library-layout={layout}>
      <DashboardHeaderActions>
      {addAction ? (
        <DenButton href={addAction.href} variant="ghost" size="sm" className="!h-8 w-8 !p-0 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-offset-2" aria-label={addAction.label} title={addAction.label}>
          <Plus aria-hidden className="h-5 w-5" />
        </DenButton>
      ) : (
        <DenButton variant="ghost" size="sm" className="!h-8 w-8 !p-0" disabled aria-label="Add to My Library" title="A workspace admin manages additions to this Library.">
          <Plus aria-hidden className="h-5 w-5" />
        </DenButton>
      )}
      </DashboardHeaderActions>

      <div className="mb-5 flex min-w-0 flex-wrap items-center justify-between gap-x-7 gap-y-3 border-b border-gray-200">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <UnderlineTabs
            className="!border-0 [&>nav]:!m-0 [&>nav]:!flex-nowrap [&>nav]:!gap-7 [&_[role=tab]]:h-12 [&_[role=tab]]:shrink-0 [&_[role=tab]]:!pb-0 [&_[role=tab]]:!text-[14px] [&_[role=tab]]:!font-normal [&_[role=tab]]:!leading-5 [&_[role=tab]]:!text-gray-500 [&_[role=tab][aria-selected=true]]:!border-gray-900 [&_[role=tab][aria-selected=true]]:!text-gray-900"
            tabs={view.tabs.map((tab) => ({ ...tab, count: view.counts[tab.value], countClassName: "!h-[22px] min-w-6 justify-center !px-1.5 !py-0 !text-[12px]" }))}
            activeTab={view.activeState}
            onChange={setActiveState}
            showZeroCounts
          />
        </div>
        <div className="w-full shrink-0 pb-3 lg:w-[280px] lg:pb-0">
          <DenInput type="search" icon={Search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your library" aria-label="Search your library" className="!h-9 !rounded-[10px]" />
        </div>
      </div>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3" aria-label="Library filters">
        <div className="flex items-center gap-2">
          {LIBRARY_KINDS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              aria-pressed={activeKind === filter.value}
              onClick={() => { setActiveKind(filter.value); setActiveState(LIBRARY_DEFAULT_STATE); }}
              className={`inline-flex h-[30px] items-center rounded-full border px-3 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 ${activeKind === filter.value ? "border-gray-900 bg-gray-900 text-white" : "border-gray-200 bg-white text-gray-500 hover:border-gray-400 hover:text-gray-900"}`}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="Library view">
          {([{ value: "grid", label: "Card view", icon: LayoutGrid }, { value: "list", label: "List view", icon: List }] satisfies { value: LibraryLayout; label: string; icon: typeof List }[]).map(({ value, label, icon: Icon }) => (
            <button key={value} type="button" aria-label={label} title={label} aria-pressed={layout === value} onClick={() => selectLayout(value)} className={`flex h-[30px] w-8 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 ${layout === value ? "bg-gray-100 text-gray-900" : "text-gray-500 hover:bg-gray-100"}`}>
              <Icon aria-hidden className="h-4 w-4" />
            </button>
          ))}
          <button type="button" aria-label="Refresh" title="Refresh" disabled={isFetching} onClick={() => void refetch()} className="flex h-[30px] w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50">
            <RefreshCw aria-hidden className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {error ? (
        <DenNotice tone="error" message={error instanceof Error ? error.message : "Failed to load library."} />
      ) : isLoading ? (
        <div role="status" className="rounded-[10px] border border-gray-200 bg-white px-6 py-10 text-[14px] text-gray-500">Loading your library...</div>
      ) : view.visibleItems.length === 0 ? (
        <div className="rounded-[10px] border border-dashed border-gray-200 bg-white px-6 py-12 text-center" data-library-empty={view.empty.action}>
          <h2 className="text-[15px] font-medium text-gray-900">{view.empty.title}</h2>
          <p className="mt-2 text-[13px] text-gray-500">{view.empty.description}</p>
          <div className="mt-4 flex justify-center">
            {view.empty.action === "add" ? addAction ? (
              <DenButton href={addAction.href} size="sm">{addAction.label}</DenButton>
            ) : (
              <p className="text-[13px] text-gray-500">Ask a workspace admin to add {activeKind === "mcps" ? "MCPs" : activeKind}.</p>
            ) : (
              <DenButton size="sm" variant="secondary" onClick={() => {
                if (view.empty.action === "clear_search") setQuery("");
                else if (view.empty.action === "needs_signin" || view.empty.action === "needs_admin_setup" || view.empty.action === "needs_setup") setActiveState(view.empty.action);
                else setActiveState("ready");
              }}>
                {view.empty.action === "clear_search" ? "Clear search" : view.empty.action === "needs_signin" ? "Needs your sign-in" : view.empty.action === "ready" ? "Ready to use" : "View setup needed"}
              </DenButton>
            )}
          </div>
        </div>
      ) : (
        <section data-library-section={view.activeState} aria-label={view.tabs.find((tab) => tab.value === view.activeState)?.label}>
          {layout === "grid" ? <div data-library-grid className="grid grid-cols-1 gap-4 xl:grid-cols-2 2xl:grid-cols-3">{rows}</div> : <div data-library-list><DenList>{rows}</DenList></div>}
        </section>
      )}
    </div>
  );
}
