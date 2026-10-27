import {
  DESKTOP_STARTUP_STEPS,
  orgDiagnosticsSchema,
  type DesktopDiagnostics,
  type DesktopStartupStep,
  type DiagnosticsAttention,
  type DiagnosticsSectionId,
  type OrgDiagnostics,
  type ProviderCheck,
} from "@openwork/types/den/diagnostics";

export const DIAGNOSTICS_PATH = "/v1/org/diagnostics";
export const DIAGNOSTICS_CHECK_PATH = `${DIAGNOSTICS_PATH}/check`;
export const DIAGNOSTICS_POLL_MS = 2_000;
/** Stop polling a check that never finishes; the next Check now reads the latest result. */
export const DIAGNOSTICS_POLL_LIMIT_MS = 30_000;
const MAX_RETRY_AFTER_SECONDS = 3_600;

/** Strict parse: unknown fields, codes or shapes are rejected rather than rendered. */
export function parseOrgDiagnostics(payload: unknown): OrgDiagnostics | null {
  const parsed = orgDiagnosticsSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/** Bounded integer seconds only; HTTP dates and nonsense are ignored. */
export function retryAfterSeconds(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : undefined;
}

/** Any part of the report still waiting on a live check. */
export function isChecking(report: OrgDiagnostics): boolean {
  return report.checking
    || (report.providers.access === "granted" && report.providers.checking)
    || (report.installation.access === "operator" && report.installation.services.checking);
}

/** Poll while a check runs, until the polling window (at most 30 s from its start) closes. */
export function shouldPollDiagnostics(report: OrgDiagnostics | undefined, pollUntil: number | null, now: number): boolean {
  return Boolean(report && isChecking(report) && pollUntil !== null && now < pollUntil);
}

/** Errors first, then warnings; the server's order is kept within each severity. */
export function orderAttention(items: readonly DiagnosticsAttention[]): DiagnosticsAttention[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => severityRank(left.item) - severityRank(right.item) || left.index - right.index)
    .map(({ item }) => item);
}

function severityRank(item: DiagnosticsAttention): number {
  return item.severity === "error" ? 0 : 1;
}

export function attentionFor(report: OrgDiagnostics, section: DiagnosticsSectionId, targetId: string): DiagnosticsAttention | undefined {
  return orderAttention(report.attention).find((item) => item.section === section && item.targetId === targetId);
}

/** Newest live check across the sections the viewer can see. */
export function latestCheckedAt(report: OrgDiagnostics): string | null {
  const candidates = [
    report.providers.access === "granted" ? report.providers.checkedAt : null,
    report.connectors.access === "granted" ? report.connectors.checkedAt : null,
    report.installation.access === "operator" ? report.installation.services.checkedAt : null,
  ].filter((value): value is string => value !== null && Number.isFinite(Date.parse(value)));
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, value) => (Date.parse(value) > Date.parse(latest) ? value : latest));
}

export type OverallStatus =
  | { kind: "attention"; count: number; severity: "error" | "warning" }
  | { kind: "working" }
  | { kind: "not_checked" };

export function overallStatus(report: OrgDiagnostics): OverallStatus {
  if (report.attention.length > 0) {
    return { kind: "attention", count: report.attention.length, severity: report.attention.some((item) => item.severity === "error") ? "error" : "warning" };
  }
  const desktopReported = report.desktop.access === "granted" && report.desktop.startups > 0;
  return desktopReported || latestCheckedAt(report) ? { kind: "working" } : { kind: "not_checked" };
}

/** Stable DOM id for a row an attention item points at. */
export function diagnosticsRowId(section: DiagnosticsSectionId, targetId: string): string {
  return `diagnostics-${section}-${targetId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** The pretty JSON that "Copy report" puts on the clipboard. */
export function diagnosticsReportText(report: OrgDiagnostics): string {
  return JSON.stringify(report, null, 2);
}

// ── Desktop ────────────────────────────────────────────────────────────────

export type StepSegment = { step: DesktopStartupStep; typicalMs: number; percent: number };

/** Steps in launch order with their share of the typical launch; steps without timing are left out. */
export function desktopStepSegments(desktop: DesktopDiagnostics): StepSegment[] {
  const timed = DESKTOP_STARTUP_STEPS.flatMap((step) => {
    const typicalMs = desktop.steps.find((entry) => entry.step === step)?.typicalMs;
    return typeof typicalMs === "number" ? [{ step, typicalMs }] : [];
  });
  const total = timed.reduce((sum, segment) => sum + segment.typicalMs, 0);
  return timed.map((segment) => ({ ...segment, percent: total > 0 ? (segment.typicalMs / total) * 100 : 100 / timed.length }));
}

export type DesktopSummaryState = "no_data" | "healthy" | "some_failed" | "not_connecting";

export function desktopSummaryState(desktop: DesktopDiagnostics): DesktopSummaryState {
  if (desktop.startups === 0) return "no_data";
  if (desktop.failed === 0) return "healthy";
  return desktop.connected === 0 ? "not_connecting" : "some_failed";
}

// ── Providers ──────────────────────────────────────────────────────────────

/** Configured models the endpoint serves; null when the endpoint wasn't listed. */
export function providerAvailableModels(provider: ProviderCheck): number | null {
  if (provider.models.served === null) return null;
  return provider.models.configured > 0
    ? Math.max(0, provider.models.configured - provider.models.missing.length)
    : provider.models.served;
}

// ── Formatting ─────────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

function elapsedLabel(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** "just now", "2 min ago", "3 h ago", "2 days ago", then a date. Null for missing or invalid times. */
export function formatAgo(value: string | null, now: number): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const elapsed = Math.max(0, now - time);
  if (elapsed < 60_000) return "just now";
  if (elapsed < 7 * 24 * 60 * 60_000) return `${elapsedLabel(elapsed)} ago`;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(time));
}

/** "Up 3 h" from a server start time. */
export function formatUptime(startedAt: string, now: number): string | null {
  const time = Date.parse(startedAt);
  if (!Number.isFinite(time)) return null;
  return `Up ${elapsedLabel(Math.max(60_000, now - time))}`;
}
