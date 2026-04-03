import { DEN_WORKER_POLL_INTERVAL_MS } from "./CONSTS";

export type AuthMode = "sign-in" | "sign-up";
export type SocialAuthProvider = "github" | "google";
export type WorkerStatusBucket = "ready" | "starting" | "attention" | "other";
export type RuntimeServiceName = "openwork-server" | "opencode" | "opencode-router";
export type EventLevel = "info" | "success" | "warning" | "error";
export type AuthMethod = "email" | SocialAuthProvider;

export type BillingPrice = {
  amount: number | null;
  currency: string | null;
  recurringInterval: string | null;
  recurringIntervalCount: number | null;
};

export type BillingSubscription = {
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

export type BillingInvoice = {
  id: string;
  createdAt: string | null;
  status: string;
  totalAmount: number | null;
  currency: string | null;
  invoiceNumber: string | null;
  invoiceUrl: string | null;
};

export type BillingSummary = {
  featureGateEnabled: boolean;
  hasActivePlan: boolean;
  checkoutRequired: boolean;
  checkoutUrl: string | null;
  portalUrl: string | null;
  price: BillingPrice | null;
  subscription: BillingSubscription | null;
  invoices: BillingInvoice[];
  productId: string | null;
  benefitId: string | null;
};

export type OrgLimitError = {
  error: "org_limit_reached";
  message: string;
  limitType: "members" | "workers";
  currentCount: number;
  limit: number;
};

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
};

export type WorkerLaunch = {
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

export type WorkerSummary = {
  workerId: string;
  workerName: string;
  status: string;
  instanceUrl: string | null;
  provider: string | null;
  isMine: boolean;
};

export type WorkerTokens = {
  clientToken: string | null;
  ownerToken: string | null;
  hostToken: string | null;
  openworkUrl: string | null;
  workspaceId: string | null;
};

export type WorkerListItem = {
  workerId: string;
  workerName: string;
  status: string;
  instanceUrl: string | null;
  provider: string | null;
  isMine: boolean;
  createdAt: string | null;
};

export type WorkerRuntimeService = {
  name: RuntimeServiceName;
  enabled: boolean;
  running: boolean;
  targetVersion: string | null;
  actualVersion: string | null;
  upgradeAvailable: boolean;
};

export type WorkerRuntimeSnapshot = {
  services: WorkerRuntimeService[];
  upgrade: {
    status: "idle" | "running" | "failed";
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
  };
};

export type LaunchEvent = {
  id: string;
  level: EventLevel;
  label: string;
  detail: string;
  at: string;
};

export type OnboardingIntent = {
  version: 1;
  workerName: string;
  shouldLaunch: boolean;
  completed: boolean;
  authMethod: AuthMethod;
};

type PosthogClient = {
  capture?: (eventName: string, properties?: Record<string, unknown>) => void;
  identify?: (distinctId?: string, properties?: Record<string, unknown>) => void;
  reset?: () => void;
};

declare global {
  interface Window {
    posthog?: PosthogClient;
  }
}

export const LAST_WORKER_STORAGE_KEY = "openwork:web:last-worker";
export const PENDING_SOCIAL_SIGNUP_STORAGE_KEY = "openwork:web:pending-social-signup";
export const AUTH_TOKEN_STORAGE_KEY = "openwork:web:auth-token";
export const ONBOARDING_INTENT_STORAGE_KEY = "openwork:web:onboarding-intent";
export const WORKER_STATUS_POLL_MS = DEN_WORKER_POLL_INTERVAL_MS;
export const DEFAULT_AUTH_NAME = "OpenWork User";
export const DEFAULT_WORKER_NAME = "My Worker";
export const OPENWORK_APP_CONNECT_BASE_URL = (process.env.NEXT_PUBLIC_OPENWORK_APP_CONNECT_URL ?? "").trim();
export const OPENWORK_AUTH_CALLBACK_BASE_URL = (process.env.NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL ?? "").trim();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getAuthInfoForMode(mode: AuthMode): string {
  return mode === "sign-up"
    ? "Create an account to launch and manage cloud workers."
    : "Sign in to launch and manage cloud workers.";
}

export function getEmailDomain(email: string): string {
  const atIndex = email.lastIndexOf("@");
  if (atIndex === -1 || atIndex + 1 >= email.length) {
    return "unknown";
  }
  return email.slice(atIndex + 1).toLowerCase();
}

export function trackPosthogEvent(eventName: string, properties: Record<string, unknown> = {}) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.posthog?.capture?.(eventName, properties);
  } catch {
    // Ignore analytics delivery failures.
  }
}

export function identifyPosthogUser(user: AuthUser) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.posthog?.identify?.(user.id, {
      email: user.email,
      name: user.name ?? undefined
    });
  } catch {
    // Ignore analytics delivery failures.
  }
}

export function resetPosthogUser() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.posthog?.reset?.();
  } catch {
    // Ignore analytics delivery failures.
  }
}

export function normalizeAuthModeParam(value: string | null | undefined): AuthMode | null {
  return value === "sign-in" || value === "sign-up" ? value : null;
}

export function getSocialProviderLabel(provider: SocialAuthProvider): string {
  return provider === "github" ? "GitHub" : "Google";
}

export function normalizeWorkerName(input: string): string {
  const normalized = input.trim().replace(/\s+/g, " ");
  return normalized || DEFAULT_WORKER_NAME;
}

export function deriveOnboardingWorkerName(user: AuthUser): string {
  const rawIdentity = (user.name?.trim() || user.email.split("@")[0] || DEFAULT_WORKER_NAME).replace(/[._-]+/g, " ").trim();
  const base = rawIdentity
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");

  const owner = base || DEFAULT_WORKER_NAME;
  const suffix = owner.endsWith("s") ? "' Worker" : "'s Worker";
  return normalizeWorkerName(`${owner}${suffix}`);
}

export function getSocialCallbackUrl(): string {
  try {
    const origin = typeof window !== "undefined" ? window.location.origin : OPENWORK_AUTH_CALLBACK_BASE_URL || "https://app.openworklabs.com";
    const callbackUrl = new URL("/", origin);
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      for (const key of ["mode", "desktopAuth", "desktopScheme", "invite"]) {
        const value = params.get(key)?.trim() ?? "";
        if (value) {
          callbackUrl.searchParams.set(key, value);
        }
      }
    }
    return callbackUrl.toString();
  } catch {
    return "https://app.openworklabs.com/";
  }
}

export function isDesktopContext(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const ua = window.navigator.userAgent || "";
  return !/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
}

export function shortValue(value: string): string {
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

export function formatMoneyMinor(amount: number | null, currency: string | null): string {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return "Not available";
  }

  const normalizedCurrency = (currency ?? "USD").toUpperCase();
  const majorValue = amount / 100;

  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: normalizedCurrency
    }).format(majorValue);
  } catch {
    return `${majorValue.toFixed(2)} ${normalizedCurrency}`;
  }
}

export function formatIsoDate(value: string | null): string {
  if (!value) {
    return "Not available";
  }

  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "Not available";
    }
    return date.toLocaleDateString();
  } catch {
    return "Not available";
  }
}

export function formatRecurringInterval(interval: string | null, count: number | null): string {
  if (!interval) {
    return "billing cycle";
  }

  const normalizedInterval = interval.replace(/_/g, " ");
  const normalizedCount = typeof count === "number" && Number.isFinite(count) ? count : 1;

  if (normalizedCount <= 1) {
    return `per ${normalizedInterval}`;
  }

  const pluralSuffix = normalizedInterval.endsWith("s") ? "" : "s";
  return `every ${normalizedCount} ${normalizedInterval}${pluralSuffix}`;
}

export function formatSubscriptionStatus(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (!normalized) {
    return "Unknown";
  }

  return normalized
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function getErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "string" && payload.trim().length > 0) {
    const trimmed = payload.trim();
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("<!doctype") || lower.startsWith("<html") || lower.includes("<body")) {
      return `${fallback} Upstream returned an HTML error page.`;
    }
    if (trimmed.length > 240) {
      return `${fallback} Upstream returned a non-JSON error payload.`;
    }
    return trimmed;
  }

  if (!isRecord(payload)) {
    return fallback;
  }

  const message = payload.message;
  if (typeof message === "string" && message.trim().length > 0) {
    return message;
  }

  const error = payload.error;
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return fallback;
}

export function getOrgLimitError(payload: unknown): OrgLimitError | null {
  if (!isRecord(payload) || payload.error !== "org_limit_reached") {
    return null;
  }

  if (
    (payload.limitType !== "members" && payload.limitType !== "workers") ||
    typeof payload.message !== "string" ||
    typeof payload.currentCount !== "number" ||
    typeof payload.limit !== "number"
  ) {
    return null;
  }

  return {
    error: "org_limit_reached",
    message: payload.message,
    limitType: payload.limitType,
    currentCount: payload.currentCount,
    limit: payload.limit,
  };
}

export function getUser(payload: unknown): AuthUser | null {
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
    name: typeof user.name === "string" ? user.name : null
  };
}

export function getToken(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  return typeof payload.token === "string" ? payload.token : null;
}

export function getCheckoutUrl(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.polar)) {
    return null;
  }
  return typeof payload.polar.checkoutUrl === "string" ? payload.polar.checkoutUrl : null;
}

export function getWorker(payload: unknown): WorkerLaunch | null {
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
    ownerToken: tokens && typeof tokens.owner === "string"
      ? tokens.owner
      : tokens && typeof tokens.host === "string"
        ? tokens.host
        : null,
    hostToken: tokens && typeof tokens.host === "string" ? tokens.host : null
  };
}

export function getWorkerSummary(payload: unknown): WorkerSummary | null {
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
    isMine: worker.isMine === true
  };
}

export function getWorkerTokens(payload: unknown): WorkerTokens | null {
  if (!isRecord(payload) || !isRecord(payload.tokens)) {
    return null;
  }

  const tokens = payload.tokens;
  const connect = isRecord(payload.connect) ? payload.connect : null;
  const clientToken = typeof tokens.client === "string" ? tokens.client : null;
  const ownerToken = typeof tokens.owner === "string"
    ? tokens.owner
    : typeof tokens.host === "string"
      ? tokens.host
      : null;
  const hostToken = typeof tokens.host === "string" ? tokens.host : null;
  const openworkUrl = connect && typeof connect.openworkUrl === "string" ? connect.openworkUrl : null;
  const workspaceId = connect && typeof connect.workspaceId === "string" ? connect.workspaceId : null;

  if (!clientToken && !ownerToken && !hostToken) {
    return null;
  }

  return { clientToken, ownerToken, hostToken, openworkUrl, workspaceId };
}

export function getWorkerRuntimeSnapshot(payload: unknown): WorkerRuntimeSnapshot | null {
  if (!isRecord(payload) || !Array.isArray(payload.services)) {
    return null;
  }

  const services = payload.services
    .map((value) => {
      if (!isRecord(value) || typeof value.name !== "string") {
        return null;
      }

      return {
        name: value.name as RuntimeServiceName,
        enabled: value.enabled === true,
        running: value.running === true,
        targetVersion: typeof value.targetVersion === "string" ? value.targetVersion : null,
        actualVersion: typeof value.actualVersion === "string" ? value.actualVersion : null,
        upgradeAvailable: value.upgradeAvailable === true
      };
    })
    .filter((item): item is WorkerRuntimeService => item !== null);

  const upgrade = isRecord(payload.upgrade) ? payload.upgrade : null;

  return {
    services,
    upgrade: {
      status:
        upgrade?.status === "running" || upgrade?.status === "failed" || upgrade?.status === "idle"
          ? upgrade.status
          : "idle",
      startedAt: typeof upgrade?.startedAt === "number" ? new Date(upgrade.startedAt).toISOString() : null,
      finishedAt: typeof upgrade?.finishedAt === "number" ? new Date(upgrade.finishedAt).toISOString() : null,
      error: typeof upgrade?.error === "string" ? upgrade.error : null
    }
  };
}

export function getRuntimeServiceLabel(name: RuntimeServiceName): string {
  switch (name) {
    case "openwork-server":
      return "OpenWork server";
    case "opencode":
      return "OpenCode";
    case "opencode-router":
      return "OpenCode Router";
  }
}

function getBillingPrice(value: unknown): BillingPrice | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    amount: typeof value.amount === "number" ? value.amount : null,
    currency: typeof value.currency === "string" ? value.currency : null,
    recurringInterval: typeof value.recurringInterval === "string" ? value.recurringInterval : null,
    recurringIntervalCount: typeof value.recurringIntervalCount === "number" ? value.recurringIntervalCount : null
  };
}

function getBillingSubscription(value: unknown): BillingSubscription | null {
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
    endedAt: typeof value.endedAt === "string" ? value.endedAt : null
  };
}

function getBillingInvoice(value: unknown): BillingInvoice | null {
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
    invoiceUrl: typeof value.invoiceUrl === "string" ? value.invoiceUrl : null
  };
}

export function getBillingSummary(payload: unknown): BillingSummary | null {
  if (!isRecord(payload) || !isRecord(payload.billing)) {
    return null;
  }

  const billing = payload.billing;
  const featureGateEnabled = billing.featureGateEnabled;
  const hasActivePlan = billing.hasActivePlan;
  const checkoutRequired = billing.checkoutRequired;

  if (
    typeof featureGateEnabled !== "boolean" ||
    typeof hasActivePlan !== "boolean" ||
    typeof checkoutRequired !== "boolean"
  ) {
    return null;
  }

  return {
    featureGateEnabled,
    hasActivePlan,
    checkoutRequired,
    checkoutUrl: typeof billing.checkoutUrl === "string" ? billing.checkoutUrl : null,
    portalUrl: typeof billing.portalUrl === "string" ? billing.portalUrl : null,
    price: getBillingPrice(billing.price),
    subscription: getBillingSubscription(billing.subscription),
    invoices: Array.isArray(billing.invoices)
      ? billing.invoices
          .map((item) => getBillingInvoice(item))
          .filter((item): item is BillingInvoice => item !== null)
      : [],
    productId: typeof billing.productId === "string" ? billing.productId : null,
    benefitId: typeof billing.benefitId === "string" ? billing.benefitId : null
  };
}

function parseWorkerListItem(value: unknown): WorkerListItem | null {
  if (!isRecord(value)) {
    return null;
  }

  const workerId = value.id;
  const workerName = value.name;
  if (typeof workerId !== "string" || typeof workerName !== "string") {
    return null;
  }

  const instance = isRecord(value.instance) ? value.instance : null;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : null;

  return {
    workerId,
    workerName,
    status: getEffectiveWorkerStatus(value.status, instance),
    instanceUrl: instance && typeof instance.url === "string" ? instance.url : null,
    provider: instance && typeof instance.provider === "string" ? instance.provider : null,
    isMine: value.isMine === true,
    createdAt
  };
}

export function getWorkersList(payload: unknown): WorkerListItem[] {
  if (!isRecord(payload) || !Array.isArray(payload.workers)) {
    return [];
  }

  const rows: WorkerListItem[] = [];
  for (const item of payload.workers) {
    const parsed = parseWorkerListItem(item);
    if (parsed) {
      rows.push(parsed);
    }
  }

  return rows;
}

export function getWorkerStatusMeta(status: string): { label: string; bucket: WorkerStatusBucket } {
  const normalized = status.trim().toLowerCase();

  if (normalized === "healthy" || normalized === "ready") {
    return { label: "Ready", bucket: "ready" };
  }

  if (normalized === "provisioning" || normalized === "starting") {
    return { label: "Starting", bucket: "starting" };
  }

  if (normalized === "failed" || normalized === "suspended" || normalized === "stopped") {
    return { label: "Needs attention", bucket: "attention" };
  }

  return { label: "Unknown", bucket: "other" };
}

export function getWorkerStatusCopy(status: string): string {
  const normalized = status.trim().toLowerCase();
  switch (normalized) {
    case "provisioning":
    case "starting":
      return "Starting...";
    case "healthy":
    case "ready":
      return "Ready to connect.";
    case "failed":
      return "Worker failed to start.";
    case "suspended":
    case "stopped":
      return "Worker is suspended.";
    default:
      return "Worker status unknown.";
  }
}

function getEffectiveWorkerStatus(workerStatus: unknown, instance: Record<string, unknown> | null): string {
  const normalizedWorkerStatus = typeof workerStatus === "string" ? workerStatus : "unknown";
  const normalized = normalizedWorkerStatus.trim().toLowerCase();
  const instanceStatus = instance && typeof instance.status === "string" ? instance.status.trim().toLowerCase() : null;

  if (!instanceStatus) {
    return normalizedWorkerStatus;
  }

  if (normalized === "provisioning" || normalized === "starting") {
    return instanceStatus;
  }

  return normalizedWorkerStatus;
}

export function isWorkerLaunch(value: unknown): value is WorkerLaunch {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.workerId === "string" &&
    typeof value.workerName === "string" &&
    typeof value.status === "string" &&
    (typeof value.provider === "string" || value.provider === null) &&
    (typeof value.instanceUrl === "string" || value.instanceUrl === null) &&
    (typeof value.openworkUrl === "string" || value.openworkUrl === null || typeof value.openworkUrl === "undefined") &&
    (typeof value.workspaceId === "string" || value.workspaceId === null || typeof value.workspaceId === "undefined") &&
    (typeof value.clientToken === "string" || value.clientToken === null) &&
    (typeof value.ownerToken === "string" || value.ownerToken === null || typeof value.ownerToken === "undefined") &&
    (typeof value.hostToken === "string" || value.hostToken === null)
  );
}

export function listItemToWorker(item: WorkerListItem, current: WorkerLaunch | null = null): WorkerLaunch {
  return {
    workerId: item.workerId,
    workerName: item.workerName,
    status: item.status,
    provider: item.provider,
    instanceUrl: item.instanceUrl,
    openworkUrl: current?.workerId === item.workerId ? current.openworkUrl ?? item.instanceUrl : item.instanceUrl,
    workspaceId: current?.workerId === item.workerId ? current.workspaceId : null,
    clientToken: current?.workerId === item.workerId ? current.clientToken : null,
    ownerToken: current?.workerId === item.workerId ? current.ownerToken : null,
    hostToken: current?.workerId === item.workerId ? current.hostToken : null
  };
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function parseWorkspaceIdFromUrl(value: string): string | null {
  const normalized = normalizeUrl(value);
  if (!normalized) {
    return null;
  }

  try {
    const url = new URL(normalized);
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] ?? "";
    const prev = segments[segments.length - 2] ?? "";
    if (prev !== "w" || !last) {
      return null;
    }
    return decodeURIComponent(last);
  } catch {
    const match = normalized.match(/\/w\/([^/?#]+)/);
    if (!match?.[1]) {
      return null;
    }
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
}

function buildWorkspaceUrl(instanceUrl: string, workspaceId: string): string {
  return `${normalizeUrl(instanceUrl)}/w/${encodeURIComponent(workspaceId)}`;
}

export function buildOpenworkDeepLink(
  openworkUrl: string | null,
  accessToken: string | null,
  workerId: string | null,
  workerName: string | null
): string | null {
  if (!openworkUrl || !accessToken) {
    return null;
  }

  const params = new URLSearchParams({
    openworkHostUrl: openworkUrl,
    openworkToken: accessToken,
    source: "openwork-web"
  });

  if (workerId) {
    params.set("workerId", workerId);
  }

  if (workerName) {
    params.set("workerName", workerName);
  }

  return `openwork://connect-remote?${params.toString()}`;
}

export function buildOpenworkAppConnectUrl(
  appConnectBaseUrl: string,
  openworkUrl: string | null,
  accessToken: string | null,
  workerId: string | null,
  workerName: string | null,
  options?: { autoConnect?: boolean }
): string | null {
  if (!appConnectBaseUrl || !openworkUrl || !accessToken) {
    return null;
  }

  let connectUrl: URL;
  try {
    connectUrl = new URL(appConnectBaseUrl);
  } catch {
    return null;
  }

  const normalizedPath = connectUrl.pathname.replace(/\/+$/, "");
  if (!normalizedPath || normalizedPath === "/") {
    connectUrl.pathname = "/connect-remote";
  } else {
    const pathSegments = normalizedPath.split("/").filter(Boolean);
    const lastSegment = (pathSegments[pathSegments.length - 1] ?? "").toLowerCase();
    connectUrl.pathname = lastSegment === "connect-remote" ? normalizedPath : `${normalizedPath}/connect-remote`;
  }

  connectUrl.searchParams.set("openworkHostUrl", openworkUrl);
  connectUrl.searchParams.set("openworkToken", accessToken);
  if (options?.autoConnect) {
    connectUrl.searchParams.set("autoConnect", "1");
  }
  connectUrl.searchParams.set("source", "openwork-web");

  if (workerId) {
    connectUrl.searchParams.set("workerId", workerId);
  }

  if (workerName) {
    connectUrl.searchParams.set("workerName", workerName);
  }

  return connectUrl.toString();
}

function parseWorkspaceIdFromWorkspacesPayload(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return null;
  }

  const activeId = typeof payload.activeId === "string" ? payload.activeId : null;
  if (activeId && payload.items.some((item) => isRecord(item) && item.id === activeId)) {
    return activeId;
  }

  for (const item of payload.items) {
    if (isRecord(item) && typeof item.id === "string" && item.id.trim()) {
      return item.id;
    }
  }

  return null;
}

async function requestAbsoluteJson(url: string, init: RequestInit = {}, timeoutMs = 12000) {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");

  const shouldAttachTimeout = !init.signal && timeoutMs > 0;
  const timeoutController = shouldAttachTimeout ? new AbortController() : null;
  const timeoutHandle = timeoutController
    ? setTimeout(() => {
        timeoutController.abort();
      }, timeoutMs)
    : null;

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
      credentials: "omit",
      signal: init.signal ?? timeoutController?.signal
    });
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }

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

export async function resolveOpenworkWorkspaceUrl(instanceUrl: string, accessToken: string): Promise<{ workspaceId: string; openworkUrl: string } | null> {
  const baseUrl = normalizeUrl(instanceUrl);
  const token = accessToken.trim();
  if (!baseUrl || !token) {
    return null;
  }

  const mountedWorkspaceId = parseWorkspaceIdFromUrl(baseUrl);
  if (mountedWorkspaceId) {
    return {
      workspaceId: mountedWorkspaceId,
      openworkUrl: baseUrl
    };
  }

  const { response, payload } = await requestAbsoluteJson(`${baseUrl}/workspaces`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    return null;
  }

  const workspaceId = parseWorkspaceIdFromWorkspacesPayload(payload);
  if (!workspaceId) {
    return null;
  }

  return {
    workspaceId,
    openworkUrl: buildWorkspaceUrl(baseUrl, workspaceId)
  };
}

export async function requestJson(path: string, init: RequestInit = {}, timeoutMs = 30000) {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");

  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const shouldAttachTimeout = !init.signal && timeoutMs > 0;
  const timeoutController = shouldAttachTimeout ? new AbortController() : null;
  const timeoutHandle = timeoutController
    ? setTimeout(() => {
        timeoutController.abort();
      }, timeoutMs)
    : null;

  let response: Response;
  try {
    const endpoint = path.startsWith("/api/") ? path : `/api/den${path}`;
    response = await fetch(endpoint, {
      ...init,
      headers,
      credentials: "include",
      signal: init.signal ?? timeoutController?.signal
    });
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }

  const text = await response.text();
  let payload: unknown = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  return { response, payload, text };
}
