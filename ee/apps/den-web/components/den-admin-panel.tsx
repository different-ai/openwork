"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Pencil } from "lucide-react";

type AccessState = "loading" | "ready" | "signed-out" | "forbidden" | "error";
type WorkerFilter = "all" | "with-workers" | "without-workers";
type BillingFilter = "all" | "paid" | "unpaid" | "unavailable";
type ViewMode = "users" | "companies" | "organizations";
type ActivityFilter = "all" | "active-7d" | "active-30d" | "recurring" | "inactive-30d";
type SortMode = "newest" | "recently-active" | "most-sign-ins" | "most-active-days" | "fastest-invite";

const DEFAULT_FREE_SEAT_COUNT = 5;

type AdminBillingStatus = {
  status: "paid" | "unpaid" | "unavailable";
  featureGateEnabled: boolean;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  source: "benefit" | "subscription" | "unavailable";
  note: string | null;
};

type AdminUserOrganization = {
  id: string;
  name: string;
  role: string;
  memberCount: number;
  joinedAt: string | null;
};

type AdminEntry = {
  email: string;
  note: string | null;
};

type ActivityPoint = {
  day: string;
  activeUsers: number;
  realActiveUsers: number;
  signups: number;
};

type AdminSummary = {
  totalUsers: number;
  verifiedUsers: number;
  recentUsers7d: number;
  recentUsers30d: number;
  totalWorkers: number;
  cloudWorkers: number;
  localWorkers: number;
  usersWithWorkers: number;
  usersWithoutWorkers: number;
  paidUsers: number | null;
  unpaidUsers: number | null;
  billingUnavailableUsers: number | null;
  adminCount: number;
  billingLoaded: boolean;
  activeUsers1d: number;
  activeUsers7d: number;
  activeUsers30d: number;
  realActiveUsers1d: number;
  realActiveUsers7d: number;
  realActiveUsers30d: number;
  recurringUsers: number;
  inviters: number;
  medianHoursToFirstInvite: number | null;
  activitySeries: ActivityPoint[];
};

type AdminUser = {
  id: string;
  name: string | null;
  email: string;
  emailVerified: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  lastSeenAt: string | null;
  sessionCount: number;
  activeDayCount: number;
  isRecurring: boolean;
  lastActiveAt: string | null;
  invitesSent: number;
  firstInviteAt: string | null;
  hoursToFirstInvite: number | null;
  authProviders: string[];
  workerCount: number;
  cloudWorkerCount: number;
  localWorkerCount: number;
  latestWorkerCreatedAt: string | null;
  billing: AdminBillingStatus | null;
  organizations: AdminUserOrganization[];
};

type AdminOrganization = {
  id: string;
  name: string;
  slug: string;
  createdAt: string | null;
  updatedAt: string | null;
  memberCount: number;
  plan: {
    tier: "free" | "team" | "enterprise";
    source: string;
  };
  seatLimit: number;
  freeSeatCount: number;
  seatsFreeAdditional: number;
  billableSeatCount: number;
};

type AdminPayload = {
  viewer: {
    id: string;
    email: string | null;
    name: string | null;
  };
  admins: AdminEntry[];
  summary: AdminSummary;
  users: AdminUser[];
  organizations: AdminOrganization[];
  generatedAt: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toNumberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toNullableNumberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseBillingStatus(value: unknown): AdminBillingStatus | null {
  if (!isRecord(value)) {
    return null;
  }

  const status = value.status === "paid" || value.status === "unpaid" || value.status === "unavailable"
    ? value.status
    : "unavailable";
  const source = value.source === "benefit" || value.source === "subscription" || value.source === "unavailable"
    ? value.source
    : "unavailable";

  return {
    status,
    featureGateEnabled: value.featureGateEnabled === true,
    subscriptionId: toStringValue(value.subscriptionId),
    subscriptionStatus: toStringValue(value.subscriptionStatus),
    currentPeriodEnd: toStringValue(value.currentPeriodEnd),
    source,
    note: toStringValue(value.note)
  };
}

function parseActivitySeries(value: unknown): ActivityPoint[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const points: ActivityPoint[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const day = toStringValue(entry.day);
    if (!day) {
      continue;
    }

    points.push({
      day,
      activeUsers: toNumberValue(entry.activeUsers),
      realActiveUsers: toNumberValue(entry.realActiveUsers),
      signups: toNumberValue(entry.signups)
    });
  }

  return points;
}

function parseAdminPayload(payload: unknown): AdminPayload | null {
  if (!isRecord(payload) || !isRecord(payload.summary) || !Array.isArray(payload.users) || !Array.isArray(payload.admins)) {
    return null;
  }

  const viewer = isRecord(payload.viewer) ? payload.viewer : {};
  const summary = payload.summary;

  const users: AdminUser[] = payload.users
    .map((value) => {
      if (!isRecord(value) || typeof value.id !== "string" || typeof value.email !== "string") {
        return null;
      }

      const authProviders = Array.isArray(value.authProviders)
        ? value.authProviders.filter((provider): provider is string => typeof provider === "string")
        : [];

      const organizations: AdminUserOrganization[] = Array.isArray(value.organizations)
        ? value.organizations
          .map((organization) => {
            if (!isRecord(organization) || typeof organization.id !== "string" || typeof organization.name !== "string" || typeof organization.role !== "string") {
              return null;
            }

            return {
              id: organization.id,
              name: organization.name,
              role: organization.role,
              memberCount: toNumberValue(organization.memberCount),
              joinedAt: toStringValue(organization.joinedAt)
            };
          })
          .filter((organization): organization is AdminUserOrganization => organization !== null)
        : [];

      return {
        id: value.id,
        name: toStringValue(value.name),
        email: value.email,
        emailVerified: value.emailVerified === true,
        createdAt: toStringValue(value.createdAt),
        updatedAt: toStringValue(value.updatedAt),
        lastSeenAt: toStringValue(value.lastSeenAt),
        sessionCount: toNumberValue(value.sessionCount),
        activeDayCount: toNumberValue(value.activeDayCount),
        isRecurring: value.isRecurring === true,
        lastActiveAt: toStringValue(value.lastActiveAt),
        invitesSent: toNumberValue(value.invitesSent),
        firstInviteAt: toStringValue(value.firstInviteAt),
        hoursToFirstInvite: toNullableNumberValue(value.hoursToFirstInvite),
        authProviders,
        workerCount: toNumberValue(value.workerCount),
        cloudWorkerCount: toNumberValue(value.cloudWorkerCount),
        localWorkerCount: toNumberValue(value.localWorkerCount),
        latestWorkerCreatedAt: toStringValue(value.latestWorkerCreatedAt),
        billing: parseBillingStatus(value.billing),
        organizations
      };
    })
    .filter((value): value is AdminUser => value !== null);

  const admins: AdminEntry[] = payload.admins
    .map((value) => {
      if (!isRecord(value) || typeof value.email !== "string") {
        return null;
      }

      return {
        email: value.email,
        note: toStringValue(value.note)
      };
    })
    .filter((value): value is AdminEntry => value !== null);

  const organizations: AdminOrganization[] = Array.isArray(payload.organizations)
    ? payload.organizations
      .map((value) => {
        if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.slug !== "string") {
          return null;
        }

        const plan = isRecord(value.plan) ? value.plan : {};
        const tier = plan.tier === "team" || plan.tier === "enterprise" ? plan.tier : "free";

        return {
          id: value.id,
          name: value.name,
          slug: value.slug,
          createdAt: toStringValue(value.createdAt),
          updatedAt: toStringValue(value.updatedAt),
          memberCount: toNumberValue(value.memberCount),
          plan: {
            tier,
            source: toStringValue(plan.source) ?? "default"
          },
          seatLimit: toNumberValue(value.seatLimit),
          freeSeatCount: toNumberValue(value.freeSeatCount) || DEFAULT_FREE_SEAT_COUNT,
          seatsFreeAdditional: toNumberValue(value.seatsFreeAdditional),
          billableSeatCount: toNumberValue(value.billableSeatCount)
        };
      })
      .filter((value): value is AdminOrganization => value !== null)
    : [];

  return {
    viewer: {
      id: typeof viewer.id === "string" ? viewer.id : "unknown",
      email: toStringValue(viewer.email),
      name: toStringValue(viewer.name)
    },
    admins,
    summary: {
      totalUsers: toNumberValue(summary.totalUsers),
      verifiedUsers: toNumberValue(summary.verifiedUsers),
      recentUsers7d: toNumberValue(summary.recentUsers7d),
      recentUsers30d: toNumberValue(summary.recentUsers30d),
      totalWorkers: toNumberValue(summary.totalWorkers),
      cloudWorkers: toNumberValue(summary.cloudWorkers),
      localWorkers: toNumberValue(summary.localWorkers),
      usersWithWorkers: toNumberValue(summary.usersWithWorkers),
      usersWithoutWorkers: toNumberValue(summary.usersWithoutWorkers),
      paidUsers: toNullableNumberValue(summary.paidUsers),
      unpaidUsers: toNullableNumberValue(summary.unpaidUsers),
      billingUnavailableUsers: toNullableNumberValue(summary.billingUnavailableUsers),
      adminCount: toNumberValue(summary.adminCount),
      billingLoaded: summary.billingLoaded === true,
      activeUsers1d: toNumberValue(summary.activeUsers1d),
      activeUsers7d: toNumberValue(summary.activeUsers7d),
      activeUsers30d: toNumberValue(summary.activeUsers30d),
      realActiveUsers1d: toNumberValue(summary.realActiveUsers1d),
      realActiveUsers7d: toNumberValue(summary.realActiveUsers7d),
      realActiveUsers30d: toNumberValue(summary.realActiveUsers30d),
      recurringUsers: toNumberValue(summary.recurringUsers),
      inviters: toNumberValue(summary.inviters),
      medianHoursToFirstInvite: toNullableNumberValue(summary.medianHoursToFirstInvite),
      activitySeries: parseActivitySeries(summary.activitySeries)
    },
    users,
    organizations,
    generatedAt: toStringValue(payload.generatedAt)
  };
}

function getFriendlyHtmlError(value: string): string | null {
  const normalized = value.replace(/\s+/g, " ").trim();
  const lower = normalized.toLowerCase();

  if (!lower) {
    return null;
  }

  if (lower.includes("cannot get /v1/admin/overview")) {
    return "The Den admin API is not live on the upstream service yet. The backend deploy likely failed or is still rolling out.";
  }

  if (lower.startsWith("<!doctype") || lower.startsWith("<html")) {
    return "The upstream Den service returned HTML instead of JSON. This usually means the admin backend route is stale or unavailable.";
  }

  return null;
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "string") {
    const friendly = getFriendlyHtmlError(payload);
    if (friendly) {
      return friendly;
    }

    if (payload.trim()) {
      return payload.trim();
    }
  }

  if (!isRecord(payload)) {
    return fallback;
  }

  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message.trim();
  }

  if (typeof payload.error === "string" && payload.error.trim()) {
    const friendly = getFriendlyHtmlError(payload.error);
    return friendly ?? payload.error.trim();
  }

  return fallback;
}

async function requestJson(path: string) {
  const response = await fetch(`/api/den${path}`, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "application/json"
    }
  });

  const text = await response.text();
  let payload: unknown = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  return { response, payload };
}

async function patchJson(path: string, body: unknown) {
  const response = await fetch(`/api/den${path}`, {
    method: "PATCH",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let payload: unknown = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  return { response, payload };
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function formatRelativeTime(value: string | null): string {
  if (!value) {
    return "No activity";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "No activity";
  }

  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.floor(diffMs / (60 * 1000));
  if (diffMinutes < 1) {
    return "Just now";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) {
    return `${diffDays}d ago`;
  }

  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) {
    return `${diffMonths}mo ago`;
  }

  return `${Math.floor(diffMonths / 12)}y ago`;
}

function isWithinDays(value: string | null, days: number): boolean {
  if (!value) {
    return false;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  return Date.now() - date.getTime() <= days * 24 * 60 * 60 * 1000;
}

function formatHours(hours: number | null): string {
  if (hours === null) {
    return "-";
  }

  if (hours < 1) {
    return "<1h";
  }

  if (hours < 48) {
    return `${Math.round(hours)}h`;
  }

  return `${Math.round(hours / 24)}d`;
}

function formatProvider(provider: string): string {
  return provider
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "aol.com",
  "qq.com",
  "163.com",
  "126.com",
  "mail.ru",
  "yandex.ru",
  "yandex.com",
  "hey.com",
  "fastmail.com",
  "zoho.com",
  "duck.com",
  "mail.com"
]);

function getEmailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  if (at === -1 || at === email.length - 1) {
    return "unknown";
  }

  return email.slice(at + 1).trim().toLowerCase();
}

type DomainGroup = {
  domain: string;
  users: AdminUser[];
  verifiedCount: number;
  workerCount: number;
  activeCount7d: number;
  latestSignupAt: string | null;
  isPersonal: boolean;
};

function buildDomainGroups(users: AdminUser[]): DomainGroup[] {
  const groups = new Map<string, DomainGroup>();

  for (const user of users) {
    const domain = getEmailDomain(user.email);
    const group = groups.get(domain) ?? {
      domain,
      users: [],
      verifiedCount: 0,
      workerCount: 0,
      activeCount7d: 0,
      latestSignupAt: null,
      isPersonal: PERSONAL_EMAIL_DOMAINS.has(domain)
    };

    group.users.push(user);
    if (user.emailVerified) {
      group.verifiedCount += 1;
    }
    if (isWithinDays(user.lastActiveAt, 7)) {
      group.activeCount7d += 1;
    }
    group.workerCount += user.workerCount;
    if (user.createdAt && (!group.latestSignupAt || user.createdAt > group.latestSignupAt)) {
      group.latestSignupAt = user.createdAt;
    }
    groups.set(domain, group);
  }

  return Array.from(groups.values()).sort((a, b) => {
    const aTime = a.latestSignupAt ?? "";
    const bTime = b.latestSignupAt ?? "";
    if (aTime !== bTime) {
      return aTime > bTime ? -1 : 1;
    }
    if (a.users.length !== b.users.length) {
      return b.users.length - a.users.length;
    }
    return a.domain.localeCompare(b.domain);
  });
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, `""`)}"` : value;
}

function downloadCsv(filename: string, rows: string[][]) {
  const content = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function formatBillingStatus(value: AdminBillingStatus | null): string {
  if (!value) {
    return "Not loaded";
  }

  if (value.status === "paid") {
    return "Paid";
  }

  if (value.status === "unpaid") {
    return "Unpaid";
  }

  return "Unavailable";
}

function formatSubscriptionStatus(value: string | null): string {
  if (!value) {
    return "No subscription record";
  }

  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function StatCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
      <p className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950">{value}</p>
      <p className="mt-1 text-sm leading-6 text-slate-500">{detail}</p>
    </div>
  );
}

function ActivityChart({ series }: { series: ActivityPoint[] }) {
  if (series.length === 0) {
    return null;
  }

  const maxActive = Math.max(1, ...series.map((point) => point.activeUsers));

  return (
    <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-slate-500">Active users · last 30 days</p>
        <p className="text-xs text-slate-500">
          <span className="mr-3 inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-slate-900/80" />Any activity</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-violet-500" />Real DAU (ran a task)</span>
        </p>
      </div>
      <div className="mt-3 flex h-16 items-end gap-[3px]">
        {series.map((point) => (
          <div
            key={point.day}
            title={`${point.day}: ${point.activeUsers} active · ${point.realActiveUsers} ran a task · ${point.signups} signup${point.signups === 1 ? "" : "s"}`}
            className="relative flex-1"
            style={{ height: "100%" }}
          >
            <div
              className={`absolute inset-x-0 bottom-0 rounded-t transition ${point.activeUsers > 0 ? "bg-slate-900/30 hover:bg-slate-900/45" : "bg-slate-200"}`}
              style={{ height: `${point.activeUsers > 0 ? Math.max(8, Math.round((point.activeUsers / maxActive) * 100)) : 4}%` }}
            />
            {point.realActiveUsers > 0 ? (
              <div
                className="absolute inset-x-0 bottom-0 rounded-t bg-violet-500"
                style={{ height: `${Math.max(8, Math.round((point.realActiveUsers / maxActive) * 100))}%` }}
              />
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[0.66rem] text-slate-400">
        <span>{series[0].day}</span>
        <span>{series[series.length - 1].day}</span>
      </div>
    </div>
  );
}

function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">{label}</p>
      <p className="mt-1 text-sm text-slate-700">{value}</p>
    </div>
  );
}

function BillingPill({ billing }: { billing: AdminBillingStatus | null }) {
  if (!billing) {
    return (
      <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-slate-500">
        Not loaded
      </span>
    );
  }

  const palette =
    billing.status === "paid"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : billing.status === "unpaid"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-slate-200 bg-slate-100 text-slate-600";

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.16em] ${palette}`}>
      {formatBillingStatus(billing)}
    </span>
  );
}

function PlanPill({ tier }: { tier: AdminOrganization["plan"]["tier"] }) {
  const palette = tier === "enterprise"
    ? "border-violet-200 bg-violet-50 text-violet-700"
    : tier === "team"
      ? "border-sky-200 bg-sky-50 text-sky-700"
      : "border-slate-200 bg-slate-100 text-slate-600";

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.16em] ${palette}`}>
      {tier}
    </span>
  );
}

export function DenAdminPanel() {
  const [accessState, setAccessState] = useState<AccessState>("loading");
  const [payload, setPayload] = useState<AdminPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("users");
  const [hidePersonalDomains, setHidePersonalDomains] = useState(true);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [workerFilter, setWorkerFilter] = useState<WorkerFilter>("all");
  const [billingFilter, setBillingFilter] = useState<BillingFilter>("all");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [copiedOrgId, setCopiedOrgId] = useState<string | null>(null);
  const [includeBilling, setIncludeBilling] = useState(false);
  const [orgDrafts, setOrgDrafts] = useState<Record<string, { tier: AdminOrganization["plan"]["tier"]; seatLimit: string }>>({});
  const [savingOrgId, setSavingOrgId] = useState<string | null>(null);
  const [freeSeatsDialog, setFreeSeatsDialog] = useState<{ org: AdminOrganization; totalFreeSeats: string } | null>(null);
  const [savingFreeSeatsOrgId, setSavingFreeSeatsOrgId] = useState<string | null>(null);

  const loadOverview = useCallback(async (loadBilling: boolean) => {
    setRefreshing(true);
    setError(null);

    try {
      const suffix = loadBilling ? "?includeBilling=1" : "";
      const { response, payload: nextPayload } = await requestJson(`/v1/admin/overview${suffix}`);

      if (response.status === 401) {
        setAccessState("signed-out");
        setPayload(null);
        return;
      }

      if (response.status === 403) {
        setAccessState("forbidden");
        setPayload(null);
        return;
      }

      if (!response.ok) {
        setAccessState("error");
        setPayload(null);
        setError(getErrorMessage(nextPayload, `Backoffice request failed with ${response.status}.`));
        return;
      }

      const parsed = parseAdminPayload(nextPayload);
      if (!parsed) {
        setAccessState("error");
        setPayload(null);
        setError("Backoffice payload was missing required fields.");
        return;
      }

      setIncludeBilling(parsed.summary.billingLoaded);
      setAccessState("ready");
      setPayload(parsed);
    } catch (nextError) {
      setAccessState("error");
      setPayload(null);
      setError(nextError instanceof Error ? nextError.message : "Unknown network error");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview(false);
  }, [loadOverview]);

  useEffect(() => {
    if (!copiedOrgId) {
      return;
    }

    const timeout = window.setTimeout(() => setCopiedOrgId(null), 1500);
    return () => window.clearTimeout(timeout);
  }, [copiedOrgId]);

  const copyOrgId = useCallback(async (orgId: string) => {
    try {
      await navigator.clipboard.writeText(orgId);
      setCopiedOrgId(orgId);
    } catch {
      setError("Could not copy the organization ID to the clipboard.");
    }
  }, []);

  const filteredUsers = useMemo(() => {
    if (!payload) {
      return [] as AdminUser[];
    }

    const normalizedQuery = query.trim().toLowerCase();
    const matches = payload.users.filter((user) => {
      if (workerFilter === "with-workers" && user.workerCount === 0) {
        return false;
      }

      if (workerFilter === "without-workers" && user.workerCount > 0) {
        return false;
      }

      if (activityFilter === "active-7d" && !isWithinDays(user.lastActiveAt, 7)) {
        return false;
      }

      if (activityFilter === "active-30d" && !isWithinDays(user.lastActiveAt, 30)) {
        return false;
      }

      if (activityFilter === "recurring" && !user.isRecurring) {
        return false;
      }

      if (activityFilter === "inactive-30d" && isWithinDays(user.lastActiveAt, 30)) {
        return false;
      }

      if (payload.summary.billingLoaded && billingFilter !== "all") {
        if (!user.billing || user.billing.status !== billingFilter) {
          return false;
        }
      }

      if (!normalizedQuery) {
        return true;
      }

      const haystack = [
        user.name ?? "",
        user.email,
        user.id,
        ...user.authProviders,
        ...user.organizations.flatMap((org) => [org.name, org.id, org.role])
      ].join(" ").toLowerCase();
      return haystack.includes(normalizedQuery);
    });

    if (sortMode === "newest") {
      return matches;
    }

    // Server timestamps are ISO 8601, so lexicographic order is chronological.
    return [...matches].sort((a, b) => {
      if (sortMode === "recently-active") {
        return (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? "");
      }

      if (sortMode === "most-sign-ins") {
        return b.sessionCount - a.sessionCount;
      }

      if (sortMode === "most-active-days") {
        return b.activeDayCount - a.activeDayCount;
      }

      const aHours = a.hoursToFirstInvite ?? Number.POSITIVE_INFINITY;
      const bHours = b.hoursToFirstInvite ?? Number.POSITIVE_INFINITY;
      return aHours - bHours;
    });
  }, [activityFilter, billingFilter, payload, query, sortMode, workerFilter]);

  const domainGroups = useMemo(() => {
    return payload ? buildDomainGroups(payload.users) : [];
  }, [payload]);

  const companyDomainCount = useMemo(() => {
    return domainGroups.filter((group) => !group.isPersonal).length;
  }, [domainGroups]);

  const filteredDomains = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return domainGroups.filter((group) => {
      if (hidePersonalDomains && group.isPersonal) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      if (group.domain.includes(normalizedQuery)) {
        return true;
      }

      return group.users.some((user) => `${user.name ?? ""} ${user.email}`.toLowerCase().includes(normalizedQuery));
    });
  }, [domainGroups, hidePersonalDomains, query]);

  const filteredOrganizations = useMemo(() => {
    if (!payload) {
      return [] as AdminOrganization[];
    }

    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return payload.organizations;
    }

    return payload.organizations.filter((org) => `${org.name} ${org.slug} ${org.id}`.toLowerCase().includes(normalizedQuery));
  }, [payload, query]);

  useEffect(() => {
    if (!payload) {
      setOrgDrafts({});
      return;
    }

    const drafts: Record<string, { tier: AdminOrganization["plan"]["tier"]; seatLimit: string }> = {};
    for (const org of payload.organizations) {
      drafts[org.id] = { tier: org.plan.tier, seatLimit: String(org.seatLimit) };
    }
    setOrgDrafts(drafts);
  }, [payload]);

  const saveOrganizationPlan = useCallback(async (org: AdminOrganization) => {
    const draft = orgDrafts[org.id];
    if (!draft) {
      return;
    }

    const seatLimit = Number(draft.seatLimit);
    if (!Number.isInteger(seatLimit) || seatLimit < 1) {
      setError("Seat limit must be a positive whole number.");
      return;
    }

    setSavingOrgId(org.id);
    setError(null);

    try {
      const { response, payload: nextPayload } = await patchJson(`/v1/admin/organizations/${org.id}/plan`, {
        tier: draft.tier,
        seatLimit
      });

      if (!response.ok) {
        setError(getErrorMessage(nextPayload, `Could not update ${org.name}.`));
        return;
      }

      await loadOverview(includeBilling);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unknown network error");
    } finally {
      setSavingOrgId(null);
    }
  }, [includeBilling, loadOverview, orgDrafts]);

  const saveOrganizationFreeSeats = useCallback(async () => {
    if (!freeSeatsDialog) {
      return;
    }

    const totalFreeSeats = Number(freeSeatsDialog.totalFreeSeats);
    if (!Number.isInteger(totalFreeSeats) || totalFreeSeats < DEFAULT_FREE_SEAT_COUNT) {
      setError(`Free seats must be a whole number at least ${DEFAULT_FREE_SEAT_COUNT}.`);
      return;
    }

    setSavingFreeSeatsOrgId(freeSeatsDialog.org.id);
    setError(null);

    try {
      const { response, payload: nextPayload } = await patchJson(`/v1/admin/organizations/${freeSeatsDialog.org.id}/free-seats`, {
        totalFreeSeats
      });

      if (!response.ok) {
        setError(getErrorMessage(nextPayload, `Could not update free seats for ${freeSeatsDialog.org.name}.`));
        return;
      }

      setFreeSeatsDialog(null);
      await loadOverview(includeBilling);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unknown network error");
    } finally {
      setSavingFreeSeatsOrgId(null);
    }
  }, [freeSeatsDialog, includeBilling, loadOverview]);

  const exportCsv = useCallback(() => {
    const date = new Date().toISOString().slice(0, 10);

    if (viewMode === "organizations") {
      downloadCsv(`den-organizations-${date}.csv`, [
        ["id", "name", "slug", "plan", "plan_source", "seat_limit", "free_seats", "additional_free_seats", "chargeable_seats", "members", "created_at"],
        ...filteredOrganizations.map((org) => [
          org.id,
          org.name,
          org.slug,
          org.plan.tier,
          org.plan.source,
          String(org.seatLimit),
          String(org.freeSeatCount),
          String(org.seatsFreeAdditional),
          String(org.billableSeatCount),
          String(org.memberCount),
          org.createdAt ?? ""
        ])
      ]);
      return;
    }

    if (viewMode === "companies") {
      downloadCsv(`den-companies-${date}.csv`, [
        ["domain", "users", "active_7d", "verified", "workers", "latest_signup", "personal", "emails"],
        ...filteredDomains.map((group) => [
          group.domain,
          String(group.users.length),
          String(group.activeCount7d),
          String(group.verifiedCount),
          String(group.workerCount),
          group.latestSignupAt ?? "",
          group.isPersonal ? "yes" : "no",
          group.users.map((user) => user.email).join("; ")
        ])
      ]);
      return;
    }

    downloadCsv(`den-users-${date}.csv`, [
      ["email", "name", "domain", "verified", "signed_up", "last_active", "sign_ins", "active_days", "recurring", "invites_sent", "hours_to_first_invite", "workers", "providers", "organizations"],
      ...filteredUsers.map((user) => [
        user.email,
        user.name ?? "",
        getEmailDomain(user.email),
        user.emailVerified ? "yes" : "no",
        user.createdAt ?? "",
        user.lastActiveAt ?? "",
        String(user.sessionCount),
        String(user.activeDayCount),
        user.isRecurring ? "yes" : "no",
        String(user.invitesSent),
        user.hoursToFirstInvite === null ? "" : String(user.hoursToFirstInvite),
        String(user.workerCount),
        user.authProviders.join("; "),
        user.organizations.map((org) => `${org.name} (${org.id}, ${org.role})`).join("; ")
      ])
    ]);
  }, [filteredDomains, filteredOrganizations, filteredUsers, viewMode]);

  useEffect(() => {
    if (!payload) {
      setSelectedUserId(null);
      return;
    }

    setSelectedUserId((current) => {
      if (current && filteredUsers.some((user) => user.id === current)) {
        return current;
      }

      return filteredUsers[0]?.id ?? null;
    });
  }, [filteredUsers, payload]);

  const selectedUser = useMemo(() => {
    return filteredUsers.find((user) => user.id === selectedUserId) ?? filteredUsers[0] ?? null;
  }, [filteredUsers, selectedUserId]);

  if (accessState === "loading") {
    return (
      <section className="mx-auto w-full max-w-6xl rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-sm text-slate-500">Loading Den admin...</p>
      </section>
    );
  }

  if (accessState === "signed-out" || accessState === "forbidden" || accessState === "error") {
    const title = accessState === "signed-out"
      ? "Sign in required"
      : accessState === "forbidden"
        ? "Admin access required"
        : "Backoffice unavailable";
    const message = accessState === "signed-out"
      ? "Use the main Den page to sign in, then return with a whitelisted admin account."
      : accessState === "forbidden"
        ? "Your session is valid, but the email on it is not present in the Den admin allowlist."
        : error ?? "The backoffice request failed before the dashboard could load.";

    return (
      <section className="mx-auto w-full max-w-4xl rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-slate-500">Den admin</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-slate-950">{title}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-600">{message}</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white"
          >
            Open sign-in page
          </a>
          <button
            type="button"
            onClick={() => {
              void loadOverview(includeBilling);
            }}
            className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700"
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  if (!payload) {
    return null;
  }

  const billingDetail = payload.summary.billingLoaded
    ? `${payload.summary.paidUsers ?? 0} paid / ${payload.summary.unpaidUsers ?? 0} unpaid`
    : "Load billing only when you need it";

  return (
    <section className="mx-auto w-full max-w-6xl rounded-3xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-6 py-6 sm:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-slate-500">Den admin</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-slate-950">User backoffice</h1>
            <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-600">
              Lightweight internal view for signups, worker creation, and on-demand billing checks.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-600">
              {payload.viewer.email ?? payload.viewer.id}
            </div>
            <button
              type="button"
              onClick={() => {
                void loadOverview(includeBilling);
              }}
              disabled={refreshing}
              className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <StatCard label="Users" value={String(payload.summary.totalUsers)} detail={`${payload.summary.recentUsers7d} new in 7d`} />
          <StatCard label="Active today" value={String(payload.summary.activeUsers1d)} detail={`${payload.summary.activeUsers7d} in 7d · ${payload.summary.activeUsers30d} in 30d`} />
          <StatCard label="Real DAU" value={String(payload.summary.realActiveUsers1d)} detail={`Ran a task · ${payload.summary.realActiveUsers7d} in 7d · ${payload.summary.realActiveUsers30d} in 30d`} />
          <StatCard label="Recurring" value={String(payload.summary.recurringUsers)} detail="Active on 2+ days" />
          <StatCard label="Inviters" value={String(payload.summary.inviters)} detail={`Median time to invite ${formatHours(payload.summary.medianHoursToFirstInvite)}`} />
          <StatCard label="Verified" value={String(payload.summary.verifiedUsers)} detail={`${payload.summary.totalUsers - payload.summary.verifiedUsers} still unverified`} />
          <StatCard label="Worker creators" value={String(payload.summary.usersWithWorkers)} detail={`${payload.summary.usersWithoutWorkers} without workers`} />
          <StatCard label="Workers" value={String(payload.summary.totalWorkers)} detail={`${payload.summary.cloudWorkers} cloud / ${payload.summary.localWorkers} local`} />
          <StatCard label="Billing" value={payload.summary.billingLoaded ? String(payload.summary.paidUsers ?? 0) : "On demand"} detail={billingDetail} />
          <StatCard label="Admins" value={String(payload.summary.adminCount)} detail="Whitelisted operator accounts" />
        </div>

        <ActivityChart series={payload.summary.activitySeries} />

        <div className="mt-5 flex flex-wrap gap-2">
          {payload.admins.map((admin) => (
            <span key={admin.email} className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700">
              {admin.email}
            </span>
          ))}
        </div>
      </div>

      <div className="px-6 py-6 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 p-1">
            <button
              type="button"
              onClick={() => setViewMode("users")}
              className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${viewMode === "users" ? "bg-slate-950 text-white" : "text-slate-600 hover:text-slate-900"}`}
            >
              Users ({payload.summary.totalUsers})
            </button>
            <button
              type="button"
              onClick={() => setViewMode("companies")}
              className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${viewMode === "companies" ? "bg-slate-950 text-white" : "text-slate-600 hover:text-slate-900"}`}
            >
              Companies ({companyDomainCount})
            </button>
            <button
              type="button"
              onClick={() => setViewMode("organizations")}
              className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${viewMode === "organizations" ? "bg-slate-950 text-white" : "text-slate-600 hover:text-slate-900"}`}
            >
              Organizations ({payload.organizations.length})
            </button>
          </div>

          <button
            type="button"
            onClick={exportCsv}
            disabled={viewMode === "organizations" ? filteredOrganizations.length === 0 : viewMode === "companies" ? filteredDomains.length === 0 : filteredUsers.length === 0}
            className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Export CSV
          </button>
        </div>

        {error ? (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
            {error}
          </div>
        ) : null}

        {viewMode === "organizations" ? (
          <div className="mt-4">
            <label className="grid w-full max-w-xl gap-2">
              <span className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">Search organizations</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Org name, slug, or id"
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
              />
            </label>
          </div>
        ) : viewMode === "companies" ? (
          <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <label className="grid w-full max-w-xl gap-2">
              <span className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">Search companies</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Domain, email, or name - try okta"
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
              />
            </label>

            <label className="flex items-center gap-2 pb-1 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={hidePersonalDomains}
                onChange={(event) => setHidePersonalDomains(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              Hide personal email domains
            </label>
          </div>
        ) : (
        <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_10.5rem_11.5rem_10.5rem_10.5rem]">
            <label className="grid gap-2">
              <span className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">Search users</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Email, name, user id, provider"
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
              />
            </label>

            <label className="grid gap-2">
              <span className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">Activity</span>
              <select
                value={activityFilter}
                onChange={(event) => setActivityFilter(event.target.value as ActivityFilter)}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
              >
                <option value="all">All users</option>
                <option value="active-7d">Active in 7d</option>
                <option value="active-30d">Active in 30d</option>
                <option value="recurring">Recurring</option>
                <option value="inactive-30d">Inactive 30d+</option>
              </select>
            </label>

            <label className="grid gap-2">
              <span className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">Sort</span>
              <select
                value={sortMode}
                onChange={(event) => setSortMode(event.target.value as SortMode)}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
              >
                <option value="newest">Newest signup</option>
                <option value="recently-active">Recently active</option>
                <option value="most-sign-ins">Most sign-ins</option>
                <option value="most-active-days">Most active days</option>
                <option value="fastest-invite">Fastest to invite</option>
              </select>
            </label>

            <label className="grid gap-2">
              <span className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">Workers</span>
              <select
                value={workerFilter}
                onChange={(event) => setWorkerFilter(event.target.value as WorkerFilter)}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
              >
                <option value="all">All users</option>
                <option value="with-workers">With workers</option>
                <option value="without-workers">Without workers</option>
              </select>
            </label>

            <label className="grid gap-2">
              <span className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">Billing</span>
              <select
                value={billingFilter}
                onChange={(event) => setBillingFilter(event.target.value as BillingFilter)}
                disabled={!payload.summary.billingLoaded}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
              >
                <option value="all">All users</option>
                <option value="paid">Paid</option>
                <option value="unpaid">Unpaid</option>
                <option value="unavailable">Unavailable</option>
              </select>
            </label>
          </div>

          {!payload.summary.billingLoaded ? (
            <button
              type="button"
              onClick={() => {
                void loadOverview(true);
              }}
              disabled={refreshing}
              className="inline-flex items-center justify-center rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              Load billing statuses
            </button>
          ) : (
            <p className="text-sm text-slate-500">Billing loaded for {payload.summary.totalUsers} users.</p>
          )}
        </div>
        )}

        <div className="mt-6 grid gap-3">
          {viewMode === "organizations" ? (
            filteredOrganizations.length > 0 ? filteredOrganizations.map((org) => {
              const draft = orgDrafts[org.id] ?? { tier: org.plan.tier, seatLimit: String(org.seatLimit) };
              const changed = draft.tier !== org.plan.tier || draft.seatLimit !== String(org.seatLimit);

              return (
                <div key={org.id} className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-base font-semibold text-slate-950">{org.name}</p>
                        <PlanPill tier={org.plan.tier} />
                      </div>
                      <p className="mt-1 truncate text-sm text-slate-500">/{org.slug} · {org.id}</p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-600">
                        {org.memberCount} / {org.seatLimit} seats
                      </span>
                      <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-emerald-700">
                        {org.freeSeatCount} free
                      </span>
                      <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-amber-700">
                        {org.billableSeatCount} chargeable
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <MetaCell label="Created" value={formatDateTime(org.createdAt)} />
                    <MetaCell label="Plan source" value={formatProvider(org.plan.source)} />
                    <MetaCell label="Members" value={String(org.memberCount)} />
                    <div>
                      <p className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">Free seats</p>
                      <div className="mt-1 flex items-center gap-2">
                        <p className="text-sm text-slate-700">{org.freeSeatCount}</p>
                        <button
                          type="button"
                          aria-label={`Edit free seats for ${org.name}`}
                          onClick={() => setFreeSeatsDialog({ org, totalFreeSeats: String(org.freeSeatCount) })}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 transition hover:border-slate-300 hover:text-slate-900"
                        >
                          <Pencil size={13} aria-hidden="true" />
                        </button>
                      </div>
                      <p className="mt-1 text-xs text-slate-400">
                        {org.seatsFreeAdditional > 0 ? `${org.seatsFreeAdditional} additional` : "Default included"}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 border-t border-slate-200 pt-4 lg:grid-cols-[12rem_10rem_auto] lg:items-end">
                    <label className="grid gap-2">
                      <span className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">Plan</span>
                      <select
                        value={draft.tier}
                        onChange={(event) => {
                          const tier = event.target.value === "enterprise" || event.target.value === "team" ? event.target.value : "free";
                          setOrgDrafts((current) => ({ ...current, [org.id]: { ...draft, tier } }));
                        }}
                        className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
                      >
                        <option value="free">Free</option>
                        <option value="team">Team</option>
                        <option value="enterprise">Enterprise</option>
                      </select>
                    </label>

                    <label className="grid gap-2">
                      <span className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">Seats</span>
                      <input
                        type="number"
                        min={1}
                        value={draft.seatLimit}
                        onChange={(event) => setOrgDrafts((current) => ({ ...current, [org.id]: { ...draft, seatLimit: event.target.value } }))}
                        className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
                      />
                    </label>

                    <button
                      type="button"
                      onClick={() => {
                        void saveOrganizationPlan(org);
                      }}
                      disabled={!changed || savingOrgId === org.id}
                      className="inline-flex items-center justify-center rounded-full bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {savingOrgId === org.id ? "Saving..." : "Save access"}
                    </button>
                  </div>
                </div>
              );
            }) : (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-5 py-10 text-center">
                <p className="text-base font-semibold text-slate-950">No organizations match</p>
                <p className="mt-2 text-sm leading-7 text-slate-500">Try a different search.</p>
              </div>
            )
          ) : viewMode === "companies" ? (
            filteredDomains.length > 0 ? filteredDomains.map((group) => (
              <div key={group.domain} className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-base font-semibold text-slate-950">{group.domain}</p>
                      {group.isPersonal ? (
                        <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[0.66rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
                          Personal
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 truncate text-sm text-slate-500">
                      {group.users.slice(0, 3).map((user) => user.email).join(", ")}
                      {group.users.length > 3 ? ` +${group.users.length - 3} more` : ""}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-600">
                      {group.users.length} {group.users.length === 1 ? "user" : "users"}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setQuery(`@${group.domain}`);
                        setViewMode("users");
                      }}
                      className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-slate-300"
                    >
                      View users
                    </button>
                  </div>
                </div>

                <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <MetaCell label="Latest signup" value={group.latestSignupAt ? `${formatRelativeTime(group.latestSignupAt)} · ${formatDateTime(group.latestSignupAt)}` : "-"} />
                  <MetaCell label="Active 7d" value={`${group.activeCount7d} of ${group.users.length}`} />
                  <MetaCell label="Verified" value={`${group.verifiedCount} of ${group.users.length}`} />
                  <MetaCell label="Workers" value={String(group.workerCount)} />
                </div>
              </div>
            )) : (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-5 py-10 text-center">
                <p className="text-base font-semibold text-slate-950">No company domains match</p>
                <p className="mt-2 text-sm leading-7 text-slate-500">Try a different search, or include personal email domains.</p>
              </div>
            )
          ) : filteredUsers.length > 0 ? filteredUsers.map((user) => {
            const isSelected = user.id === selectedUser?.id;

            return (
              <div
                key={user.id}
                className={`rounded-2xl border px-4 py-4 transition ${isSelected ? "border-slate-900 bg-slate-50" : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/70"}`}
              >
                <button type="button" onClick={() => setSelectedUserId(user.id)} className="block w-full text-left">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-base font-semibold text-slate-950">{user.name?.trim() || user.email}</p>
                        {user.emailVerified ? (
                          <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[0.66rem] font-semibold uppercase tracking-[0.14em] text-emerald-700">
                            Verified
                          </span>
                        ) : null}
                        {user.isRecurring ? (
                          <span className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[0.66rem] font-semibold uppercase tracking-[0.14em] text-sky-700">
                            Recurring
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 truncate text-sm text-slate-500">{user.email}</p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <BillingPill billing={user.billing} />
                      <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-600">
                        {user.workerCount} workers
                      </span>
                      <span className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-violet-700">
                        {user.organizations.length} {user.organizations.length === 1 ? "org" : "orgs"}
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
                    <MetaCell label="Signed up" value={formatDateTime(user.createdAt)} />
                    <MetaCell label="Last active" value={formatRelativeTime(user.lastActiveAt)} />
                    <MetaCell label="Sign-ins" value={String(user.sessionCount)} />
                    <MetaCell label="Active days" value={String(user.activeDayCount)} />
                    <MetaCell label="Invites" value={user.invitesSent > 0 ? `${user.invitesSent} · first after ${formatHours(user.hoursToFirstInvite)}` : "None"} />
                    <MetaCell label="Workers" value={`${user.cloudWorkerCount} cloud / ${user.localWorkerCount} local`} />
                  </div>
                </button>

                {isSelected ? (
                  <div className="mt-4 grid gap-4 border-t border-slate-200 pt-4 lg:grid-cols-2">
                    <div className="grid gap-4">
                      <MetaCell label="Auth providers" value={user.authProviders.length > 0 ? user.authProviders.map(formatProvider).join(", ") : "No provider records"} />
                      <MetaCell label="Latest worker" value={user.latestWorkerCreatedAt ? `${formatRelativeTime(user.latestWorkerCreatedAt)} · ${formatDateTime(user.latestWorkerCreatedAt)}` : "No workers created"} />
                    </div>

                    <div className="grid gap-4">
                      {user.billing ? (
                        <>
                          <MetaCell label="Subscription" value={formatSubscriptionStatus(user.billing.subscriptionStatus)} />
                          <MetaCell label="Billing note" value={user.billing.note ?? "No billing note returned."} />
                        </>
                      ) : (
                        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                          <p className="text-sm leading-7 text-slate-600">
                            Billing is intentionally loaded on demand to keep the admin page fast.
                          </p>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void loadOverview(true);
                            }}
                            disabled={refreshing}
                            className="mt-3 inline-flex items-center justify-center rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Load billing statuses
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4 lg:col-span-2">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">Organizations</p>
                          <p className="mt-1 text-sm text-slate-600">
                            {user.organizations.length > 0
                              ? `${user.email} is a member of ${user.organizations.length} organization${user.organizations.length === 1 ? "" : "s"}.`
                              : `${user.email} is not an active member of any organization.`}
                          </p>
                        </div>
                        {user.organizations.length > 0 ? (
                          <span className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-violet-700">
                            {user.organizations.length} total
                          </span>
                        ) : null}
                      </div>

                      {user.organizations.length > 0 ? (
                        <div className="mt-3 grid gap-2">
                          {user.organizations.map((org) => (
                            <div key={org.id} className="rounded-2xl border border-slate-200 bg-slate-50/70 px-3 py-3">
                              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-semibold text-slate-950">{org.name}</p>
                                  <p className="mt-1 truncate font-mono text-xs text-slate-500">{org.id}</p>
                                </div>

                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-600">
                                    {formatProvider(org.role)}
                                  </span>
                                  <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-600">
                                    {org.memberCount} {org.memberCount === 1 ? "member" : "members"}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      void copyOrgId(org.id);
                                    }}
                                    className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-slate-300"
                                  >
                                    <Copy size={13} aria-hidden="true" />
                                    {copiedOrgId === org.id ? "Copied" : "Copy ID"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setQuery(org.id);
                                      setViewMode("organizations");
                                    }}
                                    className="inline-flex items-center justify-center rounded-full bg-slate-950 px-3 py-1.5 text-xs font-semibold text-white"
                                  >
                                    View org
                                  </button>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          }) : (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-5 py-10 text-center">
              <p className="text-base font-semibold text-slate-950">No users match the current filters</p>
              <p className="mt-2 text-sm leading-7 text-slate-500">Try broadening search or relaxing the worker and billing filters.</p>
            </div>
          )}
        </div>

        <p className="mt-6 text-xs leading-6 text-slate-500">Snapshot generated {formatDateTime(payload.generatedAt)}.</p>
      </div>

      {freeSeatsDialog ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="free-seats-dialog-title"
          onClick={() => setFreeSeatsDialog(null)}
        >
          <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <p className="text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-slate-500">Organization billing</p>
            <h2 id="free-seats-dialog-title" className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950">
              Edit free seats
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Set the total number of free seats for {freeSeatsDialog.org.name}. The default {DEFAULT_FREE_SEAT_COUNT} seats stay included; OpenWork saves only the additional seats in organization metadata.
            </p>

            <label className="mt-5 grid gap-2">
              <span className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">Total free seats</span>
              <input
                type="number"
                min={DEFAULT_FREE_SEAT_COUNT}
                value={freeSeatsDialog.totalFreeSeats}
                onChange={(event) => setFreeSeatsDialog({ ...freeSeatsDialog, totalFreeSeats: event.target.value })}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
              />
            </label>

            <p className="mt-3 rounded-2xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500">
              Additional metadata value to save: {Math.max(0, Number(freeSeatsDialog.totalFreeSeats) - DEFAULT_FREE_SEAT_COUNT) || 0}
            </p>

            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <button
                type="button"
                onClick={() => setFreeSeatsDialog(null)}
                className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void saveOrganizationFreeSeats();
                }}
                disabled={savingFreeSeatsOrgId === freeSeatsDialog.org.id}
                className="inline-flex items-center justify-center rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {savingFreeSeatsOrgId === freeSeatsDialog.org.id ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
