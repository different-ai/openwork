"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type AccessState = "loading" | "ready" | "signed-out" | "forbidden" | "error";
type WorkerFilter = "all" | "with-workers" | "without-workers";
type BillingFilter = "all" | "paid" | "unpaid" | "unavailable";

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
  billing: AdminBillingStatus | null;
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
        note: toStringValue(value.note)
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
      paidUsers: toNullableNumberValue(summary.paidUsers),
      unpaidUsers: toNullableNumberValue(summary.unpaidUsers),
      billingUnavailableUsers: toNullableNumberValue(summary.billingUnavailableUsers),
      adminCount: toNumberValue(summary.adminCount),
      billingLoaded: summary.billingLoaded === true
    },
    users,
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

function formatProvider(provider: string): string {
  return provider
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
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

export function DenAdminPanel() {
  const [accessState, setAccessState] = useState<AccessState>("loading");
  const [payload, setPayload] = useState<AdminPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [workerFilter, setWorkerFilter] = useState<WorkerFilter>("all");
  const [billingFilter, setBillingFilter] = useState<BillingFilter>("all");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [includeBilling, setIncludeBilling] = useState(false);

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

  const filteredUsers = useMemo(() => {
    if (!payload) {
      return [] as AdminUser[];
    }

    const normalizedQuery = query.trim().toLowerCase();
    return payload.users.filter((user) => {
      if (workerFilter === "with-workers" && user.workerCount === 0) {
        return false;
      }

      if (workerFilter === "without-workers" && user.workerCount > 0) {
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
          <StatCard label="Verified" value={String(payload.summary.verifiedUsers)} detail={`${payload.summary.totalUsers - payload.summary.verifiedUsers} still unverified`} />
          <StatCard label="Worker creators" value={String(payload.summary.usersWithWorkers)} detail={`${payload.summary.usersWithoutWorkers} without workers`} />
          <StatCard label="Workers" value={String(payload.summary.totalWorkers)} detail={`${payload.summary.cloudWorkers} cloud / ${payload.summary.localWorkers} local`} />
          <StatCard label="Billing" value={payload.summary.billingLoaded ? String(payload.summary.paidUsers ?? 0) : "On demand"} detail={billingDetail} />
          <StatCard label="Admins" value={String(payload.summary.adminCount)} detail="Whitelisted operator accounts" />
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {payload.admins.map((admin) => (
            <span key={admin.email} className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700">
              {admin.email}
            </span>
          ))}
        </div>
      </div>

      <div className="px-6 py-6 sm:px-8">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_13rem_13rem]">
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

        <div className="mt-6 grid gap-3">
          {filteredUsers.length > 0 ? filteredUsers.map((user) => {
            const isSelected = user.id === selectedUser?.id;

            return (
              <button
                key={user.id}
                type="button"
                onClick={() => setSelectedUserId(user.id)}
                className={`rounded-2xl border px-4 py-4 text-left transition ${isSelected ? "border-slate-900 bg-slate-50" : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/70"}`}
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-base font-semibold text-slate-950">{user.name?.trim() || user.email}</p>
                      {user.emailVerified ? (
                        <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[0.66rem] font-semibold uppercase tracking-[0.14em] text-emerald-700">
                          Verified
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
                  </div>
                </div>

                <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <MetaCell label="Signed up" value={formatDateTime(user.createdAt)} />
                  <MetaCell label="Last seen" value={user.lastSeenAt ? `${formatRelativeTime(user.lastSeenAt)} · ${formatDateTime(user.lastSeenAt)}` : "No sessions yet"} />
                  <MetaCell label="Sessions" value={String(user.sessionCount)} />
                  <MetaCell label="Workers" value={`${user.cloudWorkerCount} cloud / ${user.localWorkerCount} local`} />
                </div>

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
                  </div>
                ) : null}
              </button>
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
    </section>
  );
}
