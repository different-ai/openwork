"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, LibraryBig, Search } from "lucide-react";

import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton } from "../../_components/ui/button";
import { DenChip } from "../../_components/ui/chip";
import { DenInput } from "../../_components/ui/input";
import { DenList, DenListRow } from "../../_components/ui/list-row";
import { DenNotice } from "../../_components/ui/notice";
import { type TabItem, UnderlineTabs } from "../../_components/ui/tabs";
import { getLibraryPluginRoute, getYourConnectionsRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  type LibraryConnectionItem,
  type LibraryItem,
  type LibraryPluginItem,
  useLibrary,
} from "./library-data";

type LibraryStateTab = "all" | "needs_signin" | "needs_admin_setup" | "ready";
type LibrarySectionState = Exclude<LibraryStateTab, "all">;
type KindFilter = "all" | "workflows" | "connections" | "skills" | "mcps" | "plugins";
type FromFilter = "anyone" | "mine" | "shared" | "team" | "everyone";
type RowKind = "workflow" | "connection" | "skill" | "plugin";

const KIND_FILTERS: readonly { value: KindFilter; label: string }[] = [
  { value: "all", label: "All kinds" },
  { value: "workflows", label: "Workflows" },
  { value: "connections", label: "Connections" },
  { value: "skills", label: "Skills" },
  { value: "mcps", label: "MCPs" },
  { value: "plugins", label: "Plugins" },
];

const FROM_FILTERS: readonly { value: FromFilter; label: string }[] = [
  { value: "anyone", label: "Anyone" },
  { value: "mine", label: "Mine" },
  { value: "shared", label: "Shared with me" },
  { value: "team", label: "My teams" },
  { value: "everyone", label: "Everyone" },
];

const SECTION_TITLES: Record<LibrarySectionState, string> = {
  needs_signin: "NEEDS YOUR SIGN-IN",
  needs_admin_setup: "NEEDS ADMIN SETUP",
  ready: "READY TO USE",
};

function matchesFrom(item: LibraryItem, from: FromFilter): boolean {
  if (from === "anyone") return true;
  if (from === "mine") return item.edges.some((edge) => edge.kind === "mine");
  if (from === "shared") return item.edges.some((edge) => edge.kind === "person");
  if (from === "team") return item.edges.some((edge) => edge.kind === "team");
  return item.edges.some((edge) => edge.kind === "org_wide" || edge.kind === "catalog");
}

function hasComponentKind(item: LibraryPluginItem, kind: "app" | "skill" | "mcp"): boolean {
  return item.componentKinds.some((componentKind) => componentKind.toLowerCase() === kind);
}

function matchesKind(item: LibraryItem, kind: KindFilter): boolean {
  if (kind === "all") return true;
  if (kind === "workflows") return item.type === "workflow";
  if (kind === "connections") return item.type === "connection";
  if (kind === "plugins") return item.type === "plugin";
  if (kind === "skills") return item.type === "plugin" && hasComponentKind(item, "skill");
  return (item.type === "plugin" && hasComponentKind(item, "mcp"))
    || (item.type === "connection" && item.transport === "mcp");
}

function getSectionState(item: LibraryItem): LibrarySectionState {
  if (item.type === "connection" && item.state === "needs_signin") return "needs_signin";
  if (item.type === "connection" && item.state === "needs_admin_setup") return "needs_admin_setup";
  if (item.type === "workflow" && item.state === "needs_signin") return "needs_signin";
  if (item.type === "workflow" && item.state === "needs_admin_setup") return "needs_admin_setup";
  return "ready";
}

function matchesState(item: LibraryItem, state: LibraryStateTab): boolean {
  return state === "all" || getSectionState(item) === state;
}

function getRowKind(item: LibraryItem): RowKind {
  if (item.type === "workflow") return "workflow";
  if (item.type === "connection") return "connection";
  return hasComponentKind(item, "skill") ? "skill" : "plugin";
}

function getKindLabel(kind: RowKind): string {
  if (kind === "workflow") return "Workflow";
  if (kind === "skill") return "Skill";
  if (kind === "plugin") return "Plugin";
  return "Connection";
}

function KindChip({ kind }: { kind: RowKind }) {
  return (
    <DenChip data-library-chip="" tone={kind === "connection" ? "info" : kind === "workflow" ? "teal" : "neutral"}>
      {getKindLabel(kind)}
    </DenChip>
  );
}

function TransportChip({ transport }: { transport: LibraryConnectionItem["transport"] }) {
  return (
    <DenChip data-library-chip="" tone={transport === "mcp" ? "neutral" : "teal"}>
      {transport === "mcp" ? "MCP" : "Native"}
    </DenChip>
  );
}

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

function getReadyCatalogCaption(items: LibraryItem[]): string | null {
  const names = new Set<string>();
  let catalogItemCount = 0;
  for (const item of items) {
    let fromCatalog = false;
    for (const edge of item.edges) {
      if (edge.kind === "catalog") {
        fromCatalog = true;
        names.add(edge.marketplace.name);
      }
    }
    if (fromCatalog) catalogItemCount += 1;
  }

  if (names.size > 1) return `${catalogItemCount} come from catalogs.`;
  if (names.size === 1 && catalogItemCount >= 2) {
    let catalogName = "";
    for (const name of names) catalogName = name;
    return `${catalogItemCount} of these come from the catalog ${catalogName}.`;
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

function LibraryRow({ item, isFocused, orgName, orgSlug }: { item: LibraryItem; isFocused: boolean; orgName: string; orgSlug: string | null }) {
  const sectionState = getSectionState(item);
  const rowKind = getRowKind(item);
  const source = getSource(item, orgName);
  const rowKey = `${item.type}-${item.id}`;
  const connectionHref = item.type === "connection"
    ? `${getYourConnectionsRoute(orgSlug)}?connectionId=${encodeURIComponent(item.id)}`
    : undefined;
  const rowHref = item.type === "workflow"
    ? `/dashboard/library/workflows/${encodeURIComponent(item.id)}`
    : item.type === "plugin"
      ? getLibraryPluginRoute(orgSlug, item.id)
      : item.type === "connection"
        ? connectionHref
        : undefined;
  const iconUrl = item.type === "connection" && item.provider === "google-workspace"
    ? "/integrations/google.svg"
    : item.type === "plugin"
      ? getGitHubOwnerAvatar(item.sourceRepositoryUrl)
      : undefined;
  const simpleIconSlug = item.type === "connection" && item.provider === "microsoft-365"
    ? "microsoft"
    : undefined;
  const serviceUrl = item.type === "connection" && item.transport === "mcp" ? item.url : undefined;
  const action = sectionState === "needs_signin" && connectionHref ? (
    <DenButton
      href={connectionHref}
      size="xs"
      variant="primary"
    >
      Sign in
    </DenButton>
  ) : sectionState === "needs_admin_setup" && connectionHref ? (
    <DenButton href={connectionHref} size="xs" variant="ghost">
      Details
    </DenButton>
  ) : (
    <ChevronRight aria-hidden className="h-4 w-4 text-gray-400" />
  );
  const nonPersonSource = source && !source.isPerson ? source : null;

  return (
    <DenListRow
      leading={(
        <DenBrandMark
          name={item.name}
          iconUrl={iconUrl}
          simpleIconSlug={simpleIconSlug}
          serviceUrl={serviceUrl}
          className="h-10 w-10 rounded-[12px] border border-gray-100 bg-white"
        />
      )}
      title={item.name}
      chips={(
        <>
          <KindChip kind={rowKind} />
          {item.type === "connection" ? <TransportChip transport={item.transport} /> : null}
          {item.type === "workflow" ? (
            <>
              <DenChip data-library-chip="" tone={item.resultState === "fresh" ? "success" : item.resultState === "needs_attention" ? "danger" : "warning"}>
                {item.resultState.replace("_", " ")}
              </DenChip>
              <DenChip data-library-chip="" tone={item.viewState === "custom_active" ? "info" : item.viewState === "build_failed" ? "danger" : "neutral"}>
                {item.viewState === "custom_active" ? item.activeViewTitle ?? "Custom view" : item.viewState.replace("_", " ")}
              </DenChip>
            </>
          ) : null}
          {sectionState !== "ready" ? (
            <DenChip data-library-chip="" tone="warning">
              {sectionState === "needs_signin" ? "Connect your account" : "Waiting on your admin"}
            </DenChip>
          ) : null}
          {source?.isPerson ? (
            <DenChip data-library-chip="" data-library-source="" tone="info">
              {source.label}
            </DenChip>
          ) : null}
        </>
      )}
      meta={item.description || nonPersonSource || item.type === "workflow" ? (
        <>
          {item.description}
          {item.type === "workflow" ? (
            <>
              {item.description ? <span aria-hidden> · </span> : null}
              <span>{item.plugin ? `Plugin ${item.plugin.name} · ` : ""}{item.latestSuccessfulAt ? `Last run ${new Date(item.latestSuccessfulAt).toLocaleString()}` : "Not run yet"} · {item.automationCount} Automation{item.automationCount === 1 ? "" : "s"}</span>
            </>
          ) : null}
          {nonPersonSource ? (
            <>
              {item.description ? <span aria-hidden> · </span> : null}
              <span data-library-source>{nonPersonSource.label}</span>
            </>
          ) : null}
        </>
      ) : undefined}
      action={action}
      href={rowHref}
      focused={isFocused}
      dataAttributes={{
        "data-library-item-type": item.type,
        "data-library-item-state": item.type === "connection" || item.type === "workflow" ? item.state : undefined,
        "data-library-item-key": rowKey,
        "data-library-focused": isFocused ? "" : undefined,
      }}
    />
  );
}

function kindFilterLabel(filter: { value: KindFilter; label: string }, counts: Record<Exclude<KindFilter, "all">, number>): string {
  if (filter.value === "all") return filter.label;
  return `${filter.label} · ${counts[filter.value]}`;
}

function LibrarySection({
  state,
  items,
  expanded,
  orgName,
  orgSlug,
  focusedKey,
  onToggle,
}: {
  state: LibrarySectionState;
  items: LibraryItem[];
  expanded: boolean;
  orgName: string;
  orgSlug: string | null;
  focusedKey: string | null;
  onToggle: () => void;
}) {
  const visibleItems = expanded ? items : items.slice(0, 6);
  const hiddenCount = items.length - visibleItems.length;
  const caption = state === "needs_signin"
    ? `these come from ${orgName}; connect your own account to use them.`
    : state === "needs_admin_setup"
      ? "waiting on an admin to finish configuration."
      : getReadyCatalogCaption(items);

  return (
    <section data-library-section={state}>
      <div className="mb-3 flex min-w-0 items-baseline gap-2 overflow-hidden whitespace-nowrap">
        <h2 className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400">
          {SECTION_TITLES[state]}
        </h2>
        <span className="shrink-0 text-[11px] font-semibold text-gray-400">{items.length}</span>
        {caption ? <span className="min-w-0 truncate text-[12px] text-gray-400">— {caption}</span> : null}
      </div>
      <div data-library-list>
        <DenList className="[&_[data-library-focused]]:relative [&_[data-library-focused]]:z-10 [&_[data-library-focused]]:ring-2 [&_[data-library-focused]]:ring-inset [&_[data-library-focused]]:ring-blue-300 [&_[data-library-focused]]:transition-shadow">
          {visibleItems.map((item) => (
            <LibraryRow
              key={`${item.type}-${item.id}`}
              item={item}
              isFocused={focusedKey === `${item.type}-${item.id}`}
              orgName={orgName}
              orgSlug={orgSlug}
            />
          ))}
          {items.length > 6 ? (
            <button
              type="button"
              onClick={onToggle}
              className="w-full bg-gray-50/40 px-6 py-3 text-center text-[12.5px] font-medium text-gray-500 hover:text-gray-900"
            >
              {expanded ? "Show less" : `Show ${hiddenCount} more`}
            </button>
          ) : null}
        </DenList>
      </div>
    </section>
  );
}

export function LibraryScreen() {
  const { orgContext, orgSlug } = useOrgDashboard();
  const { data: items = [], isLoading, error } = useLibrary();
  const searchParams = useSearchParams();
  const [activeState, setActiveState] = useState<LibraryStateTab>("all");
  const [activeKind, setActiveKind] = useState<KindFilter>("all");
  const [activeFrom, setActiveFrom] = useState<FromFilter>("anyone");
  const [query, setQuery] = useState("");
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const handledFocusRef = useRef<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<Record<LibrarySectionState, boolean>>({
    needs_signin: false,
    needs_admin_setup: false,
    ready: false,
  });
  const orgName = orgContext?.organization.name ?? "your organization";
  const requestedFocus = searchParams.get("focus");

  useEffect(() => {
    if (!requestedFocus || handledFocusRef.current === requestedFocus) return;
    if (!/^(workflow|plugin|connection)-.+$/.test(requestedFocus)) return;
    const item = items.find((candidate) => `${candidate.type}-${candidate.id}` === requestedFocus);
    if (!item) return;
    handledFocusRef.current = requestedFocus;
    setActiveState("all");
    setActiveKind("all");
    setActiveFrom("anyone");
    setQuery("");
    setExpandedSections((current) => ({ ...current, [getSectionState(item)]: true }));
    setFocusedKey(requestedFocus);
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
  const normalizedQuery = query.trim().toLowerCase();
  const kindCounts = useMemo(() => {
    const counts: Record<Exclude<KindFilter, "all">, number> = {
      workflows: 0,
      connections: 0,
      skills: 0,
      mcps: 0,
      plugins: 0,
    };
    for (const item of items) {
      if (matchesKind(item, "workflows")) counts.workflows += 1;
      if (matchesKind(item, "connections")) counts.connections += 1;
      if (matchesKind(item, "skills")) counts.skills += 1;
      if (matchesKind(item, "mcps")) counts.mcps += 1;
      if (matchesKind(item, "plugins")) counts.plugins += 1;
    }
    return counts;
  }, [items]);
  const stateCounts = useMemo(() => {
    const counts: Record<LibrarySectionState, number> = {
      needs_signin: 0,
      needs_admin_setup: 0,
      ready: 0,
    };
    for (const item of items) counts[getSectionState(item)] += 1;
    return counts;
  }, [items]);
  const stateTabs = useMemo(() => {
    const tabs: TabItem<LibraryStateTab>[] = [{ value: "all", label: "All" }];
    if (stateCounts.needs_signin > 0) {
      tabs.push({
        value: "needs_signin",
        label: "Needs your sign-in",
        count: stateCounts.needs_signin,
        countTone: "warning",
      });
    }
    if (stateCounts.needs_admin_setup > 0) {
      tabs.push({
        value: "needs_admin_setup",
        label: "Needs admin setup",
        count: stateCounts.needs_admin_setup,
        countTone: "danger",
      });
    }
    if (stateCounts.ready > 0) {
      tabs.push({
        value: "ready",
        label: "Ready to use",
        count: stateCounts.ready,
        countTone: "neutral",
      });
    }
    return tabs;
  }, [stateCounts]);
  const visibleItems = useMemo(
    () => items.filter((item) => {
      if (!matchesState(item, activeState)) return false;
      if (!matchesKind(item, activeKind)) return false;
      if (!matchesFrom(item, activeFrom)) return false;
      if (!normalizedQuery) return true;
      return item.name.toLowerCase().includes(normalizedQuery)
        || item.description?.toLowerCase().includes(normalizedQuery) === true;
    }),
    [activeFrom, activeKind, activeState, items, normalizedQuery],
  );
  const sectionItems = useMemo(() => {
    const grouped: Record<LibrarySectionState, LibraryItem[]> = {
      needs_signin: [],
      needs_admin_setup: [],
      ready: [],
    };
    for (const item of visibleItems) grouped[getSectionState(item)].push(item);
    return grouped;
  }, [visibleItems]);
  const filtersActive = normalizedQuery.length > 0
    || activeKind !== "all"
    || activeFrom !== "anyone"
    || activeState !== "all";

  return (
    <DashboardPageTemplate
      icon={LibraryBig}
      title="My Library"
      description="Everything you can use in chat — yours, shared with you, from your teams, and org-wide."
      descriptionPlacement="hero"
      colors={["#DBEAFE", "#1E3A8A", "#2563EB", "#A7F3D0"]}
      size="responsive"
    >
      <div className="mb-5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <UnderlineTabs
          className="min-w-max [&>nav]:flex-nowrap [&_[role=tab]]:!pb-2.5 [&_[role=tab]]:!text-[13px] [&_[role=tab]]:!font-medium [&_[role=tab]]:!text-gray-500 [&_[role=tab][aria-selected=true]]:!border-gray-900 [&_[role=tab][aria-selected=true]]:!font-semibold [&_[role=tab][aria-selected=true]]:!text-gray-900"
          tabs={stateTabs}
          activeTab={activeState}
          onChange={setActiveState}
        />
      </div>

      <div className="mb-7 flex flex-wrap items-center gap-2" aria-label="Library filters">
        <div className="w-full sm:w-[220px]">
          <DenInput
            type="search"
            icon={Search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search your library"
            className="h-[34px] text-[12.5px]"
          />
        </div>
        {KIND_FILTERS.map((filter) => {
          const selected = activeKind === filter.value;
          return (
            <button
              key={filter.value}
              type="button"
              aria-pressed={selected}
              onClick={() => setActiveKind(filter.value)}
              className={`inline-flex h-[26px] items-center rounded-full border px-3 text-[12px] font-medium transition-colors ${selected
                ? "border-gray-900 bg-gray-900 text-white"
                : "border-gray-200 bg-white text-gray-500 hover:border-gray-400 hover:text-gray-900"
              }`}
            >
              {kindFilterLabel(filter, kindCounts)}
            </button>
          );
        })}
        <label className="inline-flex h-[26px] items-center rounded-full border border-gray-200 bg-white pl-3 pr-2 text-[12px] font-medium text-gray-500">
          <span className="shrink-0">From ·</span>
          <select
            aria-label="Library source"
            value={activeFrom}
            onChange={(event) => setActiveFrom(event.target.value === "mine"
              ? "mine"
              : event.target.value === "shared"
                ? "shared"
                : event.target.value === "team"
                  ? "team"
                  : event.target.value === "everyone"
                    ? "everyone"
                    : "anyone")}
            className="h-[24px] max-w-[116px] appearance-none bg-transparent pl-1 pr-0 text-[12px] font-medium text-gray-500 outline-none"
          >
            {FROM_FILTERS.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
          </select>
          <span aria-hidden className="ml-1 text-[10px]">▾</span>
        </label>
      </div>

      {error ? (
        <DenNotice
          tone="error"
          message={error instanceof Error ? error.message : "Failed to load library."}
        />
      ) : isLoading ? (
        <div className="rounded-[10px] border border-gray-200 bg-white px-6 py-10 text-[14px] text-gray-500">
          Loading your library…
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="rounded-[10px] border border-dashed border-gray-200 bg-white px-6 py-12 text-center">
          <p className="text-[15px] font-medium text-gray-900">
            {filtersActive ? "No library items match these filters." : "Your library is empty."}
          </p>
          <p className="mt-2 text-[13px] text-gray-500">
            {filtersActive ? "Try changing your search or filters." : "Everything you can use in chat will appear here."}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-7">
          {(["needs_signin", "needs_admin_setup", "ready"] satisfies LibrarySectionState[]).map((state) => (
            sectionItems[state].length > 0 ? (
              <LibrarySection
                key={state}
                state={state}
                items={sectionItems[state]}
                expanded={expandedSections[state]}
                orgName={orgName}
                orgSlug={orgSlug}
                focusedKey={focusedKey}
                onToggle={() => setExpandedSections((current) => ({ ...current, [state]: !current[state] }))}
              />
            ) : null
          ))}
        </div>
      )}
    </DashboardPageTemplate>
  );
}
