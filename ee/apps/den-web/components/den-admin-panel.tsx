"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Pencil, Trash2 } from "lucide-react";

type AccessState = "loading" | "ready" | "signed-out" | "forbidden" | "error";
type ViewMode = "users" | "companies" | "organizations";

const DEFAULT_FREE_SEAT_COUNT = 5;
const ADMIN_OVERVIEW_CACHE_KEY = "den-admin-overview-cache";
const ADMIN_PAGE_SIZE = 50;
const ADMIN_MAX_PAGE_OFFSET = 100_000;
const ADMIN_SCALE_FIXTURE_USERS = 50_000;
const ADMIN_SCALE_FIXTURE_ORGANIZATIONS = 60_000;
const ADMIN_SEARCH_DEBOUNCE_MS = 75;

let cachedAdminOverviewPayload: unknown = null;

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
  totalOrganizations: number;
  verifiedUsers: number | null;
  recentUsers7d: number | null;
  recentUsers30d: number | null;
  totalWorkers: number | null;
  cloudWorkers: number | null;
  localWorkers: number | null;
  usersWithWorkers: number | null;
  usersWithoutWorkers: number | null;
  paidUsers: number | null;
  unpaidUsers: number | null;
  billingUnavailableUsers: number | null;
  adminCount: number;
  billingLoaded: boolean;
  activeUsers1d: number | null;
  activeUsers7d: number | null;
  activeUsers30d: number | null;
  realActiveUsers1d: number | null;
  realActiveUsers7d: number | null;
  realActiveUsers30d: number | null;
  recurringUsers: number | null;
  inviters: number | null;
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

type AdminOrganizationCapabilities = {
  installLinks: boolean;
  mcpConnections: boolean;
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
  capabilities: AdminOrganizationCapabilities;
};

type AdminPageInfo = {
  total: number;
  limit: number;
  offset: number;
  returned: number;
  hasMore: boolean;
  search: string;
  durationMs: number;
};

type AdminUsersPayload = {
  users: AdminUser[];
  page: AdminPageInfo;
  billing: {
    loaded: boolean;
    paidUsers: number | null;
    unpaidUsers: number | null;
    billingUnavailableUsers: number | null;
  };
  generatedAt: string | null;
};

type AdminOrganizationsPayload = {
  organizations: AdminOrganization[];
  page: AdminPageInfo;
  generatedAt: string | null;
};

type AdminMetricsPayload = {
  summary: AdminSummary;
  generatedAt: string | null;
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
  userPage: AdminPageInfo;
  organizationPage: AdminPageInfo;
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

function parseAdminPageInfo(value: unknown, total: number, returned: number): AdminPageInfo {
  if (!isRecord(value)) {
    return { total, limit: returned, offset: 0, returned, hasMore: false, search: "", durationMs: 0 };
  }

  return {
    total: toNumberValue(value.total),
    limit: toNumberValue(value.limit),
    offset: toNumberValue(value.offset),
    returned: toNumberValue(value.returned),
    hasMore: value.hasMore === true,
    search: toStringValue(value.search) ?? "",
    durationMs: toNumberValue(value.durationMs)
  };
}

function parseAdminSummary(summary: Record<string, unknown>, organizationFallback: number): AdminSummary {
  return {
    totalUsers: toNumberValue(summary.totalUsers),
    totalOrganizations: toNumberValue(summary.totalOrganizations) || organizationFallback,
    verifiedUsers: toNullableNumberValue(summary.verifiedUsers),
    recentUsers7d: toNullableNumberValue(summary.recentUsers7d),
    recentUsers30d: toNullableNumberValue(summary.recentUsers30d),
    totalWorkers: toNullableNumberValue(summary.totalWorkers),
    cloudWorkers: toNullableNumberValue(summary.cloudWorkers),
    localWorkers: toNullableNumberValue(summary.localWorkers),
    usersWithWorkers: toNullableNumberValue(summary.usersWithWorkers),
    usersWithoutWorkers: toNullableNumberValue(summary.usersWithoutWorkers),
    paidUsers: toNullableNumberValue(summary.paidUsers),
    unpaidUsers: toNullableNumberValue(summary.unpaidUsers),
    billingUnavailableUsers: toNullableNumberValue(summary.billingUnavailableUsers),
    adminCount: toNumberValue(summary.adminCount),
    billingLoaded: summary.billingLoaded === true,
    activeUsers1d: toNullableNumberValue(summary.activeUsers1d),
    activeUsers7d: toNullableNumberValue(summary.activeUsers7d),
    activeUsers30d: toNullableNumberValue(summary.activeUsers30d),
    realActiveUsers1d: toNullableNumberValue(summary.realActiveUsers1d),
    realActiveUsers7d: toNullableNumberValue(summary.realActiveUsers7d),
    realActiveUsers30d: toNullableNumberValue(summary.realActiveUsers30d),
    recurringUsers: toNullableNumberValue(summary.recurringUsers),
    inviters: toNullableNumberValue(summary.inviters),
    medianHoursToFirstInvite: toNullableNumberValue(summary.medianHoursToFirstInvite),
    activitySeries: parseActivitySeries(summary.activitySeries)
  };
}

function parseAdminPayload(payload: unknown): AdminPayload | null {
  if (!isRecord(payload) || !isRecord(payload.summary) || !isRecord(payload.userPage) || !isRecord(payload.organizationPage) || !Array.isArray(payload.users) || !Array.isArray(payload.admins)) {
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
        const capabilities = isRecord(value.capabilities) ? value.capabilities : {};

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
          billableSeatCount: toNumberValue(value.billableSeatCount),
          capabilities: {
            installLinks: capabilities.installLinks === true,
            mcpConnections: capabilities.mcpConnections === true
          }
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
    summary: parseAdminSummary(summary, organizations.length),
    users,
    organizations,
    userPage: parseAdminPageInfo(payload.userPage, toNumberValue(summary.totalUsers), users.length),
    organizationPage: parseAdminPageInfo(payload.organizationPage, toNumberValue(summary.totalOrganizations), organizations.length),
    generatedAt: toStringValue(payload.generatedAt)
  };
}

function parseAdminUsersPayload(payload: unknown): AdminUsersPayload | null {
  if (!isRecord(payload) || !Array.isArray(payload.users)) {
    return null;
  }

  const parsed = parseAdminPayload({
    viewer: {},
    admins: [],
    summary: {},
    users: payload.users,
    organizations: [],
    userPage: payload.page,
    organizationPage: {},
    generatedAt: payload.generatedAt
  });
  if (!parsed) {
    return null;
  }

  const billing = isRecord(payload.billing) ? payload.billing : {};
  return {
    users: parsed.users,
    page: parseAdminPageInfo(payload.page, parsed.users.length, parsed.users.length),
    billing: {
      loaded: billing.loaded === true,
      paidUsers: toNullableNumberValue(billing.paidUsers),
      unpaidUsers: toNullableNumberValue(billing.unpaidUsers),
      billingUnavailableUsers: toNullableNumberValue(billing.billingUnavailableUsers)
    },
    generatedAt: toStringValue(payload.generatedAt)
  };
}

function parseAdminOrganizationsPayload(payload: unknown): AdminOrganizationsPayload | null {
  if (!isRecord(payload) || !Array.isArray(payload.organizations)) {
    return null;
  }

  const parsed = parseAdminPayload({
    viewer: {},
    admins: [],
    summary: {},
    users: [],
    organizations: payload.organizations,
    userPage: {},
    organizationPage: payload.page,
    generatedAt: payload.generatedAt
  });
  if (!parsed) {
    return null;
  }

  return {
    organizations: parsed.organizations,
    page: parseAdminPageInfo(payload.page, parsed.organizations.length, parsed.organizations.length),
    generatedAt: toStringValue(payload.generatedAt)
  };
}

function parseAdminMetricsPayload(payload: unknown): AdminMetricsPayload | null {
  if (!isRecord(payload) || !isRecord(payload.summary)) {
    return null;
  }

  return {
    summary: parseAdminSummary(payload.summary, 0),
    generatedAt: toStringValue(payload.generatedAt)
  };
}

function clearPersistedAdminOverviewCache() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(ADMIN_OVERVIEW_CACHE_KEY);
  } catch {
    // Ignore storage failures: the cache is only a best-effort fast path.
  }
}

function clearAdminOverviewCache() {
  cachedAdminOverviewPayload = null;
  clearPersistedAdminOverviewCache();
}

function storeAdminOverviewCache(payload: unknown) {
  cachedAdminOverviewPayload = payload;

  if (typeof window === "undefined") {
    return;
  }

  try {
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) {
      window.sessionStorage.removeItem(ADMIN_OVERVIEW_CACHE_KEY);
      return;
    }

    window.sessionStorage.setItem(ADMIN_OVERVIEW_CACHE_KEY, serialized);
  } catch {
    clearPersistedAdminOverviewCache();
  }
}

function readAdminOverviewCache(): AdminPayload | null {
  if (shouldClearAdminCacheFromUrl()) {
    clearAdminOverviewCache();
    return null;
  }

  const parsedCachedPayload = parseAdminPayload(cachedAdminOverviewPayload);
  if (parsedCachedPayload) {
    return parsedCachedPayload;
  }

  if (typeof window === "undefined") {
    return null;
  }

  try {
    const persistedPayload = window.sessionStorage.getItem(ADMIN_OVERVIEW_CACHE_KEY);
    if (!persistedPayload) {
      return null;
    }

    const storedPayload: unknown = JSON.parse(persistedPayload);
    const parsedStoredPayload = parseAdminPayload(storedPayload);
    if (!parsedStoredPayload) {
      window.sessionStorage.removeItem(ADMIN_OVERVIEW_CACHE_KEY);
      return null;
    }

    cachedAdminOverviewPayload = storedPayload;
    return parsedStoredPayload;
  } catch {
    clearPersistedAdminOverviewCache();
    return null;
  }
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

function isAdminScaleFixtureEnabled(): boolean {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") {
    return false;
  }

  return new URLSearchParams(window.location.search).get("adminScaleFixture") === "1";
}

function shouldClearAdminCacheFromUrl(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return new URLSearchParams(window.location.search).get("adminClearCache") === "1";
}

function fixturePageInfo(total: number, returned: number, offset: number, search: string, durationMs: number): AdminPageInfo {
  return {
    total,
    limit: ADMIN_PAGE_SIZE,
    offset,
    returned,
    search,
    durationMs,
    hasMore: offset + returned < total
  };
}

function buildFixtureUser(index: number, includeBilling: boolean): AdminUser {
  const target = index === ADMIN_SCALE_FIXTURE_USERS - 7;
  const email = target ? "scale-search-target@example.com" : `user${index}@company${index % 997}.example`;
  const organizationId = `org_${String(index % ADMIN_SCALE_FIXTURE_ORGANIZATIONS).padStart(5, "0")}`;
  return {
    id: `user_${String(index).padStart(5, "0")}`,
    name: target ? "Scale Search Target" : `User ${index}`,
    email,
    emailVerified: index % 3 !== 0,
    createdAt: "2026-07-01T12:00:00.000Z",
    updatedAt: "2026-07-10T12:00:00.000Z",
    lastSeenAt: "2026-07-12T12:00:00.000Z",
    sessionCount: target ? 42 : index % 9,
    activeDayCount: target ? 8 : index % 4,
    isRecurring: target || index % 4 > 1,
    lastActiveAt: "2026-07-12T12:00:00.000Z",
    invitesSent: target ? 5 : index % 3,
    firstInviteAt: target ? "2026-07-02T12:00:00.000Z" : null,
    hoursToFirstInvite: target ? 24 : null,
    authProviders: target ? ["scale-provider"] : [index % 2 === 0 ? "google" : "github"],
    workerCount: target ? 3 : index % 2,
    cloudWorkerCount: target ? 2 : index % 2,
    localWorkerCount: target ? 1 : 0,
    latestWorkerCreatedAt: target ? "2026-07-12T10:00:00.000Z" : null,
    billing: includeBilling ? {
      status: target ? "paid" : "unpaid",
      featureGateEnabled: false,
      subscriptionId: target ? "sub_scale_fixture" : null,
      subscriptionStatus: target ? "active" : null,
      currentPeriodEnd: target ? "2026-08-01T00:00:00.000Z" : null,
      source: "subscription",
      note: target ? "Covered by an active Stripe organization subscription." : "No cached Stripe organization subscription covers this user."
    } : null,
    organizations: [{
      id: organizationId,
      name: target ? "Scale Target Org" : `Organization ${index % ADMIN_SCALE_FIXTURE_ORGANIZATIONS}`,
      role: target ? "owner" : "member",
      memberCount: target ? 128 : 3,
      joinedAt: "2026-07-01T12:00:00.000Z"
    }]
  };
}

function fixtureUserMatches(index: number, search: string): boolean {
  if (!search) {
    return true;
  }

  const user = buildFixtureUser(index, false);
  const haystack = [
    user.id,
    user.name ?? "",
    user.email,
    ...user.authProviders,
    ...user.organizations.flatMap((organization) => [organization.id, organization.name, organization.role])
  ].join(" ").toLowerCase();
  return haystack.includes(search.toLowerCase());
}

function fixtureUsers(search: string, offset: number, includeBilling: boolean) {
  const rows: AdminUser[] = [];
  let total = 0;

  if (!search) {
    for (let index = offset; index < Math.min(offset + ADMIN_PAGE_SIZE, ADMIN_SCALE_FIXTURE_USERS); index += 1) {
      rows.push(buildFixtureUser(index, includeBilling));
    }
    return { rows, total: ADMIN_SCALE_FIXTURE_USERS };
  }

  for (let index = 0; index < ADMIN_SCALE_FIXTURE_USERS; index += 1) {
    if (!fixtureUserMatches(index, search)) {
      continue;
    }
    if (total >= offset && rows.length < ADMIN_PAGE_SIZE) {
      rows.push(buildFixtureUser(index, includeBilling));
    }
    total += 1;
  }

  return { rows, total };
}

function buildFixtureOrganization(index: number): AdminOrganization {
  const target = index === ADMIN_SCALE_FIXTURE_ORGANIZATIONS - 11;
  return {
    id: `org_${String(index).padStart(5, "0")}`,
    name: target ? "Scale Performance Target Organization" : `Organization ${index}`,
    slug: target ? "scale-performance-target" : `organization-${index}`,
    createdAt: "2026-07-01T12:00:00.000Z",
    updatedAt: "2026-07-10T12:00:00.000Z",
    memberCount: target ? 128 : 4,
    plan: { tier: target ? "enterprise" : "free", source: target ? "manual" : "default" },
    seatLimit: target ? 500 : 5,
    freeSeatCount: target ? 25 : DEFAULT_FREE_SEAT_COUNT,
    seatsFreeAdditional: target ? 20 : 0,
    billableSeatCount: target ? 103 : 0,
    capabilities: { installLinks: target, mcpConnections: target }
  };
}

function fixtureOrganizationMatches(index: number, search: string): boolean {
  if (!search) {
    return true;
  }

  const organization = buildFixtureOrganization(index);
  return [organization.id, organization.name, organization.slug].some((value) => value.toLowerCase().includes(search.toLowerCase()));
}

function fixtureOrganizations(search: string, offset: number) {
  const rows: AdminOrganization[] = [];
  let total = 0;

  if (!search) {
    for (let index = offset; index < Math.min(offset + ADMIN_PAGE_SIZE, ADMIN_SCALE_FIXTURE_ORGANIZATIONS); index += 1) {
      rows.push(buildFixtureOrganization(index));
    }
    return { rows, total: ADMIN_SCALE_FIXTURE_ORGANIZATIONS };
  }

  for (let index = 0; index < ADMIN_SCALE_FIXTURE_ORGANIZATIONS; index += 1) {
    if (!fixtureOrganizationMatches(index, search)) {
      continue;
    }
    if (total >= offset && rows.length < ADMIN_PAGE_SIZE) {
      rows.push(buildFixtureOrganization(index));
    }
    total += 1;
  }

  return { rows, total };
}

function fixtureActivitySeries(): ActivityPoint[] {
  const points: ActivityPoint[] = [];
  for (let index = 29; index >= 0; index -= 1) {
    const day = new Date(Date.now() - index * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    points.push({ day, activeUsers: 160 + (29 - index) * 3, realActiveUsers: 80 + (29 - index) * 2, signups: 11 + ((29 - index) % 5) });
  }

  return points;
}

function fixtureMetricsSummary(): AdminSummary {
  return {
    totalUsers: ADMIN_SCALE_FIXTURE_USERS,
    totalOrganizations: ADMIN_SCALE_FIXTURE_ORGANIZATIONS,
    verifiedUsers: 33_333,
    recentUsers7d: 2_100,
    recentUsers30d: 8_400,
    totalWorkers: 25_002,
    cloudWorkers: 25_001,
    localWorkers: 1,
    usersWithWorkers: 25_000,
    usersWithoutWorkers: 25_000,
    paidUsers: null,
    unpaidUsers: null,
    billingUnavailableUsers: null,
    adminCount: 1,
    billingLoaded: false,
    activeUsers1d: 247,
    activeUsers7d: 1_580,
    activeUsers30d: 6_420,
    realActiveUsers1d: 138,
    realActiveUsers7d: 910,
    realActiveUsers30d: 3_770,
    recurringUsers: 25_001,
    inviters: 33_333,
    medianHoursToFirstInvite: 24,
    activitySeries: fixtureActivitySeries()
  };
}

function adminScaleFixturePayload(path: string): unknown | null {
  if (!isAdminScaleFixtureEnabled()) {
    return null;
  }

  const url = new URL(path, "http://admin.local");
  const search = url.searchParams.get("search")?.trim() ?? "";
  const offset = Math.min(ADMIN_MAX_PAGE_OFFSET, Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0));
  const includeBilling = url.searchParams.get("includeBilling") === "1";
  const generatedAt = new Date().toISOString();
  const startedAt = performance.now();

  if (url.pathname === "/v1/admin/users") {
    const users = fixtureUsers(search, offset, includeBilling);
    const durationMs = Math.round(performance.now() - startedAt);
    return {
      users: users.rows,
      page: fixturePageInfo(users.total, users.rows.length, offset, search, durationMs),
      billing: includeBilling
        ? { loaded: true, paidUsers: users.rows.filter((user) => user.billing?.status === "paid").length, unpaidUsers: users.rows.filter((user) => user.billing?.status === "unpaid").length, billingUnavailableUsers: 0 }
        : { loaded: false, paidUsers: null, unpaidUsers: null, billingUnavailableUsers: null },
      generatedAt
    };
  }

  if (url.pathname === "/v1/admin/organizations") {
    const organizations = fixtureOrganizations(search, offset);
    const durationMs = Math.round(performance.now() - startedAt);
    return {
      organizations: organizations.rows,
      page: fixturePageInfo(organizations.total, organizations.rows.length, offset, search, durationMs),
      generatedAt
    };
  }

  if (url.pathname === "/v1/admin/overview") {
    const users = fixtureUsers("", 0, false);
    const durationMs = Math.round(performance.now() - startedAt);
    return {
      viewer: { id: "user_admin_fixture", email: "admin@example.com", name: "Admin Fixture" },
      admins: [{ email: "admin@example.com", note: "Eval fixture admin" }],
      users: users.rows,
      organizations: [],
      userPage: fixturePageInfo(ADMIN_SCALE_FIXTURE_USERS, users.rows.length, 0, "", durationMs),
      organizationPage: fixturePageInfo(ADMIN_SCALE_FIXTURE_ORGANIZATIONS, 0, 0, "", 0),
      summary: {
        totalUsers: ADMIN_SCALE_FIXTURE_USERS,
        totalOrganizations: ADMIN_SCALE_FIXTURE_ORGANIZATIONS,
        verifiedUsers: null,
        recentUsers7d: null,
        recentUsers30d: null,
        totalWorkers: null,
        cloudWorkers: null,
        localWorkers: null,
        usersWithWorkers: null,
        usersWithoutWorkers: null,
        paidUsers: null,
        unpaidUsers: null,
        billingUnavailableUsers: null,
        adminCount: 1,
        billingLoaded: false,
        activeUsers1d: null,
        activeUsers7d: null,
        activeUsers30d: null,
        realActiveUsers1d: null,
        realActiveUsers7d: null,
        realActiveUsers30d: null,
        recurringUsers: null,
        inviters: null,
        medianHoursToFirstInvite: null,
        activitySeries: []
      },
      generatedAt
    };
  }

  if (url.pathname === "/v1/admin/metrics") {
    return {
      summary: fixtureMetricsSummary(),
      generatedAt
    };
  }

  return null;
}

async function requestJson(path: string, signal?: AbortSignal) {
  const fixturePayload = adminScaleFixturePayload(path);
  if (fixturePayload) {
    return { response: new Response(JSON.stringify(fixturePayload), { status: 200 }), payload: fixturePayload };
  }

  const response = await fetch(`/api/den${path}`, {
    method: "GET",
    credentials: "include",
    signal,
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
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

async function putJson(path: string, body: unknown) {
  const response = await fetch(`/api/den${path}`, {
    method: "PUT",
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

async function deleteJson(path: string) {
  const response = await fetch(`/api/den${path}`, {
    method: "DELETE",
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

function formatOptionalCount(value: number | null): string {
  return value === null ? "Deferred" : String(value);
}

function formatOptionalDetail(value: number | null, label: string): string {
  return value === null ? "Load analytics to calculate" : `${value} ${label}`;
}

function formatProvider(provider: string): string {
  return provider
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function getEmailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  if (at === -1 || at === email.length - 1) {
    return "unknown";
  }

  return email.slice(at + 1).trim().toLowerCase();
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

function DenAdminLoadingShell() {
  return (
    <section className="mx-auto w-full max-w-6xl rounded-3xl border border-slate-200 bg-white shadow-sm" aria-busy="true">
      <div className="border-b border-slate-200 px-6 py-6 sm:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-slate-500">Den admin</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-slate-950">User backoffice</h1>
            <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-600">
              Loading global totals and the first bounded user page.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 animate-pulse">
            <div className="h-10 w-48 rounded-full bg-slate-100" />
            <div className="h-10 w-24 rounded-full border border-slate-200 bg-slate-50" />
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-6 animate-pulse">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <div key={index} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
              <div className="h-3 w-20 rounded-full bg-slate-200" />
              <div className="mt-3 h-8 w-16 rounded-lg bg-slate-200" />
              <div className="mt-3 h-3 w-full rounded-full bg-slate-200" />
              <div className="mt-2 h-3 w-2/3 rounded-full bg-slate-200" />
            </div>
          ))}
        </div>
      </div>

      <div className="px-6 py-6 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3 animate-pulse">
          <div className="h-11 w-80 rounded-full border border-slate-200 bg-slate-50" />
          <div className="h-10 w-28 rounded-full border border-slate-200 bg-slate-50" />
        </div>

        <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 animate-pulse">
          <div className="h-4 w-56 rounded-full bg-slate-200" />
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="h-24 rounded-2xl bg-slate-100" />
            <div className="h-24 rounded-2xl bg-slate-100" />
          </div>
          <div className="mt-4 h-3 w-full rounded-full bg-slate-200" />
          <div className="mt-2 h-3 w-5/6 rounded-full bg-slate-200" />
        </div>
      </div>
    </section>
  );
}

export function DenAdminPanel() {
  const [accessState, setAccessState] = useState<AccessState>("loading");
  const [payload, setPayload] = useState<AdminPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [userQuery, setUserQuery] = useState("");
  const [organizationQuery, setOrganizationQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("users");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [copiedOrgId, setCopiedOrgId] = useState<string | null>(null);
  const [includeBilling, setIncludeBilling] = useState(false);
  const [usersLoading, setUsersLoading] = useState(false);
  const [organizationsLoading, setOrganizationsLoading] = useState(false);
  const [orgDrafts, setOrgDrafts] = useState<Record<string, { tier: AdminOrganization["plan"]["tier"]; seatLimit: string }>>({});
  const [savingOrgId, setSavingOrgId] = useState<string | null>(null);
  const [freeSeatsDialog, setFreeSeatsDialog] = useState<{ org: AdminOrganization; totalFreeSeats: string } | null>(null);
  const [savingFreeSeatsOrgId, setSavingFreeSeatsOrgId] = useState<string | null>(null);
  const [savingCapabilityOrgId, setSavingCapabilityOrgId] = useState<string | null>(null);
  const [capabilityError, setCapabilityError] = useState<{ orgId: string; message: string } | null>(null);
  const [deleteUserDialog, setDeleteUserDialog] = useState<AdminUser | null>(null);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const mountedAtRef = useRef<number | null>(null);
  const overviewRequestIdRef = useRef(0);
  const userRequestIdRef = useRef(0);
  const organizationRequestIdRef = useRef(0);
  const payloadRef = useRef<AdminPayload | null>(null);
  const includeBillingRef = useRef(includeBilling);
  const userSearchStartedAtRef = useRef<number | null>(null);
  const organizationSearchStartedAtRef = useRef<number | null>(null);
  const [overviewUsableMs, setOverviewUsableMs] = useState<number | null>(null);
  const [userVisibleDurationMs, setUserVisibleDurationMs] = useState<number | null>(null);
  const [organizationVisibleDurationMs, setOrganizationVisibleDurationMs] = useState<number | null>(null);

  if (mountedAtRef.current === null && typeof performance !== "undefined") {
    mountedAtRef.current = performance.now();
  }

  useEffect(() => {
    payloadRef.current = payload;
  }, [payload]);

  useEffect(() => {
    includeBillingRef.current = includeBilling;
  }, [includeBilling]);

  const loadOverview = useCallback(async () => {
    const requestId = overviewRequestIdRef.current + 1;
    overviewRequestIdRef.current = requestId;
    setRefreshing(true);
    setError(null);

    try {
      const { response, payload: nextPayload } = await requestJson("/v1/admin/overview");
      if (requestId !== overviewRequestIdRef.current) {
        return;
      }

      if (response.status === 401) {
        clearAdminOverviewCache();
        setAccessState("signed-out");
        setPayload(null);
        return;
      }

      if (response.status === 403) {
        clearAdminOverviewCache();
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

      storeAdminOverviewCache(nextPayload);
      setIncludeBilling(parsed.summary.billingLoaded);
      payloadRef.current = parsed;
      setAccessState("ready");
      setPayload(parsed);
    } catch (nextError) {
      if (requestId === overviewRequestIdRef.current) {
        setAccessState("error");
        setPayload(null);
        setError(nextError instanceof Error ? nextError.message : "Unknown network error");
      }
    } finally {
      if (requestId === overviewRequestIdRef.current) {
        setRefreshing(false);
      }
    }
  }, []);

  const loadUsers = useCallback(async (search: string, offset: number, loadBilling: boolean, signal?: AbortSignal, existingRequestId?: number) => {
    const requestId = existingRequestId ?? userRequestIdRef.current + 1;
    userRequestIdRef.current = requestId;
    setUsersLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        limit: "50",
        offset: String(offset),
      });
      const trimmed = search.trim();
      if (trimmed) {
        params.set("search", trimmed);
      }
      if (loadBilling) {
        params.set("includeBilling", "1");
      }

      const { response, payload: nextPayload } = await requestJson(`/v1/admin/users?${params.toString()}`, signal);
      if (requestId !== userRequestIdRef.current) {
        return;
      }
      if (response.status === 401) {
        clearAdminOverviewCache();
        setAccessState("signed-out");
        setPayload(null);
        return;
      }
      if (response.status === 403) {
        clearAdminOverviewCache();
        setAccessState("forbidden");
        setPayload(null);
        return;
      }
      if (!response.ok) {
        setError(getErrorMessage(nextPayload, `User search failed with ${response.status}.`));
        return;
      }

      const parsed = parseAdminUsersPayload(nextPayload);
      if (requestId !== userRequestIdRef.current) {
        return;
      }
      if (!parsed) {
        setError("User search payload was missing required fields.");
        return;
      }

      setIncludeBilling(parsed.billing.loaded);
      setPayload((current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          users: parsed.users,
          userPage: parsed.page,
          generatedAt: parsed.generatedAt,
          summary: {
            ...current.summary,
            billingLoaded: parsed.billing.loaded,
            paidUsers: parsed.billing.paidUsers,
            unpaidUsers: parsed.billing.unpaidUsers,
            billingUnavailableUsers: parsed.billing.billingUnavailableUsers
          }
        };
      });
    } catch (nextError) {
      if (requestId === userRequestIdRef.current && !isAbortError(nextError)) {
        setError(nextError instanceof Error ? nextError.message : "Unknown network error");
      }
    } finally {
      if (requestId === userRequestIdRef.current) {
        setUsersLoading(false);
      }
    }
  }, []);

  const loadOrganizations = useCallback(async (search: string, offset: number, signal?: AbortSignal, existingRequestId?: number) => {
    const requestId = existingRequestId ?? organizationRequestIdRef.current + 1;
    organizationRequestIdRef.current = requestId;
    setOrganizationsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        limit: "50",
        offset: String(offset),
      });
      const trimmed = search.trim();
      if (trimmed) {
        params.set("search", trimmed);
      }

      const { response, payload: nextPayload } = await requestJson(`/v1/admin/organizations?${params.toString()}`, signal);
      if (requestId !== organizationRequestIdRef.current) {
        return;
      }
      if (response.status === 401) {
        clearAdminOverviewCache();
        setAccessState("signed-out");
        setPayload(null);
        return;
      }
      if (response.status === 403) {
        clearAdminOverviewCache();
        setAccessState("forbidden");
        setPayload(null);
        return;
      }
      if (!response.ok) {
        setError(getErrorMessage(nextPayload, `Organization search failed with ${response.status}.`));
        return;
      }

      const parsed = parseAdminOrganizationsPayload(nextPayload);
      if (requestId !== organizationRequestIdRef.current) {
        return;
      }
      if (!parsed) {
        setError("Organization search payload was missing required fields.");
        return;
      }

      setPayload((current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          organizations: parsed.organizations,
          organizationPage: parsed.page,
          generatedAt: parsed.generatedAt
        };
      });
    } catch (nextError) {
      if (requestId === organizationRequestIdRef.current && !isAbortError(nextError)) {
        setError(nextError instanceof Error ? nextError.message : "Unknown network error");
      }
    } finally {
      if (requestId === organizationRequestIdRef.current) {
        setOrganizationsLoading(false);
      }
    }
  }, []);

  const loadAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
    setError(null);

    try {
      const { response, payload: nextPayload } = await requestJson("/v1/admin/metrics");
      if (response.status === 401) {
        clearAdminOverviewCache();
        setAccessState("signed-out");
        setPayload(null);
        return;
      }
      if (response.status === 403) {
        clearAdminOverviewCache();
        setAccessState("forbidden");
        setPayload(null);
        return;
      }
      if (!response.ok) {
        setError(getErrorMessage(nextPayload, `Analytics request failed with ${response.status}.`));
        return;
      }

      const parsed = parseAdminMetricsPayload(nextPayload);
      if (!parsed) {
        setError("Analytics payload was missing required fields.");
        return;
      }

      setPayload((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          summary: {
            ...parsed.summary,
            billingLoaded: current.summary.billingLoaded,
            paidUsers: current.summary.paidUsers,
            unpaidUsers: current.summary.unpaidUsers,
            billingUnavailableUsers: current.summary.billingUnavailableUsers
          },
          generatedAt: parsed.generatedAt
        };
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unknown network error");
    } finally {
      setAnalyticsLoading(false);
    }
  }, []);

  useEffect(() => {
    const cachedPayload = readAdminOverviewCache();
    if (cachedPayload) {
      payloadRef.current = cachedPayload;
      setPayload(cachedPayload);
      includeBillingRef.current = cachedPayload.summary.billingLoaded;
      setIncludeBilling(cachedPayload.summary.billingLoaded);
      setAccessState("ready");
    }

    void loadOverview();
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

  const filteredUsers = payload?.users ?? [];
  const filteredOrganizations = payload?.organizations ?? [];

  useEffect(() => {
    if (accessState !== "ready" || viewMode !== "users") {
      return;
    }

    const trimmedQuery = userQuery.trim();
    const currentPayload = payloadRef.current;
    if (currentPayload?.userPage.search === trimmedQuery) {
      setUsersLoading(false);
      return;
    }

    const requestId = userRequestIdRef.current + 1;
    userRequestIdRef.current = requestId;
    setUsersLoading(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void loadUsers(trimmedQuery, 0, includeBillingRef.current, controller.signal, requestId);
    }, ADMIN_SEARCH_DEBOUNCE_MS);

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [accessState, loadUsers, userQuery, viewMode]);

  useEffect(() => {
    if (accessState !== "ready" || viewMode !== "organizations") {
      return;
    }

    const trimmedQuery = organizationQuery.trim();
    const currentPayload = payloadRef.current;
    if (currentPayload?.organizationPage.search === trimmedQuery && (currentPayload.organizations.length > 0 || currentPayload.organizationPage.total === 0 || currentPayload.organizationPage.offset > 0 || currentPayload.organizationPage.returned > 0)) {
      setOrganizationsLoading(false);
      return;
    }

    const requestId = organizationRequestIdRef.current + 1;
    organizationRequestIdRef.current = requestId;
    setOrganizationsLoading(true);
    const controller = new AbortController();

    if (trimmedQuery === "") {
      void loadOrganizations(trimmedQuery, 0, controller.signal, requestId);
      return () => {
        controller.abort();
      };
    }

    const timeout = window.setTimeout(() => {
      void loadOrganizations(trimmedQuery, 0, controller.signal, requestId);
    }, ADMIN_SEARCH_DEBOUNCE_MS);

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [accessState, loadOrganizations, organizationQuery, viewMode]);

  useEffect(() => {
    if (accessState !== "ready" || !payload || overviewUsableMs !== null || mountedAtRef.current === null) {
      return;
    }

    setOverviewUsableMs(Math.round(performance.now() - mountedAtRef.current));
  }, [accessState, overviewUsableMs, payload]);

  useEffect(() => {
    if (!payload || usersLoading || userSearchStartedAtRef.current === null || payload.userPage.search !== userQuery.trim()) {
      return;
    }

    setUserVisibleDurationMs(Math.round(performance.now() - userSearchStartedAtRef.current));
    userSearchStartedAtRef.current = null;
  }, [payload, userQuery, usersLoading]);

  useEffect(() => {
    if (!payload || organizationsLoading || organizationSearchStartedAtRef.current === null || payload.organizationPage.search !== organizationQuery.trim()) {
      return;
    }

    const organizationPageLoaded = payload.organizations.length > 0 || payload.organizationPage.total === 0 || payload.organizationPage.offset > 0 || payload.organizationPage.returned > 0;
    if (!organizationPageLoaded) {
      return;
    }

    setOrganizationVisibleDurationMs(Math.round(performance.now() - organizationSearchStartedAtRef.current));
    organizationSearchStartedAtRef.current = null;
  }, [organizationQuery, organizationsLoading, payload]);

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

      setPayload((current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          organizations: current.organizations.map((entry) => entry.id === org.id
            ? { ...entry, plan: { ...entry.plan, tier: draft.tier, source: "manual" }, seatLimit }
            : entry)
        };
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unknown network error");
    } finally {
      setSavingOrgId(null);
    }
  }, [orgDrafts]);

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

      const updatedOrganization = isRecord(nextPayload) && isRecord(nextPayload.organization) ? nextPayload.organization : null;
      setPayload((current) => {
        if (!current || !updatedOrganization) {
          return current;
        }
        return {
          ...current,
          organizations: current.organizations.map((entry) => entry.id === freeSeatsDialog.org.id
            ? {
              ...entry,
              memberCount: toNumberValue(updatedOrganization.memberCount),
              freeSeatCount: toNumberValue(updatedOrganization.freeSeatCount),
              seatsFreeAdditional: toNumberValue(updatedOrganization.seatsFreeAdditional),
              billableSeatCount: toNumberValue(updatedOrganization.billableSeatCount)
            }
            : entry)
        };
      });
      setFreeSeatsDialog(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unknown network error");
    } finally {
      setSavingFreeSeatsOrgId(null);
    }
  }, [freeSeatsDialog]);

  const setOrganizationCapabilityLocally = useCallback((orgId: string, key: keyof AdminOrganizationCapabilities, enabled: boolean) => {
    setPayload((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        organizations: current.organizations.map((org) =>
          org.id === orgId ? { ...org, capabilities: { ...org.capabilities, [key]: enabled } } : org
        )
      };
    });
  }, []);

  const saveOrganizationCapability = useCallback(async (org: AdminOrganization, key: keyof AdminOrganizationCapabilities, enabled: boolean) => {
    setSavingCapabilityOrgId(org.id);
    setError(null);
    setCapabilityError(null);
    // Optimistic: flip the toggle immediately, roll back if the PUT fails.
    setOrganizationCapabilityLocally(org.id, key, enabled);

    try {
      const { response, payload: nextPayload } = await putJson(`/v1/admin/organizations/${org.id}/capabilities`, {
        capabilities: { [key]: enabled }
      });

      if (!response.ok) {
        setOrganizationCapabilityLocally(org.id, key, !enabled);
        const message = getErrorMessage(nextPayload, `Could not update capabilities for ${org.name}.`);
        setError(message);
        setCapabilityError({ orgId: org.id, message });
      }
    } catch (nextError) {
      setOrganizationCapabilityLocally(org.id, key, !enabled);
      const message = nextError instanceof Error ? nextError.message : "Unknown network error";
      setError(message);
      setCapabilityError({ orgId: org.id, message });
    } finally {
      setSavingCapabilityOrgId(null);
    }
  }, [setOrganizationCapabilityLocally]);

  const deleteUser = useCallback(async () => {
    if (!deleteUserDialog) {
      return;
    }

    setDeletingUserId(deleteUserDialog.id);
    setError(null);

    try {
      const { response, payload: nextPayload } = await deleteJson(`/v1/admin/users/${deleteUserDialog.id}`);

      if (!response.ok) {
        setError(getErrorMessage(nextPayload, `Could not delete ${deleteUserDialog.email}.`));
        return;
      }

      setDeleteUserDialog(null);
      setSelectedUserId(null);
      await loadOverview();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unknown network error");
    } finally {
      setDeletingUserId(null);
    }
  }, [deleteUserDialog, loadOverview]);

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
  }, [filteredOrganizations, filteredUsers, viewMode]);

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
    return <DenAdminLoadingShell />;
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
              void loadOverview();
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

  const billingValue = payload.summary.billingLoaded
    ? formatOptionalCount(payload.summary.paidUsers)
    : "On demand";
  const billingDetail = payload.summary.billingLoaded && payload.summary.paidUsers !== null && payload.summary.unpaidUsers !== null
    ? `${payload.summary.paidUsers} paid / ${payload.summary.unpaidUsers} unpaid on current page`
    : payload.summary.billingLoaded
      ? "Billing counts unavailable for this page"
      : "Load billing only when you need it";
  const inviterDetail = payload.summary.medianHoursToFirstInvite === null
    ? "Load analytics to calculate"
    : `Median time to invite ${formatHours(payload.summary.medianHoursToFirstInvite)}`;
  const analyticsLoaded = payload.summary.verifiedUsers !== null || payload.summary.activitySeries.length > 0;
  const pageDurationLabel = isAdminScaleFixtureEnabled() ? "fixture computation" : "server";

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
                void loadOverview();
              }}
              disabled={refreshing}
              className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
            <button
              type="button"
              onClick={() => {
                void loadAnalytics();
              }}
              disabled={analyticsLoading}
              className="inline-flex items-center justify-center rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {analyticsLoading ? "Loading analytics..." : analyticsLoaded ? "Refresh analytics" : "Load analytics"}
            </button>
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <StatCard label="Users" value={String(payload.summary.totalUsers)} detail={formatOptionalDetail(payload.summary.recentUsers7d, "new in 7d")} />
          <StatCard label="Active today" value={formatOptionalCount(payload.summary.activeUsers1d)} detail="Load analytics to calculate" />
          <StatCard label="Real DAU" value={formatOptionalCount(payload.summary.realActiveUsers1d)} detail="Load analytics to calculate" />
          <StatCard label="Recurring" value={formatOptionalCount(payload.summary.recurringUsers)} detail="Load analytics to calculate" />
          <StatCard label="Inviters" value={formatOptionalCount(payload.summary.inviters)} detail={inviterDetail} />
          <StatCard label="Verified" value={formatOptionalCount(payload.summary.verifiedUsers)} detail="Load analytics to calculate" />
          <StatCard label="Worker creators" value={formatOptionalCount(payload.summary.usersWithWorkers)} detail={payload.summary.usersWithoutWorkers === null ? "Load analytics to calculate" : `${payload.summary.usersWithoutWorkers} without workers`} />
          <StatCard label="Workers" value={formatOptionalCount(payload.summary.totalWorkers)} detail="Load analytics to calculate" />
          <StatCard label="Billing" value={billingValue} detail={billingDetail} />
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
              Companies (deferred)
            </button>
            <button
              type="button"
              onClick={() => {
                if (viewMode !== "organizations") {
                  organizationSearchStartedAtRef.current = performance.now();
                  setOrganizationVisibleDurationMs(null);
                }
                setViewMode("organizations");
              }}
              className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${viewMode === "organizations" ? "bg-slate-950 text-white" : "text-slate-600 hover:text-slate-900"}`}
            >
              Organizations ({payload.summary.totalOrganizations})
            </button>
          </div>

            <button
              type="button"
              onClick={exportCsv}
              disabled={viewMode === "companies" || (viewMode === "organizations" ? filteredOrganizations.length === 0 : filteredUsers.length === 0)}
              className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Export current page CSV
            </button>
        </div>

        {error ? (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
            {error}
          </div>
        ) : null}

        {isAdminScaleFixtureEnabled() ? (
          <div data-testid="admin-scale-eval-status" className="mt-4 rounded-2xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm leading-6 text-violet-900">
            Eval scale fixture active: 50,000 users · 60,000 organizations · first pages capped at 50. Browser usable {overviewUsableMs === null ? "measuring" : `${overviewUsableMs} ms`}. Real database budget command: pnpm benchmark:admin-scale:mysql (500 ms initial, 300 ms searches).
          </div>
        ) : null}

        {(viewMode === "users" && usersLoading) || (viewMode === "organizations" && organizationsLoading) ? (
          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600" aria-busy="true">
            Loading the bounded page…
          </div>
        ) : null}

        {viewMode === "organizations" ? (
          <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between" data-testid="admin-orgs-page">
            <div className="grid w-full max-w-xl gap-2">
              <label className="grid gap-2">
                <span className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">Search organizations</span>
                <input
                  value={organizationQuery}
                  onChange={(event) => {
                    overviewRequestIdRef.current += 1;
                    setRefreshing(false);
                    organizationRequestIdRef.current += 1;
                    organizationSearchStartedAtRef.current = performance.now();
                    setOrganizationVisibleDurationMs(null);
                    setOrganizationQuery(event.target.value);
                  }}
                  placeholder="Org name, slug, or id"
                  className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
                />
              </label>
              <p className="text-xs leading-5 text-slate-500">
                Search across all {payload.summary.totalOrganizations} organizations · page {payload.organizationPage.offset + 1}-{payload.organizationPage.offset + payload.organizationPage.returned} of {payload.organizationPage.total} · {pageDurationLabel} {payload.organizationPage.durationMs} ms{organizationVisibleDurationMs === null ? "" : ` · browser visible ${organizationVisibleDurationMs} ms`}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  void loadOrganizations(organizationQuery, Math.max(0, payload.organizationPage.offset - payload.organizationPage.limit));
                }}
                disabled={organizationsLoading || payload.organizationPage.offset === 0}
                className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => {
                  void loadOrganizations(organizationQuery, payload.organizationPage.offset + payload.organizationPage.limit);
                }}
                disabled={organizationsLoading || !payload.organizationPage.hasMore}
                className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Next
              </button>
            </div>
          </div>
        ) : viewMode === "companies" ? (
          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm leading-6 text-slate-600">
            Company-domain grouping is intentionally deferred at scale. It previously grouped only the loaded user list, which would be misleading now. Use server-side user search (for example, @acme.com) to find matching users across all {payload.summary.totalUsers} users.
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="grid w-full max-w-xl gap-2">
              <label className="grid gap-2">
                <span className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">Search users</span>
                <input
                  value={userQuery}
                  onChange={(event) => {
                    overviewRequestIdRef.current += 1;
                    setRefreshing(false);
                    userRequestIdRef.current += 1;
                    userSearchStartedAtRef.current = performance.now();
                    setUserVisibleDurationMs(null);
                    setUserQuery(event.target.value);
                  }}
                  placeholder="Email, name, user id, provider, organization"
                  className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
                />
              </label>
              <p className="text-xs leading-5 text-slate-500">
                Search across all {payload.summary.totalUsers} users · page {payload.userPage.offset + 1}-{payload.userPage.offset + payload.userPage.returned} of {payload.userPage.total} · {pageDurationLabel} {payload.userPage.durationMs} ms{userVisibleDurationMs === null ? "" : ` · browser visible ${userVisibleDurationMs} ms`}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {!payload.summary.billingLoaded ? (
                <button
                  type="button"
                  onClick={() => {
                    void loadUsers(userQuery, payload.userPage.offset, true);
                  }}
                  disabled={usersLoading}
                  className="inline-flex items-center justify-center rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Load billing for page
                </button>
              ) : (
                <p className="self-center text-sm text-slate-500">Billing loaded for this page only.</p>
              )}
              <button
                type="button"
                onClick={() => {
                  void loadUsers(userQuery, Math.max(0, payload.userPage.offset - payload.userPage.limit), includeBilling);
                }}
                disabled={usersLoading || payload.userPage.offset === 0}
                className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => {
                  void loadUsers(userQuery, payload.userPage.offset + payload.userPage.limit, includeBilling);
                }}
                disabled={usersLoading || !payload.userPage.hasMore}
                className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Next
              </button>
            </div>
          </div>
        )}

        <div className="mt-6 grid gap-3">
          {viewMode === "organizations" ? (
            filteredOrganizations.length > 0 ? (
              <>
                {filteredOrganizations.map((org) => {
              const draft = orgDrafts[org.id] ?? { tier: org.plan.tier, seatLimit: String(org.seatLimit) };
              const changed = draft.tier !== org.plan.tier || draft.seatLimit !== String(org.seatLimit);

              return (
                <div key={org.id} data-testid={`admin-org-row-${org.slug}`} className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
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

                  <div className="mt-4 border-t border-slate-200 pt-4">
                    <p className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">Capabilities</p>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                      <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          data-testid="admin-capability-installLinks"
                          checked={org.capabilities.installLinks}
                          disabled={savingCapabilityOrgId === org.id}
                          onChange={(event) => {
                            void saveOrganizationCapability(org, "installLinks", event.target.checked);
                          }}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                        Install links
                      </label>
                      <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          data-testid="admin-capability-mcpConnections"
                          checked={org.capabilities.mcpConnections}
                          disabled={savingCapabilityOrgId === org.id}
                          onChange={(event) => {
                            void saveOrganizationCapability(org, "mcpConnections", event.target.checked);
                          }}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                        OpenWork Connect (alpha)
                      </label>
                    </div>
                    {capabilityError?.orgId === org.id ? (
                      <p data-testid="admin-capability-error" className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">
                        Save failed — the change was reverted. {capabilityError.message}
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs text-slate-400">On by default. Turn off to stop workspace admins from minting desktop install links for this organization.</p>
                    <p className="mt-1 text-xs text-slate-400">On by default. Turn off to hide member-facing org connections, marketplace capabilities on the agent rail, and the desktop Connect tab.</p>
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
                })}
              </>
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-5 py-10 text-center">
                <p className="text-base font-semibold text-slate-950">No organizations match</p>
                <p className="mt-2 text-sm leading-7 text-slate-500">Try a different search.</p>
              </div>
            )
          ) : viewMode === "companies" ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-5 py-10 text-center">
              <p className="text-base font-semibold text-slate-950">Company rollups are deferred at scale</p>
              <p className="mt-2 text-sm leading-7 text-slate-500">This view no longer groups a partial user page. Search Users by domain to query the full user table server-side.</p>
            </div>
          ) : filteredUsers.length > 0 ? filteredUsers.map((user) => {
            const isSelected = user.id === selectedUser?.id;

            return (
              <div
                key={user.id}
                data-testid={`admin-user-row-${user.id}`}
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
                              void loadUsers(userQuery, payload.userPage.offset, true);
                            }}
                            disabled={usersLoading}
                            className="mt-3 inline-flex items-center justify-center rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Load billing for page
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

                      <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <p className="text-sm font-semibold text-red-950">Delete user</p>
                            <p className="mt-1 text-sm leading-6 text-red-700">Removes this user account, active sessions, auth records, and org memberships.</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => setDeleteUserDialog(user)}
                            disabled={deletingUserId === user.id}
                            className="inline-flex items-center justify-center gap-2 rounded-full border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-700 transition hover:border-red-300 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <Trash2 size={15} aria-hidden="true" />
                            {deletingUserId === user.id ? "Deleting..." : "Delete user"}
                          </button>
                        </div>
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
                                      overviewRequestIdRef.current += 1;
                                      setRefreshing(false);
                                      organizationRequestIdRef.current += 1;
                                      organizationSearchStartedAtRef.current = performance.now();
                                      setOrganizationVisibleDurationMs(null);
                                      setOrganizationQuery(org.id);
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

      {deleteUserDialog ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-user-dialog-title"
          onClick={() => setDeleteUserDialog(null)}
        >
          <div className="w-full max-w-md rounded-3xl border border-red-100 bg-white p-6 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <p className="text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-red-500">Danger zone</p>
            <h2 id="delete-user-dialog-title" className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950">
              Delete {deleteUserDialog.email}?
            </h2>
            <p className="mt-3 text-sm leading-7 text-slate-600">
              This permanently removes the user account and revokes their sessions. Organization memberships are marked removed.
            </p>
            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <button
                type="button"
                onClick={() => setDeleteUserDialog(null)}
                disabled={deletingUserId === deleteUserDialog.id}
                className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void deleteUser();
                }}
                disabled={deletingUserId === deleteUserDialog.id}
                className="inline-flex items-center justify-center rounded-full bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {deletingUserId === deleteUserDialog.id ? "Deleting..." : "Delete user"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
