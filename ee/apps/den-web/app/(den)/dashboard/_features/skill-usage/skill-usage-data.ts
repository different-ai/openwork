import { z } from "zod";

export const skillUsageWindows = [7, 30, 90] as const;
export type SkillUsageWindow = (typeof skillUsageWindows)[number];

const skillUsageRowSchema = z.object({
  skillId: z.string(),
  skillName: z.string(),
  pluginId: z.string(),
  pluginName: z.string(),
  uses: z.number().int().nonnegative(),
  people: z.number().int().nonnegative(),
  lastUsedAt: z.string().nullable(),
});

export const skillUsageReportSchema = z.object({
  days: z.number().int().positive(),
  trackingSince: z.string().nullable(),
  skills: z.array(skillUsageRowSchema),
});

export type SkillUsageRow = z.infer<typeof skillUsageRowSchema>;
export type SkillUsageReport = z.infer<typeof skillUsageReportSchema>;
export type SkillUsageFilter = "all" | "unused";

export function skillUsagePath(days: SkillUsageWindow) {
  return `/v1/skill-usage?days=${days}`;
}

export function parseSkillUsageWindow(value: string | null): SkillUsageWindow {
  return skillUsageWindows.find((days) => String(days) === value) ?? 30;
}

export function filterSkillUsage(rows: readonly SkillUsageRow[], filter: SkillUsageFilter, name: string): SkillUsageRow[] {
  const query = name.trim().toLowerCase();
  return rows.filter((row) =>
    (filter === "all" || row.uses === 0) &&
    (!query || row.skillName.toLowerCase().includes(query) || row.pluginName.toLowerCase().includes(query)));
}

/**
 * Counting starts when the feature is turned on. While that is more recent
 * than the chosen window, "Not used" means "not since then", so the screen
 * names the start date instead of implying a full window.
 */
export function countingSinceLabel(report: Pick<SkillUsageReport, "days" | "trackingSince">, now: number): string | null {
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
