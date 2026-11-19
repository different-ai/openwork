"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { requestAdmin, withStoredBearer, type AdminResult } from "../admin-request";
import { useAdminSessionCookie } from "../admin-shell";

/** Mirrors `AdminSecurityFinding` from `GET /v1/admin/security` and `/v1/admin/security/requests`. */
export type SecuritySeverity = "high" | "medium" | "low" | "clear";
export type SecurityCategory = "access" | "accounts" | "automation" | "credentials" | "usage";
export type SecurityTarget = { type: "user"; userId: string } | { type: "organization"; organizationId: string } | null;

export type SecurityEntity = {
  id: string;
  label: string;
  detail: string | null;
  value: number;
  severity: SecuritySeverity;
  target: SecurityTarget;
};

export type SecurityFinding = {
  id: string;
  category: SecurityCategory;
  severity: SecuritySeverity;
  title: string;
  summary: string;
  rule: string;
  why: string;
  review: string;
  value: number;
  unit: "count" | "micro_usd";
  entities: SecurityEntity[];
  entityCount: number;
};

export type SecurityReport = {
  generatedAt: string;
  range: { days: number; from: string; to: string };
  findings: SecurityFinding[];
};

export type SecurityRequests = {
  generatedAt: string;
  range: { hours: number; from: string; to: string };
  hourly: Array<{ hour: string; refused: number; rateLimited: number; failed: number; failedSignIns: number }>;
  endpoints: Array<{ action: string; refused: number; rateLimited: number; failed: number; peakHour: number; typicalHour: number }>;
  findings: SecurityFinding[];
};

export const SECURITY_RANGES = [7, 30] as const;
export type SecurityRange = (typeof SECURITY_RANGES)[number];

const SEVERITIES: readonly string[] = ["high", "medium", "low", "clear"];
const CATEGORIES: readonly string[] = ["access", "accounts", "automation", "credentials", "usage"];
const SEVERITY_RANK: Record<SecuritySeverity, number> = { high: 3, medium: 2, low: 1, clear: 0 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isText(value: unknown): value is string {
  return typeof value === "string";
}
function isTarget(value: unknown): value is SecurityTarget {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return (value.type === "user" && isText(value.userId)) || (value.type === "organization" && isText(value.organizationId));
}
function isEntity(value: unknown): value is SecurityEntity {
  return isRecord(value) && isText(value.id) && isText(value.label) && (value.detail === null || isText(value.detail))
    && isCount(value.value) && isText(value.severity) && SEVERITIES.includes(value.severity) && isTarget(value.target);
}
function isFinding(value: unknown): value is SecurityFinding {
  return isRecord(value) && ["id", "title", "summary", "rule", "why", "review"].every((key) => isText(value[key]))
    && isText(value.category) && CATEGORIES.includes(value.category)
    && isText(value.severity) && SEVERITIES.includes(value.severity)
    && isCount(value.value) && (value.unit === "count" || value.unit === "micro_usd")
    && Array.isArray(value.entities) && value.entities.every(isEntity) && isCount(value.entityCount);
}

/** Accepts only a complete report, so the page never renders half-understood findings. */
export function parseSecurityReport(payload: unknown): SecurityReport | null {
  if (!isRecord(payload) || !isText(payload.generatedAt) || !isRecord(payload.range) || !isCount(payload.range.days)) return null;
  if (!Array.isArray(payload.findings) || !payload.findings.every(isFinding)) return null;
  return { generatedAt: payload.generatedAt, range: { days: payload.range.days, from: String(payload.range.from), to: String(payload.range.to) }, findings: payload.findings };
}

export function parseSecurityRequests(payload: unknown): SecurityRequests | null {
  if (!isRecord(payload) || !isText(payload.generatedAt) || !isRecord(payload.range) || !isCount(payload.range.hours)) return null;
  if (!Array.isArray(payload.hourly) || !payload.hourly.every((row) => isRecord(row) && isText(row.hour)
    && ["refused", "rateLimited", "failed", "failedSignIns"].every((key) => isCount(row[key])))) return null;
  if (!Array.isArray(payload.endpoints) || !payload.endpoints.every((row) => isRecord(row) && isText(row.action)
    && ["refused", "rateLimited", "failed", "peakHour"].every((key) => isCount(row[key]))
    && typeof row.typicalHour === "number" && row.typicalHour >= 0)) return null;
  if (!Array.isArray(payload.findings) || !payload.findings.every(isFinding)) return null;
  return {
    generatedAt: payload.generatedAt,
    range: { hours: payload.range.hours, from: String(payload.range.from), to: String(payload.range.to) },
    hourly: payload.hourly,
    endpoints: payload.endpoints,
    findings: payload.findings,
  };
}

export function sortBySeverity(findings: readonly SecurityFinding[]): SecurityFinding[] {
  return [...findings].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.title.localeCompare(b.title));
}

export function severityCounts(findings: readonly SecurityFinding[]): Record<SecuritySeverity, number> {
  const counts: Record<SecuritySeverity, number> = { high: 0, medium: 0, low: 0, clear: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/** Where a reviewer goes next for an entity. User ids, never emails, go in the address. */
export function targetHref(target: SecurityTarget): string | null {
  if (!target) return null;
  if (target.type === "user") return `/admin/users?${new URLSearchParams({ search: target.userId })}`;
  return `/admin/organizations/${encodeURIComponent(target.organizationId)}`;
}

export type AdminLoadState<T> =
  | { status: "loading"; data: T | null }
  | { status: "ready"; data: T }
  | { status: Exclude<AdminResult<unknown>["access"], "ready">; message: string; data: T | null };

/** Loads an admin report; keeps the last one on screen while a new range or refresh loads. */
function useAdminReport<T>(path: string, parse: (payload: unknown) => T | null, nonce: number) {
  const hasSessionCookie = useAdminSessionCookie();
  const [state, setState] = useState<AdminLoadState<T>>(() => hasSessionCookie ? { status: "loading", data: null }
    : { status: "signed-out", message: "", data: null });
  const last = useRef<T | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (nonce === 0 && !hasSessionCookie && !withStoredBearer({}).Authorization) {
      last.current = null;
      setState({ status: "signed-out", message: "", data: null });
      return () => controller.abort();
    }
    setState({ status: "loading", data: last.current });
    requestAdmin(path, parse, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.access === "ready") { last.current = result.data; setState({ status: "ready", data: result.data }); }
        else {
          if (result.access !== "error") last.current = null;
          setState({ status: result.access, message: result.message, data: last.current });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: error instanceof Error ? error.message : "The request failed.", data: last.current });
      });
    return () => controller.abort();
  }, [path, parse, hasSessionCookie, nonce]);
  return state;
}

export function useSecurity(days: SecurityRange) {
  const [nonce, setNonce] = useState(0);
  const report = useAdminReport(`/v1/admin/security?days=${days}`, parseSecurityReport, nonce);
  const requests = useAdminReport("/v1/admin/security/requests", parseSecurityRequests, nonce);
  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  return { report, requests, refresh };
}
