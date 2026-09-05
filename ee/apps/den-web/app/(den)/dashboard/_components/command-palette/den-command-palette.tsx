"use client";

import { Command } from "cmdk";
import {
  Box,
  CalendarClock,
  FileText,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { buildDenFeedbackUrl } from "../../../_lib/feedback";
import {
  type DenOrgCapabilities,
  getAutomationsRoute,
  getOrgAccessFlags,
  getPluginRoute,
} from "../../../_lib/den-org";
import { useDenFlow } from "../../../_providers/den-flow-provider";
import {
  buildDashboardNavSections,
  flattenNavigationForSearch,
} from "../../_lib/dashboard-navigation";
import { paletteFilter } from "../../_lib/palette-filter";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { useAutomations } from "../automation-data";
import { usePlugins } from "../plugin-data";

const OPENWORK_DOCS_URL = "https://openworklabs.com/docs";
const RECENTS_STORAGE_KEY = "den.command-palette.recents";
const RECENTS_LIMIT = 8;

const EMPTY_CAPABILITIES: DenOrgCapabilities = {
  cloud: false,
  installLinks: false,
  mcpConnections: false,
  coworkerTeams: false,
  openworkWeb: false,
  orgManagedDashboards: false,
  workflows: false,
};

type PaletteEntry = {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  hint: string;
  keywords: string[];
};

type DenCommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function matchesQuery(entry: PaletteEntry, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const searchable = [entry.label, entry.hint, ...entry.keywords].join(" ").toLowerCase();
  return terms.every((term) => searchable.includes(term));
}

function visibleDataEntries(entries: PaletteEntry[], query: string): PaletteEntry[] {
  return entries.filter((entry) => matchesQuery(entry, query)).slice(0, 6);
}

function readRecentIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENTS_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string").slice(0, RECENTS_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function PaletteGroup({
  heading,
  entries,
  onSelect,
}: {
  heading: string;
  entries: PaletteEntry[];
  onSelect: (entry: PaletteEntry) => void;
}) {
  if (entries.length === 0) return null;

  return (
    <Command.Group
      heading={heading}
      className="pb-1 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.16em] [&_[cmdk-group-heading]]:text-gray-400"
    >
      {entries.map((entry) => (
        <Command.Item
          key={entry.id}
          value={`${heading}:${entry.id}`}
          keywords={[entry.label, ...entry.keywords, entry.hint]}
          onSelect={() => onSelect(entry)}
          className="flex cursor-default items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] tracking-[-0.1px] text-gray-700 outline-none data-[selected=true]:bg-gray-100 data-[selected=true]:text-gray-900"
        >
          <entry.icon className="h-4 w-4 shrink-0 text-gray-400" strokeWidth={1.8} />
          <span className="min-w-0 flex-1 truncate">{entry.label}</span>
          <span className="shrink-0 text-[11px] text-gray-400">{entry.hint}</span>
        </Command.Item>
      ))}
    </Command.Group>
  );
}

export function DenCommandPalette({ open, onOpenChange }: DenCommandPaletteProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { runtimeConfig, runtimeConfigLoaded } = useDenFlow();
  const { activeOrg, orgContext } = useOrgDashboard();
  const [query, setQuery] = useState("");
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.roles,
  );
  const capabilities = orgContext?.capabilities ?? EMPTY_CAPABILITIES;
  const pluginsQuery = usePlugins({ enabled: open && access.isAdmin });
  const automationsQuery = useAutomations({ enabled: open && capabilities.workflows });

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setRecentIds(readRecentIds());
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onOpenChange(false);
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onOpenChange]);

  const pageEntries = useMemo<PaletteEntry[]>(() => {
    const sections = buildDashboardNavSections({
      orgSlug: activeOrg?.slug ?? null,
      access,
      capabilities,
      orgMode: runtimeConfig.orgMode,
      runtimeConfigLoaded,
    });
    return flattenNavigationForSearch(sections)
      .filter((entry) => entry.href !== "#")
      .map((entry) => ({ ...entry, hint: entry.section }));
  }, [
    access.canViewSettings,
    access.isAdmin,
    activeOrg?.slug,
    capabilities,
    runtimeConfig.orgMode,
    runtimeConfigLoaded,
  ]);

  const pluginEntries = useMemo<PaletteEntry[]>(() => {
    if (!access.isAdmin || !activeOrg) return [];
    return (pluginsQuery.data ?? []).map((plugin) => ({
      id: `plugin:${plugin.id}`,
      label: plugin.name,
      href: getPluginRoute(activeOrg.slug, plugin.id),
      icon: Box,
      hint: "Plugin",
      keywords: [plugin.slug, plugin.description, "skill", "marketplace"],
    }));
  }, [access.isAdmin, activeOrg, pluginsQuery.data]);

  const automationEntries = useMemo<PaletteEntry[]>(() => {
    if (!activeOrg || !capabilities.workflows) return [];
    return (automationsQuery.data?.items ?? [])
      .filter((item) => item.automation.state !== "archived")
      .map((item) => ({
        id: `automation:${item.automation.id}`,
        label: item.automation.name,
        href: `${getAutomationsRoute(activeOrg.slug)}?automation=${encodeURIComponent(item.automation.id)}`,
        icon: CalendarClock,
        hint: "Automation",
        keywords: [item.automation.state, "schedule", "recurring"],
      }));
  }, [activeOrg, automationsQuery.data, capabilities.workflows]);

  const actionEntries = useMemo<PaletteEntry[]>(() => [
    {
      id: "action:docs",
      label: "Open docs",
      href: OPENWORK_DOCS_URL,
      icon: FileText,
      hint: "Action",
      keywords: ["documentation", "help"],
    },
    ...(runtimeConfigLoaded && runtimeConfig.orgMode === "multi_org"
      ? [{
          id: "action:feedback",
          label: "Send feedback",
          href: buildDenFeedbackUrl({ pathname, orgSlug: activeOrg?.slug }),
          icon: MessageSquare,
          hint: "Action",
          keywords: ["support", "report"],
        }]
      : []),
  ], [activeOrg?.slug, pathname, runtimeConfig.orgMode, runtimeConfigLoaded]);

  const allEntries = useMemo(
    () => [...pageEntries, ...pluginEntries, ...automationEntries, ...actionEntries],
    [actionEntries, automationEntries, pageEntries, pluginEntries],
  );
  const entriesById = useMemo(
    () => new Map(allEntries.map((entry) => [entry.id, entry])),
    [allEntries],
  );
  const recentEntries = query.trim() === ""
    ? recentIds.flatMap((id) => {
        const entry = entriesById.get(id);
        return entry ? [entry] : [];
      })
    : [];

  function selectEntry(entry: PaletteEntry) {
    const nextRecentIds = [entry.id, ...recentIds.filter((id) => id !== entry.id)].slice(0, RECENTS_LIMIT);
    setRecentIds(nextRecentIds);
    try {
      localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(nextRecentIds));
    } catch {
      // Navigation should still work when browser storage is unavailable.
    }
    onOpenChange(false);
    if (/^https?:\/\//.test(entry.href)) {
      window.open(entry.href, "_blank", "noopener,noreferrer");
      return;
    }
    router.push(entry.href);
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-gray-950/45 px-4 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search or jump to"
        data-testid="den-command-palette"
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-[0_24px_80px_-36px_rgba(15,23,42,0.7)]"
      >
        <Command label="Search or jump to" filter={paletteFilter} loop>
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Search or jump to…"
            data-testid="den-command-palette-input"
            className="h-12 w-full border-b border-gray-100 bg-transparent px-4 text-[14px] text-gray-900 outline-none placeholder:text-gray-400"
          />
          <Command.List className="max-h-[min(60vh,420px)] overflow-y-auto p-2">
            <Command.Empty className="px-3 py-10 text-center text-[13px] text-gray-400">
              No matches for “{query}”.
            </Command.Empty>
            <PaletteGroup heading="Recent" entries={recentEntries} onSelect={selectEntry} />
            <PaletteGroup heading="Pages" entries={pageEntries} onSelect={selectEntry} />
            <PaletteGroup
              heading="Plugins"
              entries={visibleDataEntries(pluginEntries, query)}
              onSelect={selectEntry}
            />
            <PaletteGroup
              heading="Automations"
              entries={visibleDataEntries(automationEntries, query)}
              onSelect={selectEntry}
            />
            <PaletteGroup heading="Actions" entries={actionEntries} onSelect={selectEntry} />
          </Command.List>
          <div className="border-t border-gray-100 px-4 py-2.5 text-[11px] text-gray-400">
            ↑↓ navigate · ↵ open · esc close
          </div>
        </Command>
      </div>
    </div>
  );
}
