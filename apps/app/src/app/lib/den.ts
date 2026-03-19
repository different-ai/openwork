import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauriRuntime } from "../utils";

const STORAGE_BASE_URL = "openwork.den.baseUrl";
const STORAGE_API_BASE_URL = "openwork.den.apiBaseUrl";
const STORAGE_AUTH_TOKEN = "openwork.den.authToken";
const STORAGE_ACTIVE_ORG_ID = "openwork.den.activeOrgId";
const DEFAULT_DEN_TIMEOUT_MS = 12_000;

export const DEN_BASE_URL_STORAGE_KEY = STORAGE_BASE_URL;
export const DEN_API_BASE_URL_STORAGE_KEY = STORAGE_API_BASE_URL;
export const DEN_AUTH_TOKEN_STORAGE_KEY = STORAGE_AUTH_TOKEN;
export const DEN_ACTIVE_ORG_ID_STORAGE_KEY = STORAGE_ACTIVE_ORG_ID;

export const DEFAULT_DEN_AUTH_NAME = "OpenWork User";
export const ENV_DEN_BASE_URL = (() => {
  const rawValue =
    typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_DEN_BASE_URL === "string"
      ? import.meta.env.VITE_DEN_BASE_URL.trim()
      : "";
  if (!rawValue) {
    return null;
  }

  try {
    const url = new URL(rawValue);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
})();
export const DEFAULT_DEN_BASE_URL =
  ENV_DEN_BASE_URL ?? "https://app.openworklabs.com";

export type DenSettings = {
  baseUrl: string;
  apiBaseUrl?: string;
  authToken?: string | null;
  activeOrgId?: string | null;
};

type DenBaseUrls = {
  baseUrl: string;
  apiBaseUrl: string;
};

export type DenUser = {
  id: string;
  email: string;
  name: string | null;
};

export type DenOrgSummary = {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "member";
};

export type DenWorkerSummary = {
  workerId: string;
  workerName: string;
  status: string;
  instanceUrl: string | null;
  provider: string | null;
  isMine: boolean;
  createdAt: string | null;
};

export type DenWorkerTokens = {
  clientToken: string | null;
  ownerToken: string | null;
  hostToken: string | null;
  openworkUrl: string | null;
  workspaceId: string | null;
};

export type DenWorkerLaunch = {
  workerId: string;
  workerName: string;
  status: string;
  provider: string | null;
  instanceUrl: string | null;
  openworkUrl: string | null;
  workspaceId: string | null;
  clientToken: string | null;
  ownerToken: string | null;
  hostToken: string | null;
};

export type DenRuntimeServiceName =
  | "openwork-server"
  | "opencode"
  | "opencode-router";

export type DenWorkerRuntimeService = {
  name: DenRuntimeServiceName;
  enabled: boolean;
  running: boolean;
  targetVersion: string | null;
  actualVersion: string | null;
  upgradeAvailable: boolean;
};

export type DenWorkerRuntimeSnapshot = {
  services: DenWorkerRuntimeService[];
  upgrade: {
    status: "idle" | "running" | "failed";
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
  };
};

export type DenSocialProvider = "github" | "google";

export type DenDesktopHandoffGrant = {
  grant: string;
  expiresAt: string | null;
  openworkUrl: string | null;
};

export type DenWorkerCreateInput = {
  name: string;
  description?: string;
  destination: "local" | "cloud";
  workspacePath?: string;
  sandboxBackend?: string;
  imageVersion?: string;
};

export type DenWorkerCreateResult =
  | {
      kind: "success";
      worker: DenWorkerLaunch;
      launchMode: "async" | "instant";
      pollAfterMs: number;
    }
  | {
      kind: "paywall";
      checkoutUrl: string | null;
      productId: string | null;
      benefitId: string | null;
    };

export type DenAdminBillingStatus = {
  status: "paid" | "unpaid" | "unavailable";
  featureGateEnabled: boolean;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  source: "benefit" | "subscription" | "unavailable";
  note: string | null;
};

export type DenAdminEntry = {
  email: string;
  note: string | null;
};

export type DenAdminSummary = {
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

export type DenAdminUser = {
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
  billing: DenAdminBillingStatus | null;
};

export type DenAdminOverview = {
  viewer: {
    id: string;
    email: string | null;
    name: string | null;
  };
  admins: DenAdminEntry[];
  summary: DenAdminSummary;
  users: DenAdminUser[];
  generatedAt: string | null;
};

export type DenBillingPrice = {
  amount: number | null;
  currency: string | null;
  recurringInterval: string | null;
  recurringIntervalCount: number | null;
};

export type DenBillingSubscription = {
  id: string;
  status: string;
  amount: number | null;
  currency: string | null;
  recurringInterval: string | null;
  recurringIntervalCount: number | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  endedAt: string | null;
};

export type DenBillingInvoice = {
  id: string;
  createdAt: string | null;
  status: string;
  totalAmount: number | null;
  currency: string | null;
  invoiceNumber: string | null;
  invoiceUrl: string | null;
};

export type DenBillingSummary = {
  featureGateEnabled: boolean;
  hasActivePlan: boolean;
  checkoutRequired: boolean;
  checkoutUrl: string | null;
  portalUrl: string | null;
  price: DenBillingPrice | null;
  subscription: DenBillingSubscription | null;
  invoices: DenBillingInvoice[];
  productId: string | null;
  benefitId: string | null;
};

type DenAuthResult = {
  user: DenUser | null;
  token: string | null;
};

export type DenDesktopHandoffExchange = {
  user: DenUser | null;
  token: string | null;
};

type RawJsonResponse<T> = {
  ok: boolean;
  status: number;
  json: T | null;
  headers: Headers;
};

export class DenApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "DenApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeDenBaseUrl(input: string | null | undefined): string | null {
  const value = (input ?? "").trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function isWebAppHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "app.openworklabs.com" || normalized === "app.openwork.software" || normalized.startsWith("app.");
}

function stripDenApiBasePath(input: string | null | undefined): string | null {
  const normalized = normalizeDenBaseUrl(input);
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const pathname = url.pathname.replace(/\/+$/, "");
    const suffix = "/api/den";
    if (!pathname.toLowerCase().endsWith(suffix)) {
      return normalized;
    }

    const nextPathname = pathname.slice(0, -suffix.length) || "/";
    url.pathname = nextPathname;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return normalized;
  }
}

function ensureDenApiBasePath(input: string | null | undefined): string | null {
  const normalized = normalizeDenBaseUrl(input);
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (pathname.toLowerCase().endsWith("/api/den")) {
      return normalized;
    }
    url.pathname = `${pathname}/api/den`.replace(/\/+/g, "/");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return normalized;
  }
}

function deriveDenApiBaseUrl(input: string | null | undefined): string {
  const normalized = normalizeDenBaseUrl(input) ?? DEFAULT_DEN_BASE_URL;

  try {
    const url = new URL(normalized);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (pathname.toLowerCase().endsWith("/api/den")) {
      return normalized;
    }
    if (isWebAppHost(url.hostname)) {
      return ensureDenApiBasePath(normalized) ?? normalized;
    }
  } catch {
    return normalized;
  }

  return normalized;
}

export function resolveDenBaseUrls(input: { baseUrl?: string | null; apiBaseUrl?: string | null } | string | null | undefined): DenBaseUrls {
  const rawBaseUrl = typeof input === "string" ? input : input?.baseUrl;
  const rawApiBaseUrl = typeof input === "string" ? null : input?.apiBaseUrl;
  const normalizedBaseUrl = normalizeDenBaseUrl(rawBaseUrl);
  const normalizedApiBaseUrl = normalizeDenBaseUrl(rawApiBaseUrl);
  const seedUrl = normalizedBaseUrl ?? normalizedApiBaseUrl ?? DEFAULT_DEN_BASE_URL;

  return {
    baseUrl: stripDenApiBasePath(normalizedBaseUrl ?? seedUrl) ?? DEFAULT_DEN_BASE_URL,
    apiBaseUrl: normalizedApiBaseUrl ?? deriveDenApiBaseUrl(seedUrl),
  };
}

function resolveRequestBaseUrl(baseUrls: DenBaseUrls, path: string): string {
  return path.startsWith("/api/") ? baseUrls.baseUrl : baseUrls.apiBaseUrl;
}

export function readDenSettings(): DenSettings {
  if (typeof window === "undefined") {
    return resolveDenBaseUrls(DEFAULT_DEN_BASE_URL);
  }

  const baseUrls = resolveDenBaseUrls({
    baseUrl: window.localStorage.getItem(STORAGE_BASE_URL) ?? "",
    apiBaseUrl: window.localStorage.getItem(STORAGE_API_BASE_URL) ?? "",
  });

  return {
    ...baseUrls,
    authToken: (window.localStorage.getItem(STORAGE_AUTH_TOKEN) ?? "").trim() || null,
    activeOrgId: (window.localStorage.getItem(STORAGE_ACTIVE_ORG_ID) ?? "").trim() || null,
  };
}

export function readStoredDenBaseUrls(): {
  baseUrl: string | null;
  apiBaseUrl: string | null;
} {
  if (typeof window === "undefined") {
    return {
      baseUrl: null,
      apiBaseUrl: null,
    };
  }

  return {
    baseUrl: normalizeDenBaseUrl(window.localStorage.getItem(STORAGE_BASE_URL) ?? ""),
    apiBaseUrl: normalizeDenBaseUrl(window.localStorage.getItem(STORAGE_API_BASE_URL) ?? ""),
  };
}

export function writeDenSettings(next: DenSettings) {
  if (typeof window === "undefined") {
    return;
  }

  const { baseUrl, apiBaseUrl } = resolveDenBaseUrls(next);
  const authToken = next.authToken?.trim() ?? "";
  const activeOrgId = next.activeOrgId?.trim() ?? "";

  window.localStorage.setItem(STORAGE_BASE_URL, baseUrl);
  window.localStorage.setItem(STORAGE_API_BASE_URL, apiBaseUrl);
  if (authToken) {
    window.localStorage.setItem(STORAGE_AUTH_TOKEN, authToken);
  } else {
    window.localStorage.removeItem(STORAGE_AUTH_TOKEN);
  }

  if (activeOrgId) {
    window.localStorage.setItem(STORAGE_ACTIVE_ORG_ID, activeOrgId);
  } else {
    window.localStorage.removeItem(STORAGE_ACTIVE_ORG_ID);
  }
}

export function clearDenSession(options?: { includeBaseUrls?: boolean }) {
  if (typeof window === "undefined") {
    return;
  }

  if (options?.includeBaseUrls) {
    window.localStorage.removeItem(STORAGE_BASE_URL);
    window.localStorage.removeItem(STORAGE_API_BASE_URL);
  }

  window.localStorage.removeItem(STORAGE_AUTH_TOKEN);
  window.localStorage.removeItem(STORAGE_ACTIVE_ORG_ID);
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

function getUser(payload: unknown): DenUser | null {
  if (!isRecord(payload) || !isRecord(payload.user)) {
    return null;
  }

  const user = payload.user;
  if (typeof user.id !== "string" || typeof user.email !== "string") {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    name: typeof user.name === "string" ? user.name : null,
  };
}

function getToken(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.token !== "string") {
    return null;
  }
  return payload.token.trim() || null;
}

function getCheckoutUrl(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.polar)) {
    return null;
  }
  return typeof payload.polar.checkoutUrl === "string" ? payload.polar.checkoutUrl : null;
}

function getOrgList(payload: unknown): DenOrgSummary[] {
  if (!isRecord(payload) || !Array.isArray(payload.orgs)) {
    return [];
  }

  return payload.orgs
    .map((entry) => {
      if (!isRecord(entry)) return null;
      if (
        typeof entry.id !== "string" ||
        typeof entry.name !== "string" ||
        typeof entry.slug !== "string" ||
        (entry.role !== "owner" && entry.role !== "member")
      ) {
        return null;
      }

      return {
        id: entry.id,
        name: entry.name,
        slug: entry.slug,
        role: entry.role,
      } satisfies DenOrgSummary;
    })
    .filter((entry): entry is DenOrgSummary => Boolean(entry));
}

function getWorkers(payload: unknown): DenWorkerSummary[] {
  if (!isRecord(payload) || !Array.isArray(payload.workers)) {
    return [];
  }

  return payload.workers
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const instance = isRecord(entry.instance) ? entry.instance : null;
      if (typeof entry.id !== "string" || typeof entry.name !== "string") {
        return null;
      }
      return {
        workerId: entry.id,
        workerName: entry.name,
        status: typeof entry.status === "string" ? entry.status : "unknown",
        instanceUrl: instance && typeof instance.url === "string" ? instance.url : null,
        provider: instance && typeof instance.provider === "string" ? instance.provider : null,
        isMine: Boolean(entry.isMine),
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : null,
      } satisfies DenWorkerSummary;
    })
    .filter((entry): entry is DenWorkerSummary => Boolean(entry));
}

function getWorkerTokens(payload: unknown): DenWorkerTokens | null {
  if (!isRecord(payload) || !isRecord(payload.tokens)) {
    return null;
  }

  const tokens = payload.tokens;
  const connect = isRecord(payload.connect) ? payload.connect : null;
  return {
    clientToken: typeof tokens.client === "string" ? tokens.client : null,
    ownerToken: typeof tokens.owner === "string" ? tokens.owner : null,
    hostToken: typeof tokens.host === "string" ? tokens.host : null,
    openworkUrl: connect && typeof connect.openworkUrl === "string" ? connect.openworkUrl : null,
    workspaceId: connect && typeof connect.workspaceId === "string" ? connect.workspaceId : null,
  };
}

function getEffectiveWorkerStatus(
  workerStatus: unknown,
  instance: Record<string, unknown> | null,
): string {
  const normalizedWorkerStatus = typeof workerStatus === "string" ? workerStatus : "unknown";
  const normalized = normalizedWorkerStatus.trim().toLowerCase();
  const instanceStatus =
    instance && typeof instance.status === "string"
      ? instance.status.trim().toLowerCase()
      : null;

  if (!instanceStatus) {
    return normalizedWorkerStatus;
  }

  if (normalized === "provisioning" || normalized === "starting") {
    return instanceStatus;
  }

  return normalizedWorkerStatus;
}

function getWorker(payload: unknown): DenWorkerLaunch | null {
  if (!isRecord(payload) || !isRecord(payload.worker)) {
    return null;
  }

  const worker = payload.worker;
  if (typeof worker.id !== "string" || typeof worker.name !== "string") {
    return null;
  }

  const instance = isRecord(payload.instance) ? payload.instance : null;
  const tokens = isRecord(payload.tokens) ? payload.tokens : null;

  return {
    workerId: worker.id,
    workerName: worker.name,
    status: getEffectiveWorkerStatus(worker.status, instance),
    provider: instance && typeof instance.provider === "string" ? instance.provider : null,
    instanceUrl: instance && typeof instance.url === "string" ? instance.url : null,
    openworkUrl: instance && typeof instance.url === "string" ? instance.url : null,
    workspaceId: null,
    clientToken: tokens && typeof tokens.client === "string" ? tokens.client : null,
    ownerToken: tokens && typeof tokens.owner === "string" ? tokens.owner : null,
    hostToken: tokens && typeof tokens.host === "string" ? tokens.host : null,
  };
}

function getWorkerSummary(payload: unknown): DenWorkerSummary | null {
  if (!isRecord(payload) || !isRecord(payload.worker)) {
    return null;
  }

  const worker = payload.worker;
  if (typeof worker.id !== "string" || typeof worker.name !== "string") {
    return null;
  }

  const instance = isRecord(payload.instance) ? payload.instance : null;

  return {
    workerId: worker.id,
    workerName: worker.name,
    status: getEffectiveWorkerStatus(worker.status, instance),
    instanceUrl: instance && typeof instance.url === "string" ? instance.url : null,
    provider: instance && typeof instance.provider === "string" ? instance.provider : null,
    isMine: worker.isMine === true,
    createdAt: typeof worker.createdAt === "string" ? worker.createdAt : null,
  };
}

function getWorkerRuntimeSnapshot(payload: unknown): DenWorkerRuntimeSnapshot | null {
  if (!isRecord(payload) || !Array.isArray(payload.services)) {
    return null;
  }

  const services = payload.services
    .map((value) => {
      if (!isRecord(value) || typeof value.name !== "string") {
        return null;
      }

      const name = value.name;
      if (
        name !== "openwork-server" &&
        name !== "opencode" &&
        name !== "opencode-router"
      ) {
        return null;
      }

      return {
        name,
        enabled: value.enabled === true,
        running: value.running === true,
        targetVersion:
          typeof value.targetVersion === "string" ? value.targetVersion : null,
        actualVersion:
          typeof value.actualVersion === "string" ? value.actualVersion : null,
        upgradeAvailable: value.upgradeAvailable === true,
      } satisfies DenWorkerRuntimeService;
    })
    .filter((item): item is DenWorkerRuntimeService => item !== null);

  const upgrade = isRecord(payload.upgrade) ? payload.upgrade : null;

  return {
    services,
    upgrade: {
      status:
        upgrade?.status === "running" ||
        upgrade?.status === "failed" ||
        upgrade?.status === "idle"
          ? upgrade.status
          : "idle",
      startedAt:
        typeof upgrade?.startedAt === "number"
          ? new Date(upgrade.startedAt).toISOString()
          : null,
      finishedAt:
        typeof upgrade?.finishedAt === "number"
          ? new Date(upgrade.finishedAt).toISOString()
          : null,
      error: typeof upgrade?.error === "string" ? upgrade.error : null,
    },
  };
}

export function getRuntimeServiceLabel(name: DenRuntimeServiceName): string {
  switch (name) {
    case "openwork-server":
      return "OpenWork server";
    case "opencode":
      return "OpenCode";
    case "opencode-router":
      return "OpenCode Router";
  }
}

function getBillingPrice(value: unknown): DenBillingPrice | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    amount: typeof value.amount === "number" ? value.amount : null,
    currency: typeof value.currency === "string" ? value.currency : null,
    recurringInterval: typeof value.recurringInterval === "string" ? value.recurringInterval : null,
    recurringIntervalCount: typeof value.recurringIntervalCount === "number" ? value.recurringIntervalCount : null,
  };
}

function getBillingSubscription(value: unknown): DenBillingSubscription | null {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }

  return {
    id: value.id,
    status: typeof value.status === "string" ? value.status : "unknown",
    amount: typeof value.amount === "number" ? value.amount : null,
    currency: typeof value.currency === "string" ? value.currency : null,
    recurringInterval: typeof value.recurringInterval === "string" ? value.recurringInterval : null,
    recurringIntervalCount: typeof value.recurringIntervalCount === "number" ? value.recurringIntervalCount : null,
    currentPeriodStart: typeof value.currentPeriodStart === "string" ? value.currentPeriodStart : null,
    currentPeriodEnd: typeof value.currentPeriodEnd === "string" ? value.currentPeriodEnd : null,
    cancelAtPeriodEnd: value.cancelAtPeriodEnd === true,
    canceledAt: typeof value.canceledAt === "string" ? value.canceledAt : null,
    endedAt: typeof value.endedAt === "string" ? value.endedAt : null,
  };
}

function getBillingInvoice(value: unknown): DenBillingInvoice | null {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }

  return {
    id: value.id,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
    status: typeof value.status === "string" ? value.status : "unknown",
    totalAmount: typeof value.totalAmount === "number" ? value.totalAmount : null,
    currency: typeof value.currency === "string" ? value.currency : null,
    invoiceNumber: typeof value.invoiceNumber === "string" ? value.invoiceNumber : null,
    invoiceUrl: typeof value.invoiceUrl === "string" ? value.invoiceUrl : null,
  };
}

function getBillingSummary(payload: unknown): DenBillingSummary | null {
  if (!isRecord(payload) || !isRecord(payload.billing)) {
    return null;
  }

  const billing = payload.billing;
  if (
    typeof billing.featureGateEnabled !== "boolean" ||
    typeof billing.hasActivePlan !== "boolean" ||
    typeof billing.checkoutRequired !== "boolean"
  ) {
    return null;
  }

  return {
    featureGateEnabled: billing.featureGateEnabled,
    hasActivePlan: billing.hasActivePlan,
    checkoutRequired: billing.checkoutRequired,
    checkoutUrl: typeof billing.checkoutUrl === "string" ? billing.checkoutUrl : null,
    portalUrl: typeof billing.portalUrl === "string" ? billing.portalUrl : null,
    price: getBillingPrice(billing.price),
    subscription: getBillingSubscription(billing.subscription),
    invoices: Array.isArray(billing.invoices)
      ? billing.invoices.map((item) => getBillingInvoice(item)).filter((item): item is DenBillingInvoice => item !== null)
      : [],
    productId: typeof billing.productId === "string" ? billing.productId : null,
    benefitId: typeof billing.benefitId === "string" ? billing.benefitId : null,
  };
}

function toNumberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toNullableNumberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseAdminBillingStatus(value: unknown): DenAdminBillingStatus | null {
  if (!isRecord(value)) {
    return null;
  }

  const status =
    value.status === "paid" ||
    value.status === "unpaid" ||
    value.status === "unavailable"
      ? value.status
      : "unavailable";
  const source =
    value.source === "benefit" ||
    value.source === "subscription" ||
    value.source === "unavailable"
      ? value.source
      : "unavailable";

  return {
    status,
    featureGateEnabled: value.featureGateEnabled === true,
    subscriptionId:
      typeof value.subscriptionId === "string" ? value.subscriptionId : null,
    subscriptionStatus:
      typeof value.subscriptionStatus === "string"
        ? value.subscriptionStatus
        : null,
    currentPeriodEnd:
      typeof value.currentPeriodEnd === "string" ? value.currentPeriodEnd : null,
    source,
    note: typeof value.note === "string" ? value.note : null,
  };
}

function getAdminOverview(payload: unknown): DenAdminOverview | null {
  if (
    !isRecord(payload) ||
    !isRecord(payload.summary) ||
    !Array.isArray(payload.users) ||
    !Array.isArray(payload.admins)
  ) {
    return null;
  }

  const viewer = isRecord(payload.viewer) ? payload.viewer : {};
  const summary = payload.summary;

  const users: DenAdminUser[] = payload.users
    .map((value) => {
      if (!isRecord(value) || typeof value.id !== "string" || typeof value.email !== "string") {
        return null;
      }

      const authProviders = Array.isArray(value.authProviders)
        ? value.authProviders.filter(
            (provider): provider is string => typeof provider === "string",
          )
        : [];

      return {
        id: value.id,
        name: typeof value.name === "string" ? value.name : null,
        email: value.email,
        emailVerified: value.emailVerified === true,
        createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
        lastSeenAt: typeof value.lastSeenAt === "string" ? value.lastSeenAt : null,
        sessionCount: toNumberValue(value.sessionCount),
        authProviders,
        workerCount: toNumberValue(value.workerCount),
        cloudWorkerCount: toNumberValue(value.cloudWorkerCount),
        localWorkerCount: toNumberValue(value.localWorkerCount),
        latestWorkerCreatedAt:
          typeof value.latestWorkerCreatedAt === "string"
            ? value.latestWorkerCreatedAt
            : null,
        billing: parseAdminBillingStatus(value.billing),
      } satisfies DenAdminUser;
    })
    .filter((value): value is DenAdminUser => value !== null);

  const admins: DenAdminEntry[] = payload.admins
    .map((value) => {
      if (!isRecord(value) || typeof value.email !== "string") {
        return null;
      }

      return {
        email: value.email,
        note: typeof value.note === "string" ? value.note : null,
      } satisfies DenAdminEntry;
    })
    .filter((value): value is DenAdminEntry => value !== null);

  return {
    viewer: {
      id: typeof viewer.id === "string" ? viewer.id : "unknown",
      email: typeof viewer.email === "string" ? viewer.email : null,
      name: typeof viewer.name === "string" ? viewer.name : null,
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
    },
    users,
    generatedAt: typeof payload.generatedAt === "string" ? payload.generatedAt : null,
  };
}

const resolveFetch = () => (isTauriRuntime() ? tauriFetch : globalThis.fetch);

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function fetchWithTimeout(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetchImpl(url, init);
  }

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const signal = controller?.signal;
  const initWithSignal = signal && !init.signal ? { ...init, signal } : init;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // ignore
      }
      reject(new Error("Request timed out."));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fetchImpl(url, initWithSignal), timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function requestJsonRaw<T>(
  input: string | DenBaseUrls,
  path: string,
  options: { method?: string; token?: string | null; body?: unknown; timeoutMs?: number } = {},
): Promise<RawJsonResponse<T>> {
  const baseUrls = typeof input === "string" ? resolveDenBaseUrls(input) : input;
  const url = `${resolveRequestBaseUrl(baseUrls, path)}${path}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = options.token?.trim() ?? "";
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetchWithTimeout(
    resolveFetch(),
    url,
    {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "include",
    },
    options.timeoutMs ?? DEFAULT_DEN_TIMEOUT_MS,
  );

  const text = await response.text();
  let json: T | null = null;
  try {
    json = text ? (JSON.parse(text) as T) : null;
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, json, headers: response.headers };
}

async function requestJson<T>(
  input: string | DenBaseUrls,
  path: string,
  options: { method?: string; token?: string | null; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const raw = await requestJsonRaw<T>(input, path, options);
  if (!raw.ok) {
    const payload = raw.json;
    const code = isRecord(payload) && typeof payload.error === "string" ? payload.error : "request_failed";
    const message = getErrorMessage(payload, `Request failed with ${raw.status}.`);
    throw new DenApiError(raw.status, code, message, isRecord(payload) ? payload.details : undefined);
  }
  return raw.json as T;
}

export function createDenClient(options: { baseUrl: string; token?: string | null }) {
  const baseUrls = resolveDenBaseUrls(options.baseUrl);
  const token = options.token?.trim() ?? null;

  return {
    async signInEmail(email: string, password: string): Promise<DenAuthResult> {
      const payload = await requestJson<unknown>(baseUrls, "/api/auth/sign-in/email", {
        method: "POST",
        body: {
          email: email.trim(),
          password,
        },
      });
      return { user: getUser(payload), token: getToken(payload) };
    },

    async signUpEmail(email: string, password: string): Promise<DenAuthResult> {
      const payload = await requestJson<unknown>(baseUrls, "/api/auth/sign-up/email", {
        method: "POST",
        body: {
          name: DEFAULT_DEN_AUTH_NAME,
          email: email.trim(),
          password,
        },
      });
      return { user: getUser(payload), token: getToken(payload) };
    },

    async beginSocialAuth(input: {
      provider: DenSocialProvider;
      callbackURL: string;
      errorCallbackURL?: string | null;
    }): Promise<{ url: string }> {
      const raw = await requestJsonRaw<unknown>(baseUrls, "/api/auth/sign-in/social", {
        method: "POST",
        body: {
          provider: input.provider,
          callbackURL: input.callbackURL,
          errorCallbackURL: input.errorCallbackURL ?? input.callbackURL,
        },
      });

      if (!raw.ok) {
        const payload = raw.json;
        const code = isRecord(payload) && typeof payload.error === "string" ? payload.error : "request_failed";
        const message = getErrorMessage(payload, `Request failed with ${raw.status}.`);
        throw new DenApiError(raw.status, code, message, isRecord(payload) ? payload.details : undefined);
      }

      const payloadUrl = isRecord(raw.json) && typeof raw.json.url === "string" ? raw.json.url.trim() : "";
      const headerUrl = raw.headers.get("location")?.trim() ?? "";
      const url = payloadUrl || headerUrl;
      if (!url) {
        throw new DenApiError(500, "missing_redirect_url", "Social auth did not return a redirect URL.");
      }
      return { url };
    },

    async signOut() {
      await requestJsonRaw(baseUrls, "/api/auth/sign-out", {
        method: "POST",
        token,
        body: {},
      });
    },

    async getSession(): Promise<DenUser> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/me", {
        method: "GET",
        token,
      });
      const user = getUser(payload);
      if (!user) {
        throw new DenApiError(500, "invalid_session_payload", "Session response did not include a user.");
      }
      return user;
    },

    async exchangeDesktopHandoff(grant: string): Promise<DenDesktopHandoffExchange> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/auth/desktop-handoff/exchange", {
        method: "POST",
        body: { grant },
      });
      return { user: getUser(payload), token: getToken(payload) };
    },

    async createDesktopHandoffGrant(input: {
      next?: string | null;
      desktopScheme?: string | null;
    } = {}): Promise<DenDesktopHandoffGrant> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/auth/desktop-handoff", {
        method: "POST",
        token,
        body: {
          next: input.next?.trim() || undefined,
          desktopScheme: input.desktopScheme?.trim() || undefined,
        },
      });

      return {
        grant: isRecord(payload) && typeof payload.grant === "string" ? payload.grant : "",
        expiresAt: isRecord(payload) && typeof payload.expiresAt === "string" ? payload.expiresAt : null,
        openworkUrl: isRecord(payload) && typeof payload.openworkUrl === "string" ? payload.openworkUrl : null,
      };
    },

    async listOrgs(): Promise<{ orgs: DenOrgSummary[]; defaultOrgId: string | null }> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/me/orgs", {
        method: "GET",
        token,
      });
      return {
        orgs: getOrgList(payload),
        defaultOrgId: isRecord(payload) && typeof payload.defaultOrgId === "string" ? payload.defaultOrgId : null,
      };
    },

    async listWorkers(orgId: string, limit = 20): Promise<DenWorkerSummary[]> {
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      params.set("orgId", orgId);
      const payload = await requestJson<unknown>(baseUrls, `/v1/workers?${params.toString()}`, {
        method: "GET",
        token,
      });
      return getWorkers(payload);
    },

    async createWorker(input: DenWorkerCreateInput): Promise<DenWorkerCreateResult> {
      const raw = await requestJsonRaw<unknown>(baseUrls, "/v1/workers", {
        method: "POST",
        token,
        body: {
          name: input.name.trim(),
          description: input.description?.trim() || undefined,
          destination: input.destination,
          workspacePath: input.workspacePath?.trim() || undefined,
          sandboxBackend: input.sandboxBackend?.trim() || undefined,
          imageVersion: input.imageVersion?.trim() || undefined,
        },
      });

      if (raw.status === 402) {
        return {
          kind: "paywall",
          checkoutUrl: getCheckoutUrl(raw.json),
          productId: isRecord(raw.json) && isRecord(raw.json.polar) && typeof raw.json.polar.productId === "string" ? raw.json.polar.productId : null,
          benefitId: isRecord(raw.json) && isRecord(raw.json.polar) && typeof raw.json.polar.benefitId === "string" ? raw.json.polar.benefitId : null,
        };
      }

      if (!raw.ok) {
        const payload = raw.json;
        const code = isRecord(payload) && typeof payload.error === "string" ? payload.error : "request_failed";
        const message = getErrorMessage(payload, `Request failed with ${raw.status}.`);
        throw new DenApiError(raw.status, code, message, isRecord(payload) ? payload.details : undefined);
      }

      const worker = getWorker(raw.json);
      if (!worker) {
        throw new DenApiError(500, "invalid_worker_payload", "Worker create response was missing worker details.");
      }

      const launch = isRecord(raw.json) && isRecord(raw.json.launch) ? raw.json.launch : null;
      return {
        kind: "success",
        worker,
        launchMode: launch?.mode === "instant" ? "instant" : "async",
        pollAfterMs: typeof launch?.pollAfterMs === "number" ? launch.pollAfterMs : 0,
      };
    },

    async getWorker(workerId: string): Promise<DenWorkerSummary> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/workers/${encodeURIComponent(workerId)}`, {
        method: "GET",
        token,
      });
      const worker = getWorkerSummary(payload);
      if (!worker) {
        throw new DenApiError(500, "invalid_worker_payload", "Worker response was missing summary details.");
      }
      return worker;
    },

    async getWorkerTokens(workerId: string, orgId: string): Promise<DenWorkerTokens> {
      const params = new URLSearchParams();
      params.set("orgId", orgId);
      const payload = await requestJson<unknown>(baseUrls, `/v1/workers/${encodeURIComponent(workerId)}/tokens?${params.toString()}`, {
        method: "POST",
        token,
        body: {},
      });
      const tokens = getWorkerTokens(payload);
      if (!tokens) {
        throw new DenApiError(500, "invalid_worker_token_payload", "Worker token response was missing token values.");
      }
      return tokens;
    },

    async getWorkerRuntime(workerId: string): Promise<DenWorkerRuntimeSnapshot> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/workers/${encodeURIComponent(workerId)}/runtime`, {
        method: "GET",
        token,
      });
      const runtime = getWorkerRuntimeSnapshot(payload);
      if (!runtime) {
        throw new DenApiError(500, "invalid_runtime_payload", "Runtime response was missing service details.");
      }
      return runtime;
    },

    async upgradeWorkerRuntime(workerId: string, input: Record<string, unknown> = {}): Promise<DenWorkerRuntimeSnapshot> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/workers/${encodeURIComponent(workerId)}/runtime/upgrade`, {
        method: "POST",
        token,
        body: input,
      });
      const runtime = getWorkerRuntimeSnapshot(payload);
      if (!runtime) {
        throw new DenApiError(500, "invalid_runtime_payload", "Runtime upgrade response was missing service details.");
      }
      return runtime;
    },

    async deleteWorker(workerId: string): Promise<void> {
      const raw = await requestJsonRaw<unknown>(baseUrls, `/v1/workers/${encodeURIComponent(workerId)}`, {
        method: "DELETE",
        token,
      });
      if (raw.status === 204 || raw.ok) {
        return;
      }

      const payload = raw.json;
      const code = isRecord(payload) && typeof payload.error === "string" ? payload.error : "request_failed";
      const message = getErrorMessage(payload, `Request failed with ${raw.status}.`);
      throw new DenApiError(raw.status, code, message, isRecord(payload) ? payload.details : undefined);
    },

    async getBillingStatus(options: { includeCheckout?: boolean; includePortal?: boolean; includeInvoices?: boolean } = {}): Promise<DenBillingSummary> {
      const params = new URLSearchParams();
      if (options.includeCheckout) {
        params.set("includeCheckout", "1");
      }
      if (options.includePortal === false) {
        params.set("excludePortal", "1");
      }
      if (options.includeInvoices === false) {
        params.set("excludeInvoices", "1");
      }

      const path = params.size > 0 ? `/v1/workers/billing?${params.toString()}` : "/v1/workers/billing";
      const payload = await requestJson<unknown>(baseUrls, path, {
        method: "GET",
        token,
      });
      const summary = getBillingSummary(payload);
      if (!summary) {
        throw new DenApiError(500, "invalid_billing_payload", "Billing response was missing details.");
      }
      return summary;
    },

    async updateSubscriptionCancellation(cancelAtPeriodEnd: boolean): Promise<{ subscription: DenBillingSubscription | null; billing: DenBillingSummary }> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/workers/billing/subscription", {
        method: "POST",
        token,
        body: { cancelAtPeriodEnd },
      });
      const billing = getBillingSummary(payload);
      if (!billing) {
        throw new DenApiError(500, "invalid_billing_payload", "Subscription update response was missing billing details.");
      }

      return {
        subscription: isRecord(payload) ? getBillingSubscription(payload.subscription) : null,
        billing,
      };
    },

    async getAdminOverview(options: { includeBilling?: boolean } = {}): Promise<DenAdminOverview> {
      const params = new URLSearchParams();
      if (options.includeBilling) {
        params.set("includeBilling", "1");
      }

      const path = params.size > 0 ? `/v1/admin/overview?${params.toString()}` : "/v1/admin/overview";
      const payload = await requestJson<unknown>(baseUrls, path, {
        method: "GET",
        token,
      });
      const overview = getAdminOverview(payload);
      if (!overview) {
        throw new DenApiError(500, "invalid_admin_payload", "Admin overview response was missing details.");
      }
      return overview;
    },
  };
}
