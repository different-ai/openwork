import { z } from "zod";

export const libraryUsageKinds = ["plugins", "skills", "connectors"] as const;
export type LibraryUsageKind = (typeof libraryUsageKinds)[number];

export const libraryUsageWindows = [7, 30, 90] as const;
export type LibraryUsageWindow = (typeof libraryUsageWindows)[number];

const libraryUsageRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  detail: z.string().nullable(),
  pluginId: z.string().nullable(),
  uses: z.number().int().nonnegative(),
  people: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative().nullable(),
  lastUsedAt: z.string().nullable(),
});

export const libraryUsageReportSchema = z.object({
  kind: z.enum(["skills", "plugins", "connectors"]),
  days: z.number().int().positive(),
  trackingSince: z.string().nullable(),
  items: z.array(libraryUsageRowSchema),
});

export type LibraryUsageRow = z.infer<typeof libraryUsageRowSchema>;
export type LibraryUsageReport = z.infer<typeof libraryUsageReportSchema>;
export type LibraryUsageFilter = "all" | "unused" | "failing";

/** Words for each view, so every view reads the same way. */
export const libraryUsageCopy: Record<LibraryUsageKind, {
  label: string; noun: string; plural: string; emptyTitle: string; emptyBody: string; emptyAction: string;
}> = {
  plugins: {
    label: "Plugins", noun: "plugin", plural: "plugins",
    emptyTitle: "No plugins yet", emptyBody: "Create a plugin with skills or Workflows to see how your team uses it.", emptyAction: "Create a plugin",
  },
  skills: {
    label: "Skills", noun: "skill", plural: "skills",
    emptyTitle: "No skills yet", emptyBody: "Add a plugin with skills to see how often people use them.", emptyAction: "Create a plugin",
  },
  connectors: {
    label: "Connectors", noun: "connector", plural: "connectors",
    emptyTitle: "No connectors yet", emptyBody: "Add a connector to see which tools your team calls and which calls fail.", emptyAction: "Add a connector",
  },
};

export function libraryUsagePath(kind: LibraryUsageKind, days: LibraryUsageWindow) {
  return `/v1/library-usage/${kind}?days=${days}`;
}

export function parseLibraryUsageWindow(value: string | null): LibraryUsageWindow {
  return libraryUsageWindows.find((days) => String(days) === value) ?? 30;
}

export function parseLibraryUsageKind(value: string | null): LibraryUsageKind {
  return libraryUsageKinds.find((kind) => kind === value) ?? "plugins";
}

export function filterLibraryUsage(rows: readonly LibraryUsageRow[], filter: LibraryUsageFilter, name: string): LibraryUsageRow[] {
  const query = name.trim().toLowerCase();
  return rows.filter((row) =>
    (filter === "all" || (filter === "unused" ? row.uses === 0 : (row.failures ?? 0) > 0)) &&
    (!query || row.name.toLowerCase().includes(query) || (row.detail ?? "").toLowerCase().includes(query)));
}

export type LibraryUsageSummary = { total: number; used: number; unused: number; uses: number; failures: number | null };

export function summarizeLibraryUsage(rows: readonly LibraryUsageRow[]): LibraryUsageSummary {
  const tracksFailures = rows.some((row) => row.failures !== null);
  return {
    total: rows.length,
    used: rows.filter((row) => row.uses > 0).length,
    unused: rows.filter((row) => row.uses === 0).length,
    uses: rows.reduce((sum, row) => sum + row.uses, 0),
    failures: tracksFailures ? rows.reduce((sum, row) => sum + (row.failures ?? 0), 0) : null,
  };
}

/** Share of calls that failed, as a short word for the list: "2 of 9". */
export function failureLabel(row: Pick<LibraryUsageRow, "failures" | "uses">): string | null {
  if (row.failures === null) return null;
  if (row.failures === 0) return "0";
  return `${row.failures} of ${row.uses}`;
}

/**
 * Counting starts when the feature is turned on. While that is more recent
 * than the chosen window, "Not used" means "not since then", so the screen
 * names the start date instead of implying a full window.
 */
export function countingSinceLabel(report: Pick<LibraryUsageReport, "days" | "trackingSince">, now: number): string | null {
  if (!report.trackingSince) return null;
  const since = new Date(report.trackingSince).getTime();
  if (Number.isNaN(since) || since <= now - report.days * 86_400_000) return null;
  return `Counting since ${new Date(since).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

export function lastUsedLabel(lastUsedAt: string | null, now: number): string | null {
  if (!lastUsedAt) return null;
  const at = new Date(lastUsedAt).getTime();
  const days = Math.floor(Math.max(0, now - at) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Drill-down: one item's people and days, one person's items and days.
// ---------------------------------------------------------------------------

export const libraryUsageSources = ["agent", "workflow", "automation", "app", "artifact"] as const;
export type LibraryUsageSource = (typeof libraryUsageSources)[number];

const sourceCountsSchema = z.object({
  agent: z.number().int().nonnegative().optional(),
  workflow: z.number().int().nonnegative().optional(),
  automation: z.number().int().nonnegative().optional(),
  app: z.number().int().nonnegative().optional(),
  artifact: z.number().int().nonnegative().optional(),
});

const libraryUsageBreakdownRowSchema = z.object({
  itemId: z.string().nullable(),
  memberId: z.string().nullable(),
  date: z.string().nullable(),
  uses: z.number().int().nonnegative(),
  people: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative().nullable(),
  lastUsedAt: z.string().nullable(),
  sources: sourceCountsSchema,
});

export const libraryUsageBreakdownSchema = z.object({
  kind: z.enum(["skills", "plugins", "connectors"]),
  days: z.number().int().positive(),
  from: z.string(),
  to: z.string(),
  rows: z.array(libraryUsageBreakdownRowSchema),
});

export type LibraryUsageBreakdownRow = z.infer<typeof libraryUsageBreakdownRowSchema>;
export type LibraryUsageBreakdown = z.infer<typeof libraryUsageBreakdownSchema>;
export type LibraryUsageGrouping = "item" | "member" | "day";
export type LibraryUsageScope = { itemId: string } | { memberId: string };

export function libraryUsageBreakdownPath(kind: LibraryUsageKind, days: LibraryUsageWindow, groupBy: LibraryUsageGrouping, scope: LibraryUsageScope) {
  const params = new URLSearchParams({ kind, days: String(days), groupBy });
  if ("itemId" in scope) params.set("itemId", scope.itemId);
  else params.set("memberId", scope.memberId);
  return `/v1/library-usage?${params.toString()}`;
}

/** What started a use, in the words people see. */
export const libraryUsageSourceLabels: Record<LibraryUsageSource, string> = {
  agent: "Agents",
  workflow: "Workflows",
  automation: "Automations",
  app: "Artifacts",
  artifact: "Workflow artifacts",
};

/** Uses per source across rows, most used first, leaving out sources nobody used. */
export function sumLibraryUsageSources(rows: readonly Pick<LibraryUsageBreakdownRow, "sources">[]): { source: LibraryUsageSource; label: string; uses: number }[] {
  return libraryUsageSources
    .map((source) => ({ source, label: libraryUsageSourceLabels[source], uses: rows.reduce((sum, row) => sum + (row.sources[source] ?? 0), 0) }))
    .filter((entry) => entry.uses > 0)
    .sort((a, b) => b.uses - a.uses);
}

/** Every UTC day of the report, oldest first, with zero for days nobody used it. */
export function dailyLibraryUsage(report: Pick<LibraryUsageBreakdown, "from" | "to" | "rows">): { date: string; uses: number; failures: number }[] {
  const byDate = new Map(report.rows.flatMap((row) => row.date ? [[row.date, row] as const] : []));
  const days: { date: string; uses: number; failures: number }[] = [];
  const start = Date.parse(`${report.from}T00:00:00Z`);
  const end = Date.parse(`${report.to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return days;
  for (let at = start; at <= end && days.length < 366; at += 86_400_000) {
    const date = new Date(at).toISOString().slice(0, 10);
    const row = byDate.get(date);
    days.push({ date, uses: row?.uses ?? 0, failures: row?.failures ?? 0 });
  }
  return days;
}

/** A member's display name and email from the organization; removed members keep a neutral label. */
export function libraryUsageMember(members: readonly { id: string; user: { name: string; email: string } }[], memberId: string | null): { name: string; email: string | null } {
  const member = memberId ? members.find((entry) => entry.id === memberId) : undefined;
  if (!member) return { name: "Former member", email: null };
  return { name: member.user.name.trim() || member.user.email, email: member.user.email };
}

export function parseLibraryUsageFocus(params: { get(name: string): string | null }): { itemId: string } | { memberId: string } | null {
  const memberId = params.get("member")?.trim();
  if (memberId) return { memberId };
  const itemId = params.get("item")?.trim();
  if (itemId) return { itemId };
  return null;
}
