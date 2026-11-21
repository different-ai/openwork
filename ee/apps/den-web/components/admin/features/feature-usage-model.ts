import { FEATURE_KEYS, isFeatureKey, type FeatureKey } from "@openwork/features";

export type FeatureUsageRange = "7d" | "30d";
export const FEATURE_USAGE_RANGES: ReadonlyArray<{ value: FeatureUsageRange; label: string }> = [{ value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }];

export type FeatureOutcomeUnit = "run" | "meeting" | "check" | "message";
export type FeatureHealthStatus = "not_used" | "in_use" | "healthy" | "failing" | "limited" | "mostly_skipped";
export type FeatureHealth = { status: FeatureHealthStatus; count: number | null };

export type FeatureOutcomeTotals = {
  runs: number;
  succeeded: number;
  failed: number;
  skipped: number;
  delivered: number | null;
  limited: number | null;
  lastRunAt: string | null;
};

export type FeatureOutcomeDay = { day: string; runs: number; failed: number };

export type FeatureOutcomes = FeatureOutcomeTotals & {
  unit: FeatureOutcomeUnit;
  days: FeatureOutcomeDay[];
  coverage: { from: string; counts: "all" | "failed" } | null;
};

export type FeatureUsageRow = {
  key: FeatureKey;
  organizationsOn: number;
  membersUsing: number;
  lastUsedAt: string | null;
  health: FeatureHealth;
  outcomes: FeatureOutcomes | null;
};

export type FeatureUsageReport = { range: FeatureUsageRange; organizations: number; features: FeatureUsageRow[]; generatedAt: string };

export type FeatureOutcomeReason = { reason: string; outcome: "failed" | "skipped"; count: number };

export type FeatureOrganizationRow = {
  organizationId: string;
  name: string;
  enabled: boolean;
  membersUsing: number;
  lastUsedAt: string | null;
  outcomes: FeatureOutcomeTotals | null;
};

export type FeatureUsageDetail = FeatureUsageRow & { reasons: FeatureOutcomeReason[]; byOrganization: FeatureOrganizationRow[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const optionalCount = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const optionalTime = (value: unknown) => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null);

const UNITS: readonly FeatureOutcomeUnit[] = ["run", "meeting", "check", "message"];
const STATUSES: readonly FeatureHealthStatus[] = ["not_used", "in_use", "healthy", "failing", "limited", "mostly_skipped"];

function parseTotals(value: unknown): FeatureOutcomeTotals | null {
  if (!isRecord(value)) return null;
  return {
    runs: count(value.runs),
    succeeded: count(value.succeeded),
    failed: count(value.failed),
    skipped: count(value.skipped),
    delivered: optionalCount(value.delivered),
    limited: optionalCount(value.limited),
    lastRunAt: optionalTime(value.lastRunAt),
  };
}

const COVERAGE_COUNTS: ReadonlyArray<"all" | "failed"> = ["all", "failed"];

function parseCoverage(value: unknown): FeatureOutcomes["coverage"] {
  if (!isRecord(value)) return null;
  const from = optionalTime(value.from);
  const counts = COVERAGE_COUNTS.find((entry) => entry === value.counts);
  return from && counts ? { from, counts } : null;
}

function parseOutcomes(value: unknown): FeatureOutcomes | null {
  const totals = parseTotals(value);
  if (!totals || !isRecord(value)) return null;
  const unit = UNITS.find((entry) => entry === value.unit) ?? "run";
  const days = Array.isArray(value.days)
    ? value.days.flatMap((day): FeatureOutcomeDay[] => isRecord(day) && typeof day.day === "string" ? [{ day: day.day, runs: count(day.runs), failed: count(day.failed) }] : [])
    : [];
  return { ...totals, unit, days, coverage: parseCoverage(value.coverage) };
}

function parseRow(value: unknown): FeatureUsageRow | null {
  if (!isRecord(value) || typeof value.key !== "string" || !isFeatureKey(value.key)) return null;
  const health = isRecord(value.health) ? value.health : {};
  return {
    key: value.key,
    organizationsOn: count(value.organizationsOn),
    membersUsing: count(value.membersUsing),
    lastUsedAt: optionalTime(value.lastUsedAt),
    health: { status: STATUSES.find((status) => status === health.status) ?? "not_used", count: optionalCount(health.count) },
    outcomes: parseOutcomes(value.outcomes),
  };
}

const rangeOf = (value: unknown): FeatureUsageRange => (value === "30d" ? "30d" : "7d");

export function parseFeatureUsageReport(payload: unknown): FeatureUsageReport | null {
  if (!isRecord(payload) || !Array.isArray(payload.features)) return null;
  return {
    range: rangeOf(payload.range),
    organizations: count(payload.organizations),
    features: payload.features.flatMap((entry) => parseRow(entry) ?? []),
    generatedAt: optionalTime(payload.generatedAt) ?? new Date().toISOString(),
  };
}

export function parseFeatureUsageDetail(payload: unknown): FeatureUsageDetail | null {
  if (!isRecord(payload)) return null;
  const row = parseRow(payload.feature);
  if (!row || !isRecord(payload.feature)) return null;
  const reasons = Array.isArray(payload.feature.reasons)
    ? payload.feature.reasons.flatMap((entry): FeatureOutcomeReason[] => isRecord(entry) && typeof entry.reason === "string" && (entry.outcome === "failed" || entry.outcome === "skipped")
      ? [{ reason: entry.reason, outcome: entry.outcome, count: count(entry.count) }]
      : [])
    : [];
  const byOrganization = Array.isArray(payload.feature.byOrganization)
    ? payload.feature.byOrganization.flatMap((entry): FeatureOrganizationRow[] => isRecord(entry) && typeof entry.organizationId === "string" && typeof entry.name === "string"
      ? [{
        organizationId: entry.organizationId,
        name: entry.name,
        enabled: entry.enabled === true,
        membersUsing: count(entry.membersUsing),
        lastUsedAt: optionalTime(entry.lastUsedAt),
        outcomes: parseTotals(entry.outcomes),
      }]
      : [])
    : [];
  return { ...row, reasons, byOrganization };
}

const NOUNS: Record<FeatureOutcomeUnit, [string, string]> = {
  run: ["run", "runs"],
  meeting: ["meeting", "meetings"],
  check: ["check", "checks"],
  message: ["message", "messages"],
};

export function unitCount(value: number, unit: FeatureOutcomeUnit): string {
  return `${value.toLocaleString("en-US")} ${NOUNS[unit][value === 1 ? 0 : 1]}`;
}

export function showsSkips(unit: FeatureOutcomeUnit): boolean {
  return unit !== "message";
}

export function unitHeading(unit: FeatureOutcomeUnit): string {
  const plural = NOUNS[unit][1];
  return `${plural.charAt(0).toUpperCase()}${plural.slice(1)}`;
}

export function healthLabel(health: FeatureHealth, unit: FeatureOutcomeUnit = "run"): string {
  switch (health.status) {
    case "healthy": return "Healthy";
    case "in_use": return "In use";
    case "not_used": return "Not used";
    case "failing": return `${(health.count ?? 0).toLocaleString("en-US")} failed`;
    case "limited": return `${(health.count ?? 0).toLocaleString("en-US")} hit the limit`;
    case "mostly_skipped": return `Most ${NOUNS[unit][1]} skipped`;
  }
}

export function healthTone(health: FeatureHealth): "failure" | "attention" | "neutral" | "quiet" {
  if (health.status === "failing") return "failure";
  if (health.status === "limited" || health.status === "mostly_skipped") return "attention";
  if (health.status === "not_used") return "quiet";
  return "neutral";
}

const REASONS: Record<string, string> = {
  execution_runtime_unavailable: "Turned off for the organization",
  model_access_lost: "Model no longer available",
  owner_membership_lost: "Owner left the organization",
  provider_unavailable: "Model provider unavailable",
  openwork_web_access_required: "Needs OpenWork Web",
  connect_access_unavailable: "Needs a connection",
  execution_failed: "Run failed",
  execution_timed_out: "Timed out",
  runner_unavailable: "No desktop online",
  lease_lost: "Interrupted",
  internal_error: "Internal error",
  cancelled: "Cancelled by the owner",
  previous_run_active: "Previous run still going",
  google_disconnected: "Google needs reconnecting",
  source_disconnected: "A source needs reconnecting",
  slack_app_not_installed: "OpenWork app not in Slack",
  member_not_linked: "Slack account not linked",
  no_destination: "Nowhere to send",
  send_failed: "Message not delivered",
  agent_unavailable: "Agent unavailable",
  slack_refused: "Slack refused the message",
  unknown: "No reason recorded",
};

export function reasonLabel(reason: string): string {
  const known = REASONS[reason];
  if (known) return known;
  const words = reason.replace(/[_-]+/g, " ").trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : REASONS.unknown ?? "No reason recorded";
}

const ATTENTION: readonly FeatureHealthStatus[] = ["failing", "limited", "mostly_skipped", "healthy", "in_use", "not_used"];

export function sortFeatureUsage(features: readonly FeatureUsageRow[]): FeatureUsageRow[] {
  const order = new Map(FEATURE_KEYS.map((key, index) => [key, index]));
  return [...features].sort((a, b) =>
    ATTENTION.indexOf(a.health.status) - ATTENTION.indexOf(b.health.status)
    || b.membersUsing - a.membersUsing
    || (b.outcomes?.runs ?? 0) - (a.outcomes?.runs ?? 0)
    || b.organizationsOn - a.organizationsOn
    || (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
}

export function lastActivity(row: { lastUsedAt: string | null; outcomes: { lastRunAt: string | null } | null }): string | null {
  const times = [row.lastUsedAt, row.outcomes?.lastRunAt ?? null].filter((value): value is string => value !== null);
  return times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

export function dayBars(days: readonly FeatureOutcomeDay[]): Array<FeatureOutcomeDay & { height: number; failedHeight: number }> {
  const most = Math.max(0, ...days.map((day) => day.runs));
  return days.map((day) => {
    const height = most === 0 || day.runs === 0 ? 0 : Math.max(0.12, day.runs / most);
    return { ...day, height, failedHeight: day.runs === 0 ? 0 : height * Math.min(1, day.failed / day.runs) };
  });
}

export function coverageLabel(coverage: FeatureOutcomes["coverage"], format: (iso: string) => string, now = Date.now()): string | null {
  if (!coverage) return null;
  if (coverage.counts === "failed") return `Failures since ${format(coverage.from)}`;
  return now - Date.parse(coverage.from) <= 25 * 3_600_000 ? "Last 24 hours only" : `Counts since ${format(coverage.from)}`;
}
