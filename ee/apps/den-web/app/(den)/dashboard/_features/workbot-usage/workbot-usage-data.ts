import type { WorkbotUsageResponse, WorkbotUsageSurface } from "@openwork/types/den/workbot-usage";

/** Where Workbot ran, as the Workbot analytics view names it. */
export const WORKBOT_SURFACE_LABELS: Record<WorkbotUsageSurface, string> = {
  chat: "Chats",
  agent: "Members' agents",
  other: "Slack and automations",
};

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en-US");

/** US dollars from millionths. A real but tiny cost never reads as free. */
export function formatWorkbotCost(microUsd: number): string {
  if (microUsd <= 0) return usd.format(0);
  if (microUsd < 10_000) return "<$0.01";
  return usd.format(microUsd / 1_000_000);
}

export function formatWorkbotCount(value: number): string {
  return value < 10_000 ? whole.format(value) : compact.format(value);
}

export function workbotCostShare(part: number, total: number): string {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : "0%";
}

/** "Counting since Nov 3" while counting started inside the window; null once the window is fully covered. */
export function workbotCountingSince(report: Pick<WorkbotUsageResponse, "since" | "daily">): string | null {
  const first = report.daily[0]?.day;
  if (!report.since || !first || report.since <= first) return null;
  const date = new Date(`${report.since}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return `Counting since ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}`;
}

export function workbotMemberLabel(member: { name: string | null; email: string | null }): string {
  return member.name?.trim() || member.email || "Former member";
}
