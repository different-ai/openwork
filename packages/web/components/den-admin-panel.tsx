"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type AccessState = "loading" | "ready" | "signed-out" | "forbidden" | "error";
type BillingFilter = "all" | "paid" | "unpaid" | "unavailable";
type WorkerFilter = "all" | "with-workers" | "without-workers";

type AdminBillingStatus = {
  status: "paid" | "unpaid" | "unavailable";
  featureGateEnabled: boolean;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  source: "benefit" | "subscription" | "unavailable";
  note: string | null;
};

type AdminEntry = {
  email: string;
  note: string | null;
  createdAt: string | null;
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
  paidUsers: number;
  unpaidUsers: number;
  billingUnavailableUsers: number;
  adminCount: number;
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
  authProviders: string[];
  workerCount: number;
  cloudWorkerCount: number;
  localWorkerCount: number;
  latestWorkerCreatedAt: string | null;
  billing: AdminBillingStatus;
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
  generatedAt: string | null;
};

const DEFAULT_BILLING_STATUS: AdminBillingStatus = {
  status: "unavailable",
  featureGateEnabled: false,
  subscriptionId: null,
  subscriptionStatus: null,
  currentPeriodEnd: null,
  source: "unavailable",
  note: "Billing lookup unavailable."
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

function parseBillingStatus(value: unknown): AdminBillingStatus {
  if (!isRecord(value)) {
    return DEFAULT_BILLING_STATUS;
  }

  const status = value.status === "paid" || value.status === "unpaid" || value.status === "unavailable"
    ? value.status
    : DEFAULT_BILLING_STATUS.status;
  const source = value.source === "benefit" || value.source === "subscription" || value.source === "unavailable"
    ? value.source
    : DEFAULT_BILLING_STATUS.source;

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

      return {
        id: value.id,
        name: toStringValue(value.name),
        email: value.email,
        emailVerified: value.emailVerified === true,
        createdAt: toStringValue(value.createdAt),
        updatedAt: toStringValue(value.updatedAt),
        lastSeenAt: toStringValue(value.lastSeenAt),
        sessionCount: toNumberValue(value.sessionCount),
        authProviders,
        workerCount: toNumberValue(value.workerCount),
        cloudWorkerCount: toNumberValue(value.cloudWorkerCount),
        localWorkerCount: toNumberValue(value.localWorkerCount),
        latestWorkerCreatedAt: toStringValue(value.latestWorkerCreatedAt),
        billing: parseBillingStatus(value.billing)
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
        note: toStringValue(value.note),
        createdAt: toStringValue(value.createdAt)
      };
    })
    .filter((value): value is AdminEntry => value !== null);

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
      paidUsers: toNumberValue(summary.paidUsers),
      unpaidUsers: toNumberValue(summary.unpaidUsers),
      billingUnavailableUsers: toNumberValue(summary.billingUnavailableUsers),
      adminCount: toNumberValue(summary.adminCount)
    },
    users,
    generatedAt: toStringValue(payload.generatedAt)
  };
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }

  if (!isRecord(payload)) {
    return fallback;
  }

  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message.trim();
  }

  if (typeof payload.error === "string" && payload.error.trim()) {
    return payload.error.trim();
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

function formatDateTime(value: string | null): string {
  if (!value) {
    return "Not available";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Not available";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function formatRelativeTime(value: string | null): string {
  if (!value) {
    return "No recent activity";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "No recent activity";
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

  const diffYears = Math.floor(diffMonths / 12);
  return `${diffYears}y ago`;
}

function formatProvider(provider: string): string {
  return provider
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
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

function StatusBadge({ status }: { status: AdminBillingStatus["status"] }) {
  const palette =
    status === "paid"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : status === "unpaid"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-slate-200 bg-slate-100 text-slate-600";
  const label = status === "paid" ? "Paid" : status === "unpaid" ? "Unpaid" : "Unavailable";

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.18em] ${palette}`}>
      {label}
    </span>
  );
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-[1.3rem] border border-slate-200/80 bg-white/85 p-4 shadow-[0_8px_30px_rgba(15,23,42,0.05)]">
      <p className="text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className="mt-2 font-mono text-[1.7rem] font-semibold tracking-[-0.04em] text-slate-900">{value}</p>
      <p className="mt-2 text-sm leading-6 text-slate-500">{detail}</p>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 rounded-xl border border-slate-200/80 bg-slate-50/90 px-3 py-2.5">
      <p className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="text-sm font-medium text-slate-800">{value}</p>
    </div>
  );
}

export function DenAdminPanel() {
  const [accessState, setAccessState] = useState<AccessState>("loading");
  const [payload, setPayload] = useState<AdminPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [billingFilter, setBillingFilter] = useState<BillingFilter>("all");
  const [workerFilter, setWorkerFilter] = useState<WorkerFilter>("all");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setRefreshing(true);
    setError(null);

    try {
      const { response, payload: nextPayload } = await requestJson("/v1/admin/overview");

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
    void loadOverview();
  }, [loadOverview]);

  const filteredUsers = useMemo(() => {
    if (!payload) {
      return [] as AdminUser[];
    }

    const normalizedQuery = query.trim().toLowerCase();
    return payload.users.filter((user) => {
      if (billingFilter !== "all" && user.billing.status !== billingFilter) {
        return false;
      }

      if (workerFilter === "with-workers" && user.workerCount === 0) {
        return false;
      }

      if (workerFilter === "without-workers" && user.workerCount > 0) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      const haystack = [user.name ?? "", user.email, user.id, ...user.authProviders].join(" ").toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [billingFilter, payload, query, workerFilter]);

  useEffect(() => {
    if (!payload) {
      setSelectedUserId(null);
      return;
    }

    setSelectedUserId((current) => {
      if (current && filteredUsers.some((user) => user.id === current)) {
        return current;
      }

      return filteredUsers[0]?.id ?? payload.users[0]?.id ?? null;
    });
  }, [filteredUsers, payload]);

  const selectedUser = useMemo(() => {
    if (!payload) {
      return null;
    }

    return payload.users.find((user) => user.id === selectedUserId) ?? filteredUsers[0] ?? null;
  }, [filteredUsers, payload, selectedUserId]);

  if (accessState === "loading") {
    return (
      <section className="relative z-10 w-full max-w-[92rem] rounded-[2rem] border border-slate-200/80 bg-white/80 p-10 shadow-[0_20px_80px_rgba(15,23,42,0.10)] backdrop-blur-xl">
        <div className="grid gap-3">
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.24em] text-slate-500">Internal tool</p>
          <h1 className="font-mono text-[2rem] font-semibold tracking-[-0.05em] text-slate-900">Loading Den backoffice...</h1>
          <p className="max-w-2xl text-sm leading-7 text-slate-500">Checking your session, loading the admin allowlist, and compiling the latest signup, worker, and billing snapshot.</p>
        </div>
      </section>
    );
  }

  if (accessState === "signed-out" || accessState === "forbidden" || accessState === "error") {
    const title = accessState === "signed-out"
      ? "Sign in first"
      : accessState === "forbidden"
        ? "Admin access required"
        : "Backoffice unavailable";
    const message = accessState === "signed-out"
      ? "Use the main Den page to sign in, then come back here with a whitelisted admin account."
      : accessState === "forbidden"
        ? "Your current session is valid, but the email on it is not present in the Den admin allowlist."
        : error ?? "The backoffice request failed before the dashboard could load.";

    return (
      <section className="relative z-10 w-full max-w-[56rem] rounded-[2rem] border border-slate-200/80 bg-white/85 p-8 shadow-[0_20px_80px_rgba(15,23,42,0.10)] backdrop-blur-xl">
        <div className="grid gap-4">
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.24em] text-slate-500">Internal tool</p>
          <h1 className="font-mono text-[2rem] font-semibold tracking-[-0.05em] text-slate-900">{title}</h1>
          <p className="max-w-2xl text-sm leading-7 text-slate-500">{message}</p>
          <div className="flex flex-wrap gap-3 pt-2">
            <a
              href="/"
              className="inline-flex items-center justify-center rounded-full border border-[#1B29FF]/20 bg-[#1B29FF] px-4 py-2 text-sm font-semibold text-white shadow-[0_12px_28px_rgba(27,41,255,0.22)]"
            >
              Open sign-in page
            </a>
            <button
              type="button"
              onClick={() => {
                void loadOverview();
              }}
              className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700"
            >
              Retry
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (!payload) {
    return null;
  }

  const metrics = [
    {
      label: "Users",
      value: String(payload.summary.totalUsers),
      detail: `${payload.summary.recentUsers7d} new in the last 7 days`
    },
    {
      label: "Verified",
      value: String(payload.summary.verifiedUsers),
      detail: `${payload.summary.totalUsers - payload.summary.verifiedUsers} still unverified`
    },
    {
      label: "Worker creators",
      value: String(payload.summary.usersWithWorkers),
      detail: `${payload.summary.usersWithoutWorkers} users have not created a worker yet`
    },
    {
      label: "Workers",
      value: String(payload.summary.totalWorkers),
      detail: `${payload.summary.cloudWorkers} cloud / ${payload.summary.localWorkers} local`
    },
    {
      label: "Paid",
      value: String(payload.summary.paidUsers),
      detail: `${payload.summary.unpaidUsers} unpaid, ${payload.summary.billingUnavailableUsers} unavailable`
    },
    {
      label: "Admins",
      value: String(payload.summary.adminCount),
      detail: `Seeded allowlist currently grants ${payload.summary.adminCount} internal operators access`
    }
  ];

  return (
    <section className="relative z-10 w-full max-w-[92rem] rounded-[2rem] border border-slate-200/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(248,250,252,0.96))] shadow-[0_20px_80px_rgba(15,23,42,0.10)] backdrop-blur-xl">
      <div className="border-b border-slate-200/80 px-6 py-6 sm:px-8">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="grid gap-3">
            <p className="text-[0.7rem] font-semibold uppercase tracking-[0.24em] text-slate-500">Internal tool</p>
            <div className="grid gap-2">
              <h1 className="font-mono text-[2rem] font-semibold tracking-[-0.06em] text-slate-950 sm:text-[2.4rem]">Den backoffice</h1>
              <p className="max-w-3xl text-sm leading-7 text-slate-500 sm:text-[0.96rem]">
                Audit signups, operator access, worker creation, and billing coverage from a single internal surface.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600">
              Viewing as <span className="font-semibold text-slate-900">{payload.viewer.email ?? payload.viewer.id}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                void loadOverview();
              }}
              className="inline-flex items-center justify-center rounded-full border border-[#1B29FF]/20 bg-[#1B29FF] px-4 py-2 text-sm font-semibold text-white shadow-[0_12px_28px_rgba(27,41,255,0.22)] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={refreshing}
            >
              {refreshing ? "Refreshing..." : "Refresh snapshot"}
            </button>
          </div>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
          {metrics.map((metric) => (
            <MetricCard key={metric.label} label={metric.label} value={metric.value} detail={metric.detail} />
          ))}
        </div>
      </div>

      <div className="grid gap-6 px-6 py-6 sm:px-8 xl:grid-cols-[23rem_minmax(0,1fr)] xl:items-start">
        <div className="grid gap-4 xl:sticky xl:top-6">
          <section className="rounded-[1.5rem] border border-slate-200/80 bg-white/90 p-5 shadow-[0_10px_34px_rgba(15,23,42,0.05)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-slate-500">Selected user</p>
                <h2 className="mt-2 text-lg font-semibold tracking-[-0.03em] text-slate-950">
                  {selectedUser?.name?.trim() || selectedUser?.email || "No user selected"}
                </h2>
                <p className="mt-1 text-sm text-slate-500">{selectedUser?.email ?? "Adjust filters to select a user."}</p>
              </div>

              {selectedUser ? <StatusBadge status={selectedUser.billing.status} /> : null}
            </div>

            {selectedUser ? (
              <div className="mt-5 grid gap-3">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                  <DetailRow label="Signed up" value={formatDateTime(selectedUser.createdAt)} />
                  <DetailRow label="Last seen" value={selectedUser.lastSeenAt ? `${formatDateTime(selectedUser.lastSeenAt)} (${formatRelativeTime(selectedUser.lastSeenAt)})` : "No sessions yet"} />
                  <DetailRow label="Sessions" value={String(selectedUser.sessionCount)} />
                  <DetailRow label="Email status" value={selectedUser.emailVerified ? "Verified" : "Not verified"} />
                </div>

                <div className="rounded-[1.2rem] border border-slate-200/80 bg-slate-50/90 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-slate-500">Worker footprint</p>
                    <p className="text-sm font-semibold text-slate-900">{selectedUser.workerCount} total</p>
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-3">
                    <DetailRow label="Cloud" value={String(selectedUser.cloudWorkerCount)} />
                    <DetailRow label="Local" value={String(selectedUser.localWorkerCount)} />
                    <DetailRow label="Latest" value={selectedUser.latestWorkerCreatedAt ? formatRelativeTime(selectedUser.latestWorkerCreatedAt) : "Never"} />
                  </div>
                </div>

                <div className="rounded-[1.2rem] border border-slate-200/80 bg-slate-50/90 p-4">
                  <p className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-slate-500">Billing signal</p>
                  <div className="mt-3 grid gap-3">
                    <DetailRow label="Status" value={selectedUser.billing.status === "paid" ? "Paid" : selectedUser.billing.status === "unpaid" ? "Unpaid" : "Unavailable"} />
                    <DetailRow label="Subscription" value={formatSubscriptionStatus(selectedUser.billing.subscriptionStatus)} />
                    <DetailRow label="Current period end" value={formatDateTime(selectedUser.billing.currentPeriodEnd)} />
                    <DetailRow label="Signal source" value={selectedUser.billing.source === "benefit" ? "Benefit lookup" : selectedUser.billing.source === "subscription" ? "Subscription lookup" : "Unavailable"} />
                    <p className="rounded-xl border border-slate-200/80 bg-white px-3 py-3 text-sm leading-6 text-slate-600">
                      {selectedUser.billing.note ?? "No billing note returned."}
                    </p>
                  </div>
                </div>

                <div className="rounded-[1.2rem] border border-slate-200/80 bg-slate-50/90 p-4">
                  <p className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-slate-500">Auth providers</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {selectedUser.authProviders.length > 0 ? selectedUser.authProviders.map((provider) => (
                      <span key={provider} className="inline-flex items-center rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700">
                        {formatProvider(provider)}
                      </span>
                    )) : (
                      <span className="text-sm text-slate-500">No provider records yet.</span>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <p className="mt-4 text-sm leading-7 text-slate-500">No users match the current filters.</p>
            )}
          </section>

          <section className="rounded-[1.5rem] border border-slate-200/80 bg-white/90 p-5 shadow-[0_10px_34px_rgba(15,23,42,0.05)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-slate-500">Admin allowlist</p>
                <h2 className="mt-2 text-lg font-semibold tracking-[-0.03em] text-slate-950">Seeded internal operators</h2>
              </div>
              <div className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-600">
                {payload.admins.length}
              </div>
            </div>

            <div className="mt-4 grid gap-3">
              {payload.admins.map((admin) => (
                <div key={admin.email} className="rounded-[1.1rem] border border-slate-200/80 bg-slate-50/80 px-3 py-3">
                  <p className="font-medium text-slate-900">{admin.email}</p>
                  <p className="mt-1 text-sm text-slate-500">{admin.note ?? "Seeded admin entry"}</p>
                </div>
              ))}
            </div>

            <p className="mt-4 text-xs leading-6 text-slate-500">
              Snapshot generated {formatDateTime(payload.generatedAt)}.
            </p>
          </section>
        </div>

        <section className="rounded-[1.5rem] border border-slate-200/80 bg-white/90 p-5 shadow-[0_10px_34px_rgba(15,23,42,0.05)]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-slate-500">User explorer</p>
              <h2 className="mt-2 text-lg font-semibold tracking-[-0.03em] text-slate-950">Inspect every signup and segment by worker or payment status</h2>
            </div>
            <div className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-600">
              {filteredUsers.length} of {payload.users.length} shown
            </div>
          </div>

          <div className="mt-5 grid gap-3 lg:grid-cols-[minmax(0,1fr)_10rem_12rem]">
            <label className="grid gap-2">
              <span className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-slate-500">Search</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by email, name, id, or provider"
                className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[#1B29FF] focus:ring-4 focus:ring-[#1B29FF]/10"
              />
            </label>

            <label className="grid gap-2">
              <span className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-slate-500">Billing</span>
              <select
                value={billingFilter}
                onChange={(event) => setBillingFilter(event.target.value as BillingFilter)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[#1B29FF] focus:ring-4 focus:ring-[#1B29FF]/10"
              >
                <option value="all">All</option>
                <option value="paid">Paid</option>
                <option value="unpaid">Unpaid</option>
                <option value="unavailable">Unavailable</option>
              </select>
            </label>

            <label className="grid gap-2">
              <span className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-slate-500">Workers</span>
              <select
                value={workerFilter}
                onChange={(event) => setWorkerFilter(event.target.value as WorkerFilter)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[#1B29FF] focus:ring-4 focus:ring-[#1B29FF]/10"
              >
                <option value="all">All users</option>
                <option value="with-workers">With workers</option>
                <option value="without-workers">Without workers</option>
              </select>
            </label>
          </div>

          <div className="mt-5 grid gap-3">
            {filteredUsers.length > 0 ? filteredUsers.map((user) => {
              const isSelected = user.id === selectedUser?.id;
              return (
                <button
                  key={user.id}
                  type="button"
                  onClick={() => setSelectedUserId(user.id)}
                  className={`rounded-[1.25rem] border p-4 text-left transition ${isSelected ? "border-[#1B29FF]/30 bg-[#1B29FF]/[0.04] shadow-[0_12px_34px_rgba(27,41,255,0.10)]" : "border-slate-200/80 bg-slate-50/50 hover:border-slate-300 hover:bg-white"}`}
                >
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-base font-semibold tracking-[-0.02em] text-slate-950">{user.name?.trim() || user.email}</p>
                        {user.emailVerified ? (
                          <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[0.66rem] font-semibold uppercase tracking-[0.16em] text-emerald-700">
                            Verified
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 truncate text-sm text-slate-500">{user.email}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {user.authProviders.length > 0 ? user.authProviders.map((provider) => (
                          <span key={`${user.id}-${provider}`} className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[0.68rem] font-semibold text-slate-600">
                            {formatProvider(provider)}
                          </span>
                        )) : (
                          <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[0.68rem] font-semibold text-slate-500">
                            No providers recorded
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                      <StatusBadge status={user.billing.status} />
                      <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-slate-600">
                        {user.workerCount} workers
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <DetailRow label="Signed up" value={formatDateTime(user.createdAt)} />
                    <DetailRow label="Last seen" value={user.lastSeenAt ? formatRelativeTime(user.lastSeenAt) : "No sessions yet"} />
                    <DetailRow label="Sessions" value={String(user.sessionCount)} />
                    <DetailRow label="Billing detail" value={formatSubscriptionStatus(user.billing.subscriptionStatus)} />
                  </div>
                </button>
              );
            }) : (
              <div className="rounded-[1.25rem] border border-dashed border-slate-300 bg-slate-50/70 px-5 py-10 text-center">
                <p className="text-base font-semibold text-slate-900">No users match the current filters</p>
                <p className="mt-2 text-sm leading-7 text-slate-500">Try clearing search terms or broadening the billing and worker filters.</p>
              </div>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
