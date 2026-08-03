"use client";

import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";
import { LibraryBig, Search } from "lucide-react";

import { buttonVariants } from "../../_components/ui/button";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { type TabItem, UnderlineTabs } from "../../_components/ui/tabs";
import { getOrgAccessFlags, getPluginRoute, getYourConnectionsRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  type LibraryAccessEdge,
  type LibraryConnectionItem,
  type LibraryItem,
  type LibraryPluginItem,
  useLibrary,
} from "./library-data";

type LibraryTab = "all" | "mine" | "shared" | "team" | "everyone";
type KindFilter = "all" | "connections" | "skills" | "mcps" | "plugins";
type DisplayKind = "connection" | "skill" | "mcp" | "plugin";

const LIBRARY_TABS: readonly TabItem<LibraryTab>[] = [
  { value: "all", label: "All" },
  { value: "mine", label: "Mine" },
  { value: "shared", label: "Shared with me" },
  { value: "team", label: "Team" },
  { value: "everyone", label: "Everyone" },
];

const KIND_FILTERS: readonly { value: KindFilter; label: string }[] = [
  { value: "all", label: "All kinds" },
  { value: "connections", label: "Connections" },
  { value: "skills", label: "Skills" },
  { value: "mcps", label: "MCPs" },
  { value: "plugins", label: "Plugins" },
];

const EMPTY_TITLES: Record<LibraryTab, string> = {
  all: "Your library is empty.",
  mine: "You don’t have anything in your library yet.",
  shared: "Nothing shared with you yet.",
  team: "Your teams don’t have anything in their library yet.",
  everyone: "Nothing is available to everyone yet.",
};

function matchesTab(item: LibraryItem, tab: LibraryTab): boolean {
  if (tab === "all") return true;
  if (tab === "mine") return item.edges.some((edge) => edge.kind === "mine");
  if (tab === "shared") return item.edges.some((edge) => edge.kind === "person");
  if (tab === "team") return item.edges.some((edge) => edge.kind === "team");
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

function sourceRepositoryName(value: string | null): string | null {
  if (!value) return null;
  try {
    const pathParts = new URL(value).pathname.split("/").filter(Boolean);
    const owner = pathParts[0];
    const repository = pathParts[1]?.replace(/\.git$/, "");
    return owner && repository ? `${owner}/${repository}` : null;
  } catch {
    return null;
  }
}

function itemInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0))
    .join("")
    .toUpperCase();
}

function getDisplayKinds(item: LibraryItem): DisplayKind[] {
  if (item.type === "connection") return ["connection"];
  const kinds: DisplayKind[] = [];
  if (hasComponentKind(item, "skill")) kinds.push("skill");
  if (hasComponentKind(item, "mcp")) kinds.push("mcp");
  return kinds.length > 0 ? kinds : ["plugin"];
}

function getKindLabel(kind: DisplayKind): string {
  if (kind === "connection") return "Connection";
  if (kind === "skill") return "Skill";
  if (kind === "mcp") return "MCP";
  return "Plugin";
}

function getKindClasses(kind: DisplayKind): string {
  if (kind === "connection") return "bg-[#dbeafe] text-[#1d4ed8]";
  if (kind === "skill") return "bg-[#fef3c7] text-[#b45309]";
  return "bg-[#f3f4f6] text-[#4b5563]";
}

function KindChip({ kind }: { kind: DisplayKind }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium ${getKindClasses(kind)}`}>
      {getKindLabel(kind)}
    </span>
  );
}

function EdgeChip({ edge }: { edge: LibraryAccessEdge }) {
  if (edge.kind === "mine") {
    return <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700">Yours</span>;
  }
  if (edge.kind === "person") {
    return (
      <span className="inline-flex max-w-full items-center rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700">
        <span className="shrink-0">Shared by&nbsp;</span>
        <span className="min-w-0 max-w-[220px] truncate">{edge.sharedBy?.name ?? "someone"}</span>
      </span>
    );
  }
  if (edge.kind === "team") {
    return (
      <span className="inline-flex max-w-full items-center rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-600">
        <span className="shrink-0">Team:&nbsp;</span>
        <span className="min-w-0 max-w-[220px] truncate">{edge.team.name}</span>
      </span>
    );
  }
  if (edge.kind === "catalog") {
    return (
      <span className="inline-flex max-w-full items-center rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700">
        <span className="shrink-0">Catalog:&nbsp;</span>
        <span className="min-w-0 max-w-[220px] truncate">{edge.marketplace.name}</span>
      </span>
    );
  }
  return <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-600">Everyone</span>;
}

function TransportChip({ transport }: { transport: LibraryConnectionItem["transport"] }) {
  return (
    <span className="inline-flex rounded-full bg-[#f3f4f6] px-2.5 py-1 text-[11px] font-medium text-[#4b5563]">
      {transport === "mcp" ? "MCP" : "Native"}
    </span>
  );
}

function ConnectionStateChip({ state }: { state: LibraryConnectionItem["state"] }) {
  if (state === "connected") return null;
  if (state === "needs_signin") {
    return (
      <span className="inline-flex rounded-full bg-[#fffbeb] px-2.5 py-1 text-[11px] font-medium text-[#b45309]">
        Needs your sign-in
      </span>
    );
  }
  if (state === "needs_admin_setup") {
    return (
      <span className="inline-flex rounded-full bg-[#fef2f2] px-2.5 py-1 text-[11px] font-medium text-[#b91c1c]">
        Needs admin setup
      </span>
    );
  }
  return (
    <span className="inline-flex rounded-full bg-[#f3f4f6] px-2.5 py-1 text-[11px] font-medium text-[#4b5563]">
      Available
    </span>
  );
}

function LibraryRowContent({ item, action }: { item: LibraryItem; action: ReactNode }) {
  const displayKinds = getDisplayKinds(item);
  const sourceName = item.type === "plugin" ? sourceRepositoryName(item.sourceRepositoryUrl) : null;
  const tileKind = displayKinds[0];

  return (
    <div className="flex flex-col gap-4 px-4 py-4 md:flex-row md:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[13px] font-semibold ${getKindClasses(tileKind)}`}>
          {itemInitials(item.name)}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0 md:flex-1">
            <h2 className="text-[14px] font-semibold text-gray-950">{item.name}</h2>
            <p className="mt-1 line-clamp-2 text-[12px] leading-[18px] text-gray-500">
              {item.description ?? "No description provided."}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5 md:max-w-[58%] md:justify-end">
            {displayKinds.map((kind) => <KindChip key={kind} kind={kind} />)}
            {item.type === "connection" ? <TransportChip transport={item.transport} /> : null}
            {item.edges.map((edge, index) => <EdgeChip key={`${edge.kind}-${index}`} edge={edge} />)}
            {item.type === "connection" ? <ConnectionStateChip state={item.state} /> : null}
            {sourceName ? (
              <span className="inline-flex max-w-full items-center rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-600">
                <span className="shrink-0">From&nbsp;</span>
                <span className="min-w-0 max-w-[220px] truncate">{sourceName}</span>
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {action ? <div className="w-full shrink-0 md:w-auto">{action}</div> : null}
    </div>
  );
}

function LibraryRow({ item, isAdmin, orgSlug }: { item: LibraryItem; isAdmin: boolean; orgSlug: string | null }) {
  const rowClassName = "block rounded-xl border border-gray-200 bg-white";

  if (item.type === "plugin" && isAdmin) {
    return (
      <Link
        href={getPluginRoute(orgSlug, item.id)}
        className={`${rowClassName} transition-colors hover:border-gray-400`}
        data-library-item-type={item.type}
      >
        <LibraryRowContent
          item={item}
          action={<span className={buttonVariants({ variant: "secondary", size: "sm", className: "w-full md:w-auto" })}>View</span>}
        />
      </Link>
    );
  }

  const signInHref = item.type === "connection" && item.state === "needs_signin"
    ? `${getYourConnectionsRoute(orgSlug)}?connectionId=${encodeURIComponent(item.id)}`
    : null;

  return (
    <div
      className={rowClassName}
      data-library-item-type={item.type}
      data-library-item-state={item.type === "connection" ? item.state : undefined}
    >
      <LibraryRowContent
        item={item}
        action={signInHref ? (
          <Link href={signInHref} className={buttonVariants({ variant: "primary", size: "sm", className: "w-full md:w-auto" })}>
            Sign in
          </Link>
        ) : null}
      />
    </div>
  );
}

function kindFilterLabel(filter: { value: KindFilter; label: string }, counts: Record<Exclude<KindFilter, "all">, number>): string {
  if (filter.value === "all") return filter.label;
  return `${filter.label} · ${counts[filter.value]}`;
}

export function LibraryScreen() {
  const { orgContext, orgSlug } = useOrgDashboard();
  const { data: items = [], isLoading, error } = useLibrary();
  const [activeTab, setActiveTab] = useState<LibraryTab>("all");
  const [activeKind, setActiveKind] = useState<KindFilter>("all");
  const [needsSigninOnly, setNeedsSigninOnly] = useState(false);
  const [query, setQuery] = useState("");
  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.roles,
  );
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
  const needsSigninCount = useMemo(
    () => items.filter((item) => item.type === "connection" && item.state === "needs_signin").length,
    [items],
  );
  const visibleKindFilters = KIND_FILTERS.filter((filter) => (
    filter.value === "all" || kindCounts[filter.value] > 0
  ));
  const visibleItems = useMemo(
    () => items.filter((item) => {
      if (!matchesTab(item, activeTab)) return false;
      if (!matchesKind(item, activeKind)) return false;
      if (needsSigninOnly && (item.type !== "connection" || item.state !== "needs_signin")) return false;
      if (!normalizedQuery) return true;
      return item.name.toLowerCase().includes(normalizedQuery)
        || item.description?.toLowerCase().includes(normalizedQuery) === true;
    }),
    [activeKind, activeTab, items, needsSigninOnly, normalizedQuery],
  );
  const filtersActive = normalizedQuery.length > 0 || activeKind !== "all" || needsSigninOnly;

  return (
    <DashboardPageTemplate
      icon={LibraryBig}
      badgeLabel="Member library"
      title="Library"
      description="Everything you can use in chat — yours, shared with you, from your teams, and org-wide."
      descriptionPlacement="hero"
      colors={["#DBEAFE", "#1E3A8A", "#2563EB", "#A7F3D0"]}
      size="responsive"
    >
      <div className="mb-5 w-full max-w-[340px]">
        <DenInput
          type="search"
          icon={Search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search your library"
        />
      </div>
      <div className="mb-6 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <UnderlineTabs
          className="min-w-max [&>nav]:flex-nowrap"
          tabs={LIBRARY_TABS}
          activeTab={activeTab}
          onChange={setActiveTab}
        />
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-2" aria-label="Library filters">
        {visibleKindFilters.map((filter) => {
          const selected = activeKind === filter.value;
          return (
            <button
              key={filter.value}
              type="button"
              aria-pressed={selected}
              onClick={() => setActiveKind(filter.value)}
              className={`rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors ${selected
                ? "border-[#0f172a] bg-[#0f172a] text-white"
                : "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:text-gray-900"
              }`}
            >
              {kindFilterLabel(filter, kindCounts)}
            </button>
          );
        })}
        {needsSigninCount > 0 ? (
          <button
            type="button"
            aria-pressed={needsSigninOnly}
            onClick={() => setNeedsSigninOnly((active) => !active)}
            className={`rounded-full border bg-[#fffbeb] px-3 py-1.5 text-[12px] font-medium text-[#b45309] transition-colors ${needsSigninOnly
              ? "border-amber-400"
              : "border-amber-200 hover:border-amber-300"
            }`}
          >
            Needs sign-in · {needsSigninCount} <span aria-hidden>×</span>
          </button>
        ) : null}
      </div>

      {error ? (
        <DenNotice
          tone="error"
          message={error instanceof Error ? error.message : "Failed to load library."}
        />
      ) : isLoading ? (
        <div className="rounded-xl border border-gray-200 bg-white px-6 py-10 text-[14px] text-gray-500">
          Loading your library…
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 bg-white px-6 py-12 text-center">
          <p className="text-[15px] font-medium text-gray-900">
            {filtersActive ? "No library items match these filters." : EMPTY_TITLES[activeTab]}
          </p>
          <p className="mt-2 text-[13px] text-gray-500">
            {filtersActive ? "Try changing your search or filters." : "Everything you can use in chat will appear here."}
          </p>
        </div>
      ) : (
        <div data-library-list className="flex flex-col gap-3">
          {visibleItems.map((item) => (
            <LibraryRow key={`${item.type}-${item.id}`} item={item} isAdmin={access.isAdmin} orgSlug={orgSlug} />
          ))}
        </div>
      )}
    </DashboardPageTemplate>
  );
}
