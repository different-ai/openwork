"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { LibraryBig, Search } from "lucide-react";

import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { type TabItem, UnderlineTabs } from "../../_components/ui/tabs";
import { getOrgAccessFlags, getPluginRoute, getYourConnectionsRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  type LibraryConnectionItem,
  type LibraryItem,
  type LibraryPluginItem,
  useLibrary,
} from "./library-data";

type LibraryStateTab = "all" | "needs_signin" | "needs_admin_setup" | "ready";
type LibrarySectionState = Exclude<LibraryStateTab, "all">;
type KindFilter = "all" | "connections" | "skills" | "mcps" | "plugins";
type FromFilter = "anyone" | "mine" | "shared" | "team" | "everyone";
type RowKind = "connection" | "skill" | "plugin";

const KIND_FILTERS: readonly { value: KindFilter; label: string }[] = [
  { value: "all", label: "All kinds" },
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

function hasComponentKind(item: LibraryPluginItem, kind: "skill" | "mcp"): boolean {
  return item.componentKinds.some((componentKind) => componentKind.toLowerCase() === kind);
}

function matchesKind(item: LibraryItem, kind: KindFilter): boolean {
  if (kind === "all") return true;
  if (kind === "connections") return item.type === "connection";
  if (kind === "plugins") return item.type === "plugin";
  if (kind === "skills") return item.type === "plugin" && hasComponentKind(item, "skill");
  return (item.type === "plugin" && hasComponentKind(item, "mcp"))
    || (item.type === "connection" && item.transport === "mcp");
}

function getSectionState(item: LibraryItem): LibrarySectionState {
  if (item.type === "connection" && item.state === "needs_signin") return "needs_signin";
  if (item.type === "connection" && item.state === "needs_admin_setup") return "needs_admin_setup";
  return "ready";
}

function matchesState(item: LibraryItem, state: LibraryStateTab): boolean {
  return state === "all" || getSectionState(item) === state;
}

function getRowKind(item: LibraryItem): RowKind {
  if (item.type === "connection") return "connection";
  return hasComponentKind(item, "skill") ? "skill" : "plugin";
}

function getKindChipClasses(kind: RowKind): string {
  if (kind === "skill" || kind === "plugin") return "bg-[#f3f4f6] text-[#4b5563]";
  return "bg-[#dbeafe] text-[#1d4ed8]";
}

function getKindLabel(kind: RowKind): string {
  if (kind === "skill") return "Skill";
  if (kind === "plugin") return "Plugin";
  return "Connection";
}

function KindChip({ kind }: { kind: RowKind }) {
  return (
    <span
      data-library-chip
      className={`inline-flex h-[20px] items-center rounded-full px-2 text-[11px] font-semibold ${getKindChipClasses(kind)}`}
    >
      {getKindLabel(kind)}
    </span>
  );
}

function TransportChip({ transport }: { transport: LibraryConnectionItem["transport"] }) {
  return (
    <span
      data-library-chip
      className={`inline-flex h-[20px] items-center rounded-full px-2 text-[11px] font-semibold ${transport === "mcp"
        ? "bg-[#f3f4f6] text-[#4b5563]"
        : "bg-[#ccfbf1] text-[#0f766e]"
      }`}
    >
      {transport === "mcp" ? "MCP" : "Native"}
    </span>
  );
}

function firstName(name: string | null): string {
  if (!name) return "someone";
  return name.trim().split(/\s+/)[0] ?? "someone";
}

function getSource(item: LibraryItem, orgName: string): { label: string; isPerson: boolean } {
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
  return { label: "Yours", isPerson: false };
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

function LibraryRowContent({ item, orgName, action }: { item: LibraryItem; orgName: string; action: ReactNode }) {
  const rowKind = getRowKind(item);
  const source = getSource(item, orgName);
  const iconUrl = item.type === "connection" && item.provider === "google-workspace"
    ? "/integrations/google.svg"
    : item.type === "plugin"
      ? getGitHubOwnerAvatar(item.sourceRepositoryUrl)
      : undefined;
  const simpleIconSlug = item.type === "connection" && item.provider === "microsoft-365"
    ? "microsoft"
    : undefined;
  const serviceUrl = item.type === "connection" && item.transport === "mcp" ? item.url : undefined;

  return (
    <div className="flex h-full min-w-0 items-center overflow-hidden pl-[10px] pr-[12px]">
      <DenBrandMark
        name={item.name}
        iconUrl={iconUrl}
        simpleIconSlug={simpleIconSlug}
        serviceUrl={serviceUrl}
        className="h-[32px] w-[32px] rounded-[8px] border-[#e1e4e8] bg-[#f7f8fa]"
        imageClassName="h-[32px] w-[32px] rounded-[8px] object-cover"
      />
      <div className="ml-2 w-[88px] shrink-0 truncate text-[13.5px] font-semibold text-[#1c2024] sm:w-[190px]">
        {item.name}
      </div>
      <div className="flex w-[112px] shrink-0 items-center gap-1 sm:w-[158px]">
        <KindChip kind={rowKind} />
        {item.type === "connection" ? <TransportChip transport={item.transport} /> : null}
      </div>
      <p className="hidden min-w-0 flex-1 truncate text-[12.5px] font-normal text-[#6b7280] sm:block">
        {item.description ?? ""}
      </p>
      <div data-library-source className={`hidden w-[120px] shrink-0 truncate text-right text-[12px] sm:block ${source.isPerson
        ? "font-medium text-[#1d4ed8]"
        : "font-normal text-[#9ca3af]"
      }`}>
        {source.label}
      </div>
      <div className="ml-2 flex w-[68px] shrink-0 justify-end">
        {action}
      </div>
    </div>
  );
}

function LibraryRow({ item, isAdmin, isFocused, orgName, orgSlug }: { item: LibraryItem; isAdmin: boolean; isFocused: boolean; orgName: string; orgSlug: string | null }) {
  const sectionState = getSectionState(item);
  const rowClassName = `${sectionState === "ready"
    ? "block h-[52px] border-b border-[#f0f1f3] bg-transparent"
    : "block h-[52px] rounded-[10px] border border-[#fde9c3] bg-[#fffbeb]"} ${isFocused ? "ring-2 ring-blue-300 ring-offset-2 transition-shadow" : ""}`;
  const rowKey = `${item.type}-${item.id}`;
  const connectionHref = item.type === "connection"
    ? `${getYourConnectionsRoute(orgSlug)}?connectionId=${encodeURIComponent(item.id)}`
    : null;
  const action = sectionState === "needs_signin" && connectionHref ? (
    <Link
      href={connectionHref}
      className="inline-flex h-[28px] items-center rounded-[8px] bg-[#1c2024] px-3 text-[12px] font-semibold text-white"
    >
      Sign in
    </Link>
  ) : sectionState === "needs_admin_setup" && connectionHref ? (
    <Link href={connectionHref} className="text-[12px] font-medium text-[#6b7280] hover:text-[#1c2024]">
      Details
    </Link>
  ) : (
    <span aria-hidden className="text-[14px] font-normal text-[#c3c7cd]">›</span>
  );

  if (item.type === "plugin" && isAdmin) {
    return (
      <Link
        href={getPluginRoute(orgSlug, item.id)}
        className={`${rowClassName} hover:bg-gray-50`}
        data-library-item-type={item.type}
        data-library-item-key={rowKey}
        data-library-focused={isFocused ? "" : undefined}
      >
        <LibraryRowContent item={item} orgName={orgName} action={action} />
      </Link>
    );
  }

  return (
    <div
      className={rowClassName}
      data-library-item-type={item.type}
      data-library-item-state={item.type === "connection" ? item.state : undefined}
      data-library-item-key={rowKey}
      data-library-focused={isFocused ? "" : undefined}
    >
      <LibraryRowContent item={item} orgName={orgName} action={action} />
    </div>
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
  isAdmin,
  orgName,
  orgSlug,
  focusedKey,
  onToggle,
}: {
  state: LibrarySectionState;
  items: LibraryItem[];
  expanded: boolean;
  isAdmin: boolean;
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
      <div className="mb-2 flex min-w-0 items-baseline gap-2 overflow-hidden whitespace-nowrap">
        <h2 className="shrink-0 text-[11px] font-semibold tracking-[0.07em] text-[#6b7280]">
          {SECTION_TITLES[state]}
        </h2>
        <span className="shrink-0 text-[11px] font-medium text-[#9ca3af]">{items.length}</span>
        {caption ? <span className="min-w-0 truncate text-[12px] font-normal tracking-normal text-[#9ca3af]">— {caption}</span> : null}
      </div>
      <div className={state === "ready" ? "flex flex-col" : "flex flex-col gap-2"}>
        {visibleItems.map((item) => (
          <LibraryRow
            key={`${item.type}-${item.id}`}
            item={item}
            isAdmin={isAdmin}
            isFocused={focusedKey === `${item.type}-${item.id}`}
            orgName={orgName}
            orgSlug={orgSlug}
          />
        ))}
      </div>
      {items.length > 6 ? (
        <button
          type="button"
          onClick={onToggle}
          className="flex h-[40px] w-full items-center justify-center text-[12.5px] font-medium text-[#4b5563] hover:text-[#1c2024]"
        >
          {expanded ? "Show less" : `Show ${hiddenCount} more`}
        </button>
      ) : null}
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
  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.roles,
  );
  const orgName = orgContext?.organization.name ?? "your organization";
  const requestedFocus = searchParams.get("focus");

  useEffect(() => {
    if (!requestedFocus || handledFocusRef.current === requestedFocus) return;
    if (!/^(plugin|connection)-.+$/.test(requestedFocus)) return;
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
      connections: 0,
      skills: 0,
      mcps: 0,
      plugins: 0,
    };
    for (const item of items) {
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
        countClassName: "!bg-[#fef3c7] !text-[#b45309]",
      });
    }
    if (stateCounts.needs_admin_setup > 0) {
      tabs.push({
        value: "needs_admin_setup",
        label: "Needs admin setup",
        count: stateCounts.needs_admin_setup,
        countClassName: "!bg-[#fee2e2] !text-[#b91c1c]",
      });
    }
    if (stateCounts.ready > 0) {
      tabs.push({
        value: "ready",
        label: "Ready to use",
        count: stateCounts.ready,
        countClassName: "!bg-[#f0f1f3] !text-[#4b5563]",
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
      badgeLabel="Member library"
      badgeCompanion={(
        <span className="inline-flex h-[22px] shrink-0 items-center rounded-full bg-[rgba(236,253,243,0.92)] px-2.5 text-[11px] font-semibold text-[#15803d]">
          {stateCounts.ready} ready to use
        </span>
      )}
      title="Library"
      description="Everything you can use in chat — yours, shared with you, from your teams, and org-wide."
      descriptionPlacement="hero"
      colors={["#DBEAFE", "#1E3A8A", "#2563EB", "#A7F3D0"]}
      size="responsive"
    >
      <div className="mb-5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <UnderlineTabs
          className="min-w-max [&>nav]:flex-nowrap [&_[role=tab]]:!pb-2.5 [&_[role=tab]]:!text-[13px] [&_[role=tab]]:!font-medium [&_[role=tab]]:!text-[#60646c] [&_[role=tab][aria-selected=true]]:!border-[#1c2024] [&_[role=tab][aria-selected=true]]:!font-semibold [&_[role=tab][aria-selected=true]]:!text-[#1c2024] [&_[role=tab]>span]:inline-flex [&_[role=tab]>span]:h-[18px] [&_[role=tab]>span]:items-center [&_[role=tab]>span]:text-[11px] [&_[role=tab]>span]:font-semibold"
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
                ? "border-[#1c2024] bg-[#1c2024] text-white"
                : "border-[#e1e4e8] bg-white text-[#4b5563] hover:border-[#c3c7cd] hover:text-[#1c2024]"
              }`}
            >
              {kindFilterLabel(filter, kindCounts)}
            </button>
          );
        })}
        <label className="inline-flex h-[26px] items-center rounded-full border border-[#e1e4e8] bg-white pl-3 pr-2 text-[12px] font-medium text-[#4b5563]">
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
            className="h-[24px] max-w-[116px] appearance-none bg-transparent pl-1 pr-0 text-[12px] font-medium text-[#4b5563] outline-none"
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
        <div data-library-list className="flex flex-col gap-7">
          {(["needs_signin", "needs_admin_setup", "ready"] satisfies LibrarySectionState[]).map((state) => (
            sectionItems[state].length > 0 ? (
              <LibrarySection
                key={state}
                state={state}
                items={sectionItems[state]}
                expanded={expandedSections[state]}
                isAdmin={access.isAdmin}
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
