"use client";

import { FormEvent, useEffect, useState } from "react";
import {
  Boxes,
  CheckCircle2,
  Cpu,
  FileText,
  FolderOpen,
  Globe,
  Key,
  Loader2,
  MessageCircle,
  Package,
  RefreshCcw,
  Server,
  Sparkles,
  Terminal,
  Zap,
  type LucideIcon
} from "lucide-react";

type Step = 1 | 2;
type AuthMode = "sign-in" | "sign-up";
type SocialAuthProvider = "github" | "google";
type ShellView = "workers" | "billing";
type WorkerStatusBucket = "ready" | "starting" | "attention" | "other";

type BillingPrice = {
  amount: number | null;
  currency: string | null;
  recurringInterval: string | null;
  recurringIntervalCount: number | null;
};

type BillingSubscription = {
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

type BillingInvoice = {
  id: string;
  createdAt: string | null;
  status: string;
  totalAmount: number | null;
  currency: string | null;
  invoiceNumber: string | null;
  invoiceUrl: string | null;
};

type BillingSummary = {
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

type AuthUser = {
  id: string;
  email: string;
  name: string | null;
};

type WorkerLaunch = {
  workerId: string;
  workerName: string;
  status: string;
  provider: string | null;
  instanceUrl: string | null;
  openworkUrl: string | null;
  workspaceId: string | null;
  clientToken: string | null;
  hostToken: string | null;
};

type WorkerSummary = {
  workerId: string;
  workerName: string;
  status: string;
  instanceUrl: string | null;
  provider: string | null;
  isMine: boolean;
};

type WorkerTokens = {
  clientToken: string | null;
  hostToken: string | null;
  openworkUrl: string | null;
  workspaceId: string | null;
};

type WorkerListItem = {
  workerId: string;
  workerName: string;
  status: string;
  instanceUrl: string | null;
  provider: string | null;
  isMine: boolean;
  createdAt: string | null;
};

type RuntimeServiceName = "openwork-server" | "opencode" | "opencode-router";

type WorkerRuntimeService = {
  name: RuntimeServiceName;
  enabled: boolean;
  running: boolean;
  targetVersion: string | null;
  actualVersion: string | null;
  upgradeAvailable: boolean;
};

type WorkerRuntimeSnapshot = {
  services: WorkerRuntimeService[];
  upgrade: {
    status: "idle" | "running" | "failed";
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
  };
};

type EventLevel = "info" | "success" | "warning" | "error";

type LaunchEvent = {
  id: string;
  level: EventLevel;
  label: string;
  detail: string;
  at: string;
};

type StartupSequenceItem = {
  label: string;
  sublabel: string;
  Icon: LucideIcon;
  spin?: boolean;
};

type PosthogClient = {
  capture?: (eventName: string, properties?: Record<string, unknown>) => void;
  identify?: (distinctId?: string, properties?: Record<string, unknown>) => void;
  reset?: () => void;
};

type DenSignupTrackPayload = {
  email: string;
  name: string | null;
  userId: string;
  authMethod: "email" | SocialAuthProvider;
};

declare global {
  interface Window {
    posthog?: PosthogClient;
  }
}

function getAuthInfoForMode(mode: AuthMode): string {
  return mode === "sign-up"
    ? "Create an account to launch and manage cloud workers."
    : "Sign in to launch and manage cloud workers.";
}

const LAST_WORKER_STORAGE_KEY = "openwork:web:last-worker";
const PENDING_SOCIAL_SIGNUP_STORAGE_KEY = "openwork:web:pending-social-signup";
const AUTH_TOKEN_STORAGE_KEY = "openwork:web:auth-token";
const WORKER_STATUS_POLL_MS = 5000;
const DEFAULT_AUTH_NAME = "OpenWork User";
const OPENWORK_APP_CONNECT_BASE_URL = (process.env.NEXT_PUBLIC_OPENWORK_APP_CONNECT_URL ?? "").trim();
const OPENWORK_AUTH_CALLBACK_BASE_URL = (process.env.NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL ?? "https://app.openwork.software").trim();
const OPENWORK_DOWNLOAD_URL = "https://openwork.software/";
const OPENWORK_DOWNLOAD_FALLBACK_URL = "https://openwork.software/download";
const BILLING_DISABLED_FOR_EXPERIMENT = true;
const STARTUP_ROTATION_MS = 2700;
const STARTUP_SEQUENCE: StartupSequenceItem[] = [
  { Icon: Loader2, label: "Warming Docker", sublabel: "Spinning up the local container stack.", spin: true },
  { Icon: Cpu, label: "Checking engine", sublabel: "Verifying the runtime is responding." },
  { Icon: Package, label: "Pulling layers", sublabel: "Preparing the worker image in the background." },
  { Icon: FolderOpen, label: "Mounting workspace", sublabel: "Connecting the worker to your files." },
  { Icon: Globe, label: "Priming network", sublabel: "Opening the paths the worker needs." },
  { Icon: Server, label: "Starting MySQL", sublabel: "Bringing the data layer online." },
  { Icon: RefreshCcw, label: "Applying migrations", sublabel: "Aligning the schema before launch.", spin: true },
  { Icon: FileText, label: "Reading config", sublabel: "Loading the worker settings for this session." },
  { Icon: Zap, label: "Starting Den", sublabel: "Booting the OpenWork server layer." },
  { Icon: Key, label: "Minting tokens", sublabel: "Preparing secure access for the worker." },
  { Icon: Boxes, label: "Creating worker", sublabel: "Provisioning the worker container." },
  { Icon: RefreshCcw, label: "Spinning runtime", sublabel: "Starting the runtime services.", spin: true },
  { Icon: CheckCircle2, label: "Checking health", sublabel: "Waiting for the worker to report healthy." },
  { Icon: MessageCircle, label: "Opening channel", sublabel: "Bringing the app connection online." },
  { Icon: Terminal, label: "Preparing console", sublabel: "Getting the console ready for handoff." },
  { Icon: Sparkles, label: "Launch in progress", sublabel: "Setup is still running while we rotate startup signals." }
];

function getEmailDomain(email: string): string {
  const atIndex = email.lastIndexOf("@");
  if (atIndex === -1 || atIndex + 1 >= email.length) {
    return "unknown";
  }
  return email.slice(atIndex + 1).toLowerCase();
}

function trackPosthogEvent(eventName: string, properties: Record<string, unknown> = {}) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.posthog?.capture?.(eventName, properties);
  } catch {
    // Ignore analytics delivery failures.
  }
}

function identifyPosthogUser(user: AuthUser) {
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

function resetPosthogUser() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.posthog?.reset?.();
  } catch {
    // Ignore analytics delivery failures.
  }
}

async function trackDenSignupInLoops(payload: DenSignupTrackPayload) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    await fetch("/api/loops/den-signup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      keepalive: true
    });
  } catch {
    // Ignore analytics delivery failures.
  }
}

function getSocialCallbackUrl(): string {
  try {
    const origin = typeof window !== "undefined"
      ? window.location.origin
      : OPENWORK_AUTH_CALLBACK_BASE_URL || "https://app.openwork.software";
    return new URL("/", origin).toString();
  } catch {
    return "https://app.openwork.software/";
  }
}

function getSocialProviderLabel(provider: SocialAuthProvider): string {
  return provider === "github" ? "GitHub" : "Google";
}

function getExperimentBillingSummary(): BillingSummary {
  return {
    featureGateEnabled: false,
    hasActivePlan: false,
    checkoutRequired: false,
    checkoutUrl: null,
    portalUrl: null,
    price: null,
    subscription: null,
    invoices: [],
    productId: null,
    benefitId: null
  };
}

function getAdditionalWorkerRequestHref(): string {
  const subject = "requesting an additional worker";
  const body = [
    "Hey Ben,",
    "",
    "I would like to create an additional worker in order to {INSERT REASON}"
  ].join("\n");

  return `mailto:ben@openwork.software?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function GitHubLogo() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="ow-social-icon">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.5 7.5 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

function GoogleLogo() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true" className="ow-social-icon">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.31-1.58-5.01-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.99 10.72A5.41 5.41 0 0 1 3.71 9c0-.6.1-1.18.28-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.05l3.03-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.43 1.33l2.57-2.57C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.03 2.33c.7-2.12 2.67-3.7 5.01-3.7Z"
      />
    </svg>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function shortValue(value: string): string {
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function formatMoneyMinor(amount: number | null, currency: string | null): string {
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

function formatIsoDate(value: string | null): string {
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

function formatRecurringInterval(interval: string | null, count: number | null): string {
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

function formatSubscriptionStatus(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (!normalized) {
    return "Unknown";
  }

  return normalized
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function getErrorMessage(payload: unknown, fallback: string): string {
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

function getUser(payload: unknown): AuthUser | null {
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

function getToken(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  return typeof payload.token === "string" ? payload.token : null;
}

function getCheckoutUrl(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.polar)) {
    return null;
  }
  return typeof payload.polar.checkoutUrl === "string" ? payload.polar.checkoutUrl : null;
}

function getWorker(payload: unknown): WorkerLaunch | null {
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
    status: typeof worker.status === "string" ? worker.status : "unknown",
    provider: instance && typeof instance.provider === "string" ? instance.provider : null,
    instanceUrl: instance && typeof instance.url === "string" ? instance.url : null,
    openworkUrl: instance && typeof instance.url === "string" ? instance.url : null,
    workspaceId: null,
    clientToken: tokens && typeof tokens.client === "string" ? tokens.client : null,
    hostToken: tokens && typeof tokens.host === "string" ? tokens.host : null
  };
}

function getWorkerSummary(payload: unknown): WorkerSummary | null {
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
    status: typeof worker.status === "string" ? worker.status : "unknown",
    instanceUrl: instance && typeof instance.url === "string" ? instance.url : null,
    provider: instance && typeof instance.provider === "string" ? instance.provider : null,
    isMine: worker.isMine === true
  };
}

function getWorkerTokens(payload: unknown): WorkerTokens | null {
  if (!isRecord(payload) || !isRecord(payload.tokens)) {
    return null;
  }

  const tokens = payload.tokens;
  const connect = isRecord(payload.connect) ? payload.connect : null;
  const clientToken = typeof tokens.client === "string" ? tokens.client : null;
  const hostToken = typeof tokens.host === "string" ? tokens.host : null;
  const openworkUrl = connect && typeof connect.openworkUrl === "string" ? connect.openworkUrl : null;
  const workspaceId = connect && typeof connect.workspaceId === "string" ? connect.workspaceId : null;

  if (!clientToken && !hostToken) {
    return null;
  }

  return { clientToken, hostToken, openworkUrl, workspaceId };
}

function getWorkerRuntimeSnapshot(payload: unknown): WorkerRuntimeSnapshot | null {
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

function getRuntimeServiceLabel(name: RuntimeServiceName): string {
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

function getBillingSummary(payload: unknown): BillingSummary | null {
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
    status: typeof value.status === "string" ? value.status : "unknown",
    instanceUrl: instance && typeof instance.url === "string" ? instance.url : null,
    provider: instance && typeof instance.provider === "string" ? instance.provider : null,
    isMine: value.isMine === true,
    createdAt
  };
}

function getWorkersList(payload: unknown): WorkerListItem[] {
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

function getWorkerStatusMeta(status: string): { label: string; bucket: WorkerStatusBucket } {
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

function getWorkerStatusCopy(status: string): string {
  const normalized = status.trim().toLowerCase();
  switch (normalized) {
    case "provisioning":
    case "starting":
      return "Starting... This may take a minute.";
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

function getTrafficLightClasses(bucket: WorkerStatusBucket) {
  return {
    red: bucket === "attention" || bucket === "other" ? "bg-rose-500 shadow-[0_0_0_4px_rgba(244,63,94,0.16)]" : "bg-rose-100",
    amber: bucket === "starting" ? "bg-amber-500 shadow-[0_0_0_4px_rgba(245,158,11,0.16)]" : "bg-amber-100",
    green: bucket === "ready" ? "bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.16)]" : "bg-emerald-100"
  };
}

function getSimplifiedStatusTitle(bucket: WorkerStatusBucket): string {
  switch (bucket) {
    case "ready":
      return "Available";
    case "starting":
      return "Working";
    case "attention":
    case "other":
    default:
      return "Unavailable";
  }
}

function getWorkerAddressLabel(item: WorkerListItem): string {
  if (!item.instanceUrl) {
    return shortValue(item.workerId);
  }

  try {
    return new URL(item.instanceUrl).host;
  } catch {
    return shortValue(item.instanceUrl);
  }
}

function isWorkerLaunch(value: unknown): value is WorkerLaunch {
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
    (typeof value.hostToken === "string" || value.hostToken === null)
  );
}

function listItemToWorker(item: WorkerListItem, current: WorkerLaunch | null = null): WorkerLaunch {
  return {
    workerId: item.workerId,
    workerName: item.workerName,
    status: item.status,
    provider: item.provider,
    instanceUrl: item.instanceUrl,
    openworkUrl: item.instanceUrl,
    workspaceId: null,
    clientToken: current?.workerId === item.workerId ? current.clientToken : null,
    hostToken: current?.workerId === item.workerId ? current.hostToken : null
  };
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function parseWorkspaceIdFromUrl(value: string): string | null {
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

function buildOpenworkDeepLink(
  openworkUrl: string | null,
  accessToken: string | null,
  workerId: string | null,
  workerName: string | null,
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

function buildOpenworkAppConnectUrl(
  appConnectBaseUrl: string,
  openworkUrl: string | null,
  accessToken: string | null,
  workerId: string | null,
  workerName: string | null,
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
    connectUrl.pathname =
      lastSegment === "connect-remote" ? normalizedPath : `${normalizedPath}/connect-remote`;
  }

  connectUrl.searchParams.set("openworkHostUrl", openworkUrl);
  connectUrl.searchParams.set("openworkToken", accessToken);
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

async function resolveOpenworkWorkspaceUrl(instanceUrl: string, accessToken: string): Promise<{ workspaceId: string; openworkUrl: string } | null> {
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

async function requestJson(path: string, init: RequestInit = {}, timeoutMs = 30000) {
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

function CredentialRow({
  label,
  value,
  placeholder,
  canCopy,
  copied,
  onCopy
}: {
  label: string;
  value: string | null;
  placeholder: string;
  canCopy: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <label className="grid gap-2">
      <span className="px-0.5 text-[0.67rem] font-bold uppercase tracking-[0.11em] text-slate-500">{label}</span>
      <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-1.5">
        <input
          readOnly
          value={value ?? placeholder}
          className="min-w-0 flex-1 border-none bg-transparent px-2 py-1.5 font-mono text-xs text-slate-700 outline-none"
          onClick={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:border-[#1B29FF] hover:text-[#1B29FF] disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canCopy}
          onClick={onCopy}
        >
          {copied ? "Copied" : canCopy ? "Copy" : "N/A"}
        </button>
      </div>
    </label>
  );
}

function getStartupMilestoneIndex({
  launchStatus,
  latestEvent,
  bucket,
  launchBusy,
  workersBusy
}: {
  launchStatus: string;
  latestEvent: LaunchEvent | null;
  bucket: WorkerStatusBucket;
  launchBusy: boolean;
  workersBusy: boolean;
}): number | null {
  const combined = `${latestEvent?.label ?? ""} ${latestEvent?.detail ?? ""} ${launchStatus}`.toLowerCase();

  if (combined.includes("access token ready") || combined.includes("ready to connect")) {
    return 15;
  }

  if (combined.includes("token")) {
    return 9;
  }

  if (combined.includes("provisioning complete") || combined.includes("health")) {
    return 12;
  }

  if (combined.includes("status refreshed") || combined.includes("provisioning update") || workersBusy) {
    return 10;
  }

  if (combined.includes("provisioning started")) {
    return 3;
  }

  if (combined.includes("worker launched") || combined.includes("worker is currently") || bucket === "starting") {
    return 6;
  }

  if (combined.includes("checking subscription") || combined.includes("launch requested")) {
    return 0;
  }

  if (launchBusy) {
    return 0;
  }

  return null;
}

function getStartupSequenceItem(index: number): StartupSequenceItem {
  return STARTUP_SEQUENCE[index % STARTUP_SEQUENCE.length];
}

function getNextStartupSequenceIndex(index: number): number {
  return (index + 1) % STARTUP_SEQUENCE.length;
}

function StartupSequenceRow({
  active,
  launchStatus,
  latestEvent,
  bucket,
  launchBusy,
  workersBusy
}: {
  active: boolean;
  launchStatus: string;
  latestEvent: LaunchEvent | null;
  bucket: WorkerStatusBucket;
  launchBusy: boolean;
  workersBusy: boolean;
}) {
  const milestoneIndex = getStartupMilestoneIndex({ launchStatus, latestEvent, bucket, launchBusy, workersBusy });
  const [currentIndex, setCurrentIndex] = useState(milestoneIndex ?? 0);
  const [phraseVisible, setPhraseVisible] = useState(true);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = () => setPrefersReducedMotion(mediaQuery.matches);

    handleChange();
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    if (!active) {
      setCurrentIndex(0);
      setPhraseVisible(true);
      return;
    }

    if (milestoneIndex !== null) {
      setCurrentIndex((value) => Math.max(value, milestoneIndex));
    }
  }, [active, milestoneIndex]);

  useEffect(() => {
    if (!active || typeof window === "undefined") {
      return;
    }

    let fadeTimeout: number | undefined;

    const interval = window.setInterval(() => {
      if (prefersReducedMotion) {
        setCurrentIndex((value) => getNextStartupSequenceIndex(value));
        return;
      }

      setPhraseVisible(false);
      fadeTimeout = window.setTimeout(() => {
        setCurrentIndex((value) => getNextStartupSequenceIndex(value));
        setPhraseVisible(true);
      }, 180);
    }, STARTUP_ROTATION_MS);

    return () => {
      window.clearInterval(interval);
      if (fadeTimeout !== undefined) {
        window.clearTimeout(fadeTimeout);
      }
    };
  }, [active, prefersReducedMotion]);

  const item = getStartupSequenceItem(currentIndex);
  const Icon = item.Icon;

  return (
    <div className="rounded-[22px] border border-slate-200 bg-slate-50 px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-[#1B29FF] shadow-[0_10px_24px_rgba(27,41,255,0.08)]">
          <Icon className={`h-4 w-4 ${item.spin ? "animate-spin motion-reduce:animate-none" : ""}`} />
        </div>

        <div className="min-w-0 flex-1">
          <div
            aria-live="polite"
            aria-atomic="true"
            className={`min-h-[1.5rem] text-sm font-semibold leading-6 text-slate-900 transition-all duration-200 ease-out motion-reduce:transition-none ${phraseVisible ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"}`}
          >
            {item.label}
          </div>
          <p className="mt-1 hidden text-xs leading-5 text-slate-500 lg:block">{item.sublabel}</p>
        </div>

        <div className="hidden sm:block">
          <div className="h-2 w-16 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full w-1/2 rounded-full bg-[#1B29FF] animate-pulse motion-reduce:animate-none" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function CloudControlPanel() {
  const [step, setStep] = useState<Step>(1);
  const [shellView, setShellView] = useState<ShellView>("workers");

  const [authMode, setAuthMode] = useState<AuthMode>("sign-up");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authInfo, setAuthInfo] = useState(getAuthInfoForMode("sign-up"));
  const [authError, setAuthError] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }

    const token = window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    if (!token || token.trim().length === 0) {
      return null;
    }

    return token;
  });

  const [workerName, setWorkerName] = useState("Founder Ops");
  const [worker, setWorker] = useState<WorkerLaunch | null>(null);
  const [workerLookupId, setWorkerLookupId] = useState("");
  const [workers, setWorkers] = useState<WorkerListItem[]>([]);
  const [workersBusy, setWorkersBusy] = useState(false);
  const [workersError, setWorkersError] = useState<string | null>(null);
  const [launchBusy, setLaunchBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<"status" | "token" | null>(null);
  const [launchStatus, setLaunchStatus] = useState("Start your worker when you're ready.");
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [billingSummary, setBillingSummary] = useState<BillingSummary | null>(null);
  const [billingBusy, setBillingBusy] = useState(false);
  const [billingCheckoutBusy, setBillingCheckoutBusy] = useState(false);
  const [billingSubscriptionBusy, setBillingSubscriptionBusy] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [paymentReturned, setPaymentReturned] = useState(false);

  const [events, setEvents] = useState<LaunchEvent[]>([]);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [tokenFetchedForWorkerId, setTokenFetchedForWorkerId] = useState<string | null>(null);
  const [deleteBusyWorkerId, setDeleteBusyWorkerId] = useState<string | null>(null);
  const [workerQuery, setWorkerQuery] = useState("");
  const [workerStatusFilter, setWorkerStatusFilter] = useState<WorkerStatusBucket | "all">("all");
  const [showLaunchForm, setShowLaunchForm] = useState(false);
  const [mobileWorkersExpanded, setMobileWorkersExpanded] = useState(false);
  const [pendingRestoredWorkerId, setPendingRestoredWorkerId] = useState<string | null>(null);
  const [openAccordion, setOpenAccordion] = useState<"connect" | "actions" | "advanced" | null>(null);
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<WorkerRuntimeSnapshot | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [runtimeUpgradeBusy, setRuntimeUpgradeBusy] = useState(false);
  const [dismissedDesktopPromptWorkerId, setDismissedDesktopPromptWorkerId] = useState<string | null>(null);
  const [isDesktopViewport, setIsDesktopViewport] = useState(false);

  const selectedWorker = workers.find((item) => item.workerId === workerLookupId) ?? null;
  const activeWorker: WorkerLaunch | null =
    worker && workerLookupId === worker.workerId
      ? worker
      : selectedWorker
        ? listItemToWorker(selectedWorker, worker)
        : worker;

  const progressWidth = step === 1 ? "45%" : "100%";
  const isShellStep = step === 2;
  const defaultAuthInfo = getAuthInfoForMode(authMode);
  const showAuthFeedback = authInfo !== defaultAuthInfo || authError !== null;
  const openworkConnectUrl = activeWorker?.openworkUrl ?? activeWorker?.instanceUrl ?? null;
  const hasWorkspaceScopedUrl = Boolean(openworkConnectUrl && /\/w\/[^/?#]+/.test(openworkConnectUrl));
  const ownedWorkerCount = workers.filter((item) => item.isMine).length;
  const workerLimitReached = Boolean(user && ownedWorkerCount > 0);
  const openworkDeepLink = buildOpenworkDeepLink(
    openworkConnectUrl,
    activeWorker?.clientToken ?? null,
    activeWorker?.workerId ?? null,
    activeWorker?.workerName ?? null,
  );
  const openworkAppConnectUrl = buildOpenworkAppConnectUrl(
    OPENWORK_APP_CONNECT_BASE_URL,
    openworkConnectUrl,
    activeWorker?.clientToken ?? null,
    activeWorker?.workerId ?? null,
    activeWorker?.workerName ?? null,
  );

  const filteredWorkers = workers.filter((item) => {
    const query = workerQuery.trim().toLowerCase();
    const matchesQuery =
      !query ||
      item.workerName.toLowerCase().includes(query) ||
      item.workerId.toLowerCase().includes(query);

    if (!matchesQuery) {
      return false;
    }

    if (workerStatusFilter === "all") {
      return true;
    }

    return getWorkerStatusMeta(item.status).bucket === workerStatusFilter;
  });

  const selectWorker = (item: WorkerListItem, options: { collapseMobile?: boolean } = {}) => {
    setWorkerLookupId(item.workerId);
    setWorker((current) => listItemToWorker(item, current));
    if (options.collapseMobile) {
      setMobileWorkersExpanded(false);
      setShowLaunchForm(false);
    }
  };

  const mobilePreviewWorker = selectedWorker ?? filteredWorkers[0] ?? null;

  const renderWorkerRow = (
    item: WorkerListItem,
    options: { collapseMobile?: boolean; dense?: boolean } = {}
  ) => {
    const meta = getWorkerStatusMeta(item.status);
    const isActive = workerLookupId === item.workerId;
    const statusPill =
      meta.bucket === "ready"
        ? "bg-[#E8F5E9] text-[#2E7D32]"
        : meta.bucket === "starting"
          ? "bg-amber-100 text-amber-700"
          : meta.bucket === "attention"
            ? "bg-rose-100 text-rose-700"
            : "bg-slate-100 text-slate-500";

    const statusDot =
      meta.bucket === "ready"
        ? "bg-[#2E7D32]"
        : meta.bucket === "starting"
          ? "bg-amber-500"
          : meta.bucket === "attention"
            ? "bg-rose-500"
            : "bg-slate-400";

    return (
      <button
        key={item.workerId}
        type="button"
        onClick={() => selectWorker(item, { collapseMobile: options.collapseMobile })}
        className={`w-full rounded-[20px] border ${options.dense ? "p-3" : "p-4"} text-left transition-all ${
          isActive
            ? "border-[#1B29FF] bg-[#1B29FF]/[0.03] ring-1 ring-[#1B29FF]/30"
            : "border-slate-100 bg-white hover:border-slate-300"
        }`}
      >
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className={`truncate pr-2 text-sm font-semibold ${isActive ? "text-[#1B29FF]" : "text-slate-700"}`}>
            {item.workerName}
          </span>
          {item.isMine ? (
            <span className="shrink-0 rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Yours
            </span>
          ) : null}
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="font-mono text-xs font-medium text-slate-400">{getWorkerAddressLabel(item)}</span>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${statusPill}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${statusDot}`} />
            {meta.label}
          </span>
        </div>
      </button>
    );
  };

  const selectedWorkerStatus = activeWorker?.status ?? selectedWorker?.status ?? "unknown";
  const selectedStatusMeta = getWorkerStatusMeta(selectedWorkerStatus);
  const trafficLights = getTrafficLightClasses(selectedStatusMeta.bucket);
  const primaryWorker = activeWorker;
  const primaryAppUrl = openworkDeepLink;
  const browserStartUrl = openworkAppConnectUrl;
  const canOpenWorker = selectedStatusMeta.bucket === "ready" && Boolean(primaryAppUrl);
  const canStartInOpenwork = selectedStatusMeta.bucket === "ready" && Boolean(openworkDeepLink);
  const canStartHere = selectedStatusMeta.bucket === "ready" && Boolean(browserStartUrl);
  const showStartupSequence = launchBusy || (Boolean(primaryWorker) && selectedStatusMeta.bucket !== "ready");
  const showDesktopStartupModal =
    isDesktopViewport &&
    Boolean(primaryWorker) &&
    selectedStatusMeta.bucket !== "ready" &&
    dismissedDesktopPromptWorkerId !== primaryWorker?.workerId;
  const showInlineStartupSequence = showStartupSequence && !showDesktopStartupModal;
  const effectiveCheckoutUrl = BILLING_DISABLED_FOR_EXPERIMENT ? null : (checkoutUrl ?? billingSummary?.checkoutUrl ?? null);
  const billingSubscription = billingSummary?.subscription ?? null;
  const billingPrice = billingSummary?.price ?? null;
  const runtimeUpgradeCount = runtimeSnapshot?.services.filter((item) => item.upgradeAvailable).length ?? 0;

  function appendEvent(level: EventLevel, label: string, detail: string) {
    setEvents((current) => {
      const next: LaunchEvent[] = [
        {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          level,
          label,
          detail,
          at: new Date().toISOString()
        },
        ...current
      ];

      return next.slice(0, 10);
    });
  }

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(min-width: 1024px)");
    const handleChange = () => setIsDesktopViewport(mediaQuery.matches);

    handleChange();
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    if (!primaryWorker || selectedStatusMeta.bucket === "ready") {
      setDismissedDesktopPromptWorkerId(null);
    }
  }, [primaryWorker?.workerId, selectedStatusMeta.bucket]);

  useEffect(() => {
    if (!showDesktopStartupModal || !primaryWorker) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setDismissedDesktopPromptWorkerId(primaryWorker.workerId);
    }, 90_000);

    return () => window.clearTimeout(timeout);
  }, [primaryWorker, showDesktopStartupModal]);

  async function withResolvedOpenworkCredentials(candidate: WorkerLaunch, options: { quiet?: boolean } = {}) {
    const existingConnectUrl = candidate.openworkUrl?.trim() ?? "";
    const existingWorkspaceId = candidate.workspaceId?.trim() ?? "";
    if (existingConnectUrl && existingWorkspaceId) {
      return {
        ...candidate,
        openworkUrl: existingConnectUrl,
        workspaceId: existingWorkspaceId
      };
    }

    const instanceUrl = candidate.instanceUrl?.trim() ?? "";
    if (!instanceUrl) {
      return {
        ...candidate,
        openworkUrl: null,
        workspaceId: null
      };
    }

    const accessToken = candidate.clientToken?.trim() ?? "";
    if (!accessToken) {
      const mountedWorkspaceId = parseWorkspaceIdFromUrl(instanceUrl);
      return {
        ...candidate,
        openworkUrl: normalizeUrl(instanceUrl),
        workspaceId: mountedWorkspaceId
      };
    }

    try {
      const resolved = await resolveOpenworkWorkspaceUrl(instanceUrl, accessToken);
      if (resolved) {
        return {
          ...candidate,
          openworkUrl: resolved.openworkUrl,
          workspaceId: resolved.workspaceId
        };
      }
    } catch {
      if (!options.quiet) {
        appendEvent("warning", "Credential hint", "Could not resolve /w/ws_ URL yet. Using host URL fallback.");
      }
    }

    return {
      ...candidate,
      openworkUrl: normalizeUrl(instanceUrl),
      workspaceId: parseWorkspaceIdFromUrl(instanceUrl)
    };
  }

  async function refreshWorkers(options: { keepSelection?: boolean } = {}) {
    if (!user) {
      setWorkers([]);
      setWorkersError(null);
      return;
    }

    setWorkersBusy(true);
    setWorkersError(null);

    try {
      const { response, payload } = await requestJson("/v1/workers?limit=20", {
        method: "GET",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
      });

      if (!response.ok) {
        const message = getErrorMessage(payload, `Failed to load workers (${response.status}).`);
        setWorkersError(message);
        return;
      }

      const nextWorkers = getWorkersList(payload);
      setWorkers(nextWorkers);

      const restoredWorkerStillExists =
        pendingRestoredWorkerId && nextWorkers.some((item) => item.workerId === pendingRestoredWorkerId);

      const nextSelectedId =
        (restoredWorkerStillExists ? pendingRestoredWorkerId : null) ||
        (workerLookupId && nextWorkers.some((item) => item.workerId === workerLookupId) ? workerLookupId : null) ||
        nextWorkers[0]?.workerId ||
        "";

      setWorkerLookupId(nextSelectedId);

      if (!nextSelectedId) {
        setWorker(null);
        setTokenFetchedForWorkerId(null);
        setPendingRestoredWorkerId(null);
        setLaunchStatus("Start your worker when you're ready.");
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(LAST_WORKER_STORAGE_KEY);
        }
        return;
      }

      if (restoredWorkerStillExists) {
        setPendingRestoredWorkerId(null);
      }

      const selected = nextWorkers.find((item) => item.workerId === nextSelectedId) ?? null;
      if (selected) {
        setWorker((current) => listItemToWorker(selected, current));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      setWorkersError(message);
    } finally {
      setWorkersBusy(false);
    }
  }

  async function refreshRuntime(workerId?: string, options: { quiet?: boolean } = {}) {
    const targetWorkerId = workerId ?? activeWorker?.workerId ?? selectedWorker?.workerId ?? null;
    if (!user || !targetWorkerId) {
      setRuntimeSnapshot(null);
      if (!options.quiet) {
        setRuntimeError("Select a worker to inspect runtime versions.");
      }
      return null;
    }

    setRuntimeBusy(true);
    if (!options.quiet) {
      setRuntimeError(null);
    }

    try {
      const { response, payload } = await requestJson(`/v1/workers/${encodeURIComponent(targetWorkerId)}/runtime`, {
        method: "GET",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
      }, 12000);

      if (!response.ok) {
        const message = getErrorMessage(payload, `Runtime check failed with ${response.status}.`);
        if (!options.quiet) {
          setRuntimeError(message);
        }
        return null;
      }

      const snapshot = getWorkerRuntimeSnapshot(payload);
      if (!snapshot) {
        if (!options.quiet) {
          setRuntimeError("Runtime details were missing from the worker response.");
        }
        return null;
      }

      setRuntimeSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      if (!options.quiet) {
        setRuntimeError(message);
      }
      return null;
    } finally {
      setRuntimeBusy(false);
    }
  }

  async function handleRuntimeUpgrade() {
    const targetWorkerId = activeWorker?.workerId ?? selectedWorker?.workerId ?? null;
    if (!user || !targetWorkerId || runtimeUpgradeBusy) {
      return;
    }

    setRuntimeUpgradeBusy(true);
    setRuntimeError(null);

    try {
      const { response, payload } = await requestJson(`/v1/workers/${encodeURIComponent(targetWorkerId)}/runtime/upgrade`, {
        method: "POST",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
        body: JSON.stringify({ services: ["openwork-server", "opencode"] })
      }, 12000);

      if (!response.ok) {
        const message = getErrorMessage(payload, `Runtime upgrade failed with ${response.status}.`);
        setRuntimeError(message);
        appendEvent("error", "Runtime upgrade failed", message);
        return;
      }

      appendEvent("info", "Runtime upgrade started", activeWorker?.workerName ?? selectedWorker?.workerName ?? targetWorkerId);
      setRuntimeSnapshot((current) => current
        ? {
            ...current,
            upgrade: {
              ...current.upgrade,
              status: "running",
              startedAt: new Date().toISOString(),
              finishedAt: null,
              error: null
            }
          }
        : current);

      window.setTimeout(() => {
        void refreshRuntime(targetWorkerId, { quiet: true });
      }, 4000);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      setRuntimeError(message);
      appendEvent("error", "Runtime upgrade failed", message);
    } finally {
      setRuntimeUpgradeBusy(false);
    }
  }

  async function refreshBilling(options: { includeCheckout?: boolean; quiet?: boolean } = {}) {
    if (BILLING_DISABLED_FOR_EXPERIMENT) {
      const summary = getExperimentBillingSummary();
      setBillingSummary(summary);
      setCheckoutUrl(null);
      setBillingError(null);
      return summary;
    }

    if (!user) {
      setBillingSummary(null);
      if (!options.quiet) {
        setBillingError("Sign in to view billing details.");
      }
      return null;
    }

    const includeCheckout = options.includeCheckout === true;
    const quiet = options.quiet === true;

    if (includeCheckout) {
      setBillingCheckoutBusy(true);
    } else {
      setBillingBusy(true);
    }

    if (!quiet) {
      setBillingError(null);
    }

    try {
      const query = includeCheckout ? "?includeCheckout=1" : "";
      const { response, payload } = await requestJson(`/v1/workers/billing${query}`, {
        method: "GET",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
      }, 12000);

      if (!response.ok) {
        const message = getErrorMessage(payload, `Billing lookup failed with ${response.status}.`);
        if (!quiet) {
          setBillingError(message);
          appendEvent("error", "Billing check failed", message);
        }
        return null;
      }

      const summary = getBillingSummary(payload);
      if (!summary) {
        if (!quiet) {
          setBillingError("Billing response was missing details.");
          appendEvent("error", "Billing check failed", "Billing summary missing");
        }
        return null;
      }

      setBillingSummary(summary);
      if (summary.checkoutUrl) {
        setCheckoutUrl(summary.checkoutUrl);
      } else if (!summary.checkoutRequired) {
        setCheckoutUrl(null);
      }

      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      if (!quiet) {
        setBillingError(message);
        appendEvent("error", "Billing check failed", message);
      }
      return null;
    } finally {
      if (includeCheckout) {
        setBillingCheckoutBusy(false);
      } else {
        setBillingBusy(false);
      }
    }
  }

  async function handleSubscriptionCancellation(cancelAtPeriodEnd: boolean) {
    if (BILLING_DISABLED_FOR_EXPERIMENT) {
      setBillingSummary(getExperimentBillingSummary());
      setCheckoutUrl(null);
      setBillingError("Billing is disabled for this experiment.");
      return;
    }

    if (!user || billingSubscriptionBusy) {
      return;
    }

    if (cancelAtPeriodEnd && typeof window !== "undefined") {
      const confirmed = window.confirm("Cancel subscription at period end? You can still use your current billing period.");
      if (!confirmed) {
        return;
      }
    }

    setBillingSubscriptionBusy(true);
    setBillingError(null);

    try {
      const { response, payload } = await requestJson("/v1/workers/billing/subscription", {
        method: "POST",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
        body: JSON.stringify({ cancelAtPeriodEnd })
      }, 12000);

      if (!response.ok) {
        const message = getErrorMessage(payload, `Subscription update failed (${response.status}).`);
        setBillingError(message);
        appendEvent("error", "Subscription update failed", message);
        return;
      }

      const summary = getBillingSummary(payload);
      if (!summary) {
        setBillingError("Subscription updated, but billing details could not be refreshed.");
        appendEvent("warning", "Subscription updated", "Billing summary missing");
        return;
      }

      setBillingSummary(summary);
      if (summary.checkoutUrl) {
        setCheckoutUrl(summary.checkoutUrl);
      } else if (!summary.checkoutRequired) {
        setCheckoutUrl(null);
      }

      const actionLabel = cancelAtPeriodEnd ? "Subscription will cancel at period end" : "Subscription auto-renew resumed";
      appendEvent("success", actionLabel, user.email);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      setBillingError(message);
      appendEvent("error", "Subscription update failed", message);
    } finally {
      setBillingSubscriptionBusy(false);
    }
  }

  async function copyToClipboard(field: string, value: string | null) {
    if (!value) {
      return;
    }

    await navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => {
      setCopiedField((current) => (current === field ? null : current));
    }, 1800);
  }

  async function refreshSession(quiet = false) {
    const headers = new Headers();
    if (authToken) {
      headers.set("Authorization", `Bearer ${authToken}`);
    }

    const { response, payload } = await requestJson("/v1/me", { method: "GET", headers }, 12000);

    if (!response.ok) {
      setUser(null);
      if (response.status === 401 && authToken) {
        setAuthToken(null);
      }
      if (!quiet) {
        setAuthError("No active session found. Sign in first.");
      }
      return null;
    }

    const sessionUser = getUser(payload);
    if (!sessionUser) {
      if (!quiet) {
        setAuthError("Session response did not include a user.");
      }
      return null;
    }

    setUser(sessionUser);
    setAuthInfo(`Signed in as ${sessionUser.email}.`);
    return sessionUser;
  }

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (authToken) {
      window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, authToken);
    } else {
      window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    }
  }, [authToken]);

  useEffect(() => {
    void refreshSession(true);
  }, [authToken]);

  useEffect(() => {
    if (!user) {
      setWorkers([]);
      setWorkersError(null);
      return;
    }

    void refreshWorkers();
  }, [user?.id, authToken]);

  useEffect(() => {
    setRuntimeSnapshot(null);
    setRuntimeError(null);
  }, [activeWorker?.workerId, selectedWorker?.workerId]);

  useEffect(() => {
    if (BILLING_DISABLED_FOR_EXPERIMENT) {
      setBillingSummary(getExperimentBillingSummary());
      setBillingError(null);
      setCheckoutUrl(null);
      return;
    }

    if (!user) {
      setBillingSummary(null);
      setBillingError(null);
      return;
    }

    void refreshBilling({ quiet: true });
  }, [user?.id, authToken]);

  useEffect(() => {
    if (BILLING_DISABLED_FOR_EXPERIMENT) {
      if (shellView !== "workers") {
        setShellView("workers");
      }
      return;
    }

    if (!user || shellView !== "billing") {
      return;
    }

    void refreshBilling();
  }, [shellView, user?.id, authToken]);

  useEffect(() => {
    if (!user || typeof window === "undefined") {
      return;
    }

    identifyPosthogUser(user);

    const pendingSocialSignup = window.sessionStorage.getItem(PENDING_SOCIAL_SIGNUP_STORAGE_KEY);
    if (pendingSocialSignup !== "github" && pendingSocialSignup !== "google") {
      return;
    }

    window.sessionStorage.removeItem(PENDING_SOCIAL_SIGNUP_STORAGE_KEY);
    trackPosthogEvent("den_signup_completed", {
      mode: "sign-up",
      method: pendingSocialSignup,
      email_domain: getEmailDomain(user.email)
    });
    void trackDenSignupInLoops({
      email: user.email,
      name: user.name,
      userId: user.id,
      authMethod: pendingSocialSignup
    });
  }, [user?.id]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const customerSessionToken = params.get("customer_session_token");
    if (!customerSessionToken) {
      return;
    }

    // Polar checkout returns are ignored while billing is disabled for this experiment.
    // TODO(den-free-first-worker): Re-enable the original Polar checkout return flow after the experiment.
    // setPaymentReturned(true);
    // setCheckoutUrl(null);
    // setShellView("billing");
    // setLaunchStatus("Checkout return detected. Click launch to continue worker provisioning.");
    // setAuthInfo("Checkout return detected. Sign in to continue to Billing.");
    // appendEvent("success", "Returned from checkout", `Session ${shortValue(customerSessionToken)}`);
    // trackPosthogEvent("den_paywall_checkout_returned", {
    //   source: "polar",
    //   session_token_present: true
    // });
    setCheckoutUrl(null);
    setShellView("workers");
    setLaunchStatus("Start your worker when you're ready.");

    params.delete("customer_session_token");
    const nextQuery = params.toString();
    const nextUrl = nextQuery ? `${window.location.pathname}?${nextQuery}` : window.location.pathname;
    window.history.replaceState({}, "", nextUrl);
  }, []);

  useEffect(() => {
    if (!paymentReturned || !user) {
      return;
    }

    // Billing refresh intentionally disabled for the one-worker experiment.
  }, [paymentReturned, user?.id, authToken]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const raw = window.localStorage.getItem(LAST_WORKER_STORAGE_KEY);
    if (!raw) {
      return;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isWorkerLaunch(parsed)) {
        return;
      }

      const restored: WorkerLaunch = {
        ...parsed,
        openworkUrl: parsed.openworkUrl ?? parsed.instanceUrl,
        workspaceId: parsed.workspaceId ?? parseWorkspaceIdFromUrl(parsed.instanceUrl ?? ""),
        clientToken: null,
        hostToken: null
      };

      setWorker(restored);
      setWorkerLookupId(restored.workerId);
      setPendingRestoredWorkerId(restored.workerId);
      setLaunchStatus(`Recovered worker ${restored.workerName}. ${getWorkerStatusCopy(restored.status)}`);
      appendEvent("info", "Recovered worker context", `Worker ID ${restored.workerId}`);
    } catch {
      return;
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !worker) {
      return;
    }

    const serializable: WorkerLaunch = {
      ...worker,
      clientToken: null,
      hostToken: null
    };

    window.localStorage.setItem(LAST_WORKER_STORAGE_KEY, JSON.stringify(serializable));
  }, [worker]);

  useEffect(() => {
    if (user || checkoutUrl) {
      setStep(2);
      return;
    }

    setStep(1);
  }, [user, checkoutUrl]);

  useEffect(() => {
    if (step !== 2) {
      return;
    }

    if (workers.length > 0) {
      return;
    }

    setMobileWorkersExpanded(false);
    setShowLaunchForm(pendingRestoredWorkerId === null);
  }, [pendingRestoredWorkerId, step, workers.length]);

  useEffect(() => {
    if (!user || !worker) {
      return;
    }
    if (pendingRestoredWorkerId === worker.workerId) {
      return;
    }
    if (worker.clientToken) {
      return;
    }
    if (actionBusy !== null || launchBusy) {
      return;
    }
    if (tokenFetchedForWorkerId === worker.workerId) {
      return;
    }

    setTokenFetchedForWorkerId(worker.workerId);
    void handleGenerateKey();
  }, [actionBusy, launchBusy, pendingRestoredWorkerId, tokenFetchedForWorkerId, user, worker]);

  useEffect(() => {
    if (!user || !worker || worker.status !== "provisioning") {
      return;
    }
    if (pendingRestoredWorkerId === worker.workerId) {
      return;
    }
    if (actionBusy !== null || launchBusy) {
      return;
    }

    let cancelled = false;

    const poll = async () => {
      if (cancelled) {
        return;
      }
      await handleCheckStatus({ workerId: worker.workerId, quiet: true, background: true });
    };

    void poll();
    const interval = window.setInterval(() => {
      void poll();
    }, WORKER_STATUS_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [actionBusy, authToken, launchBusy, pendingRestoredWorkerId, user?.id, worker?.workerId, worker?.status]);

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setAuthBusy(true);
    setAuthError(null);
    trackPosthogEvent("den_auth_submitted", {
      mode: authMode,
      method: "email"
    });

    try {
      const endpoint = authMode === "sign-up" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email";
      const trimmedEmail = email.trim();
      const body =
        authMode === "sign-up"
          ? {
              name: DEFAULT_AUTH_NAME,
              email: trimmedEmail,
              password
            }
          : {
              email: trimmedEmail,
              password
            };

      const { response, payload } = await requestJson(endpoint, {
        method: "POST",
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        setAuthError(getErrorMessage(payload, `Authentication failed with ${response.status}.`));
        trackPosthogEvent("den_auth_failed", {
          mode: authMode,
          method: "email",
          status: response.status
        });
        return;
      }

      const token = getToken(payload);
      if (token) {
        setAuthToken(token);
      }

      let authenticatedUser: AuthUser | null = null;
      const payloadUser = getUser(payload);
      if (payloadUser) {
        authenticatedUser = payloadUser;
        setUser(payloadUser);
        setAuthInfo(`Signed in as ${payloadUser.email}.`);
        appendEvent("success", authMode === "sign-up" ? "Account created" : "Signed in", payloadUser.email);
      } else {
        const refreshed = await refreshSession(true);
        if (!refreshed) {
          setAuthInfo("Authentication succeeded, but session details are still syncing.");
        } else {
          authenticatedUser = refreshed;
          appendEvent("success", authMode === "sign-up" ? "Account created" : "Signed in", refreshed.email);
        }
      }

      if (authenticatedUser) {
        identifyPosthogUser(authenticatedUser);

        const analyticsPayload = {
          mode: authMode,
          method: "email",
          email_domain: getEmailDomain(authenticatedUser.email)
        };

        if (authMode === "sign-up") {
          trackPosthogEvent("den_signup_completed", analyticsPayload);
          void trackDenSignupInLoops({
            email: authenticatedUser.email,
            name: authenticatedUser.name,
            userId: authenticatedUser.id,
            authMethod: "email"
          });
        } else {
          trackPosthogEvent("den_signin_completed", analyticsPayload);
        }
      }

      setStep(2);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      setAuthError(message);
      trackPosthogEvent("den_auth_failed", {
        mode: authMode,
        method: "email",
        reason: "network_error"
      });
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSocialSignIn(provider: SocialAuthProvider) {
    if (authBusy || typeof window === "undefined") {
      return;
    }

    const shouldTrackSocialSignup = authMode === "sign-up";
    if (shouldTrackSocialSignup) {
      window.sessionStorage.setItem(PENDING_SOCIAL_SIGNUP_STORAGE_KEY, provider);
    }

    setAuthBusy(true);
    setAuthError(null);
    setAuthInfo(`Redirecting to ${getSocialProviderLabel(provider)}...`);
    trackPosthogEvent("den_auth_submitted", {
      mode: authMode,
      method: provider
    });

    try {
      const callbackURL = getSocialCallbackUrl();
      const { response, payload } = await requestJson("/api/auth/sign-in/social", {
        method: "POST",
        body: JSON.stringify({
          provider,
          callbackURL,
          errorCallbackURL: callbackURL
        })
      });

      if (!response.ok) {
        if (shouldTrackSocialSignup) {
          window.sessionStorage.removeItem(PENDING_SOCIAL_SIGNUP_STORAGE_KEY);
        }
        setAuthInfo(getAuthInfoForMode(authMode));
        setAuthError(getErrorMessage(payload, `${getSocialProviderLabel(provider)} sign-in failed with ${response.status}.`));
        trackPosthogEvent("den_auth_failed", {
          mode: authMode,
          method: provider,
          status: response.status
        });
        setAuthBusy(false);
        return;
      }

      const payloadUrl = isRecord(payload) && typeof payload.url === "string" ? payload.url.trim() : "";
      const headerUrl = response.headers.get("location")?.trim() ?? "";
      const redirectUrl = payloadUrl || headerUrl;

      if (!redirectUrl) {
        if (shouldTrackSocialSignup) {
          window.sessionStorage.removeItem(PENDING_SOCIAL_SIGNUP_STORAGE_KEY);
        }
        setAuthInfo(getAuthInfoForMode(authMode));
        setAuthError(`${getSocialProviderLabel(provider)} sign-in did not return a redirect URL.`);
        trackPosthogEvent("den_auth_failed", {
          mode: authMode,
          method: provider,
          reason: "missing_redirect_url"
        });
        setAuthBusy(false);
        return;
      }

      trackPosthogEvent("den_auth_redirected", {
        mode: authMode,
        method: provider
      });
      window.location.assign(redirectUrl);
    } catch (error) {
      if (shouldTrackSocialSignup) {
        window.sessionStorage.removeItem(PENDING_SOCIAL_SIGNUP_STORAGE_KEY);
      }
      const message = error instanceof Error ? error.message : "Unknown network error";
      setAuthInfo(getAuthInfoForMode(authMode));
      setAuthError(message);
      trackPosthogEvent("den_auth_failed", {
        mode: authMode,
        method: provider,
        reason: "network_error"
      });
      setAuthBusy(false);
    }
  }

  async function handleSignOut() {
    if (authBusy) {
      return;
    }

    setAuthBusy(true);
    setAuthError(null);

    try {
      await requestJson("/api/auth/sign-out", {
        method: "POST",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
        body: JSON.stringify({})
      });
    } catch {
      // Ignore sign-out transport issues and clear local session state anyway.
    } finally {
      setAuthBusy(false);
    }

    setUser(null);
    setAuthToken(null);
    setWorker(null);
    setWorkers([]);
    setWorkerLookupId("");
    setWorkersError(null);
    setLaunchError(null);
    setCheckoutUrl(null);
    setBillingSummary(null);
    setBillingError(null);
    setBillingBusy(false);
    setBillingCheckoutBusy(false);
    setBillingSubscriptionBusy(false);
    setPaymentReturned(false);
    setTokenFetchedForWorkerId(null);
    setDeleteBusyWorkerId(null);
    setActionBusy(null);
    setLaunchBusy(false);
    setStep(1);
    setShellView("workers");
    setWorkerQuery("");
    setWorkerStatusFilter("all");
    setShowLaunchForm(false);
    setMobileWorkersExpanded(false);
    setPendingRestoredWorkerId(null);
    setAuthMode("sign-up");
    setEmail("");
    setPassword("");
    setAuthInfo(getAuthInfoForMode("sign-up"));
    setLaunchStatus("Start your worker when you're ready.");
    setEvents([]);
    resetPosthogUser();
    trackPosthogEvent("den_signout_completed", { method: "manual" });

    if (typeof window !== "undefined") {
      window.localStorage.removeItem(LAST_WORKER_STORAGE_KEY);
      window.sessionStorage.removeItem(PENDING_SOCIAL_SIGNUP_STORAGE_KEY);
    }
  }

  async function handleLaunchWorker() {
    if (!user) {
      setAuthError("Sign in before launching a worker.");
      return;
    }

    setLaunchBusy(true);
    setLaunchError(null);
    setCheckoutUrl(null);
    setLaunchStatus("Checking subscription and launch eligibility...");
    appendEvent("info", "Launch requested", workerName.trim() || "Cloud worker");
    trackPosthogEvent("den_worker_launch_requested", {
      worker_name_present: Boolean(workerName.trim())
    });

    try {
      const { response, payload } = await requestJson(
        "/v1/workers",
        {
          method: "POST",
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
          body: JSON.stringify({
            name: workerName.trim() || "Cloud Worker",
            destination: "cloud"
          })
        },
        12000
      );

      // TODO(den-free-first-worker): Restore this 402 paywall branch after the one-worker experiment ends.
      // if (response.status === 402) {
      //   const url = getCheckoutUrl(payload);
      //   setCheckoutUrl(url);
      //   setShellView("billing");
      //   setBillingSummary((current) => {
      //     if (!current) {
      //       return current;
      //     }
      //
      //     return {
      //       ...current,
      //       hasActivePlan: false,
      //       checkoutRequired: true,
      //       checkoutUrl: url ?? current.checkoutUrl
      //     };
      //   });
      //   setLaunchStatus("Payment is required. Complete checkout and return to continue launch.");
      //   setLaunchError(url ? null : "Checkout URL missing from paywall response.");
      //   appendEvent("warning", "Paywall required", url ? "Checkout URL generated" : "Checkout URL missing");
      //   trackPosthogEvent("den_paywall_required", {
      //     checkout_url_present: Boolean(url)
      //   });
      //
      //   if (!url) {
      //     void refreshBilling({ includeCheckout: true, quiet: true });
      //   }
      //
      //   return;
      // }
      if (response.status === 409) {
        const message = getErrorMessage(payload, "You can only create one cloud worker during this experiment.");
        setLaunchStatus("Worker limit reached.");
        setLaunchError(message);
        appendEvent("warning", "Worker limit reached", message);
        return;
      }

      if (!response.ok) {
        const message = getErrorMessage(payload, `Launch failed with ${response.status}.`);
        setLaunchError(message);
        setLaunchStatus("Launch failed. Fix the error and retry.");
        appendEvent("error", "Launch failed", message);
        trackPosthogEvent("den_worker_launch_failed", {
          status: response.status
        });
        return;
      }

      const parsedWorker = getWorker(payload);
      if (!parsedWorker) {
        setLaunchError("Launch response was missing worker details.");
        setLaunchStatus("Launch response format was unexpected.");
        appendEvent("error", "Launch failed", "Worker payload missing");
        trackPosthogEvent("den_worker_launch_failed", {
          reason: "missing_worker_payload"
        });
        return;
      }

      const resolvedWorker = await withResolvedOpenworkCredentials(parsedWorker);
      setWorker(resolvedWorker);
      setWorkerLookupId(parsedWorker.workerId);
      setPendingRestoredWorkerId(null);
      setPaymentReturned(false);
      setCheckoutUrl(null);
      setShowLaunchForm(false);

      if (resolvedWorker.status === "provisioning") {
        setLaunchStatus("Provisioning started. This can take a few minutes, and we will keep checking automatically.");
        appendEvent("info", "Provisioning started", `Worker ID ${parsedWorker.workerId}`);
      } else {
        setLaunchStatus(getWorkerStatusCopy(resolvedWorker.status));
        appendEvent("success", "Worker launched", `Worker ID ${parsedWorker.workerId}`);
      }

      trackPosthogEvent("den_worker_launch_succeeded", {
        worker_status: resolvedWorker.status,
        worker_provider: resolvedWorker.provider ?? "unknown"
      });
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === "AbortError"
          ? "Launch request took longer than expected. Provisioning can continue in the background. Refresh worker status below."
          : error instanceof Error
            ? error.message
            : "Unknown network error";

      setLaunchError(message);
      setLaunchStatus("Launch request failed.");
      appendEvent("error", "Launch failed", message);
      trackPosthogEvent("den_worker_launch_failed", {
        reason: "network_error"
      });
    } finally {
      setLaunchBusy(false);
      void refreshWorkers({ keepSelection: true });
    }
  }

  async function handleCheckStatus(options: { workerId?: string; quiet?: boolean; background?: boolean } = {}) {
    const quiet = options.quiet === true;
    const background = options.background === true;

    if (!user) {
      if (!quiet) {
        setLaunchError("Sign in before checking worker status.");
      }
      return;
    }

    const fallbackId = workerLookupId.trim() || worker?.workerId || workers[0]?.workerId || "";
    const id = options.workerId ?? fallbackId;
    if (!id) {
      if (!quiet) {
        setLaunchError("No worker selected yet. Launch one first, then use this panel.");
      }
      return;
    }

    setWorkerLookupId(id);

    if (!background) {
      setActionBusy("status");
    }
    if (!quiet) {
      setLaunchError(null);
    }

    try {
      const { response, payload } = await requestJson(`/v1/workers/${encodeURIComponent(id)}`, {
        method: "GET",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
      });

      if (!response.ok) {
        const message = getErrorMessage(payload, `Status check failed with ${response.status}.`);
        if (!quiet) {
          setLaunchError(message);
          appendEvent("error", "Status check failed", message);
        }
        return;
      }

      const summary = getWorkerSummary(payload);
      if (!summary) {
        if (!quiet) {
          setLaunchError("Status response was missing worker details.");
          appendEvent("error", "Status check failed", "Worker summary missing");
        }
        return;
      }

      const previousStatus = worker?.workerId === summary.workerId ? worker.status : null;

      const nextWorker: WorkerLaunch =
        worker && worker.workerId === summary.workerId
          ? {
              ...worker,
              workerName: summary.workerName,
              status: summary.status,
              provider: summary.provider,
              instanceUrl: summary.instanceUrl
            }
          : {
              workerId: summary.workerId,
              workerName: summary.workerName,
              status: summary.status,
              provider: summary.provider,
              instanceUrl: summary.instanceUrl,
              openworkUrl: summary.instanceUrl,
              workspaceId: null,
              clientToken: null,
              hostToken: null
            };

      const resolvedWorker = await withResolvedOpenworkCredentials(nextWorker, { quiet: true });
      setWorker(resolvedWorker);
      setPendingRestoredWorkerId(null);

      setWorkerLookupId(summary.workerId);

      if (!quiet) {
        setLaunchStatus(`Worker ${summary.workerName} is currently ${summary.status}.`);
        appendEvent("info", "Status refreshed", `${summary.workerName}: ${summary.status}`);
      } else if (previousStatus && previousStatus !== summary.status) {
        setLaunchStatus(getWorkerStatusCopy(summary.status));

        if (summary.status === "healthy") {
          appendEvent("success", "Provisioning complete", `${summary.workerName} is ready`);
        } else if (summary.status === "failed") {
          appendEvent("error", "Provisioning failed", `${summary.workerName} failed to provision`);
        } else {
          appendEvent("info", "Provisioning update", `${summary.workerName}: ${summary.status}`);
        }
      }

      if (!background) {
        void refreshWorkers({ keepSelection: true });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      if (!quiet) {
        setLaunchError(message);
        appendEvent("error", "Status check failed", message);
      }
    } finally {
      if (!background) {
        setActionBusy(null);
      }
    }
  }

  async function handleGenerateKey() {
    if (!user) {
      setLaunchError("Sign in before fetching a worker access token.");
      return;
    }

    const id = workerLookupId.trim() || worker?.workerId || workers[0]?.workerId || "";
    if (!id) {
      setLaunchError("No worker selected yet. Launch one first, then fetch a token.");
      return;
    }

    setWorkerLookupId(id);

    setActionBusy("token");
    setLaunchError(null);

    try {
      const { response, payload } = await requestJson(`/v1/workers/${encodeURIComponent(id)}/tokens`, {
        method: "POST",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
        body: JSON.stringify({})
      });

      if (!response.ok) {
        const message = getErrorMessage(payload, `Token fetch failed with ${response.status}.`);
        setLaunchError(message);
        appendEvent("error", "Token fetch failed", message);
        return;
      }

      const tokens = getWorkerTokens(payload);
      if (!tokens) {
        setLaunchError("Token response returned no token values.");
        appendEvent("error", "Token fetch failed", "Missing token payload");
        return;
      }

      const nextWorker: WorkerLaunch =
        worker && worker.workerId === id
          ? {
              ...worker,
              openworkUrl: tokens.openworkUrl ?? worker.openworkUrl,
              workspaceId: tokens.workspaceId ?? worker.workspaceId,
              clientToken: tokens.clientToken,
              hostToken: tokens.hostToken
            }
          : {
              workerId: id,
              workerName: "Existing worker",
              status: "unknown",
              provider: null,
              instanceUrl: null,
              openworkUrl: tokens.openworkUrl,
              workspaceId: tokens.workspaceId,
              clientToken: tokens.clientToken,
              hostToken: tokens.hostToken
            };

      const resolvedWorker = await withResolvedOpenworkCredentials(nextWorker, { quiet: true });
      setWorker(resolvedWorker);
      setPendingRestoredWorkerId(null);

      setLaunchStatus("Worker is ready to connect.");
      appendEvent("success", "Access token ready", `Worker ID ${id}`);
      void refreshWorkers({ keepSelection: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      setLaunchError(message);
      appendEvent("error", "Token fetch failed", message);
    } finally {
      setActionBusy(null);
    }
  }

  async function handleDeleteWorker(workerId: string) {
    if (!user) {
      setLaunchError("Sign in before deleting a worker.");
      return;
    }

    if (deleteBusyWorkerId || actionBusy !== null || launchBusy) {
      return;
    }

    const target = workers.find((entry) => entry.workerId === workerId) ?? null;
    const workerLabel = target?.workerName ?? "this worker";

    if (typeof window !== "undefined") {
      const confirmed = window.confirm(`Delete "${workerLabel}"? This removes it from your worker list.`);
      if (!confirmed) {
        return;
      }
    }

    setDeleteBusyWorkerId(workerId);
    setLaunchError(null);

    try {
      const { response, payload } = await requestJson(`/v1/workers/${encodeURIComponent(workerId)}`, {
        method: "DELETE",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
      });

      if (response.status !== 204 && !response.ok) {
        const message = getErrorMessage(payload, `Delete failed with ${response.status}.`);
        setLaunchError(message);
        appendEvent("error", "Delete failed", message);
        return;
      }

      setWorkers((current) => current.filter((entry) => entry.workerId !== workerId));

      setWorker((current) => {
        if (!current || current.workerId !== workerId) {
          return current;
        }
        return null;
      });
      setPendingRestoredWorkerId((current) => (current === workerId ? null : current));

      setWorkerLookupId((current) => (current === workerId ? "" : current));

      if (typeof window !== "undefined" && worker?.workerId === workerId) {
        window.localStorage.removeItem(LAST_WORKER_STORAGE_KEY);
      }

      setLaunchStatus(`Deleted ${workerLabel}.`);
      appendEvent("success", "Worker deleted", workerLabel);
      await refreshWorkers({ keepSelection: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      setLaunchError(message);
      appendEvent("error", "Delete failed", message);
    } finally {
      setDeleteBusyWorkerId(null);
    }
  }

  return (
    <section className={`ow-card${isShellStep ? " ow-card-shell" : " ow-card-auth"}`}>
      {!isShellStep ? (
        <div className="ow-progress-track">
          <span className="ow-progress-fill" style={{ width: progressWidth }} />
        </div>
      ) : null}

      <div className="ow-card-body">

        {step === 1 ? (
          <div className="ow-stack ow-auth-panel">
            <div className="ow-heading-block">
              <span className="ow-icon-chip">01</span>
              <h1 className="ow-title">{authMode === "sign-up" ? "Get started" : "Welcome back"}</h1>
              <p className="ow-subtitle">
                {authMode === "sign-up" ? (
                  <>
                    <span className="ow-subtitle-line">Create an account to launch</span>
                    <span className="ow-subtitle-line">and manage cloud workers.</span>
                  </>
                ) : (
                  getAuthInfoForMode("sign-in")
                )}
              </p>
            </div>

            <form className="ow-stack" onSubmit={handleAuthSubmit}>
              <button
                type="button"
                className="ow-btn-secondary ow-social-btn"
                onClick={() => void handleSocialSignIn("github")}
                disabled={authBusy}
              >
                <GitHubLogo />
                <span>Continue with GitHub</span>
              </button>

              <button
                type="button"
                className="ow-btn-secondary ow-social-btn"
                onClick={() => void handleSocialSignIn("google")}
                disabled={authBusy}
              >
                <GoogleLogo />
                <span>Continue with Google</span>
              </button>

              <div className="ow-divider" aria-hidden="true">
                <span>or</span>
              </div>

              <label className="ow-field-block">
                <span className="ow-field-label">Email</span>
                <input
                  className="ow-input"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  required
                />
              </label>

              <label className="ow-field-block">
                <span className="ow-field-label">Password</span>
                <input
                  className="ow-input"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={authMode === "sign-up" ? "new-password" : "current-password"}
                  required
                />
              </label>

              <button type="submit" className="ow-btn-primary" disabled={authBusy}>
                {authBusy ? "Working..." : authMode === "sign-in" ? "Sign in" : "Create account"}
              </button>
            </form>

            <div className="ow-inline-row">
              <p className="ow-caption">{authMode === "sign-in" ? "Need an account?" : "Already have an account?"}</p>
              <button
                type="button"
                className="ow-link"
                onClick={() => {
                  const nextMode = authMode === "sign-in" ? "sign-up" : "sign-in";
                  setAuthMode(nextMode);
                  setAuthInfo(getAuthInfoForMode(nextMode));
                  setAuthError(null);
                }}
              >
                {authMode === "sign-in" ? "Create account" : "Switch to sign in"}
              </button>
            </div>

            {showAuthFeedback ? (
              <div className="ow-auth-feedback" aria-live="polite">
                {authInfo !== defaultAuthInfo ? <p>{authInfo}</p> : null}
                {authError ? <p className="ow-error-text">{authError}</p> : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {step === 2 ? (
          <div className="mx-auto w-full max-w-[40rem] px-1 py-1 lg:max-w-[52rem]">
            <section className="mx-auto flex w-full flex-col justify-between rounded-[32px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
              <div className="space-y-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">OpenWork Cloud</p>
                    <h2 className="mt-2 break-words text-[1.9rem] font-semibold leading-tight tracking-tight text-slate-900">Overview</h2>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      {primaryWorker
                        ? "Open your worker as soon as it is ready."
                        : "Start your worker first. You can adjust the name before launch if you want to."}
                    </p>
                  </div>

                  {primaryWorker ? (
                    <div className="rounded-[20px] border border-slate-200 bg-slate-50 p-3">
                      <div className="flex items-center gap-2">
                        <span className={`h-3 w-3 rounded-full ${trafficLights.red}`} />
                        <span className={`h-3 w-3 rounded-full ${trafficLights.amber}`} />
                        <span className={`h-3 w-3 rounded-full ${trafficLights.green}`} />
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="space-y-3">
                  {!primaryWorker ? (
                    <button
                      type="button"
                      className="w-full rounded-[18px] bg-[#1B29FF] px-4 py-3 text-base font-semibold text-white shadow-[0_14px_30px_rgba(27,41,255,0.22)] transition hover:bg-[#151FDA] disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={handleLaunchWorker}
                      disabled={!user || launchBusy}
                    >
                      {launchBusy ? "Starting worker..." : "Start worker"}
                    </button>
                  ) : (
                    <>
                      {canOpenWorker && primaryAppUrl ? (
                        <a
                          href={primaryAppUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="block w-full rounded-[18px] bg-[#1B29FF] px-4 py-3 text-center text-base font-semibold text-white shadow-[0_14px_30px_rgba(27,41,255,0.22)] transition hover:bg-[#151FDA] lg:hidden"
                        >
                          Open in app
                        </a>
                      ) : (
                        <button
                          type="button"
                          disabled
                          className="w-full rounded-[18px] bg-slate-200 px-4 py-3 text-base font-semibold text-slate-500 lg:hidden"
                        >
                          Open in app
                        </button>
                      )}

                      <div className="hidden gap-3 lg:grid">
                        {canStartInOpenwork && openworkDeepLink ? (
                          <a
                            href={openworkDeepLink}
                            className="block w-full rounded-[18px] bg-[#1B29FF] px-4 py-3 text-center text-base font-semibold text-white shadow-[0_14px_30px_rgba(27,41,255,0.22)] transition hover:bg-[#151FDA]"
                          >
                            Start in OpenWork
                          </a>
                        ) : (
                          <button
                            type="button"
                            disabled
                            className="w-full rounded-[18px] bg-slate-200 px-4 py-3 text-base font-semibold text-slate-500"
                          >
                            Start in OpenWork
                          </button>
                        )}

                        {canStartHere && browserStartUrl ? (
                          <a
                            href={browserStartUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="block w-full rounded-[18px] border border-slate-300 bg-white px-4 py-3 text-center text-base font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-900"
                          >
                            Start here
                          </a>
                        ) : (
                          <button
                            type="button"
                            disabled
                            className="w-full rounded-[18px] border border-slate-200 bg-slate-100 px-4 py-3 text-base font-semibold text-slate-400"
                          >
                            Start here
                          </button>
                        )}
                      </div>
                    </>
                  )}

                  <p className="text-xs leading-5 text-slate-500">
                    {primaryWorker
                      ? canOpenWorker
                        ? "The start button unlocks as soon as the worker is ready."
                        : "The start button unlocks automatically when the worker is ready."
                      : "Founder Ops is the default name. Change it before launch if you want to."}
                  </p>
                </div>

                {workersBusy ? <p className="text-sm text-slate-500">Checking your worker…</p> : null}
                {workersError ? (
                  <div className="rounded-[18px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{workersError}</div>
                ) : null}
                {launchError ? (
                  <div className="rounded-[18px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{launchError}</div>
                ) : null}

                {effectiveCheckoutUrl ? (
                  <div className="rounded-[18px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    Finish checkout before starting a worker.
                    <a
                      href={effectiveCheckoutUrl}
                      rel="noreferrer"
                      className="mt-3 inline-flex rounded-[12px] border border-amber-300 bg-white px-3 py-2 font-semibold text-amber-900 transition hover:bg-amber-100"
                    >
                      Continue to checkout
                    </a>
                  </div>
                ) : null}

                {/* Preserved for later recovery: the previous status/connection overview card.
                <div className="rounded-[28px] border border-slate-200 bg-slate-50 p-4">
                  {primaryWorker ? (
                    <>
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2">
                          <span className={`h-2.5 w-2.5 rounded-full ${trafficLights.red}`} />
                          <span className={`h-2.5 w-2.5 rounded-full ${trafficLights.amber}`} />
                          <span className={`h-2.5 w-2.5 rounded-full ${trafficLights.green}`} />
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Status</p>
                          <p className="text-base font-semibold text-slate-900">{getSimplifiedStatusTitle(selectedStatusMeta.bucket)}</p>
                        </div>
                      </div>
                      <p className="mt-4 break-all text-sm leading-6 text-slate-600">
                        {openworkConnectUrl ?? primaryWorker.instanceUrl ?? shortValue(primaryWorker.workerId)}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Worker setup</p>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        We already hide the extra setup. Tap once, wait for the light to turn green, then open your worker in the app.
                      </p>
                    </>
                  )}
                </div>
                */}

                <div className="rounded-[28px] border border-slate-200 bg-slate-50 p-4">
                  <label className="grid gap-2">
                    <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Worker name</span>
                    {primaryWorker ? (
                      <div className="rounded-[18px] border border-slate-200 bg-white px-4 py-3 text-base font-semibold text-slate-900">
                        {primaryWorker.workerName}
                      </div>
                    ) : (
                      <input
                        className="min-w-0 rounded-[18px] border border-slate-200 bg-white px-4 py-3 text-base font-semibold text-slate-900 outline-none transition focus:border-[#1B29FF]"
                        value={workerName}
                        onChange={(event) => setWorkerName(event.target.value)}
                        placeholder="Founder Ops"
                      />
                    )}
                  </label>
                  <p className="mt-3 text-sm leading-6 text-slate-600">
                    {primaryWorker
                      ? "This name is already set for the worker you launched."
                      : "We preset this to Founder Ops. Change it before launch if you want a different label."}
                  </p>
                </div>
              </div>

              <div className="mt-6 space-y-3">
                {showInlineStartupSequence ? (
                  <StartupSequenceRow
                    active={showInlineStartupSequence}
                    launchStatus={launchStatus}
                    latestEvent={events[0] ?? null}
                    bucket={selectedStatusMeta.bucket}
                    launchBusy={launchBusy}
                    workersBusy={workersBusy}
                  />
                ) : (
                  <p className="text-xs leading-5 text-slate-500">{launchStatus}</p>
                )}
              </div>
            </section>
          </div>
        ) : null}

        {showDesktopStartupModal ? (
          <div
            className="fixed inset-0 z-50 hidden items-center justify-center bg-slate-950/10 p-5 backdrop-blur-[2px] lg:flex"
            onClick={() => {
              if (primaryWorker) {
                setDismissedDesktopPromptWorkerId(primaryWorker.workerId);
              }
            }}
          >
            <div
              className="relative w-[min(70vw,86rem)] overflow-hidden rounded-[36px] border border-slate-200 bg-white/95 shadow-[0_32px_100px_rgba(15,23,42,0.2)] backdrop-blur-xl"
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                aria-label="Close download prompt"
                onClick={() => {
                  if (primaryWorker) {
                    setDismissedDesktopPromptWorkerId(primaryWorker.workerId);
                  }
                }}
                className="absolute right-5 top-5 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 transition hover:border-slate-300 hover:text-slate-800"
              >
                ×
              </button>
              <div className="grid gap-8 p-8 lg:grid-cols-[minmax(0,0.92fr)_minmax(25rem,1.08fr)] lg:items-center xl:p-10">
                <div className="min-w-0 self-center text-center">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Desktop</p>
                  <h3 className="mt-2 text-[2.35rem] font-semibold leading-[1.05] tracking-tight text-slate-900">Download OpenWork</h3>
                  <p className="mt-3 text-[1.1rem] font-normal leading-snug tracking-normal text-slate-600">
                    while we finish setting up your ai worker
                  </p>
                  <p className="mx-auto mt-4 max-w-[34rem] text-justify text-[1.05rem] leading-8 text-slate-600">
                    Cloud setup usually takes about 2 minutes. Download the desktop app now, or take a quick coffee
                    break while we finish getting everything ready.
                  </p>

                  <div className="mx-auto mt-6 max-w-[34rem] text-left">
                    <StartupSequenceRow
                      active={showDesktopStartupModal}
                      launchStatus={launchStatus}
                      latestEvent={events[0] ?? null}
                      bucket={selectedStatusMeta.bucket}
                      launchBusy={launchBusy}
                      workersBusy={workersBusy}
                    />
                  </div>

                  <div className="mx-auto mt-6 max-w-[34rem] rounded-[22px] border border-slate-200 bg-slate-50 p-4 text-left">
                    <p className="text-sm font-semibold text-slate-900">While OpenWork Cloud gets everything ready:</p>
                    <div className="mt-4 space-y-2 text-sm text-slate-600">
                      <p>1. Keep this tab open while OpenWork Cloud prepares the worker.</p>
                      <p>2. Download the desktop app if you want to jump in the moment the worker is ready.</p>
                    </div>
                  </div>

                  <div className="mt-6 flex items-center justify-center gap-4">
                    <a
                      href={OPENWORK_DOWNLOAD_URL}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => {
                        if (primaryWorker) {
                          setDismissedDesktopPromptWorkerId(primaryWorker.workerId);
                        }
                      }}
                      className="inline-flex rounded-[16px] bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
                    >
                      Download OpenWork
                    </a>
                    <a
                      href={OPENWORK_DOWNLOAD_FALLBACK_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-slate-500 transition hover:text-slate-700"
                    >
                      That didn&apos;t work?
                    </a>
                  </div>
                </div>

                <div className="flex items-center justify-center">
                  <img
                    src="/startup-mobile-preview.png"
                    alt="OpenWork app preview"
                    className="block max-h-[78vh] w-auto max-w-full rounded-[18px] object-contain shadow-[0_30px_90px_rgba(15,23,42,0.2)]"
                  />
                </div>
              </div>
            </div>
          </div>
        ) : null}

      </div>
    </section>
  );
}
