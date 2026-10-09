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
