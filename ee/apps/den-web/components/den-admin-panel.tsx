"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { DenButton } from "../app/(den)/_components/ui/button";
import { AdminDashboard, QuickFind } from "./admin/admin-dashboard";
import { AdminControlCenter } from "./admin/control-center/admin-control-center";
import { Check, Copy, Download, Search, Trash2 } from "lucide-react";
import { planEndLabel } from "../app/(den)/_lib/plan-display";
import { mapFeatures } from "@openwork/features";
import { denApiCredentials, denBrowserEndpoint } from "../app/(den)/_lib/den-api-origin";
import { withStoredBearer } from "./admin/admin-request";
import { adminOrganizationHref, useAdminListLocation, type AdminDataSection } from "./admin/admin-list-location";
import { AdminDeferredContent } from "./admin/admin-deferred-content";
import { AdminAccessScreen } from "./admin/admin-access-screen";
import { AdminRecentOrganizationsPanel, AdminRecentOrganizationsStrip } from "./admin/admin-recent-organizations";
import { parseAdminOrganizationFeatures, type AdminOrganizationFeatures } from "./admin/admin-organization-feature-controls";

type AccessState = "ready" | "signed-out" | "forbidden" | "error";

const DEFAULT_FREE_SEAT_COUNT = 5;
const ADMIN_PAGE_SIZE = 50;
const ADMIN_MAX_PAGE_OFFSET = 100_000;
const ADMIN_SCALE_FIXTURE_USERS = 50_000;
const ADMIN_SCALE_FIXTURE_ORGANIZATIONS = 60_000;
const ADMIN_SEARCH_DEBOUNCE_MS = 75;

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
  id: string;
  email: string;
  note: string | null;
  createdAt: string;
};

type InferenceUsageWindow = {
  bucketId: string;
  windowType: string;
  windowStartAt: string;
  windowEndAt: string;
  limitAmount: number;
  organizationUsedAmount: number;
  userUsedAmount: number;
};

type InferenceUsageOrganization = {
  id: string;
  name: string;
  membershipId: string;
  windows: InferenceUsageWindow[];
};

type InferenceUsagePayload = {
  user: { id: string; email: string };
  organizations: InferenceUsageOrganization[];
};

type InferenceUsageCacheEntry =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: InferenceUsagePayload };

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

type AdminOpenWorkWebAccess = {
  hasAccess: boolean;
  accessSource: "subscription" | "complimentary" | null;
  complimentaryAccess: boolean;
  hasEligibleSubscription: boolean;
  hasOngoingSubscription: boolean;
  subscriptionStatus: string | null;
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
  /** Users the plan allows, counting pending invitations; null when nothing limits it. */
  userLimit: number | null;
  /** Display-only end date of a plan a platform admin set, YYYY-MM-DD. */
  endsAt: string | null;
  ended: boolean;
  paidBy: "none" | "stripe_team";
  features: AdminOrganizationFeatures | null;
  openworkWebAccess: AdminOpenWorkWebAccess;
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

function parseAdminOpenWorkWebAccess(value: unknown): AdminOpenWorkWebAccess {
  if (!isRecord(value)) {
    return {
      hasAccess: false,
      accessSource: null,
      complimentaryAccess: false,
      hasEligibleSubscription: false,
      hasOngoingSubscription: false,
      subscriptionStatus: null
    };
  }

  const accessSource = value.accessSource === "subscription" || value.accessSource === "complimentary"
    ? value.accessSource
    : null;
  return {
    hasAccess: value.hasAccess === true,
    accessSource,
    complimentaryAccess: value.complimentaryAccess === true,
    hasEligibleSubscription: value.hasEligibleSubscription === true,
    hasOngoingSubscription: value.hasOngoingSubscription === true,
    subscriptionStatus: toStringValue(value.subscriptionStatus)
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
      if (!isRecord(value) || typeof value.id !== "string" || typeof value.email !== "string" || typeof value.createdAt !== "string") {
        return null;
      }

      return {
        id: value.id,
        email: value.email,
        note: toStringValue(value.note),
        createdAt: value.createdAt
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
          billableSeatCount: toNumberValue(value.billableSeatCount),
          userLimit: typeof value.userLimit === "number" ? value.userLimit : null,
          endsAt: toStringValue(value.endsAt),
          ended: value.ended === true,
          paidBy: value.paidBy === "stripe_team" ? value.paidBy : "none",
          features: isRecord(value.featureStates) || isRecord(value.capabilities)
            ? parseAdminOrganizationFeatures(value.featureStates, value.capabilities)
            : null,
          openworkWebAccess: parseAdminOpenWorkWebAccess(value.openworkWebAccess)
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

function parseAdminInitialPayload(value: unknown, section: AdminDataSection): AdminPayload | null {
  if (section === "overview") return parseAdminPayload(value);
  const users = section === "users" ? parseAdminUsersPayload(value) : null;
  const organizations = section === "organizations" ? parseAdminOrganizationsPayload(value) : null;
  if (!users && !organizations) return null;
  return {
    viewer: { id: "", email: null, name: null },
    admins: [],
    summary: parseAdminSummary({
      totalUsers: users?.page.total ?? 0,
      totalOrganizations: organizations?.page.total ?? 0,
      billingLoaded: users?.billing.loaded ?? false,
      paidUsers: users?.billing.paidUsers,
      unpaidUsers: users?.billing.unpaidUsers,
      billingUnavailableUsers: users?.billing.billingUnavailableUsers,
    }, 0),
    users: users?.users ?? [],
    organizations: organizations?.organizations ?? [],
    userPage: users?.page ?? parseAdminPageInfo({}, 0, 0),
    organizationPage: organizations?.page ?? parseAdminPageInfo({}, 0, 0),
    generatedAt: users?.generatedAt ?? organizations?.generatedAt ?? null,
  };
}

function parseInferenceUsagePayload(payload: unknown): InferenceUsagePayload | null {
  if (!isRecord(payload) || !isRecord(payload.user) || typeof payload.user.id !== "string" || typeof payload.user.email !== "string" || !Array.isArray(payload.organizations)) {
    return null;
  }

  const organizations: InferenceUsageOrganization[] = [];
  for (const value of payload.organizations) {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.membershipId !== "string" || !Array.isArray(value.windows)) {
      return null;
    }

    const windows: InferenceUsageWindow[] = [];
    for (const window of value.windows) {
      if (!isRecord(window) || typeof window.bucketId !== "string" || typeof window.windowType !== "string" || typeof window.windowStartAt !== "string" || typeof window.windowEndAt !== "string") {
        return null;
      }
      windows.push({
        bucketId: window.bucketId,
        windowType: window.windowType,
        windowStartAt: window.windowStartAt,
        windowEndAt: window.windowEndAt,
        limitAmount: toNumberValue(window.limitAmount),
        organizationUsedAmount: toNumberValue(window.organizationUsedAmount),
        userUsedAmount: toNumberValue(window.userUsedAmount)
      });
    }
    organizations.push({ id: value.id, name: value.name, membershipId: value.membershipId, windows });
  }

  return { user: { id: payload.user.id, email: payload.user.email }, organizations };
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
      note: target ? "Covered by an active organization subscription." : "No cached organization subscription covers this user."
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

function buildFixtureOrganization(index: number, includeFeatures = false): AdminOrganization {
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
    userLimit: target ? 500 : 5,
    endsAt: null,
    ended: false,
    paidBy: "none",
    features: includeFeatures ? mapFeatures((key) => {
      const enabled = target && key === "workbotDocuments";
      return { enabled, source: "everyone", everyone: enabled, killed: false, override: null, overrideApplies: true };
    }) : null,
    openworkWebAccess: {
      hasAccess: target,
      accessSource: target ? "complimentary" : null,
      complimentaryAccess: target,
      hasEligibleSubscription: false,
      hasOngoingSubscription: false,
      subscriptionStatus: null
    }
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

export function adminScaleFixturePayload(path: string): unknown | null {
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
      organizations: organizations.rows.map(({ features: _features, ...organization }) => organization),
      page: fixturePageInfo(organizations.total, organizations.rows.length, offset, search, durationMs),
      generatedAt
    };
  }

  const featureOrganization = url.pathname.match(/^\/v1\/admin\/organizations\/org_(\d+)\/capabilities$/);
  if (featureOrganization) {
    return { featureStates: buildFixtureOrganization(Number(featureOrganization[1]), true).features };
  }

  if (url.pathname === "/v1/admin/overview") {
    const users = fixtureUsers("", 0, false);
    const durationMs = Math.round(performance.now() - startedAt);
    return {
      viewer: { id: "user_admin_fixture", email: "admin@example.com", name: "Admin Fixture" },
      admins: [{ id: "admin_fixture", email: "admin@example.com", note: "Eval fixture admin", createdAt: generatedAt }],
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

  const endpoint = denBrowserEndpoint(path);
  const response = await fetch(endpoint, {
    method: "GET",
    credentials: denApiCredentials(endpoint),
    signal,
    headers: withStoredBearer({
      Accept: "application/json"
    })
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

async function postJson(path: string, body: unknown) {
  const endpoint = denBrowserEndpoint(path);
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: denApiCredentials(endpoint),
    headers: withStoredBearer({
      Accept: "application/json",
      "Content-Type": "application/json"
    }),
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
  const endpoint = denBrowserEndpoint(path);
  const response = await fetch(endpoint, {
    method: "PUT",
    credentials: denApiCredentials(endpoint),
    headers: withStoredBearer({
      Accept: "application/json",
      "Content-Type": "application/json"
    }),
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
  const endpoint = denBrowserEndpoint(path);
  const response = await fetch(endpoint, {
    method: "DELETE",
    credentials: denApiCredentials(endpoint),
    headers: withStoredBearer({
      Accept: "application/json"
    })
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

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatUsageAmount(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: Math.abs(value) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: Math.abs(value) >= 10_000 ? 2 : 3
  }).format(value);
}

function formatWindowType(value: string): string {
  const normalized = value.toLowerCase().replace(/[-_]/g, " ");
  if (normalized.includes("five") || normalized.includes("5 hour") || normalized.includes("5h")) {
    return "Five-hour";
  }
  if (normalized.includes("week")) {
    return "Weekly";
  }
  if (normalized.includes("month")) {
    return "Monthly";
  }
  return formatProvider(value);
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
    <div className="py-2">
      <p className="text-xs font-medium text-slate-500">{label}</p>
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
    <div className="mt-4 border-t border-slate-200 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-slate-500">Active users · last 30 days</p>
        <p className="text-xs text-slate-500">
          <span className="mr-3 inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-md bg-slate-900/80" />Any activity</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-md bg-violet-500" />Real DAU (ran a task)</span>
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
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-sm text-slate-700">{value}</p>
    </div>
  );
}

function BillingPill({ billing }: { billing: AdminBillingStatus | null }) {
  if (!billing) {
    return (
      <span className="inline-flex items-center rounded-md border border-slate-200 bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500">
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
    <span className={`inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium ${palette}`}>
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
    <span className={`inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium ${palette}`}>
      {tier}
    </span>
  );
}

export function DenAdminPanel({ initialPayload, section }: { initialPayload: unknown; section: AdminDataSection }) {
  const viewMode = section;
  const { search: routeSearch, draftSearch, page: routePage, offset: routeOffset, setSearch, setPage } = useAdminListLocation();
  const userQuery = draftSearch;
  const organizationQuery = draftSearch;
  const [initial] = useState(() => parseAdminInitialPayload(initialPayload, section));
  const [accessState, setAccessState] = useState<AccessState>(initial ? "ready" : "error");
  const [payload, setPayload] = useState<AdminPayload | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [copiedOrgId, setCopiedOrgId] = useState<string | null>(null);
  const [includeBilling, setIncludeBilling] = useState(false);
  const [usersLoading, setUsersLoading] = useState(false);
  const [organizationsLoading, setOrganizationsLoading] = useState(false);
  const [deleteUserDialog, setDeleteUserDialog] = useState<AdminUser | null>(null);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const [adminEmail, setAdminEmail] = useState("");
  const [adminNote, setAdminNote] = useState("");
  const [adminMutationId, setAdminMutationId] = useState<string | null>(null);
  const [usageByUserId, setUsageByUserId] = useState<Record<string, InferenceUsageCacheEntry>>({});
  const [resetUsageDialog, setResetUsageDialog] = useState<AdminUser | null>(null);
  const [resettingUsageUserId, setResettingUsageUserId] = useState<string | null>(null);
  const [resetSuccessByUserId, setResetSuccessByUserId] = useState<Record<string, number>>({});
  const mountedAtRef = useRef<number | null>(null);
  const overviewRequestIdRef = useRef(0);
  const userRequestIdRef = useRef(0);
  const organizationRequestIdRef = useRef(0);
  const payloadRef = useRef<AdminPayload | null>(initial);
  const usageRequestsRef = useRef(new Set<string>());
  const overviewControllerRef = useRef<AbortController | null>(null);
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
    overviewControllerRef.current?.abort();
    const controller = new AbortController();
    overviewControllerRef.current = controller;
    setRefreshing(true);
    setError(null);

    try {
      const { response, payload: nextPayload } = await requestJson("/v1/admin/overview?limit=1", controller.signal);
      if (requestId !== overviewRequestIdRef.current) {
        return;
      }

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
      payloadRef.current = parsed;
      setAccessState("ready");
      setPayload(parsed);
    } catch (nextError) {
      if (requestId === overviewRequestIdRef.current && !isAbortError(nextError)) {
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

      setAccessState("ready");
      setIncludeBilling(parsed.billing.loaded);
      setPayload((current) => {
        if (!current) {
          return parseAdminInitialPayload(nextPayload, "users");
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
        includeFeatures: "0",
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

      setAccessState("ready");
      setPayload((current) => {
        if (!current) {
          return parseAdminInitialPayload(nextPayload, "organizations");
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

  const refreshCurrentPage = useCallback(() => {
    if (section === "users") return loadUsers(routeSearch, routeOffset, includeBillingRef.current);
    if (section === "organizations") return loadOrganizations(routeSearch, routeOffset);
    return loadOverview();
  }, [section, routeSearch, routeOffset, loadUsers, loadOrganizations, loadOverview]);

  const loadAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
    setError(null);

    try {
      const { response, payload: nextPayload } = await requestJson("/v1/admin/metrics");
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

  const loadInferenceUsage = useCallback(async (userId: string) => {
    if (usageRequestsRef.current.has(userId)) return;
    usageRequestsRef.current.add(userId);
    setUsageByUserId((current) => ({ ...current, [userId]: { status: "loading" } }));
    try {
      const { response, payload: nextPayload } = await requestJson(`/v1/admin/users/${encodeURIComponent(userId)}/inference-usage`);
      if (!response.ok) {
        const message = getErrorMessage(nextPayload, `Could not load model consumption (${response.status}).`);
        setUsageByUserId((current) => ({ ...current, [userId]: { status: "error", message } }));
        return;
      }
      const parsed = parseInferenceUsagePayload(nextPayload);
      if (!parsed) {
        setUsageByUserId((current) => ({ ...current, [userId]: { status: "error", message: "Model consumption payload was missing required fields." } }));
        return;
      }
      setUsageByUserId((current) => ({ ...current, [userId]: { status: "ready", data: parsed } }));
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : "Unknown network error";
      setUsageByUserId((current) => ({ ...current, [userId]: { status: "error", message } }));
    } finally {
      usageRequestsRef.current.delete(userId);
    }
  }, []);

  const addAdmin = useCallback(async () => {
    const email = adminEmail.trim();
    const note = adminNote.trim();
    if (!email) {
      setError("Enter an email address for the new platform admin.");
      return;
    }
    setAdminMutationId("add");
    setError(null);
    try {
      const { response, payload: nextPayload } = await postJson("/v1/admin/admins", note ? { email, note } : { email });
      const admin = isRecord(nextPayload) && isRecord(nextPayload.admin) ? nextPayload.admin : null;
      if (!response.ok || !admin || typeof admin.id !== "string" || typeof admin.email !== "string" || typeof admin.createdAt !== "string") {
        setError(getErrorMessage(nextPayload, `Could not add ${email}.`));
        return;
      }
      const entry: AdminEntry = { id: admin.id, email: admin.email, note: toStringValue(admin.note), createdAt: admin.createdAt };
      setPayload((current) => current ? {
        ...current,
        admins: [...current.admins, entry],
        summary: { ...current.summary, adminCount: current.summary.adminCount + 1 }
      } : current);
      setAdminEmail("");
      setAdminNote("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unknown network error");
    } finally {
      setAdminMutationId(null);
    }
  }, [adminEmail, adminNote]);

  const removeAdmin = useCallback(async (admin: AdminEntry) => {
    setAdminMutationId(admin.id);
    setError(null);
    try {
      const { response, payload: nextPayload } = await deleteJson(`/v1/admin/admins/${encodeURIComponent(admin.id)}`);
      if (!response.ok) {
        setError(getErrorMessage(nextPayload, `Could not remove ${admin.email}.`));
        return;
      }
      setPayload((current) => current ? {
        ...current,
        admins: current.admins.filter((entry) => entry.id !== admin.id),
        summary: { ...current.summary, adminCount: Math.max(0, current.summary.adminCount - 1) }
      } : current);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unknown network error");
    } finally {
      setAdminMutationId(null);
    }
  }, []);

  const resetInferenceUsage = useCallback(async () => {
    if (!resetUsageDialog) {
      return;
    }
    const userId = resetUsageDialog.id;
    setResettingUsageUserId(userId);
    setError(null);
    try {
      const { response, payload: nextPayload } = await postJson(`/v1/admin/users/${encodeURIComponent(userId)}/inference-usage/reset`, {});
      if (!response.ok || !isRecord(nextPayload) || typeof nextPayload.resetAmount !== "number") {
        setError(getErrorMessage(nextPayload, `Could not reset consumption for ${resetUsageDialog.email}.`));
        return;
      }
      const resetAmount = nextPayload.resetAmount;
      setResetSuccessByUserId((current) => ({ ...current, [userId]: resetAmount }));
      setResetUsageDialog(null);
      await loadInferenceUsage(userId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unknown network error");
    } finally {
      setResettingUsageUserId(null);
    }
  }, [loadInferenceUsage, resetUsageDialog]);

  useEffect(() => () => {
    overviewControllerRef.current?.abort();
    overviewRequestIdRef.current += 1;
  }, []);

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
    if (accessState !== "ready" || viewMode !== "users") return;
    const trimmedQuery = routeSearch.trim();
    const currentPage = payloadRef.current?.userPage;
    if (currentPage?.search === trimmedQuery && currentPage.offset === routeOffset) {
      setUsersLoading(false);
      return;
    }
    const requestId = ++userRequestIdRef.current;
    setUsersLoading(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void loadUsers(trimmedQuery, routeOffset, includeBillingRef.current, controller.signal, requestId);
    }, ADMIN_SEARCH_DEBOUNCE_MS);
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, [accessState, loadUsers, routeSearch, routeOffset, viewMode]);

  useEffect(() => {
    if (accessState !== "ready" || viewMode !== "organizations") return;
    const trimmedQuery = routeSearch.trim();
    const currentPage = payloadRef.current?.organizationPage;
    if (currentPage?.search === trimmedQuery && currentPage.offset === routeOffset) {
      setOrganizationsLoading(false);
      return;
    }
    const requestId = ++organizationRequestIdRef.current;
    setOrganizationsLoading(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void loadOrganizations(trimmedQuery, routeOffset, controller.signal, requestId);
    }, ADMIN_SEARCH_DEBOUNCE_MS);
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, [accessState, loadOrganizations, routeSearch, routeOffset, viewMode]);

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
      await refreshCurrentPage();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unknown network error");
    } finally {
      setDeletingUserId(null);
    }
  }, [deleteUserDialog, refreshCurrentPage]);

  const exportCsv = useCallback(() => {
    const date = new Date().toISOString().slice(0, 10);

    if (viewMode === "organizations") {
      downloadCsv(`den-organizations-${date}.csv`, [
        ["id", "name", "slug", "plan", "plan_source", "paid_by", "users", "user_limit", "ends_at", "free_seats", "additional_free_seats", "chargeable_seats", "created_at"],
        ...filteredOrganizations.map((org) => [
          org.id,
          org.name,
          org.slug,
          org.plan.tier,
          org.plan.source,
          org.paidBy,
          String(org.memberCount),
          org.userLimit === null ? "" : String(org.userLimit),
          org.endsAt ?? "",
          String(org.freeSeatCount),
          String(org.seatsFreeAdditional),
          String(org.billableSeatCount),
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

  const handleDashboardAccessDenied = useCallback((access: "signed-out" | "forbidden") => {
    setAccessState(access);
    setPayload(null);
  }, []);

  if (accessState === "signed-out" || accessState === "forbidden" || accessState === "error") {
    return <AdminAccessScreen state={accessState} message={error ?? undefined} onRetry={() => void refreshCurrentPage()} />;
  }

  if (!payload) {
    return null;
  }

  const analyticsLoaded = payload.summary.verifiedUsers !== null || payload.summary.activitySeries.length > 0;
  const pageDurationLabel = isAdminScaleFixtureEnabled() ? "fixture computation" : "server";

  return (
    <section data-testid="admin-data-page" className="mx-auto w-full max-w-6xl bg-white">
      <div className="border-b border-slate-200 pb-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-lg font-semibold text-slate-950">{section === "overview" ? "Overview" : section === "users" ? "Users" : "Organizations"}</h1>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {section === "overview" ? <p className="text-sm text-slate-600">{payload.viewer.email ?? payload.viewer.id}</p> : null}
            <button
              type="button"
              onClick={() => {
                void refreshCurrentPage();
              }}
              disabled={refreshing || usersLoading || organizationsLoading}
              className="inline-flex items-center justify-center rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
            {section !== "overview" ? (
              <button
                type="button"
                onClick={exportCsv}
                disabled={viewMode === "organizations" ? filteredOrganizations.length === 0 : filteredUsers.length === 0}
                className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Download size={15} strokeWidth={1.75} aria-hidden="true" />
                Export current page CSV
              </button>
            ) : null}

          </div>
        </div>

        {error ? (
          <div role="alert" className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
            {error}
          </div>
        ) : null}

        {section === "overview" ? <>
        <QuickFind />
        <AdminControlCenter onAccessDenied={handleDashboardAccessDenied} />
        <section aria-labelledby="admin-gateway-usage-title" className="border-t border-slate-200 pt-5">
          <h2 id="admin-gateway-usage-title" className="text-sm font-semibold text-slate-950">AI gateway usage</h2>
          <AdminDashboard quickFind={false} refreshKey={payload.generatedAt} totalOrganizations={payload.summary.totalOrganizations} totalUsers={payload.summary.totalUsers} onAccessDenied={handleDashboardAccessDenied} />
        </section>
        <details className="border-t border-slate-200 py-4">
          <summary className="w-fit cursor-pointer text-sm font-medium text-slate-700 focus-visible:outline-2 focus-visible:outline-slate-500">More analytics</summary>
          <div className="mt-4"><DenButton size="sm" variant="secondary" loading={analyticsLoading} onClick={() => void loadAnalytics()}>{analyticsLoaded ? "Refresh analytics" : "Load analytics"}</DenButton></div>
          {analyticsLoaded ? <><div className="mt-4 grid gap-4 sm:grid-cols-3">
            <StatCard label="New users" value={formatOptionalCount(payload.summary.recentUsers7d)} detail="Last 7 days" />
            <StatCard label="Task runners" value={formatOptionalCount(payload.summary.realActiveUsers30d)} detail="Last 30 days" />
            <StatCard label="Worker creators" value={formatOptionalCount(payload.summary.usersWithWorkers)} detail={`${formatOptionalCount(payload.summary.totalWorkers)} workers`} />
          </div><ActivityChart series={payload.summary.activitySeries} /></> : null}
        </details>
        <details className="border-t border-slate-200 py-4"><summary className="w-fit cursor-pointer text-sm font-medium text-slate-700 focus-visible:outline-2 focus-visible:outline-slate-500">Platform admins ({payload.summary.adminCount})</summary>
        <div className="pt-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-sm font-medium text-slate-700">Operator access</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-[minmax(12rem,1fr)_minmax(10rem,1fr)_auto]">
              <input
                type="email"
                data-testid="admin-add-email"
                value={adminEmail}
                onChange={(event) => setAdminEmail(event.target.value)}
                placeholder="Email"
                aria-label="Admin email"
                className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-hidden focus:border-slate-400"
              />
              <input
                data-testid="admin-add-note"
                value={adminNote}
                onChange={(event) => setAdminNote(event.target.value)}
                placeholder="Note (optional)"
                aria-label="Admin note"
                className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-hidden focus:border-slate-400"
              />
              <button
                type="button"
                data-testid="admin-add-action"
                onClick={() => void addAdmin()}
                disabled={adminMutationId !== null || !adminEmail.trim()}
                className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {adminMutationId === "add" ? "Adding..." : "Add admin"}
              </button>
            </div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {payload.admins.map((admin) => {
              const isViewer = admin.email.toLowerCase() === payload.viewer.email?.toLowerCase();
              return (
                <div key={admin.id} className="flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-white px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-800">{admin.email}{isViewer ? " · You" : ""}</p>
                    <p className="truncate text-xs text-slate-500">{admin.note ?? `Added ${formatDateTime(admin.createdAt)}`}</p>
                  </div>
                  {!isViewer ? (
                    <button
                      type="button"
                      data-testid={`admin-remove-${admin.id}`}
                      onClick={() => void removeAdmin(admin)}
                      disabled={adminMutationId !== null}
                      className="shrink-0 rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {adminMutationId === admin.id ? "Removing..." : "Remove"}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
        </details>
        </> : null}
      </div>

      {section !== "overview" ? <div className="py-5">

        {isAdminScaleFixtureEnabled() ? (
          <div data-testid="admin-scale-eval-status" className="mt-4 rounded-md border border-violet-200 bg-violet-50 px-4 py-3 text-sm leading-6 text-violet-900">
            Eval scale fixture active: 50,000 users · 60,000 organizations · first pages capped at 50. Browser usable {overviewUsableMs === null ? "measuring" : `${overviewUsableMs} ms`}. Real database budget command: pnpm benchmark:admin-scale:mysql (500 ms initial, 300 ms searches).
          </div>
        ) : null}

        {(viewMode === "users" && usersLoading) || (viewMode === "organizations" && organizationsLoading) ? (
          <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600" aria-busy="true">
            Loading the bounded page…
          </div>
        ) : null}

        {viewMode === "organizations" ? (
          <div className="grid gap-4" data-testid="admin-orgs-page">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <label className="relative block w-full max-w-xl">
                <span className="sr-only">Search organizations</span>
                <Search size={16} strokeWidth={1.75} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  maxLength={160}
                  aria-label="Search organizations"
                  value={organizationQuery}
                  onChange={(event) => {
                    overviewRequestIdRef.current += 1;
                    setRefreshing(false);
                    organizationRequestIdRef.current += 1;
                    organizationSearchStartedAtRef.current = performance.now();
                    setOrganizationVisibleDurationMs(null);
                    setSearch(event.target.value);
                  }}
                  placeholder="Search by name, slug, or id"
                  className="w-full rounded-md border border-slate-200 bg-white py-2.5 pl-9 pr-4 text-sm text-slate-900 outline-hidden transition focus:border-slate-400"
                />
              </label>
              <div className="flex shrink-0 items-center gap-3">
                <p className="text-xs tabular-nums text-slate-500" title={`${pageDurationLabel} ${payload.organizationPage.durationMs} ms${organizationVisibleDurationMs === null ? "" : ` · browser visible ${organizationVisibleDurationMs} ms`}`}>
                  {payload.organizationPage.total === 0
                    ? "No matches"
                    : `${formatCount(payload.organizationPage.offset + 1)}–${formatCount(payload.organizationPage.offset + payload.organizationPage.returned)} of ${formatCount(payload.organizationPage.total)}`}
                </p>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setPage(Math.max(1, routePage - 1));
                    }}
                    disabled={organizationsLoading || payload.organizationPage.offset === 0}
                    className="inline-flex items-center justify-center rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPage(routePage + 1);
                    }}
                    disabled={organizationsLoading || !payload.organizationPage.hasMore}
                    className="inline-flex items-center justify-center rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>
            <AdminRecentOrganizationsStrip />
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="grid w-full max-w-xl gap-2">
              <label className="grid gap-2">
                <span className="text-xs font-medium text-slate-500">Search users</span>
                <input
                  maxLength={160}
                  aria-label="Search users"
                  value={userQuery}
                  onChange={(event) => {
                    overviewRequestIdRef.current += 1;
                    setRefreshing(false);
                    userRequestIdRef.current += 1;
                    userSearchStartedAtRef.current = performance.now();
                    setUserVisibleDurationMs(null);
                    setSearch(event.target.value);
                  }}
                  placeholder="Email, name, user id, provider, organization"
                  className="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-hidden transition focus:border-slate-400"
                />
              </label>
              <p className="text-xs leading-5 text-slate-500">
                Page {routePage} · {payload.userPage.total} matching users · {pageDurationLabel} {payload.userPage.durationMs} ms{userVisibleDurationMs === null ? "" : ` · browser visible ${userVisibleDurationMs} ms`}
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
                  className="inline-flex items-center justify-center rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Load billing for page
                </button>
              ) : (
                <p className="self-center text-sm text-slate-500">Billing loaded for this page only.</p>
              )}
              <button
                type="button"
                onClick={() => {
                  setPage(Math.max(1, routePage - 1));
                }}
                disabled={usersLoading || payload.userPage.offset === 0}
                className="inline-flex items-center justify-center rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => {
                  setPage(routePage + 1);
                }}
                disabled={usersLoading || !payload.userPage.hasMore}
                className="inline-flex items-center justify-center rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Next
              </button>
            </div>
          </div>
        )}

        <div className="mt-6 grid gap-3">
          {viewMode === "organizations" ? (
            filteredOrganizations.length > 0 ? (
              <div className="min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white">
                <div aria-hidden="true" className="hidden border-b border-slate-200 bg-slate-50/80 px-4 py-2 text-xs font-medium text-slate-500 lg:grid lg:grid-cols-[minmax(0,1fr)_12rem_12rem] lg:gap-4 xl:grid-cols-[minmax(0,1fr)_12rem_7rem_12rem]">
                  <span>Organization</span><span>Users</span><span className="hidden xl:block">Created</span><span className="text-right">Actions</span>
                </div>
                <ul className="divide-y divide-slate-200">
                {filteredOrganizations.map((org) => {
              const limited = org.paidBy === "none" && org.userLimit !== null;
              const full = limited && org.userLimit !== null && org.memberCount >= org.userLimit;
              const share = limited && org.userLimit ? Math.min(100, Math.round((org.memberCount / org.userLimit) * 100)) : 0;
              const endLabel = planEndLabel(org.endsAt, org.ended);

              return (
                <li key={org.id} data-testid={`admin-org-row-${org.slug}`} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 64px" }} className="min-w-0">
                  <div className="grid min-w-0 grid-cols-2 items-center gap-3 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_12rem_12rem] lg:gap-4 xl:grid-cols-[minmax(0,1fr)_12rem_7rem_12rem]">
                    <div className="col-span-2 min-w-0 lg:col-span-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <Link href={adminOrganizationHref(org.id, routeSearch, routePage)} prefetch={false} className="min-w-0 truncate text-sm font-semibold text-slate-950 hover:underline">{org.name}</Link>
                        <PlanPill tier={org.plan.tier} />
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-slate-500">
                        <span className="min-w-0 truncate font-mono">{org.slug && org.slug !== org.id ? `/${org.slug} · ${org.id}` : org.id}</span>
                        <button
                          type="button"
                          aria-label={`Copy id for ${org.name}`}
                          title="Copy organization id"
                          onClick={() => {
                            void copyOrgId(org.id);
                          }}
                          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                        >
                          {copiedOrgId === org.id ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                        </button>
                      </div>
                    </div>

                    <div className="min-w-0" data-testid={`admin-org-users-${org.slug}`}>
                      <p className="text-sm tabular-nums text-slate-700">
                        {limited && org.userLimit !== null
                          ? <>{formatCount(org.memberCount)} / {formatCount(org.userLimit)}{endLabel ? <span className={org.ended ? "text-amber-700" : "text-slate-500"}> · {endLabel}</span> : null}</>
                          : <>{formatCount(org.memberCount)} <span className="text-slate-500">· {org.paidBy === "none" ? "no limit" : "paid in Stripe"}</span></>}
                      </p>
                      {limited ? (
                        <div className="mt-1 h-1 w-full max-w-[8rem] overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
                          <div className={`h-full rounded-full ${full ? "bg-slate-700" : "bg-slate-400"}`} style={{ width: `${Math.max(share, 4)}%` }} />
                        </div>
                      ) : null}
                    </div>

                    <p className="text-sm text-slate-600 lg:hidden xl:block" title={formatDateTime(org.createdAt)}><span className="xl:hidden">Created </span>{org.createdAt ? formatRelativeTime(org.createdAt) : "—"}</p>

                    <div className="col-span-2 flex flex-wrap items-center justify-end gap-1 lg:col-span-1">
                      <Link href={adminOrganizationHref(org.id, routeSearch, routePage, "features")} prefetch={false}
                        data-testid="admin-organization-features-link" className="rounded-md px-2.5 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-950">
                        Features
                      </Link>
                      <Link href={adminOrganizationHref(org.id, routeSearch, routePage, "billing")} prefetch={false}
                        data-testid="admin-organization-billing-link" aria-label={`Billing for ${org.name}`} className="rounded-md px-2.5 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-950">
                        Billing
                      </Link>
                    </div>
                  </div>
                </li>
              );
                })}
                </ul>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-5 py-10 text-center">
                <p className="text-base font-semibold text-slate-950">No organizations match</p>
                <p className="mt-2 text-sm leading-7 text-slate-500">Try a different name, slug, or id.</p>
              </div>
            )
          ) : filteredUsers.length > 0 ? filteredUsers.map((user) => {
            const isSelected = user.id === selectedUser?.id;
            const usageEntry = usageByUserId[user.id];

            return (
              <div
                key={user.id}
                data-testid={`admin-user-row-${user.id}`}
                style={isSelected ? undefined : { contentVisibility: "auto", containIntrinsicSize: "auto 180px" }}
                className={`min-w-0 rounded-md border px-4 py-4 transition ${isSelected ? "border-slate-900 bg-slate-50" : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/70"}`}
              >
                <button type="button" onClick={() => setSelectedUserId(user.id)} className="block w-full text-left">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-base font-semibold text-slate-950">{user.name?.trim() || user.email}</p>
                        {user.emailVerified ? (
                          <span className="inline-flex items-center rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[0.66rem] font-medium text-emerald-700">
                            Verified
                          </span>
                        ) : null}
                        {user.isRecurring ? (
                          <span className="inline-flex items-center rounded-md border border-sky-200 bg-sky-50 px-2 py-0.5 text-[0.66rem] font-medium text-sky-700">
                            Recurring
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 truncate text-sm text-slate-500">{user.email}</p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <BillingPill billing={user.billing} />
                      <span className="inline-flex items-center rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600">
                        {user.workerCount} workers
                      </span>
                      <span className="inline-flex items-center rounded-md border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700">
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
                        <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-4">
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
                            className="mt-3 inline-flex items-center justify-center rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Load billing for page
                          </button>
                        </div>
                      )}
                    </div>

                    <AdminDeferredContent
                      key={user.id}
                      label={`Model consumption for ${user.email}`}
                      className="lg:col-span-2"
                      placeholderClassName="min-h-48"
                      onVisible={() => { if (!usageEntry) void loadInferenceUsage(user.id); }}
                    >
                      {() => (
                        <div data-testid="admin-usage-section" className="rounded-md border border-slate-200 bg-white px-4 py-4 lg:col-span-2">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <p className="text-xs font-medium text-slate-500">OpenWork model consumption</p>
                              <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
                                Limits are shared by everyone in each organization. Reset only forgives this user&apos;s consumption in the current windows; it does not change shared limits or other members&apos; usage.
                              </p>
                            </div>
                            <button
                              type="button"
                              data-testid="admin-usage-reset-open"
                              onClick={() => setResetUsageDialog(user)}
                              disabled={usageEntry?.status !== "ready" || usageEntry.data.organizations.length === 0}
                              className="shrink-0 rounded-md border border-amber-200 bg-white px-4 py-2 text-sm font-semibold text-amber-800 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Reset consumption
                            </button>
                          </div>

                          {resetSuccessByUserId[user.id] !== undefined ? (
                            <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                              Reset complete. Forgave {formatUsageAmount(resetSuccessByUserId[user.id])} units from this user&apos;s current windows.
                            </p>
                          ) : null}

                          {!usageEntry || usageEntry.status === "loading" ? (
                            <p className="mt-4 text-sm text-slate-500" aria-busy="true">Loading model consumption…</p>
                          ) : usageEntry.status === "error" ? (
                            <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
                              <p>{usageEntry.message}</p>
                              <button type="button" onClick={() => void loadInferenceUsage(user.id)} className="mt-2 font-semibold underline">Retry</button>
                            </div>
                          ) : usageEntry.data.organizations.length === 0 ? (
                            <p className="mt-4 rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-5 text-center text-sm text-slate-500">No organization consumption windows are available for this user.</p>
                          ) : (
                            <div className="mt-4 grid gap-3">
                              {usageEntry.data.organizations.map((organization) => (
                                <div key={organization.membershipId} className="rounded-md border border-slate-200 bg-slate-50/70 p-3">
                                  <p className="text-sm font-semibold text-slate-950">{organization.name}</p>
                                  <p className="mt-0.5 truncate font-mono text-xs text-slate-400">{organization.id}</p>
                                  {organization.windows.length === 0 ? (
                                    <p className="mt-3 text-sm text-slate-500">No current five-hour, weekly, or monthly windows.</p>
                                  ) : (
                                    <div className="mt-3 grid gap-2 md:grid-cols-3">
                                      {organization.windows.map((window) => (
                                        <div key={window.bucketId} className="rounded-md border border-slate-200 bg-white p-3">
                                          <p className="text-xs font-semibold text-slate-800">{formatWindowType(window.windowType)}</p>
                                          <p className="mt-2 text-sm text-slate-700">User: <strong>{formatUsageAmount(window.userUsedAmount)}</strong></p>
                                          <p className="mt-1 text-xs text-slate-500">Shared: {formatUsageAmount(window.organizationUsedAmount)} / {formatUsageAmount(window.limitAmount)}</p>
                                          <p className="mt-2 text-xs leading-5 text-slate-400">Resets {formatDateTime(window.windowEndAt)}</p>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </AdminDeferredContent>

                    <div className="rounded-md border border-slate-200 bg-white px-4 py-4 lg:col-span-2">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="text-xs font-medium text-slate-500">Organizations</p>
                          <p className="mt-1 text-sm text-slate-600">
                            {user.organizations.length > 0
                              ? `${user.email} is a member of ${user.organizations.length} organization${user.organizations.length === 1 ? "" : "s"}.`
                              : `${user.email} is not an active member of any organization.`}
                          </p>
                        </div>
                        {user.organizations.length > 0 ? (
                          <span className="inline-flex items-center rounded-md border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700">
                            {user.organizations.length} total
                          </span>
                        ) : null}
                      </div>

                      <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <p className="text-sm font-semibold text-red-950">Delete user</p>
                            <p className="mt-1 text-sm leading-6 text-red-700">Removes this user account, active sessions, auth records, and org memberships.</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => setDeleteUserDialog(user)}
                            disabled={deletingUserId === user.id}
                            className="inline-flex items-center justify-center gap-2 rounded-md border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-700 transition hover:border-red-300 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <Trash2 size={15} aria-hidden="true" />
                            {deletingUserId === user.id ? "Deleting..." : "Delete user"}
                          </button>
                        </div>
                      </div>

                      {user.organizations.length > 0 ? (
                        <div className="mt-3 grid gap-2">
                          {user.organizations.map((org) => (
                            <div key={org.id} className="rounded-md border border-slate-200 bg-slate-50/70 px-3 py-3">
                              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-semibold text-slate-950">{org.name}</p>
                                  <p className="mt-1 truncate font-mono text-xs text-slate-500">{org.id}</p>
                                </div>

                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="inline-flex items-center rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600">
                                    {formatProvider(org.role)}
                                  </span>
                                  <span className="inline-flex items-center rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600">
                                    {org.memberCount} {org.memberCount === 1 ? "member" : "members"}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      void copyOrgId(org.id);
                                    }}
                                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-slate-300"
                                  >
                                    <Copy size={13} aria-hidden="true" />
                                    {copiedOrgId === org.id ? "Copied" : "Copy ID"}
                                  </button>
                                  <Link
                                    href={`/admin/organizations/${encodeURIComponent(org.id)}`}
                                    prefetch={false}
                                    className="inline-flex items-center justify-center rounded-md bg-slate-950 px-3 py-1.5 text-xs font-semibold text-white"
                                  >
                                    View org
                                  </Link>
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
            <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-5 py-10 text-center">
              <p className="text-base font-semibold text-slate-950">No users match the current filters</p>
              <p className="mt-2 text-sm leading-7 text-slate-500">Try broadening search or relaxing the worker and billing filters.</p>
            </div>
          )}
        </div>

        <p className="mt-6 text-xs leading-6 text-slate-500">Snapshot generated {formatDateTime(payload.generatedAt)}.</p>
      </div> : null}

      {deleteUserDialog ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-user-dialog-title"
          onClick={() => setDeleteUserDialog(null)}
        >
          <div className="w-full max-w-md rounded-lg border border-red-100 bg-white p-6 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-red-500">Danger zone</p>
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
                className="inline-flex items-center justify-center rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void deleteUser();
                }}
                disabled={deletingUserId === deleteUserDialog.id}
                className="inline-flex items-center justify-center rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {deletingUserId === deleteUserDialog.id ? "Deleting..." : "Delete user"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {resetUsageDialog ? (
        <div
          data-testid="admin-usage-reset-confirmation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reset-usage-dialog-title"
          onClick={() => setResetUsageDialog(null)}
        >
          <div className="w-full max-w-md rounded-lg border border-amber-100 bg-white p-6 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-600">Model consumption</p>
            <h2 id="reset-usage-dialog-title" className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950">
              Reset {resetUsageDialog.email}?
            </h2>
            <p className="mt-3 text-sm leading-7 text-slate-600">
              This forgives only this user&apos;s consumption in the current five-hour, weekly, and monthly windows. Organization limits remain shared and other members&apos; consumption is unchanged.
            </p>
            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <button
                type="button"
                onClick={() => setResetUsageDialog(null)}
                disabled={resettingUsageUserId === resetUsageDialog.id}
                className="rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="admin-usage-reset-action"
                onClick={() => void resetInferenceUsage()}
                disabled={resettingUsageUserId === resetUsageDialog.id}
                className="rounded-md bg-amber-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {resettingUsageUserId === resetUsageDialog.id ? "Resetting..." : "Reset consumption"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
