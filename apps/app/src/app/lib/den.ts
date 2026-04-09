import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isDesktopDeployment } from "./openwork-deployment";
import { isTauriRuntime } from "../utils";
import type { DenOrgSkillCard } from "../types";

const STORAGE_BASE_URL = "openwork.den.baseUrl";
const STORAGE_API_BASE_URL = "openwork.den.apiBaseUrl";
const STORAGE_AUTH_TOKEN = "openwork.den.authToken";
const STORAGE_ACTIVE_ORG_ID = "openwork.den.activeOrgId";
const STORAGE_ACTIVE_ORG_SLUG = "openwork.den.activeOrgSlug";
const STORAGE_ACTIVE_ORG_NAME = "openwork.den.activeOrgName";
const DEFAULT_DEN_TIMEOUT_MS = 12_000;

export const DEFAULT_DEN_AUTH_NAME = "OpenWork User";
export const DEFAULT_DEN_BASE_URL =
  (typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_DEN_BASE_URL === "string"
    ? import.meta.env.VITE_DEN_BASE_URL
    : "").trim() || "https://app.openworklabs.com";

export type DenSettings = {
  baseUrl: string;
  apiBaseUrl?: string;
  authToken?: string | null;
  activeOrgId?: string | null;
  activeOrgSlug?: string | null;
  activeOrgName?: string | null;
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

export type DenTemplateCreator = {
  memberId: string;
  role: "owner" | "admin" | "member";
  userId: string;
  name: string | null;
  email: string | null;
  image: string | null;
};

export type DenTemplate = {
  id: string;
  organizationId: string;
  name: string;
  templateData: unknown;
  createdAt: string | null;
  updatedAt: string | null;
  creator: DenTemplateCreator | null;
};

export type DenOrgLlmProviderModel = {
  id: string;
  name: string;
  config: Record<string, unknown>;
  createdAt: string | null;
};

export type DenOrgLlmProvider = {
  id: string;
  source: "models_dev" | "custom";
  providerId: string;
  name: string;
  providerConfig: Record<string, unknown>;
  hasApiKey: boolean;
  models: DenOrgLlmProviderModel[];
  createdAt: string | null;
  updatedAt: string | null;
};

export type DenOrgLlmProviderConnection = DenOrgLlmProvider & {
  apiKey: string | null;
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

  if (
    normalized === "localhost" ||
    normalized === "0.0.0.0" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  ) {
    return true;
  }

  const ipv4Match = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [first, second, third, fourth] = ipv4Match.slice(1).map(Number);
    const octets = [first, second, third, fourth];
    if (octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
      if (
        first === 10 ||
        first === 127 ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168) ||
        (first === 169 && second === 254) ||
        (first === 100 && second >= 64 && second <= 127)
      ) {
        return true;
      }
    }
  }

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

export function buildDenAuthUrl(baseUrl: string, mode: "sign-in" | "sign-up"): string {
  const target = new URL(resolveDenBaseUrls(baseUrl).baseUrl);
  target.searchParams.set("mode", mode);
  if (isDesktopDeployment()) {
    target.searchParams.set("desktopAuth", "1");
    target.searchParams.set("desktopScheme", "openwork");
  }
  return target.toString();
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
    activeOrgSlug: (window.localStorage.getItem(STORAGE_ACTIVE_ORG_SLUG) ?? "").trim() || null,
    activeOrgName: (window.localStorage.getItem(STORAGE_ACTIVE_ORG_NAME) ?? "").trim() || null,
  };
}

export function writeDenSettings(next: DenSettings) {
  if (typeof window === "undefined") {
    return;
  }

  const { baseUrl, apiBaseUrl } = resolveDenBaseUrls(next);
  const authToken = next.authToken?.trim() ?? "";
  const activeOrgId = next.activeOrgId?.trim() ?? "";
  const activeOrgSlug = next.activeOrgSlug?.trim() ?? "";
  const activeOrgName = next.activeOrgName?.trim() ?? "";

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

  if (activeOrgSlug) {
    window.localStorage.setItem(STORAGE_ACTIVE_ORG_SLUG, activeOrgSlug);
  } else {
    window.localStorage.removeItem(STORAGE_ACTIVE_ORG_SLUG);
  }

  if (activeOrgName) {
    window.localStorage.setItem(STORAGE_ACTIVE_ORG_NAME, activeOrgName);
  } else {
    window.localStorage.removeItem(STORAGE_ACTIVE_ORG_NAME);
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
  window.localStorage.removeItem(STORAGE_ACTIVE_ORG_SLUG);
  window.localStorage.removeItem(STORAGE_ACTIVE_ORG_NAME);
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

function getTemplateCreator(value: unknown): DenTemplateCreator | null {
  if (!isRecord(value)) {
    return null;
  }

  const role = value.role;
  if (
    typeof value.memberId !== "string" ||
    typeof value.userId !== "string" ||
    (role !== "owner" && role !== "admin" && role !== "member")
  ) {
    return null;
  }

  return {
    memberId: value.memberId,
    role,
    userId: value.userId,
    name: typeof value.name === "string" ? value.name : null,
    email: typeof value.email === "string" ? value.email : null,
    image: typeof value.image === "string" ? value.image : null,
  };
}

function getTemplate(value: unknown): DenTemplate | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.id !== "string" ||
    typeof value.organizationId !== "string" ||
    typeof value.name !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    organizationId: value.organizationId,
    name: value.name,
    templateData: value.templateData,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    creator: getTemplateCreator(value.creator),
  };
}

function getTemplates(payload: unknown): DenTemplate[] {
  if (!isRecord(payload) || !Array.isArray(payload.templates)) {
    return [];
  }

  return payload.templates
    .map((entry) => getTemplate(entry))
    .filter((entry): entry is DenTemplate => entry !== null);
}


function parseDenOrgSkillRow(record: Record<string, unknown>, hubName: string | null): DenOrgSkillCard | null {
  if (typeof record.id !== "string" || typeof record.title !== "string" || typeof record.skillText !== "string") {
    return null;
  }
  const description = typeof record.description === "string" ? record.description : null;
  const shared = record.shared === "org" || record.shared === "public" ? record.shared : null;
  return {
    id: record.id,
    title: record.title,
    description,
    skillText: record.skillText,
    hubName,
    shared,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
  };
}

function getDenOrgSkillsFromPayload(payload: unknown): DenOrgSkillCard[] {
  if (!isRecord(payload) || !Array.isArray(payload.skills)) {
    return [];
  }
  return payload.skills
    .map((entry) => (isRecord(entry) ? parseDenOrgSkillRow(entry, null) : null))
    .filter((entry): entry is DenOrgSkillCard => entry !== null);
}

export type DenOrgSkillHub = { id: string; name: string; skills: DenOrgSkillCard[] };

function parseOrgSkillHubEntry(hub: Record<string, unknown>): DenOrgSkillHub | null {
  const hubId = hub.id;
  const hubName = hub.name;
  const hubSkills = hub.skills;
  if (typeof hubId !== "string" || typeof hubName !== "string" || !Array.isArray(hubSkills)) {
    return null;
  }
  const skills = hubSkills
    .map((s) => (isRecord(s) ? parseDenOrgSkillRow(s, hubName) : null))
    .filter((s): s is DenOrgSkillCard => s !== null);
  return { id: hubId, name: hubName, skills };
}

function getDenOrgSkillHubsFromPayload(payload: unknown): DenOrgSkillHub[] {
  if (!isRecord(payload) || !Array.isArray(payload.skillHubs)) {
    return [];
  }
  return payload.skillHubs
    .map((entry) => (isRecord(entry) ? parseOrgSkillHubEntry(entry) : null))
      .filter((e): e is DenOrgSkillHub => e !== null);
}

function parseDenOrgLlmProviderModel(value: unknown): DenOrgLlmProviderModel | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    return null;
  }

  return {
    id: value.id,
    name: value.name,
    config: isRecord(value.config) ? value.config : {},
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
  };
}

function parseDenOrgLlmProvider(value: unknown): DenOrgLlmProvider | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.providerId !== "string" ||
    typeof value.name !== "string" ||
    (value.source !== "models_dev" && value.source !== "custom")
  ) {
    return null;
  }

  return {
    id: value.id,
    source: value.source,
    providerId: value.providerId,
    name: value.name,
    providerConfig: isRecord(value.providerConfig) ? value.providerConfig : {},
    hasApiKey: value.hasApiKey === true,
    models: Array.isArray(value.models)
      ? value.models.map(parseDenOrgLlmProviderModel).filter((entry): entry is DenOrgLlmProviderModel => entry !== null)
      : [],
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

function getDenOrgLlmProviders(payload: unknown): DenOrgLlmProvider[] {
  if (!isRecord(payload) || !Array.isArray(payload.llmProviders)) {
    return [];
  }

  return payload.llmProviders
    .map(parseDenOrgLlmProvider)
    .filter((entry): entry is DenOrgLlmProvider => entry !== null);
}

function getDenOrgLlmProviderConnection(payload: unknown): DenOrgLlmProviderConnection | null {
  if (!isRecord(payload) || !payload.llmProvider) {
    return null;
  }

  const provider = parseDenOrgLlmProvider(payload.llmProvider);
  if (!provider || !isRecord(payload.llmProvider)) {
    return null;
  }

  return {
    ...provider,
    apiKey: typeof payload.llmProvider.apiKey === "string" ? payload.llmProvider.apiKey : null,
  };
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

export type DenOrgSkillHubSummary = {
  id: string;
  name: string;
  canManage: boolean;
};

function getOrgSkillHubSummaries(payload: unknown): DenOrgSkillHubSummary[] {
  if (!isRecord(payload) || !Array.isArray(payload.skillHubs)) {
    return [];
  }

  return payload.skillHubs
    .map((entry) => {
      if (!isRecord(entry)) return null;
      if (typeof entry.id !== "string" || typeof entry.name !== "string" || typeof entry.canManage !== "boolean") {
        return null;
      }
      return { id: entry.id, name: entry.name, canManage: entry.canManage };
    })
    .filter((entry): entry is DenOrgSkillHubSummary => Boolean(entry));
}

function getCreatedOrgSkillId(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.skill)) return null;
  return typeof payload.skill.id === "string" ? payload.skill.id : null;
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
  return { ok: response.ok, status: response.status, json };
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

    async listTemplates(orgSlug: string): Promise<DenTemplate[]> {
      const payload = await requestJson<unknown>(
        baseUrls,
        `/v1/orgs/${encodeURIComponent(orgSlug)}/templates`,
        {
          method: "GET",
          token,
        },
      );
      return getTemplates(payload);
    },

    async createTemplate(
      orgSlug: string,
      input: { name: string; templateData: unknown },
    ): Promise<DenTemplate> {
      const payload = await requestJson<unknown>(
        baseUrls,
        `/v1/orgs/${encodeURIComponent(orgSlug)}/templates`,
        {
          method: "POST",
          token,
          body: {
            name: input.name.trim(),
            templateData: input.templateData,
          },
        },
      );
      const template = isRecord(payload) ? getTemplate(payload.template) : null;
      if (!template) {
        throw new DenApiError(500, "invalid_template_payload", "Template response was missing template details.");
      }
      return template;
    },

    async deleteTemplate(orgSlug: string, templateId: string): Promise<void> {
      const raw = await requestJsonRaw(
        baseUrls,
        `/v1/orgs/${encodeURIComponent(orgSlug)}/templates/${encodeURIComponent(templateId)}`,
        {
          method: "DELETE",
          token,
        },
      );
      if (!raw.ok) {
        const payload = raw.json;
        const code = isRecord(payload) && typeof payload.error === "string" ? payload.error : "request_failed";
        const message = getErrorMessage(payload, `Request failed with ${raw.status}.`);
        throw new DenApiError(raw.status, code, message, isRecord(payload) ? payload.details : undefined);
      }
    },

    async listOrgSkills(orgId: string): Promise<DenOrgSkillCard[]> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/orgs/${encodeURIComponent(orgId)}/skills`, {
        method: "GET",
        token,
      });
      return getDenOrgSkillsFromPayload(payload);
    },

    async listOrgSkillHubs(orgId: string): Promise<DenOrgSkillHub[]> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/orgs/${encodeURIComponent(orgId)}/skill-hubs`, {
        method: "GET",
        token,
      });
      return getDenOrgSkillHubsFromPayload(payload);
    },

    async listOrgSkillHubSummaries(orgId: string): Promise<DenOrgSkillHubSummary[]> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/orgs/${encodeURIComponent(orgId)}/skill-hubs`, {
        method: "GET",
        token,
      });
      return getOrgSkillHubSummaries(payload);
    },

    async createOrgSkill(
      orgId: string,
      input: { skillText: string; shared?: "org" | "public" | null },
    ): Promise<{ id: string }> {
      const body = {
        skillText: input.skillText,
        shared: input.shared === undefined ? ("org" as const) : input.shared,
      };
      const payload = await requestJson<unknown>(baseUrls, `/v1/orgs/${encodeURIComponent(orgId)}/skills`, {
        method: "POST",
        token,
        body,
      });
      const id = getCreatedOrgSkillId(payload);
      if (!id) {
        throw new DenApiError(500, "invalid_skill_payload", "Skill response was missing id.");
      }
      return { id };
    },

    async addOrgSkillToHub(orgId: string, skillHubId: string, skillId: string): Promise<void> {
      await requestJson<unknown>(
        baseUrls,
        `/v1/orgs/${encodeURIComponent(orgId)}/skill-hubs/${encodeURIComponent(skillHubId)}/skills`,
        {
          method: "POST",
          token,
          body: { skillId },
        },
      );
    },

    async listOrgLlmProviders(orgId: string): Promise<DenOrgLlmProvider[]> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/orgs/${encodeURIComponent(orgId)}/llm-providers`, {
        method: "GET",
        token,
      });
      return getDenOrgLlmProviders(payload);
    },

    async getOrgLlmProviderConnection(orgId: string, llmProviderId: string): Promise<DenOrgLlmProviderConnection> {
      const payload = await requestJson<unknown>(
        baseUrls,
        `/v1/orgs/${encodeURIComponent(orgId)}/llm-providers/${encodeURIComponent(llmProviderId)}/connect`,
        {
          method: "GET",
          token,
        },
      );
      const provider = getDenOrgLlmProviderConnection(payload);
      if (!provider) {
        throw new DenApiError(500, "invalid_llm_provider_payload", "LLM provider response was missing connection details.");
      }
      return provider;
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
  };
}

export async function fetchDenOrgSkillsCatalog(
  client: ReturnType<typeof createDenClient>,
  orgId: string,
): Promise<DenOrgSkillCard[]> {
  const [hubs, flatSkills] = await Promise.all([client.listOrgSkillHubs(orgId), client.listOrgSkills(orgId)]);
  const hubNameBySkillId = new Map<string, string>();
  for (const hub of hubs) {
    for (const skill of hub.skills) {
      if (!hubNameBySkillId.has(skill.id)) {
        hubNameBySkillId.set(skill.id, hub.name);
      }
    }
  }
  const byId = new Map<string, DenOrgSkillCard>();
  for (const skill of flatSkills) {
    byId.set(skill.id, {
      ...skill,
      hubName: hubNameBySkillId.get(skill.id) ?? null,
    });
  }
  return [...byId.values()].sort((a, b) => a.title.localeCompare(b.title));
}
