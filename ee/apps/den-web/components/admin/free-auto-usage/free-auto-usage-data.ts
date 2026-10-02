"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { requestAdmin, type AdminResult } from "../admin-request";

/** Mirrors `GET /v1/admin/free-auto/usage`. Amounts are micro-USD; days are UTC. */
export type FreeAutoUsage = {
  costMicroUsd: number;
  requests: number;
  estimatedRequests: number;
  inputTokens: number;
  outputTokens: number;
};

export type FreeAutoOrganizationUsage = FreeAutoUsage & {
  id: string;
  name: string;
  slug: string | null;
  enrolled: boolean;
  subscribed: boolean;
  memberCount: number;
  activePeople: number;
  peopleAtWeeklyLimit: number;
  lastUsedAt: string | null;
};

export type FreeAutoUsageReport = {
  generatedAt: string;
  range: { days: number; from: string; to: string; timezone: "UTC" };
  settings: { membersEnabled: boolean; rolloutAllOrganizations: boolean; weeklyLimitMicroUsd: number };
  totals: FreeAutoUsage & { activePeople: number; activeOrganizations: number };
  members: FreeAutoUsage & { activePeople: number };
  guests: FreeAutoUsage;
  week: { startsAt: string; endsAt: string; activePeople: number; peopleAtWeeklyLimit: number };
  daily: Array<{ date: string; membersMicroUsd: number; guestsMicroUsd: number; requests: number }>;
  organizations: FreeAutoOrganizationUsage[];
  otherOrganizations: (FreeAutoUsage & { organizations: number }) | null;
};

export const FREE_AUTO_RANGES = [7, 30, 90] as const;
export type FreeAutoRange = (typeof FREE_AUTO_RANGES)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isUsage(value: unknown): value is FreeAutoUsage {
  return isRecord(value) && ["costMicroUsd", "requests", "estimatedRequests", "inputTokens", "outputTokens"].every((key) => isCount(value[key]));
}
function isOrganization(value: unknown): value is FreeAutoOrganizationUsage {
  if (!isRecord(value) || !isUsage(value)) return false;
  const row: Record<string, unknown> = value;
  return typeof row.id === "string" && typeof row.name === "string"
    && typeof row.enrolled === "boolean" && typeof row.subscribed === "boolean"
    && ["memberCount", "activePeople", "peopleAtWeeklyLimit"].every((key) => isCount(row[key]))
    && (row.lastUsedAt === null || typeof row.lastUsedAt === "string");
}

/** Accepts only a complete report, so the page never renders half-understood numbers. */
export function parseFreeAutoUsageReport(payload: unknown): FreeAutoUsageReport | null {
  if (!isRecord(payload) || !isRecord(payload.range) || !isRecord(payload.settings) || !isRecord(payload.week)) return null;
  if (!isUsage(payload.totals) || !isUsage(payload.members) || !isUsage(payload.guests)) return null;
  if (!Array.isArray(payload.daily) || !payload.daily.every((day) => isRecord(day) && typeof day.date === "string"
    && isCount(day.membersMicroUsd) && isCount(day.guestsMicroUsd) && isCount(day.requests))) return null;
  if (!Array.isArray(payload.organizations) || !payload.organizations.every(isOrganization)) return null;
  if (payload.otherOrganizations !== null && !isUsage(payload.otherOrganizations)) return null;
  return payload as FreeAutoUsageReport;
}

export type FreeAutoUsageState =
  | { status: "loading"; report: FreeAutoUsageReport | null }
  | { status: "ready"; report: FreeAutoUsageReport }
  | { status: Exclude<AdminResult<unknown>["access"], "ready">; message: string; report: FreeAutoUsageReport | null };

/** Loads the report for a range; keeps the last report on screen while a new range or refresh loads. */
export function useFreeAutoUsage(days: FreeAutoRange) {
  const [state, setState] = useState<FreeAutoUsageState>({ status: "loading", report: null });
  const [nonce, setNonce] = useState(0);
  const last = useRef<FreeAutoUsageReport | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading", report: last.current });
    requestAdmin(`/v1/admin/free-auto/usage?days=${days}`, parseFreeAutoUsageReport, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.access === "ready") { last.current = result.data; setState({ status: "ready", report: result.data }); }
        else setState({ status: result.access, message: result.message, report: last.current });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: error instanceof Error ? error.message : "The request failed.", report: last.current });
      });
    return () => controller.abort();
  }, [days, nonce]);
  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  return { state, refresh };
}

export type OrganizationSort = "spend" | "requests" | "people" | "limit" | "recent";

export function selectOrganizations(rows: readonly FreeAutoOrganizationUsage[], options: { search: string; sort: OrganizationSort; enrolledOnly: boolean }) {
  const needle = options.search.trim().toLowerCase();
  const filtered = rows.filter((row) => (!options.enrolledOnly || row.enrolled)
    && (!needle || row.name.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle) || (row.slug ?? "").toLowerCase().includes(needle)));
  const key: Record<OrganizationSort, (row: FreeAutoOrganizationUsage) => number> = {
    spend: (row) => row.costMicroUsd,
    requests: (row) => row.requests,
    people: (row) => row.activePeople,
    limit: (row) => row.peopleAtWeeklyLimit,
    recent: (row) => (row.lastUsedAt ? Date.parse(row.lastUsedAt) : 0),
  };
  return [...filtered].sort((a, b) => key[options.sort](b) - key[options.sort](a) || a.name.localeCompare(b.name));
}

function csvCell(value: string | number | boolean | null) {
  const text = value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One row per listed organization, amounts in USD, for spreadsheets. */
export function organizationsCsv(report: FreeAutoUsageReport): string {
  const header = ["organization_id", "name", "enrolled", "subscribed", "members", "active_people", "requests", "estimated_requests",
    "input_tokens", "output_tokens", "spend_usd", "people_at_weekly_limit", "last_used_at"];
  const rows = report.organizations.map((row) => [row.id, row.name, row.enrolled, row.subscribed, row.memberCount, row.activePeople, row.requests,
    row.estimatedRequests, row.inputTokens, row.outputTokens, (row.costMicroUsd / 1_000_000).toFixed(6), row.peopleAtWeeklyLimit, row.lastUsedAt]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}
