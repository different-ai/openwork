import {
  normalizeDesktopConfig,
  type DesktopConfig as SharedDesktopConfig,
} from "@openwork/types/den/desktop-policies";

// Re-export the shared schema under the local alias so React consumers
// (e.g. the cloud domain's desktop-config provider) can import it alongside
// the helpers they need. Solid references it internally only; the React
// port wants it as part of the public surface of this module.
export type { SharedDesktopConfig };
export { normalizeDesktopConfig };

import { isDesktopDeployment } from "./openwork-deployment";
import {
  dispatchDenSettingsChanged,
} from "./den-session-events";
import {
  desktopFetch,
  getDesktopBootstrapConfig as getDesktopBootstrapConfigFromShell,
  setDesktopBootstrapConfig as setDesktopBootstrapConfigInShell,
  type DesktopBootstrapConfig as ShellDesktopBootstrapConfig,
} from "./desktop";
import { isDesktopRuntime } from "./runtime-env";
import type { DenOrgSkillCard, ReloadReason } from "../types";
import type {
  OpenWorkExtensionContribution,
  OpenWorkExtensionContributionType,
  OpenWorkExtensionLifecycle,
  OpenWorkExtensionManifest,
  OpenWorkExtensionResource,
  OpenWorkExtensionResourceType,
  OpenWorkExtensionSetup,
  OpenWorkExtensionSource,
  OpenWorkExtensionSourceFormat,
} from "../extensions";

const STORAGE_BASE_URL = "openwork.den.baseUrl";
const STORAGE_API_BASE_URL = "openwork.den.apiBaseUrl";
const STORAGE_AUTH_TOKEN = "openwork.den.authToken";
const STORAGE_ACTIVE_ORG_ID = "openwork.den.activeOrgId";
const STORAGE_ACTIVE_ORG_SLUG = "openwork.den.activeOrgSlug";
const STORAGE_ACTIVE_ORG_NAME = "openwork.den.activeOrgName";
const ORG_PROXY_HEADER = "x-openwork-legacy-org-id";
const DEFAULT_DEN_TIMEOUT_MS = 12_000;

export const DEFAULT_DEN_AUTH_NAME = "OpenWork User";
const BUILD_DEN_BASE_URL =
  (typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_DEN_BASE_URL === "string"
    ? import.meta.env.VITE_DEN_BASE_URL
    : "").trim() || "https://app.openworklabs.com";
const BUILD_DEN_API_BASE_URL =
  (typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_DEN_API_BASE_URL === "string"
    ? import.meta.env.VITE_DEN_API_BASE_URL
    : "").trim() || undefined;
const BUILD_DEN_REQUIRE_SIGNIN =
  (typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_DEN_REQUIRE_SIGNIN === "string"
    ? /^(1|true|yes|on)$/i.test(import.meta.env.VITE_DEN_REQUIRE_SIGNIN.trim())
    : false);

export const DEFAULT_DEN_BASE_URL = BUILD_DEN_BASE_URL;
export const DEN_INFERENCE_PATH = "/dashboard/inference";

// Den wire types moved to den-types.ts (leaf module); re-exported here so
// the many existing den.ts importers keep working.
export type * from "./den-types";
import type {
  DenOrgExtensionProjection,
  DenOrgMarketplace,
  DenOrgPlugin,
  DenOrgPluginResolved,
  DenPluginConfigObject,
  DenPluginConfigObjectType,
  DenPluginConfigObjectVersion,
  DenPluginMembership,
  DenResourceSnapshot,
  DenResourceSnapshotConfigItem,
  DenResourceSnapshotMarketplace,
  DenResourceSnapshotPlugin,
  DenSettings,
  DenUser,
} from "./den-types";

type DenBaseUrls = {
  baseUrl: string;
  apiBaseUrl: string;
};

export type DenBootstrapConfig = DenBaseUrls & {
  requireSignin: boolean;
};

export type DenDesktopConfig = SharedDesktopConfig;

export type DenOrgSummary = {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "member";
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

export type DenMcpToken = {
  token: string;
  expiresAt: string;
  organizationId: string;
  scopes: string[];
  resource: string;
};

export type DenOrgLlmProviderModel = {
  id: string;
  name: string;
  config: Record<string, unknown>;
  createdAt: string | null;
};

export type DenOrgLlmProvider = {
  id: string;
  source: "models_dev" | "custom" | "openwork";
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

export type DenOrgMarketplaceResolved = {
  marketplace: DenOrgMarketplace;
  plugins: DenOrgPlugin[];
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

const defaultBootstrapBaseUrls = resolveDenBaseUrls({
  baseUrl: BUILD_DEN_BASE_URL,
  apiBaseUrl: BUILD_DEN_API_BASE_URL,
});

let desktopBootstrapConfig: DenBootstrapConfig = {
  ...defaultBootstrapBaseUrls,
  requireSignin: BUILD_DEN_REQUIRE_SIGNIN,
};

export type DenAppVersionMetadata = {
  minAppVersion: string;
  latestAppVersion: string;
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

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function getDenAppVersionMetadata(payload: unknown): DenAppVersionMetadata | null {
  if (!isRecord(payload)) return null;

  const latestAppVersion =
    typeof payload.latestAppVersion === "string" ? payload.latestAppVersion.trim() : "";
  if (!latestAppVersion) return null;

  return {
    minAppVersion:
      typeof payload.minAppVersion === "string" ? payload.minAppVersion.trim() : "",
    latestAppVersion,
  };
}

export function normalizeDenDesktopConfig(payload: unknown): DenDesktopConfig {
  return normalizeDesktopConfig(payload);
}

function readTimestampRecord(value: unknown): Record<string, string> {
  if (!isRecord(value) || Array.isArray(value)) return {};

  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const id = key.trim();
    const timestampValue = typeof entry === "string" ? entry.trim() : "";
    if (id && timestampValue) {
      record[id] = timestampValue;
    }
  }
  return record;
}

function readDenResourceSnapshotConfigItems(value: unknown): DenResourceSnapshotConfigItem[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const configItemId = typeof entry.configItemId === "string" ? entry.configItemId.trim() : "";
    const lastUpdatedAt = typeof entry.lastUpdatedAt === "string" ? entry.lastUpdatedAt.trim() : "";
    return configItemId && lastUpdatedAt ? [{ configItemId, lastUpdatedAt }] : [];
  });
}

function readDenResourceSnapshotPlugins(value: unknown): DenResourceSnapshotPlugin[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const pluginId = typeof entry.pluginId === "string" ? entry.pluginId.trim() : "";
    const lastUpdatedAt = typeof entry.lastUpdatedAt === "string" ? entry.lastUpdatedAt.trim() : "";
    if (!pluginId || !lastUpdatedAt) return [];

    return [{
      pluginId,
      lastUpdatedAt,
      configItems: readDenResourceSnapshotConfigItems(entry.configItems),
    }];
  });
}

function readDenResourceSnapshotMarketplaces(value: unknown): Record<string, DenResourceSnapshotMarketplace> {
  if (!isRecord(value) || Array.isArray(value)) return {};

  const marketplaces: Record<string, DenResourceSnapshotMarketplace> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const marketplaceId = key.trim();
    const lastUpdatedAt = typeof entry.lastUpdatedAt === "string" ? entry.lastUpdatedAt.trim() : "";
    if (!marketplaceId || !lastUpdatedAt) continue;
    marketplaces[marketplaceId] = {
      lastUpdatedAt,
      plugins: readDenResourceSnapshotPlugins(entry.plugins),
    };
  }
  return marketplaces;
}

export function normalizeDenResourceSnapshot(payload: unknown): DenResourceSnapshot | null {
  if (!isRecord(payload)) return null;

  const organizationId = typeof payload.organizationId === "string" ? payload.organizationId.trim() : "";
  const orgMemberId = typeof payload.orgMemberId === "string" ? payload.orgMemberId.trim() : "";
  const resources = isRecord(payload.resources) ? payload.resources : null;
  if (!organizationId || !orgMemberId || !resources) return null;

  return {
    organizationId,
    orgMemberId,
    teamIds: readStringArray(payload.teamIds),
    resources: {
      llmProviders: readTimestampRecord(resources.llmProviders),
      marketplaces: readDenResourceSnapshotMarketplaces(resources.marketplaces),
    },
  };
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

/**
 * Origin-level comparison key for Den URLs. Ignores paths (deep links may
 * carry an `/api/den` proxy path) and treats loopback aliases (127.0.0.1,
 * [::1]) as `localhost`, matching den-api's own dev-mode resource aliasing.
 */
export function denOriginComparisonKey(input: string | null | undefined): string | null {
  const normalized = normalizeDenBaseUrl(input);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    const host = url.hostname.toLowerCase();
    if (host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "0.0.0.0") {
      url.hostname = "localhost";
    }
    return url.origin;
  } catch {
    return normalized;
  }
}

export function getDenInferenceUrl(baseUrl?: string | null): string {
  const normalized = normalizeDenBaseUrl(baseUrl ?? readDenSettings().baseUrl) ?? DEFAULT_DEN_BASE_URL;
  return `${normalized}${DEN_INFERENCE_PATH}`;
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

  return (
    normalized === "app.openworklabs.com" ||
    normalized === "app.openwork.software" ||
    normalized.startsWith("app.") ||
    // Cloud Run hostnames serve the den-web frontend, which only exposes the
    // Den API behind its `/api/den` proxy path (see #1807/#1808).
    normalized.endsWith(".run.app")
  );
}

/**
 * Hosted web-app hosts (`app.openworklabs.com`, `app.openwork.software`,
 * `app.*`) never serve the Den API at their root — only behind the
 * `/api/den` proxy. Loopback/private hosts are excluded on purpose: in dev
 * an explicit apiBaseUrl may point directly at den-api.
 */
function isHostedWebAppHost(hostname: string): boolean {
  return hostname.trim().toLowerCase().startsWith("app.");
}

/**
 * Older builds persisted the bare web-app origin as the API base URL
 * (bootstrap file and localStorage). Requests against that origin 404 —
 * notably the cloud MCP at `https://app.openworklabs.com/mcp`. Heal such
 * values by routing them through the web app's `/api/den` proxy.
 */
function healWebAppApiBaseUrl(input: string | null): string | null {
  if (!input) return null;
  try {
    const url = new URL(input);
    if (isHostedWebAppHost(url.hostname)) {
      return ensureDenApiBasePath(input);
    }
  } catch {
    // Not a URL — leave untouched.
  }
  return input;
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
    apiBaseUrl: healWebAppApiBaseUrl(normalizedApiBaseUrl) ?? deriveDenApiBaseUrl(seedUrl),
  };
}

/**
 * The MCP endpoint served by den-api, resolved from the bootstrap config.
 * On the hosted web app this goes through the `/api/den` proxy
 * (`https://app.openworklabs.com/api/den/mcp`); a direct API origin maps to
 * `<apiBaseUrl>/mcp` (canonically `https://api.openworklabs.com/mcp`).
 */
export function getDenMcpUrl(): string {
  const { apiBaseUrl } = resolveDenBaseUrls(readDenBootstrapConfig());
  return `${apiBaseUrl.replace(/\/+$/, "")}/mcp`;
}

/**
 * Detects MCP URLs written by older builds that pointed `/mcp` at the bare
 * web-app origin (e.g. `https://app.openworklabs.com/mcp`). Nothing serves
 * MCP there — those entries fail with a 404 and must be reconfigured.
 */
export function isLegacyWebAppMcpUrl(input: string | null | undefined): boolean {
  if (!input) return false;
  try {
    const url = new URL(input);
    return isHostedWebAppHost(url.hostname) && url.pathname.replace(/\/+$/, "") === "/mcp";
  } catch {
    return false;
  }
}

/**
 * Resolve the URL the cloud MCP entry should connect to from a minted
 * token's `resource`. Older den-api builds mint the bare web-app origin
 * (`https://app.openworklabs.com/mcp`) where nothing serves MCP — heal
 * those to the `/api/den` proxy on the same origin instead of trusting
 * them verbatim. Returns null when the resource is unusable so callers
 * can keep their bootstrap-derived URL.
 */
export function resolveCloudMcpResourceUrl(resource: string | null | undefined): string | null {
  const trimmed = resource?.trim() ?? "";
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (isLegacyWebAppMcpUrl(trimmed)) {
      url.pathname = "/api/den/mcp";
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function resolveDenBootstrapConfig(
  input: { baseUrl: string; apiBaseUrl?: string | null; requireSignin?: boolean | null },
): DenBootstrapConfig {
  return {
    ...resolveDenBaseUrls(input),
    requireSignin: input.requireSignin === true,
  };
}

function syncBootstrapSettingsToLocalStorage(config: DenBootstrapConfig) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(STORAGE_BASE_URL, config.baseUrl);
  window.localStorage.setItem(STORAGE_API_BASE_URL, config.apiBaseUrl);
}

function getPendingBootstrapConfig(next: DenSettings): DenBootstrapConfig | null {
  if (next.baseUrl === undefined && next.apiBaseUrl === undefined) {
    return null;
  }

  const previous = readDenBootstrapConfig();
  return resolveDenBootstrapConfig({
    baseUrl: next.baseUrl ?? previous.baseUrl,
    apiBaseUrl: next.apiBaseUrl ?? previous.apiBaseUrl,
    requireSignin: previous.requireSignin,
  });
}

function applyDesktopBootstrapConfig(config: DenBootstrapConfig) {
  desktopBootstrapConfig = config;
  syncBootstrapSettingsToLocalStorage(config);
}

export function readDenBootstrapConfig(): DenBootstrapConfig {
  return desktopBootstrapConfig;
}

export async function initializeDenBootstrapConfig(): Promise<DenBootstrapConfig> {
  if (!isDesktopRuntime()) {
    desktopBootstrapConfig = resolveDenBootstrapConfig({
      baseUrl: BUILD_DEN_BASE_URL,
      apiBaseUrl: BUILD_DEN_API_BASE_URL,
      requireSignin: BUILD_DEN_REQUIRE_SIGNIN,
    });
    return desktopBootstrapConfig;
  }

  // The shell IPC bridge can be momentarily unavailable at first paint;
  // retry briefly before giving up so a boot race does not poison the
  // session with build defaults.
  const SHELL_BOOTSTRAP_ATTEMPTS = 3;
  const SHELL_BOOTSTRAP_RETRY_DELAY_MS = 350;
  for (let attempt = 1; attempt <= SHELL_BOOTSTRAP_ATTEMPTS; attempt += 1) {
    try {
      const bootstrap = await getDesktopBootstrapConfigFromShell() as ShellDesktopBootstrapConfig;
      applyDesktopBootstrapConfig(resolveDenBootstrapConfig(bootstrap));
      return desktopBootstrapConfig;
    } catch (error) {
      console.error("[den-bootstrap] shell read failed", attempt, error);
      if (attempt < SHELL_BOOTSTRAP_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, SHELL_BOOTSTRAP_RETRY_DELAY_MS));
      }
    }
  }

  // All quick attempts failed. Keep build defaults in memory only — do NOT
  // sync them to localStorage: previously synced values from a successful
  // boot are more trustworthy than build defaults, and clobbering them
  // silently reverted custom/self-hosted control planes to the production
  // URL until a manual reload.
  desktopBootstrapConfig = resolveDenBootstrapConfig({
    baseUrl: BUILD_DEN_BASE_URL,
    apiBaseUrl: BUILD_DEN_API_BASE_URL,
    requireSignin: BUILD_DEN_REQUIRE_SIGNIN,
  });

  // Heal in the background without blocking boot: once the bridge comes up,
  // apply the real shell config and notify listeners.
  void (async () => {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      try {
        const bootstrap = await getDesktopBootstrapConfigFromShell() as ShellDesktopBootstrapConfig;
        applyDesktopBootstrapConfig(resolveDenBootstrapConfig(bootstrap));
        dispatchDenSettingsChanged({ settings: readDenSettings() });
        return;
      } catch {
        // Bridge still unavailable — keep trying.
      }
    }
  })();

  return desktopBootstrapConfig;
}

export async function setDenBootstrapConfig(
  next: ShellDesktopBootstrapConfig,
): Promise<DenBootstrapConfig> {
  const normalized = resolveDenBootstrapConfig(next);

  if (isDesktopRuntime()) {
    const persisted = await setDesktopBootstrapConfigInShell({
      baseUrl: normalized.baseUrl,
      apiBaseUrl: normalized.apiBaseUrl,
      requireSignin: normalized.requireSignin,
    }) as ShellDesktopBootstrapConfig;
    
    applyDesktopBootstrapConfig(resolveDenBootstrapConfig(persisted));
  } else {
    applyDesktopBootstrapConfig(normalized);
  }

  dispatchDenSettingsChanged({
    settings: readDenSettings(),
  });

  return readDenBootstrapConfig();
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
    return {
      ...readDenBootstrapConfig(),
      authToken: null,
      activeOrgId: null,
      activeOrgSlug: null,
      activeOrgName: null,
    };
  }

  const baseUrls = resolveDenBaseUrls({
    baseUrl: window.localStorage.getItem(STORAGE_BASE_URL) ?? readDenBootstrapConfig().baseUrl,
    apiBaseUrl: window.localStorage.getItem(STORAGE_API_BASE_URL) ?? readDenBootstrapConfig().apiBaseUrl,
  });

  return {
    ...baseUrls,
    authToken: (window.localStorage.getItem(STORAGE_AUTH_TOKEN) ?? "").trim() || null,
    activeOrgId: (window.localStorage.getItem(STORAGE_ACTIVE_ORG_ID) ?? "").trim() || null,
    activeOrgSlug: (window.localStorage.getItem(STORAGE_ACTIVE_ORG_SLUG) ?? "").trim() || null,
    activeOrgName: (window.localStorage.getItem(STORAGE_ACTIVE_ORG_NAME) ?? "").trim() || null,
  };
}

export function writeDenSettings(next: DenSettings, options?: { persistBootstrap?: boolean }) {
  if (typeof window === "undefined") {
    return;
  }

  const pendingBootstrap = getPendingBootstrapConfig(next);
  const previous = readDenSettings();
  const resolved = resolveDenBaseUrls(next);
  const previousResolved = resolveDenBaseUrls(previous);
  const baseUrl = resolved.baseUrl;
  const apiBaseUrl = next.apiBaseUrl !== undefined
    ? resolved.apiBaseUrl
    : previousResolved.baseUrl === resolved.baseUrl
      ? previous.apiBaseUrl ?? resolved.apiBaseUrl
      : resolved.apiBaseUrl;
  const authToken = next.authToken?.trim() ?? "";
  const activeOrgId = next.activeOrgId?.trim() ?? "";
  const activeOrgSlug = next.activeOrgSlug?.trim() ?? "";
  const activeOrgName = next.activeOrgName?.trim() ?? "";

  if (
    previous.baseUrl === baseUrl &&
    (previous.apiBaseUrl ?? "") === apiBaseUrl &&
    (previous.authToken ?? "") === authToken &&
    (previous.activeOrgId ?? "") === activeOrgId &&
    (previous.activeOrgSlug ?? "") === activeOrgSlug &&
    (previous.activeOrgName ?? "") === activeOrgName
  ) {
    return;
  }

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

  if (options?.persistBootstrap !== false && pendingBootstrap) {
    const currentBootstrap = readDenBootstrapConfig();
    if (
      pendingBootstrap.baseUrl !== currentBootstrap.baseUrl ||
      pendingBootstrap.apiBaseUrl !== currentBootstrap.apiBaseUrl
    ) {
      void setDenBootstrapConfig({
        baseUrl: pendingBootstrap.baseUrl,
        apiBaseUrl: pendingBootstrap.apiBaseUrl,
        requireSignin: currentBootstrap.requireSignin,
      }).catch(() => undefined);
    }
  }

  dispatchDenSettingsChanged({
    settings: readDenSettings(),
  });
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

  dispatchDenSettingsChanged({
    settings: readDenSettings(),
  });
}

export async function ensureDenActiveOrganization(options?: { forceServerSync?: boolean }) {
  const settings = readDenSettings();
  const token = settings.authToken?.trim() ?? "";
  if (!token) {
    return null;
  }

  const client = createDenClient({
    baseUrl: settings.baseUrl,
    apiBaseUrl: settings.apiBaseUrl,
    token,
  });

  const response = await client.listOrgs();
  const selectedOrgId = settings.activeOrgId?.trim() ?? "";
  const selectedOrgSlug = settings.activeOrgSlug?.trim() ?? "";
  const targetOrg =
    response.orgs.find((org) => org.id === selectedOrgId) ??
    response.orgs.find((org) => org.slug === selectedOrgSlug) ??
    response.orgs.find((org) => org.id === response.activeOrgId) ??
    response.orgs.find((org) => org.slug === response.activeOrgSlug) ??
    response.orgs[0] ??
    null;

  if (!targetOrg) {
    writeDenSettings({
      ...settings,
      activeOrgId: null,
      activeOrgSlug: null,
      activeOrgName: null,
    }, { persistBootstrap: false });
    return null;
  }

  if (
    options?.forceServerSync &&
    (!response.activeOrgId || response.activeOrgId !== targetOrg.id)
  ) {
    await client.setActiveOrganization({ organizationId: targetOrg.id });
  }

  writeDenSettings({
    ...settings,
    activeOrgId: targetOrg.id,
    activeOrgSlug: targetOrg.slug,
    activeOrgName: targetOrg.name,
  }, { persistBootstrap: false });

  return targetOrg;
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

  return payload.orgs.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    if (
      typeof entry.id !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.slug !== "string" ||
      (entry.role !== "owner" && entry.role !== "admin" && entry.role !== "member")
    ) {
      return [];
    }

    return [
      {
        id: entry.id,
        name: entry.name,
        slug: entry.slug,
        role: entry.role,
      } satisfies DenOrgSummary,
    ];
  });
}

function getWorkers(payload: unknown): DenWorkerSummary[] {
  if (!isRecord(payload) || !Array.isArray(payload.workers)) {
    return [];
  }

  return payload.workers.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const instance = isRecord(entry.instance) ? entry.instance : null;
    if (typeof entry.id !== "string" || typeof entry.name !== "string") {
      return [];
    }
    return [
      {
        workerId: entry.id,
        workerName: entry.name,
        status: typeof entry.status === "string" ? entry.status : "unknown",
        instanceUrl: instance && typeof instance.url === "string" ? instance.url : null,
        provider: instance && typeof instance.provider === "string" ? instance.provider : null,
        isMine: Boolean(entry.isMine),
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : null,
      } satisfies DenWorkerSummary,
    ];
  });
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

function getMcpToken(payload: unknown): DenMcpToken | null {
  if (
    !isRecord(payload) ||
    typeof payload.token !== "string" ||
    typeof payload.expiresAt !== "string" ||
    typeof payload.organizationId !== "string" ||
    typeof payload.resource !== "string"
  ) {
    return null;
  }
  return {
    token: payload.token,
    expiresAt: payload.expiresAt,
    organizationId: payload.organizationId,
    scopes: Array.isArray(payload.scopes)
      ? payload.scopes.filter((entry): entry is string => typeof entry === "string")
      : [],
    resource: payload.resource,
  };
}

function parseDenOrgSkillRow(record: Record<string, unknown>): DenOrgSkillCard | null {
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
    shared,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
  };
}

function getDenOrgSkillsFromPayload(payload: unknown): DenOrgSkillCard[] {
  if (!isRecord(payload) || !Array.isArray(payload.skills)) {
    return [];
  }
  return payload.skills.flatMap((entry) => {
    const skill = isRecord(entry) ? parseDenOrgSkillRow(entry) : null;
    return skill ? [skill] : [];
  });
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseDenOrgLlmProviderModel(value: unknown): DenOrgLlmProviderModel | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    return null;
  }

  return {
    id: value.id,
    name: value.name,
    config: parseJsonRecord(value.config),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
  };
}

function parseDenOrgLlmProvider(value: unknown): DenOrgLlmProvider | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.providerId !== "string" ||
    typeof value.name !== "string" ||
    (value.source !== "models_dev" &&
      value.source !== "custom" &&
      value.source !== "openwork")
  ) {
    return null;
  }

  return {
    id: value.id,
    source: value.source,
    providerId: value.providerId,
    name: value.name,
    providerConfig: parseJsonRecord(value.providerConfig),
    hasApiKey: value.hasApiKey === true,
    models: Array.isArray(value.models)
      ? value.models.flatMap((model) => {
          const parsed = parseDenOrgLlmProviderModel(model);
          return parsed ? [parsed] : [];
        })
      : [],
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

function getDenOrgLlmProviders(payload: unknown): DenOrgLlmProvider[] {
  if (!isRecord(payload) || !Array.isArray(payload.llmProviders)) {
    return [];
  }

  return payload.llmProviders.flatMap((provider) => {
    const parsed = parseDenOrgLlmProvider(provider);
    return parsed ? [parsed] : [];
  });
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

function parsePluginConfigObjectType(value: unknown): DenPluginConfigObjectType | null {
  return value === "skill" || value === "agent" || value === "command" || value === "tool" ||
    value === "mcp" || value === "hook" || value === "context" || value === "custom"
    ? value
    : null;
}

function parsePluginConfigObjectVersion(value: unknown): DenPluginConfigObjectVersion | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    rawSourceText: typeof value.rawSourceText === "string" ? value.rawSourceText : null,
    normalizedPayloadJson: isRecord(value.normalizedPayloadJson) ? value.normalizedPayloadJson : null,
    sourceRevisionRef: typeof value.sourceRevisionRef === "string" ? value.sourceRevisionRef : null,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
  };
}

function parsePluginConfigObject(value: unknown): DenPluginConfigObject | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string") return null;
  const objectType = parsePluginConfigObjectType(value.objectType);
  if (!objectType) return null;
  return {
    id: value.id,
    objectType,
    title: value.title,
    description: typeof value.description === "string" ? value.description : null,
    currentFileName: typeof value.currentFileName === "string" ? value.currentFileName : null,
    currentFileExtension: typeof value.currentFileExtension === "string" ? value.currentFileExtension : null,
    currentRelativePath: typeof value.currentRelativePath === "string" ? value.currentRelativePath : null,
    status: typeof value.status === "string" ? value.status : "active",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    latestVersion: parsePluginConfigObjectVersion(value.latestVersion),
  };
}

function parseExtensionSourceFormat(value: unknown): OpenWorkExtensionSourceFormat | null {
  switch (value) {
    case "openwork-builtin":
    case "openwork-extension-manifest":
    case "claude-plugin":
    case "opencode-plugin":
    case "mcp-directory":
    case "manual":
      return value;
    default:
      return null;
  }
}

function parseExtensionSourceOrigin(value: unknown): OpenWorkExtensionSource["origin"] | undefined {
  switch (value) {
    case "builtin":
    case "den":
    case "workspace":
    case "local":
      return value;
    default:
      return undefined;
  }
}

function parseExtensionSource(value: unknown): OpenWorkExtensionSource | null {
  if (!isRecord(value) || typeof value.trusted !== "boolean") return null;
  const format = parseExtensionSourceFormat(value.format);
  if (!format) return null;
  const origin = parseExtensionSourceOrigin(value.origin);
  return {
    format,
    trusted: value.trusted,
    ...(origin ? { origin } : {}),
    ...(typeof value.reference === "string" ? { reference: value.reference } : {}),
  };
}

function parseStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value;
}

function parseExtensionResourceType(value: unknown): OpenWorkExtensionResourceType | null {
  switch (value) {
    case "skill":
    case "agent":
    case "command":
    case "tool":
    case "mcp":
    case "opencode-plugin":
    case "provider":
    case "hook":
    case "context":
    case "secret":
    case "file":
    case "local-service":
    case "native-binary":
      return value;
    default:
      return null;
  }
}

function parseExtensionLocalCommandRef(value: unknown): OpenWorkExtensionResource["localCommandRef"] | undefined {
  switch (value) {
    case "openwork.computerUseMcp":
    case "openwork.uiMcp":
      return value;
    default:
      return undefined;
  }
}

function parseExtensionResource(value: unknown): OpenWorkExtensionResource | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const type = parseExtensionResourceType(value.type);
  if (!type) return null;
  const command = parseStringList(value.command);
  const localCommandRef = parseExtensionLocalCommandRef(value.localCommandRef);
  return {
    type,
    id: value.id,
    ...(typeof value.label === "string" ? { label: value.label } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(command ? { command } : {}),
    ...(typeof value.envKey === "string" ? { envKey: value.envKey } : {}),
    ...(typeof value.packageName === "string" ? { packageName: value.packageName } : {}),
    ...(typeof value.providerId === "string" ? { providerId: value.providerId } : {}),
    ...(typeof value.mcpServerName === "string" ? { mcpServerName: value.mcpServerName } : {}),
    ...(localCommandRef ? { localCommandRef } : {}),
    ...(typeof value.required === "boolean" ? { required: value.required } : {}),
  };
}

function parseExtensionContributionType(value: unknown): OpenWorkExtensionContributionType | null {
  switch (value) {
    case "settings-panel":
    case "setup-instructions":
    case "composer-prompt":
    case "session-side-panel":
    case "session-rail-item":
    case "control-actions":
    case "server-route":
    case "native-capability":
    case "test-action":
      return value;
    default:
      return null;
  }
}

function parseExtensionContributionLocation(value: unknown): OpenWorkExtensionContribution["location"] | undefined {
  switch (value) {
    case "settings-detail":
    case "composer":
    case "session-right-pane":
    case "session-rail":
    case "server":
    case "native":
      return value;
    default:
      return undefined;
  }
}

function parseExtensionContribution(value: unknown): OpenWorkExtensionContribution | null {
  if (!isRecord(value)) return null;
  const type = parseExtensionContributionType(value.type);
  if (!type) return null;
  const location = parseExtensionContributionLocation(value.location);
  return {
    type,
    ...(typeof value.ref === "string" ? { ref: value.ref } : {}),
    ...(typeof value.label === "string" ? { label: value.label } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.prompt === "string" ? { prompt: value.prompt } : {}),
    ...(location ? { location } : {}),
  };
}

function parseExtensionSetup(value: unknown): OpenWorkExtensionSetup | undefined {
  if (!isRecord(value)) return undefined;
  const requiredEnv = parseStringList(value.requiredEnv);
  return {
    ...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}),
    ...(typeof value.primaryCta === "string" ? { primaryCta: value.primaryCta } : {}),
    ...(typeof value.secondaryCta === "string" ? { secondaryCta: value.secondaryCta } : {}),
    ...(requiredEnv ? { requiredEnv } : {}),
    ...(typeof value.testActionRef === "string" ? { testActionRef: value.testActionRef } : {}),
  };
}

function parseReloadReason(value: unknown): ReloadReason | null {
  switch (value) {
    case "plugins":
    case "skills":
    case "mcp":
    case "config":
    case "agents":
    case "commands":
      return value;
    default:
      return null;
  }
}

function parseReloadReasons(value: unknown): ReloadReason[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const reasons = value.flatMap((item) => {
    const reason = parseReloadReason(item);
    return reason ? [reason] : [];
  });
  return reasons.length === value.length ? reasons : undefined;
}

function parseExtensionLifecycle(value: unknown): OpenWorkExtensionLifecycle | undefined {
  if (!isRecord(value)) return undefined;
  const reload = parseReloadReasons(value.reload);
  const detection = parseStringList(value.detection);
  return {
    ...(reload ? { reload } : {}),
    ...(detection ? { detection } : {}),
  };
}

function parseExtensionPlatform(value: unknown): OpenWorkExtensionManifest["platform"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const platforms = value.flatMap((item) => {
    switch (item) {
      case "darwin":
      case "linux":
      case "windows":
      case "web":
        return [item];
      default:
        return [];
    }
  });
  return platforms.length === value.length ? platforms : undefined;
}

function parseOpenWorkExtensionManifest(value: unknown): OpenWorkExtensionManifest | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    !Array.isArray(value.resources)
  ) {
    return null;
  }
  const source = parseExtensionSource(value.source);
  if (!source) return null;
  const resources = value.resources.flatMap((entry) => {
    const resource = parseExtensionResource(entry);
    return resource ? [resource] : [];
  });
  if (resources.length !== value.resources.length) return null;
  const contributions = Array.isArray(value.contributions)
    ? value.contributions.flatMap((entry) => {
        const contribution = parseExtensionContribution(entry);
        return contribution ? [contribution] : [];
      })
    : undefined;
  if (Array.isArray(value.contributions) && contributions?.length !== value.contributions.length) return null;
  const setup = parseExtensionSetup(value.setup);
  const lifecycle = parseExtensionLifecycle(value.lifecycle);
  const platform = parseExtensionPlatform(value.platform);
  if (Array.isArray(value.platform) && !platform) return null;
  return {
    schemaVersion: 1,
    id: value.id,
    name: value.name,
    description: value.description,
    source,
    ...(isRecord(value.icon)
      ? { icon: {
          ...(typeof value.icon.src === "string" ? { src: value.icon.src } : {}),
          ...(typeof value.icon.simpleIconSlug === "string" ? { simpleIconSlug: value.icon.simpleIconSlug } : {}),
        } }
      : {}),
    ...(isRecord(value.composer) && typeof value.composer.prompt === "string" ? { composer: { prompt: value.composer.prompt } } : {}),
    ...(setup ? { setup } : {}),
    resources,
    ...(contributions ? { contributions } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(typeof value.defaultEnabled === "boolean" ? { defaultEnabled: value.defaultEnabled } : {}),
    ...(typeof value.defaultHidden === "boolean" ? { defaultHidden: value.defaultHidden } : {}),
    ...(platform ? { platform } : {}),
  };
}

function parseDenExtensionProjection(value: unknown): DenOrgExtensionProjection | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return null;
  const sourceFormat = parseExtensionSourceFormat(value.sourceFormat);
  if (!sourceFormat) return null;
  return {
    id: value.id,
    name: value.name,
    description: typeof value.description === "string" ? value.description : null,
    sourceFormat,
    manifest: parseOpenWorkExtensionManifest(value.manifest),
  };
}

function parseOrgPlugin(value: unknown): DenOrgPlugin | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return null;
  const counts = isRecord(value.componentCounts)
    ? Object.fromEntries(
        Object.entries(value.componentCounts).filter((entry): entry is [string, number] =>
          typeof entry[0] === "string" && typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0,
        ),
      )
    : {};
  return {
    id: value.id,
    name: value.name,
    description: typeof value.description === "string" ? value.description : null,
    status: typeof value.status === "string" ? value.status : "active",
    memberCount: typeof value.memberCount === "number" && Number.isFinite(value.memberCount) ? value.memberCount : 0,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    componentCounts: counts,
    extension: parseDenExtensionProjection(value.extension),
  };
}

function parseOrgMarketplace(value: unknown): DenOrgMarketplace | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return null;
  return {
    id: value.id,
    name: value.name,
    description: typeof value.description === "string" ? value.description : null,
    status: typeof value.status === "string" ? value.status : "active",
    pluginCount: typeof value.pluginCount === "number" && Number.isFinite(value.pluginCount) ? value.pluginCount : 0,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

function parsePluginMembership(value: unknown): DenPluginMembership | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.pluginId !== "string" || typeof value.configObjectId !== "string") {
    return null;
  }
  const configObject = parsePluginConfigObject(value.configObject);
  return {
    id: value.id,
    pluginId: value.pluginId,
    configObjectId: value.configObjectId,
    ...(configObject ? { configObject } : {}),
  };
}

function getOrgMarketplaces(payload: unknown): DenOrgMarketplace[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return [];
  return payload.items.flatMap((item) => {
    const marketplace = parseOrgMarketplace(item);
    return marketplace ? [marketplace] : [];
  });
}

function getOrgMarketplaceResolved(payload: unknown): DenOrgMarketplaceResolved | null {
  if (!isRecord(payload) || !isRecord(payload.item)) return null;
  const marketplace = parseOrgMarketplace(payload.item.marketplace);
  if (!marketplace || !Array.isArray(payload.item.plugins)) return null;
  return {
    marketplace,
    plugins: payload.item.plugins.flatMap((item) => {
      const plugin = parseOrgPlugin(item);
      return plugin ? [plugin] : [];
    }),
  };
}

function getOrgPluginResolved(plugin: DenOrgPlugin, payload: unknown): DenOrgPluginResolved {
  const memberships = isRecord(payload) && Array.isArray(payload.items)
    ? payload.items.flatMap((item) => {
        const membership = parsePluginMembership(item);
        return membership ? [membership] : [];
      })
    : [];
  return { plugin, memberships };
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
      ? billing.invoices.flatMap((item) => {
          const invoice = getBillingInvoice(item);
          return invoice ? [invoice] : [];
        })
      : [],
    productId: typeof billing.productId === "string" ? billing.productId : null,
    benefitId: typeof billing.benefitId === "string" ? billing.benefitId : null,
  };
}

const resolveFetch = () => (isDesktopRuntime() ? desktopFetch : globalThis.fetch);

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type DenRequestOptions = {
  method?: string;
  token?: string | null;
  body?: unknown;
  timeoutMs?: number;
  organizationId?: string | null;
};

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
  options: DenRequestOptions = {},
): Promise<RawJsonResponse<T>> {
  const baseUrls = typeof input === "string" ? resolveDenBaseUrls(input) : input;
  const url = `${resolveRequestBaseUrl(baseUrls, path)}${path}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = options.token?.trim() ?? "";
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const organizationId = options.organizationId?.trim() ?? "";
  if (organizationId) {
    headers[ORG_PROXY_HEADER] = organizationId;
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
  options: DenRequestOptions = {},
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

async function ensureActiveOrganization(
  baseUrls: DenBaseUrls,
  token: string | null,
  input: { organizationId?: string | null; organizationSlug?: string | null },
) {
  const organizationId = input.organizationId?.trim() ?? "";
  const organizationSlug = input.organizationSlug?.trim() ?? "";
  if (!token || (!organizationId && !organizationSlug)) {
    return;
  }

  await requestJson<unknown>(baseUrls, "/v1/me/active-organization", {
    method: "POST",
    token,
    body: {
      organizationId: organizationId || undefined,
      organizationSlug: organizationSlug || undefined,
    },
  });
}

export function createDenClient(options: { baseUrl: string; apiBaseUrl?: string | null; token?: string | null }) {
  const baseUrls = resolveDenBaseUrls({
    baseUrl: options.baseUrl,
    apiBaseUrl: options.apiBaseUrl,
  });
  const token = options.token?.trim() ?? null;

  return {
    /**
     * The resolved URLs this client actually talks to. Call sites that
     * persist Den settings after a successful auth flow should store
     * `baseUrls.apiBaseUrl` so relaunches reuse the exact endpoint that
     * worked instead of re-deriving it from the web URL (see #1808).
     */
    baseUrls,

    async setActiveOrganization(input: { organizationId?: string | null; organizationSlug?: string | null }): Promise<void> {
      await ensureActiveOrganization(baseUrls, token, input);
    },

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

    async getAppVersionMetadata(): Promise<DenAppVersionMetadata> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/app-version", {
        method: "GET",
      });
      const appVersionMetadata = getDenAppVersionMetadata(payload);
      if (!appVersionMetadata) {
        throw new DenApiError(500, "invalid_app_version_payload", "App version response was missing version details.");
      }
      return appVersionMetadata;
    },

    async getDesktopConfig(): Promise<DenDesktopConfig> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/me/desktop-config", {
        method: "GET",
        token,
      });
      return normalizeDenDesktopConfig(payload);
    },

    async getResourceSnapshot(orgId?: string | null): Promise<DenResourceSnapshot> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/resources", {
        method: "GET",
        token,
        organizationId: orgId,
      });
      const snapshot = normalizeDenResourceSnapshot(payload);
      if (!snapshot) {
        throw new DenApiError(500, "invalid_resource_snapshot_payload", "Resource snapshot response was invalid.");
      }
      return snapshot;
    },

    async exchangeDesktopHandoff(grant: string): Promise<DenDesktopHandoffExchange> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/auth/desktop-handoff/exchange", {
        method: "POST",
        body: { grant },
      });
      return { user: getUser(payload), token: getToken(payload) };
    },

    async listOrgs(): Promise<{ orgs: DenOrgSummary[]; activeOrgId: string | null; activeOrgSlug: string | null; defaultOrgId: string | null }> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/me/orgs", {
        method: "GET",
        token,
      });

      const activeOrgId = isRecord(payload) && typeof payload.activeOrgId === "string"
        ? payload.activeOrgId
        : null;
      const activeOrgSlug = isRecord(payload) && typeof payload.activeOrgSlug === "string"
        ? payload.activeOrgSlug
        : null;

      return {
        orgs: getOrgList(payload),
        activeOrgId,
        activeOrgSlug,
        defaultOrgId: activeOrgId,
      };
    },

    async listWorkers(orgId: string, limit = 20): Promise<DenWorkerSummary[]> {
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      const payload = await requestJson<unknown>(baseUrls, `/v1/workers?${params.toString()}`, {
        method: "GET",
        token,
        organizationId: orgId,
      });
      return getWorkers(payload);
    },

    async mintMcpToken(orgId: string): Promise<DenMcpToken> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/mcp/token", {
        method: "POST",
        token,
        organizationId: orgId,
        body: { scopes: ["mcp:read", "mcp:write"] },
      });
      const minted = getMcpToken(payload);
      if (!minted) {
        throw new DenApiError(500, "invalid_mcp_token_payload", "MCP token response was missing required values.");
      }
      return minted;
    },

    async getWorkerTokens(workerId: string, orgId: string): Promise<DenWorkerTokens> {
      const payload = await requestJson<unknown>(baseUrls, `/v1/workers/${encodeURIComponent(workerId)}/tokens`, {
        method: "POST",
        token,
        organizationId: orgId,
        body: {},
      });
      const tokens = getWorkerTokens(payload);
      if (!tokens) {
        throw new DenApiError(500, "invalid_worker_token_payload", "Worker token response was missing token values.");
      }
      return tokens;
    },

    async listOrgSkills(orgId: string): Promise<DenOrgSkillCard[]> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/skills", {
        method: "GET",
        token,
        organizationId: orgId,
      });
      return getDenOrgSkillsFromPayload(payload);
    },

    async createOrgSkill(
      orgId: string,
      input: { skillText: string; shared?: "org" | "public" | null },
    ): Promise<{ id: string }> {
      const body = {
        skillText: input.skillText,
        shared: input.shared === undefined ? ("org" as const) : input.shared,
      };
      const payload = await requestJson<unknown>(baseUrls, "/v1/skills", {
        method: "POST",
        token,
        organizationId: orgId,
        body,
      });
      const id = getCreatedOrgSkillId(payload);
      if (!id) {
        throw new DenApiError(500, "invalid_skill_payload", "Skill response was missing id.");
      }
      return { id };
    },

    async listOrgLlmProviders(orgId: string): Promise<DenOrgLlmProvider[]> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/llm-providers", {
        method: "GET",
        token,
        organizationId: orgId,
      });
      return getDenOrgLlmProviders(payload);
    },

    async getOrgLlmProviderConnection(orgId: string, llmProviderId: string): Promise<DenOrgLlmProviderConnection> {
      const payload = await requestJson<unknown>(
        baseUrls,
        `/v1/llm-providers/${encodeURIComponent(llmProviderId)}/connect`,
        {
          method: "GET",
          token,
          organizationId: orgId,
        },
      );
      const provider = getDenOrgLlmProviderConnection(payload);
      if (!provider) {
        throw new DenApiError(500, "invalid_llm_provider_payload", "LLM provider response was missing connection details.");
      }
      return provider;
    },

    async listOrgMarketplaces(orgId: string): Promise<DenOrgMarketplace[]> {
      const payload = await requestJson<unknown>(
        baseUrls,
        `/v1/marketplaces?status=active&limit=100`,
        { method: "GET", token, organizationId: orgId },
      );
      return getOrgMarketplaces(payload);
    },

    async getOrgMarketplaceResolved(orgId: string, marketplaceId: string): Promise<DenOrgMarketplaceResolved> {
      const payload = await requestJson<unknown>(
        baseUrls,
        `/v1/marketplaces/${encodeURIComponent(marketplaceId)}/resolved`,
        { method: "GET", token, organizationId: orgId },
      );
      const resolved = getOrgMarketplaceResolved(payload);
      if (!resolved) {
        throw new DenApiError(500, "invalid_marketplace_payload", "Marketplace response was missing plugin details.");
      }
      return resolved;
    },

    async getOrgPluginResolved(orgId: string, plugin: DenOrgPlugin): Promise<DenOrgPluginResolved> {
      const payload = await requestJson<unknown>(
        baseUrls,
        `/v1/plugins/${encodeURIComponent(plugin.id)}/resolved`,
        { method: "GET", token, organizationId: orgId },
      );
      return getOrgPluginResolved(plugin, payload);
    },

    async getBillingStatus(options: { includePortal?: boolean; includeInvoices?: boolean } = {}): Promise<DenBillingSummary> {
      const params = new URLSearchParams();
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

export type DenClient = ReturnType<typeof createDenClient>;

export async function fetchDenOrgSkillsCatalog(
  client: ReturnType<typeof createDenClient>,
  orgId: string,
): Promise<DenOrgSkillCard[]> {
  const skills = await client.listOrgSkills(orgId);
  const byId = new Map<string, DenOrgSkillCard>();
  for (const skill of skills) {
    byId.set(skill.id, skill);
  }
  return Array.from(byId.values()).toSorted((a, b) => a.title.localeCompare(b.title));
}

/**
 * Mint an org-scoped MCP access token for the Den cloud MCP using the
 * current desktop Den session. Returns null when signed out or no active
 * organization is selected.
 */
export async function mintCloudControlMcpToken(): Promise<DenMcpToken | null> {
  const settings = readDenSettings();
  const token = settings.authToken?.trim() ?? "";
  const orgId = settings.activeOrgId?.trim() ?? "";
  if (!token || !orgId) {
    return null;
  }
  const client = createDenClient({
    baseUrl: settings.baseUrl,
    apiBaseUrl: settings.apiBaseUrl ?? null,
    token,
  });
  return client.mintMcpToken(orgId);
}
