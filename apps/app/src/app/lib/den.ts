import {
  normalizeDesktopConfig,
  type DesktopConfig as SharedDesktopConfig,
} from "@openwork/types/den/desktop-policies";
import {
  AUTOMATION_MODEL_ATTENTION_CAPABILITY,
  AUTOMATION_MODEL_ATTENTION_CAPABILITY_HEADER,
} from "@openwork/types/automations";
import type {
  AutomationDetail,
  AutomationDesktopRunnerPresence,
  AutomationDesktopRunnerRegistration,
  AutomationList,
  AutomationRun,
  AutomationRunReceipt,
  AutomationRunnerTokenResponse,
  CreateAutomation,
  UpdateAutomation,
} from "@openwork/types/automations";

// Re-export the shared schema under the local alias so React consumers
// (e.g. the cloud domain's desktop-config provider) can import it alongside
// the helpers they need. Solid references it internally only; the React
// port wants it as part of the public surface of this module.
export type { SharedDesktopConfig };
export { normalizeDesktopConfig };

import { isDesktopDeployment, isWebDeployment } from "./openwork-deployment";
import {
  dispatchDenSessionUpdated,
  dispatchDenSettingsChanged,
} from "./den-session-events";
import {
  desktopFetch,
  desktopFetchViaMain,
  getDesktopBootstrapConfig as getDesktopBootstrapConfigFromShell,
  readInitialDesktopBootstrapConfig,
  setDesktopBootstrapConfig as setDesktopBootstrapConfigInShell,
  type DesktopBootstrapConfig as ShellDesktopBootstrapConfig,
} from "./desktop";
import { getOpenworkGatewayOrigin } from "./gateway-runtime";
import { clearDesktopSignInIntent, clearOrgSelectionPending } from "./den-sign-in-intent";
import { clearDashboardTileCacheStorage } from "./dashboard-cache-storage";
import { isDesktopRuntime } from "./runtime-env";
import type { ReloadReason } from "../types";
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

declare global {
  interface Window {
    __openworkOrgDropWarnings?: string[];
  }
}

export const STORAGE_BASE_URL = "openwork.den.baseUrl";
const LEGACY_STORAGE_API_BASE_URL = "openwork.den.apiBaseUrl";
const STORAGE_AUTH_TOKEN = "openwork.den.authToken";
/**
 * Origin comparison key (see denOriginComparisonKey) of the Den control plane
 * that issued the retained auth token. Written together with the token so a
 * later boot can prove the retained session belongs to the resolved bootstrap
 * origin before any credential-bearing request is made.
 */
export const STORAGE_SESSION_ORIGIN = "openwork.den.sessionOrigin";
const STORAGE_ACTIVE_ORG_ID = "openwork.den.activeOrgId";
const STORAGE_ACTIVE_ORG_SLUG = "openwork.den.activeOrgSlug";
const STORAGE_ACTIVE_ORG_NAME = "openwork.den.activeOrgName";
const DESKTOP_CONFIG_CACHE_PREFIX = "openwork.den.desktopConfig:";
export const CLOUD_MCP_SYNC_MARKER_STORAGE_KEY = "openwork.den.mcp.sync";
const ORG_PROXY_HEADER = "x-openwork-legacy-org-id";
const ORG_SCOPE_HEADER = "x-openwork-org-id";
const DEFAULT_DEN_TIMEOUT_MS = 12_000;

export const DEFAULT_DEN_AUTH_NAME = "OpenWork User";
const BUILD_DEN_BASE_URL =
  (typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_DEN_BASE_URL === "string"
    ? import.meta.env.VITE_DEN_BASE_URL
    : "").trim() || "https://app.openworklabs.com";
const BUILD_DEN_REQUIRE_SIGNIN =
  (typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_DEN_REQUIRE_SIGNIN === "string"
    ? /^(1|true|yes|on)$/i.test(import.meta.env.VITE_DEN_REQUIRE_SIGNIN.trim())
    : false);

/**
 * Pins Den API calls (not the sign-in pages) to a specific base. Headless/dev
 * web runs use it to route the Den API through a same-origin proxy so a remote
 * control plane never needs CORS, while sign-in still opens the real web app.
 * Read dynamically so tests can vary it; Vite inlines the env in real builds.
 */
function readBuildDenApiBaseUrl(): string {
  return (typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_DEN_API_BASE_URL === "string"
    ? import.meta.env.VITE_DEN_API_BASE_URL
    : "").trim();
}

function readForceEnvDenSettings(): boolean {
  return (typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_OPENWORK_FORCE_ENV_SETTINGS === "string"
    ? /^(1|true|yes|on)$/i.test(import.meta.env.VITE_OPENWORK_FORCE_ENV_SETTINGS.trim())
    : false);
}

export const HOSTED_DEFAULT_DEN_BASE_URL = "https://app.openworklabs.com";
export const HOSTED_DEFAULT_DEN_API_BASE_URL = "https://api.app.openworklabs.com";
export const DEFAULT_DEN_BASE_URL = BUILD_DEN_BASE_URL;
export const DEN_INFERENCE_PATH = "/dashboard/inference";

// Den wire types moved to den-types.ts (leaf module); re-exported here so
// the many existing den.ts importers keep working.
export type * from "./den-types";
import type {
  DenAssignedMarketplaceCapability,
  DenDashboardElement,
  DenGrantedDashboard,
  DenMeLibraryPlugin,
  DenOrgExtensionProjection,
  DenOrgMarketplace,
  DenOrgPlugin,
  DenOrgPluginResolved,
  DenPluginCloudReadiness,
  DenPluginCloudReadinessConnection,
  DenPluginCloudReadinessState,
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

export type DenBootstrapSource = "file" | "default";

/** Org + first-skill identity shared by the handoff and prepared records. */
export type DenBootstrapOrgSkill = {
  orgId: string;
  orgName: string;
  orgSlug: string;
  skillId: string;
  skillTitle: string;
};

export type DenBootstrapHandoff = DenBootstrapOrgSkill & {
  grant: string;
  denBaseUrl: string;
  createdAt: string;
};

export type DenBootstrapPrepared = DenBootstrapOrgSkill & {
  skillsDir: string;
  skillPath: string;
  preparedAt: string;
};

export type DenEnterpriseActivation = {
  activatedAt: string;
  denBaseUrl: string;
};

export type DenBootstrapConfig = DenBaseUrls & {
  source: DenBootstrapSource;
  requireSignin: boolean;
  requireActivation?: boolean;
  brandAppName?: string | null;
  brandLogoUrl?: string | null;
  brandIconUrl?: string | null;
  claimLinks?: Array<{
    id: string;
    role: string;
    token?: string;
    url: string;
    expiresAt: string;
  }> | null;
  handoff?: DenBootstrapHandoff | null;
  prepared?: DenBootstrapPrepared | null;
  enterpriseActivation?: DenEnterpriseActivation | null;
};

export type DenDesktopConfig = SharedDesktopConfig;

export type DenCanonicalOrgRole = "super-admin" | "owner" | "admin" | "member";
export type DenOrgRole = string;

export type DenOrgSummary = {
  id: string;
  name: string;
  slug: string;
  role: DenOrgRole;
};

function normalizeDenCanonicalOrgRole(role: string): DenCanonicalOrgRole | null {
  const normalized = role.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (normalized === "super-admin") return "super-admin";
  if (normalized === "owner") return "owner";
  if (normalized === "admin") return "admin";
  if (normalized === "member") return "member";
  return null;
}

function denCanonicalOrgRoles(roleValue: string) {
  const roles = new Set<DenCanonicalOrgRole>();
  for (const role of roleValue.split(",")) {
    const canonicalRole = normalizeDenCanonicalOrgRole(role);
    if (canonicalRole) roles.add(canonicalRole);
  }
  return roles;
}

export function getDenCanonicalOrgRole(roleValue: string): DenCanonicalOrgRole {
  const roles = denCanonicalOrgRoles(roleValue);
  if (roles.has("owner")) return "owner";
  if (roles.has("super-admin")) return "super-admin";
  if (roles.has("admin")) return "admin";
  return "member";
}

export function isDenOrgAdminRole(roleValue: string | null | undefined) {
  if (!roleValue) return false;
  return getDenCanonicalOrgRole(roleValue) !== "member";
}

export function formatDenOrgRoleLabel(roleValue: string) {
  return roleValue
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean)
    .map((role) => {
      const canonicalRole = normalizeDenCanonicalOrgRole(role);
      if (canonicalRole === "super-admin") return "Super admin";
      if (canonicalRole === "owner") return "Owner";
      if (canonicalRole === "admin") return "Admin";
      if (canonicalRole === "member") return "Member";
      return role
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
        .join(" ");
    })
    .join(", ");
}

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

export type DenCloudInstance = {
  status: "provisioning" | "waking" | "ready" | "failed";
  url: string | null;
  imageVersion: string | null;
  instanceName?: string | null;
  latestVersion: string | null;
  failure?: DenCloudStartupFailure;
};

export type DenCloudStartupFailure = {
  code: string;
  stage: "provisioning" | "recovery" | "runtime";
  reference: string;
  occurredAt: string;
};

export type DenCloudInstanceUpdateResult =
  | { ok: true; status: "update_requested" }
  | { ok: false; error: "already_current" | "flush_failed" };

export type DenMemoryContext = {
  id: string;
  snippet: string;
  citation: Record<string, unknown> | null;
  origin: string | null;
  createdAt: string;
};

export type DenMemory = {
  id: string;
  content: string;
  tags: string[] | null;
  source: string;
  scope: string;
  createdAt: string;
  updatedAt: string;
  contexts: DenMemoryContext[];
};

export type DenMcpToken = {
  token: string;
  appHostToken?: string;
  expiresAt: string;
  appHostExpiresAt?: string;
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

export type DenExternalMcpConnection = {
  id: string;
  name: string;
  url: string;
  authType: "oauth" | "apikey" | "none";
  credentialMode: "shared" | "per_member";
  connected: boolean;
  connectedAt: string | null;
  /** For per_member connections: whether the CALLING member has connected their own account. Always true for connected shared connections. */
  connectedForMe: boolean;
  needsReconnect?: boolean;
  issuerReviewRequired?: boolean;
  reconnectActionOwner?: "member" | "organization_admin" | null;
  missingFeatures?: string[];
  externalAccountId?: string | null;
  grantedScopes?: string[];
  tenantId?: string | null;
  /** Which service a native connector fronts (e.g. "google-workspace"); null/absent for external MCP connections. */
  nativeProviderKey?: string | null;
};

export type DenExternalMcpPreset = {
  presetId: string;
  displayName: string;
  description: string;
  url: string;
  authType: "oauth" | "apikey" | "none";
};

export type DenMcpConnectionConnectStart = {
  status: "connected" | "needs_auth";
  authorizeUrl: string | null;
};

export type DenOrgLlmProviderConnection = DenOrgLlmProvider & {
  apiKey: string | null;
  /**
   * Per-env-var credential values for providers whose config declares several
   * env keys (e.g. AWS Bedrock). Servers send either `apiKey` or `apiKeys`,
   * never both.
   */
  apiKeys: Record<string, string> | null;
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

export type DenOpenWorkWebAccessSource = "subscription" | "complimentary" | null;

export type DenOpenWorkWebAccess = {
  hasAccess: boolean;
  accessSource: DenOpenWorkWebAccessSource;
};

type DenAuthResult = {
  user: DenUser | null;
  token: string | null;
};

export type DenDesktopHandoffExchangeOrganization = {
  id: string;
  slug: string | null;
  name: string | null;
};

export type DenDesktopHandoffExchange = {
  user: DenUser | null;
  token: string | null;
  organization: DenDesktopHandoffExchangeOrganization | null;
  connectEnabled: boolean | null;
};

const defaultBootstrapBaseUrls = resolveDenBaseUrls({
  baseUrl: BUILD_DEN_BASE_URL,
});
export const DEFAULT_DEN_API_BASE_URL = defaultBootstrapBaseUrls.apiBaseUrl;

let desktopBootstrapConfig: DenBootstrapConfig = {
  ...defaultBootstrapBaseUrls,
  source: "default",
  requireSignin: BUILD_DEN_REQUIRE_SIGNIN,
};
let gatewayBootstrapConfig: DenBootstrapConfig | null = null;
let gatewayBootstrapConfigOrigin: string | null = null;
let gatewayBootstrapConfigSource: DenBootstrapConfig | null = null;

/**
 * Whether the in-memory bootstrap snapshot came from an authoritative source
 * (preload snapshot, shell IPC read, or an explicit persist) or is only the
 * in-memory fallback used while the shell bridge is unavailable. An
 * `unresolved` bootstrap must never be treated as a real hosted selection:
 * retained credentials stay quarantined until the origin that owns them is
 * proven.
 */
export type DenBootstrapResolution = "unresolved" | "resolved";
let desktopBootstrapResolution: DenBootstrapResolution = "unresolved";
/**
 * Monotonic startup/refresh generation. Every asynchronous bootstrap
 * resolution belongs to the generation that started it; a late result from an
 * obsolete generation must never replace the current snapshot.
 */
let desktopBootstrapGeneration = 0;
let lastCredentialGateLog: string | null = null;

export function getDenBootstrapResolution(): DenBootstrapResolution {
  return desktopBootstrapResolution;
}

export type DenAppVersionMetadata = {
  minAppVersion: string;
  latestAppVersion: string;
  publishedDesktopVersions: string[];
  /**
   * This deployment's web app base URL, as advertised by `GET /v1/app-version`.
   * Null when talking to a den-api that predates the field.
   */
  webUrl: string | null;
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

/**
 * Codes the Den API uses when the session itself is invalid, expired, or
 * revoked. Only these may destroy the stored token; every other 401 code is
 * treated as the control plane being temporarily unreachable.
 */
const DEN_SESSION_TERMINATION_CODES = new Set([
  "unauthorized",
  "invalid_session",
  "session_expired",
  "session_revoked",
  "session_not_found",
  "invalid_token",
  "token_expired",
  "token_revoked",
]);

/**
 * True only for 401s whose Den error code explicitly names an invalid,
 * expired, or revoked session. A bare/foreign 401 from a corporate proxy or
 * captive portal — and structured 401s minted by deployment infrastructure in
 * front of the control plane (`base_url_not_present`, misrouted proxies,
 * platform placeholders) — must be treated as "unavailable", not as a revoked
 * session. Otherwise a VPN blip or a mid-deploy edge response signs the user
 * out and destroys the stored token.
 */
export function isDenSessionRevokedError(error: unknown): boolean {
  return (
    error instanceof DenApiError &&
    error.status === 401 &&
    DEN_SESSION_TERMINATION_CODES.has(error.code)
  );
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
  const publishedDesktopVersions = readStringArray(payload.publishedDesktopVersions);

  return {
    minAppVersion:
      typeof payload.minAppVersion === "string" ? payload.minAppVersion.trim() : "",
    latestAppVersion,
    publishedDesktopVersions:
      publishedDesktopVersions.length > 0 ? publishedDesktopVersions : [latestAppVersion],
    webUrl: normalizeDenBaseUrl(typeof payload.webUrl === "string" ? payload.webUrl : ""),
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

/**
 * True when the effective Den control plane is not the hosted OpenWork Cloud
 * (app.openworklabs.com). Self-hosted deployments point the app at their own
 * control plane via VITE_DEN_BASE_URL or the desktop bootstrap config, so
 * hosted-only surfaces (e.g. OpenWork Models upsells) should stay hidden.
 */
export function isSelfHostedControlPlane(): boolean {
  return (
    denOriginComparisonKey(readDenSettings().baseUrl) !==
    denOriginComparisonKey(HOSTED_DEFAULT_DEN_BASE_URL)
  );
}

export function getDenInferenceUrl(baseUrl?: string | null): string {
  const normalized = normalizeDenBaseUrl(baseUrl ?? readDenSettings().baseUrl) ?? DEFAULT_DEN_BASE_URL;
  return `${normalized}${DEN_INFERENCE_PATH}`;
}

function isHostedWebAppHost(hostname: string): boolean {
  return hostname.trim().toLowerCase().startsWith("app.");
}

function directHostedApiMcpResourceUrl(input: URL): string | null {
  if (input.protocol !== "https:" || input.hostname.toLowerCase() !== "app.openworklabs.com") {
    return null;
  }
  const pathname = input.pathname.replace(/\/+$/, "");
  if (pathname !== "/mcp" && pathname !== "/api/den/mcp") {
    return null;
  }
  const output = new URL(input.toString());
  output.hostname = "api.app.openworklabs.com";
  output.pathname = "/mcp";
  output.search = "";
  output.hash = "";
  return output.toString().replace(/\/+$/, "");
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

const HOSTED_DEN_APEX_HOST = "openworklabs.com";

function isHostedDenHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === HOSTED_DEN_APEX_HOST || normalized.endsWith(`.${HOSTED_DEN_APEX_HOST}`);
}

/**
 * The deterministic API origin for a Den base URL, without runtime config.
 *
 * Only two shapes are known ahead of time:
 * - An explicit API host (`api.*`) is already the API origin.
 * - Hosted OpenWork Cloud (`*.openworklabs.com`) serves its API at the
 *   `api.`-prefixed host.
 *
 * Every other deployment (self-hosted single host, localhost, tunnel or
 * sandbox preview hosts with single-label wildcard certificates) keeps the
 * same-origin `/api/den` proxy. Inventing `api.<host>` there produced
 * unreachable origins and TLS names the deployment's certificate cannot
 * cover, which broke desktop sign-in. Runtime config (`denApiUrl`) remains
 * the source of truth when present.
 */
function denApiOriginForDenBaseUrl(input: string | null | undefined): string | null {
  const normalized = normalizeDenBaseUrl(input);
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const hostname = url.hostname.toLowerCase();
    const isExplicitApiHost = hostname === "api" || hostname.startsWith("api.");
    if (!isExplicitApiHost && !isHostedDenHost(hostname)) {
      return null;
    }
    if (!isExplicitApiHost) {
      url.hostname = `api.${hostname}`;
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function resolveDenBaseUrls(input: { baseUrl?: string | null; apiBaseUrl?: string | null } | string | null | undefined): DenBaseUrls {
  const rawBaseUrl = typeof input === "string" ? input : input?.baseUrl;
  const normalizedBaseUrl = normalizeDenBaseUrl(rawBaseUrl);
  const normalizedApiBaseUrl = typeof input === "string" ? null : normalizeDenBaseUrl(input?.apiBaseUrl);
  const gatewayOrigin = getOpenworkGatewayOrigin();

  if (gatewayOrigin) {
    const normalizedGatewayOrigin = normalizeDenBaseUrl(gatewayOrigin) ?? gatewayOrigin;
    const gatewayBaseUrl =
      normalizedBaseUrl && denOriginComparisonKey(normalizedBaseUrl) !== denOriginComparisonKey(normalizedGatewayOrigin)
        ? normalizedBaseUrl
        : DEFAULT_DEN_BASE_URL;
    const baseUrl = stripDenApiBasePath(gatewayBaseUrl) ?? DEFAULT_DEN_BASE_URL;

    return {
      baseUrl,
      apiBaseUrl: ensureDenApiBasePath(normalizedGatewayOrigin) ?? normalizedGatewayOrigin,
    };
  }

  const seedUrl = stripDenApiBasePath(normalizedBaseUrl ?? normalizedApiBaseUrl) ?? DEFAULT_DEN_BASE_URL;
  const baseUrl = stripDenApiBasePath(seedUrl) ?? DEFAULT_DEN_BASE_URL;

  // Build-time API pin (headless/dev web): route API calls through the
  // configured proxy regardless of which web base the caller resolved.
  const buildDenApiBaseUrl = normalizedApiBaseUrl ? null : normalizeDenBaseUrl(readBuildDenApiBaseUrl());
  const deterministicApiBaseUrl = denApiOriginForDenBaseUrl(baseUrl);

  return {
    baseUrl,
    apiBaseUrl: normalizedApiBaseUrl
      ? normalizedApiBaseUrl
      : buildDenApiBaseUrl
        ? ensureDenApiBasePath(buildDenApiBaseUrl) ?? buildDenApiBaseUrl
        : deterministicApiBaseUrl ?? ensureDenApiBasePath(baseUrl) ?? baseUrl,
  };
}

function resolveDenClientBaseUrls(options: { baseUrl: string; apiBaseUrl?: string | null }): DenBaseUrls {
  if (options.apiBaseUrl !== undefined) {
    return resolveDenBaseUrls(options);
  }

  if (isDesktopRuntime() && typeof window.localStorage !== "undefined") {
    const settings = readDenSettings();
    if (denOriginComparisonKey(settings.baseUrl) === denOriginComparisonKey(options.baseUrl)) {
      return resolveDenBaseUrls({
        baseUrl: options.baseUrl,
        apiBaseUrl: settings.apiBaseUrl,
      });
    }
  }

  return resolveDenBaseUrls(options);
}

/** The MCP endpoint served from the resolved Den API base URL. */
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
    const directHostedApiResource = directHostedApiMcpResourceUrl(url);
    if (directHostedApiResource) return directHostedApiResource;
    if (isLegacyWebAppMcpUrl(trimmed)) {
      url.pathname = "/api/den/mcp";
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function resolveDenBootstrapConfig(
  input: {
    baseUrl: string;
    apiBaseUrl?: string | null;
    requireSignin?: boolean | null;
    requireActivation?: boolean | null;
    brandAppName?: string | null;
    brandLogoUrl?: string | null;
    brandIconUrl?: string | null;
    fromFile?: boolean | null;
    source?: DenBootstrapSource | null;
    claimLinks?: DenBootstrapConfig["claimLinks"];
    handoff?: DenBootstrapHandoff | null;
    prepared?: DenBootstrapPrepared | null;
    enterpriseActivation?: DenEnterpriseActivation | null;
  },
): DenBootstrapConfig {
  return {
    ...resolveDenBaseUrls(input),
    source: input.source === "file" || input.fromFile === true ? "file" : "default",
    requireSignin: input.requireSignin === true,
    ...(typeof input.requireActivation === "boolean"
      ? { requireActivation: input.requireActivation }
      : {}),
    ...(input.brandAppName?.trim() ? { brandAppName: input.brandAppName.trim().slice(0, 64) } : {}),
    ...(input.brandLogoUrl?.trim() ? { brandLogoUrl: input.brandLogoUrl.trim() } : {}),
    ...(input.brandIconUrl?.trim() ? { brandIconUrl: input.brandIconUrl.trim() } : {}),
    ...(input.claimLinks ? { claimLinks: input.claimLinks } : {}),
    ...(input.handoff ? { handoff: input.handoff } : {}),
    ...(input.prepared ? { prepared: input.prepared } : {}),
    ...(input.enterpriseActivation ? { enterpriseActivation: input.enterpriseActivation } : {}),
  };
}

function denRuntimeConfigUrl(baseUrl: string): string | null {
  const normalized = normalizeDenBaseUrl(baseUrl);
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    url.pathname = "/api/runtime-config";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function readRuntimeConfigDenApiUrl(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const denApiUrl = typeof payload.denApiUrl === "string" ? payload.denApiUrl.trim() : "";
  return normalizeDenBaseUrl(denApiUrl);
}

async function fetchRuntimeConfigDenApiUrl(baseUrl: string): Promise<string | null> {
  const url = denRuntimeConfigUrl(baseUrl);
  if (!url) return null;

  try {
    const response = await fetchWithTimeout(
      resolveFetch(url),
      url,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "omit",
        cache: "no-store",
      },
      2_000,
    );
    if (!response.ok) return null;
    return readRuntimeConfigDenApiUrl(await response.json());
  } catch {
    return null;
  }
}

async function resolveDenBootstrapConfigWithRuntimeApi(
  input: Parameters<typeof resolveDenBootstrapConfig>[0],
): Promise<DenBootstrapConfig> {
  const resolved = resolveDenBootstrapConfig(input);
  if (!isDesktopRuntime()) {
    return resolved;
  }

  const runtimeApiBaseUrl = await fetchRuntimeConfigDenApiUrl(resolved.baseUrl);
  if (!runtimeApiBaseUrl) {
    return resolved;
  }

  return {
    ...resolved,
    apiBaseUrl: resolveDenBaseUrls({
      baseUrl: resolved.baseUrl,
      apiBaseUrl: runtimeApiBaseUrl,
    }).apiBaseUrl,
  };
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
    requireActivation: previous.requireActivation,
    brandAppName: previous.brandAppName,
    brandLogoUrl: previous.brandLogoUrl,
    brandIconUrl: previous.brandIconUrl,
    source: previous.source,
    claimLinks: previous.claimLinks,
    handoff: previous.handoff,
    prepared: previous.prepared,
    enterpriseActivation: previous.enterpriseActivation,
  });
}

function applyDesktopBootstrapConfig(config: DenBootstrapConfig) {
  desktopBootstrapConfig = config;
  desktopBootstrapResolution = "resolved";
}

function readStoredDenSessionOrigin(): string | null {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") return null;
  return (window.localStorage.getItem(STORAGE_SESSION_ORIGIN) ?? "").trim() || null;
}

function readStoredDenAuthToken(): string | null {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") return null;
  return (window.localStorage.getItem(STORAGE_AUTH_TOKEN) ?? "").trim() || null;
}

/**
 * Adopts a retained session written by builds that predate the session-origin
 * tag. Runs only at authoritative boot-time resolution: an untagged token is
 * bound to the origin the bootstrap actually resolved to, which matches the
 * origin those builds would have used it against.
 */
function adoptUntaggedDenSessionOrigin() {
  if (!isDesktopRuntime() || desktopBootstrapResolution !== "resolved") return;
  if (!readStoredDenAuthToken() || readStoredDenSessionOrigin()) return;
  const origin = denOriginComparisonKey(desktopBootstrapConfig.baseUrl);
  if (!origin) return;
  try {
    window.localStorage.setItem(STORAGE_SESSION_ORIGIN, origin);
  } catch {
    // Storage unavailable: the session stays quarantined instead of adopted.
  }
}

/**
 * The single origin-coherence gate. True when the retained token must be
 * withheld because the enrollment that owns it has not been proven to match
 * the effective Den origin: either the bootstrap is still unresolved (the
 * in-memory fallback is not a real selection) or the resolved origin differs
 * from the origin recorded next to the token.
 */
function shouldWithholdDenCredentials(bootstrapBaseUrl: string): boolean {
  if (!isDesktopRuntime()) return false;
  if (!readStoredDenAuthToken()) return false;

  const sessionOrigin = readStoredDenSessionOrigin();
  const configOrigin = denOriginComparisonKey(bootstrapBaseUrl);
  const withheld = sessionOrigin
    ? sessionOrigin !== configOrigin
    : desktopBootstrapResolution !== "resolved";

  const logKey = withheld
    ? (sessionOrigin ? "origin-mismatch" : "bootstrap-unresolved")
    : null;
  if (logKey !== lastCredentialGateLog) {
    lastCredentialGateLog = logKey;
    if (logKey === "bootstrap-unresolved") {
      console.warn(
        "[den-session] Desktop bootstrap is unresolved; retained Den credentials are quarantined until the control plane origin is proven.",
      );
    } else if (logKey === "origin-mismatch") {
      console.warn(
        "[den-session] Retained Den session belongs to a different control plane origin than the resolved bootstrap; credentials are quarantined.",
      );
    }
  }
  return withheld;
}

export function readDenBootstrapConfig(): DenBootstrapConfig {
  const gatewayOrigin = getOpenworkGatewayOrigin();
  if (gatewayOrigin) {
    if (
      gatewayBootstrapConfig &&
      gatewayBootstrapConfigOrigin === gatewayOrigin &&
      gatewayBootstrapConfigSource === desktopBootstrapConfig
    ) {
      return gatewayBootstrapConfig;
    }

    gatewayBootstrapConfig = {
      ...desktopBootstrapConfig,
      ...resolveDenBaseUrls({
        baseUrl: desktopBootstrapConfig.baseUrl,
        apiBaseUrl: gatewayOrigin,
      }),
    };
    gatewayBootstrapConfigOrigin = gatewayOrigin;
    gatewayBootstrapConfigSource = desktopBootstrapConfig;
    return gatewayBootstrapConfig;
  }

  return desktopBootstrapConfig;
}

export async function initializeDenBootstrapConfig(): Promise<DenBootstrapConfig> {
  const generation = ++desktopBootstrapGeneration;

  if (!isDesktopRuntime()) {
    const gatewayOrigin = getOpenworkGatewayOrigin();
    // Forced env settings (headless/dev runs): stale stored base URLs from
    // earlier sessions must not override the launcher-provided control plane.
    if (readForceEnvDenSettings() && typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(STORAGE_BASE_URL);
      } catch {
        // Storage unavailable: nothing stale to clear.
      }
    }
    desktopBootstrapConfig = resolveDenBootstrapConfig({
      baseUrl: BUILD_DEN_BASE_URL,
      ...(gatewayOrigin ? { apiBaseUrl: gatewayOrigin } : {}),
      requireSignin: BUILD_DEN_REQUIRE_SIGNIN,
    });
    desktopBootstrapResolution = "resolved";
    return desktopBootstrapConfig;
  }

  const initialBootstrap = readInitialDesktopBootstrapConfig();
  if (initialBootstrap) {
    const resolved = await resolveDenBootstrapConfigWithRuntimeApi(initialBootstrap);
    if (generation !== desktopBootstrapGeneration) return readDenBootstrapConfig();
    applyDesktopBootstrapConfig(resolved);
    adoptUntaggedDenSessionOrigin();
    return desktopBootstrapConfig;
  }

  // The shell IPC bridge can be momentarily unavailable at first paint;
  // retry briefly before giving up so a boot race does not poison the
  // session with build defaults.
  const SHELL_BOOTSTRAP_ATTEMPTS = 3;
  const SHELL_BOOTSTRAP_RETRY_DELAY_MS = 350;
  for (let attempt = 1; attempt <= SHELL_BOOTSTRAP_ATTEMPTS; attempt += 1) {
    try {
      const bootstrap = await getDesktopBootstrapConfigFromShell();
      const resolved = await resolveDenBootstrapConfigWithRuntimeApi(bootstrap);
      if (generation !== desktopBootstrapGeneration) return readDenBootstrapConfig();
      applyDesktopBootstrapConfig(resolved);
      adoptUntaggedDenSessionOrigin();
      return desktopBootstrapConfig;
    } catch (error) {
      console.error("[den-bootstrap] shell read failed", attempt, error);
      if (generation !== desktopBootstrapGeneration) return readDenBootstrapConfig();
      if (attempt < SHELL_BOOTSTRAP_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, SHELL_BOOTSTRAP_RETRY_DELAY_MS));
      }
    }
  }

  if (generation !== desktopBootstrapGeneration) return readDenBootstrapConfig();

  // All quick attempts failed. Keep build defaults in memory only — do NOT
  // sync them to localStorage: previously synced values from a successful
  // boot are more trustworthy than build defaults, and clobbering them
  // silently reverted custom/self-hosted control planes to the production
  // URL until a manual reload. The snapshot stays `unresolved`: it is a
  // recovery placeholder, not a real hosted selection, so retained
  // credentials remain quarantined until an authoritative read succeeds.
  desktopBootstrapConfig = resolveDenBootstrapConfig({
    baseUrl: HOSTED_DEFAULT_DEN_BASE_URL,
    requireSignin: BUILD_DEN_REQUIRE_SIGNIN,
  });
  desktopBootstrapResolution = "unresolved";
  console.warn(
    "[den-bootstrap] Shell bootstrap is unavailable; using an in-memory placeholder and withholding Den credentials until the real config is read.",
  );

  // Heal in the background without blocking boot: once the bridge comes up,
  // apply the real shell config and notify listeners. Results from an
  // obsolete startup generation are discarded.
  void (async () => {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      if (generation !== desktopBootstrapGeneration) return;
      try {
        const bootstrap = await getDesktopBootstrapConfigFromShell();
        const resolved = await resolveDenBootstrapConfigWithRuntimeApi(bootstrap);
        if (generation !== desktopBootstrapGeneration) return;
        applyDesktopBootstrapConfig(resolved);
        adoptUntaggedDenSessionOrigin();
        dispatchDenSettingsChanged({ settings: readDenSettings() });
        return;
      } catch {
        // Bridge still unavailable — keep trying.
      }
    }
  })();

  return desktopBootstrapConfig;
}

/**
 * Re-reads desktop-bootstrap.json from the shell and applies it to the cached
 * snapshot, notifying listeners. Used after the shell itself persisted a new
 * config (e.g. an accepted connect link) so the renderer converges without a
 * reload.
 */
export async function refreshDenBootstrapConfigFromShell(): Promise<DenBootstrapConfig> {
  if (isDesktopRuntime()) {
    const generation = ++desktopBootstrapGeneration;
    try {
      const bootstrap = await getDesktopBootstrapConfigFromShell();
      const resolved = await resolveDenBootstrapConfigWithRuntimeApi(bootstrap);
      if (generation === desktopBootstrapGeneration) {
        applyDesktopBootstrapConfig(resolved);
        adoptUntaggedDenSessionOrigin();
        dispatchDenSettingsChanged({ settings: readDenSettings() });
      }
    } catch {
      // Bridge hiccup — keep the current cached snapshot.
    }
  }
  return readDenBootstrapConfig();
}

export async function setDenBootstrapConfig(
  next: ShellDesktopBootstrapConfig,
  options?: { dispatchSettingsChanged?: boolean },
): Promise<DenBootstrapConfig> {
  const previous = readDenBootstrapConfig();
  const normalized = await resolveDenBootstrapConfigWithRuntimeApi({
    ...next,
    enterpriseActivation: next.enterpriseActivation ?? previous.enterpriseActivation,
  });

  if (isDesktopRuntime()) {
    // An explicit persist is a new authoritative bootstrap: retire any
    // in-flight startup resolution so a late read cannot replace it.
    desktopBootstrapGeneration += 1;
    const persisted = await setDesktopBootstrapConfigInShell({
      baseUrl: normalized.baseUrl,
      apiBaseUrl: normalized.apiBaseUrl,
      requireSignin: normalized.requireSignin,
      ...(typeof normalized.requireActivation === "boolean"
        ? { requireActivation: normalized.requireActivation }
        : {}),
      ...(normalized.brandAppName ? { brandAppName: normalized.brandAppName } : {}),
      ...(normalized.brandLogoUrl ? { brandLogoUrl: normalized.brandLogoUrl } : {}),
      ...(normalized.brandIconUrl ? { brandIconUrl: normalized.brandIconUrl } : {}),
      ...(normalized.handoff ? { handoff: normalized.handoff } : {}),
      ...(normalized.prepared ? { prepared: normalized.prepared } : {}),
      ...(normalized.enterpriseActivation ? { enterpriseActivation: normalized.enterpriseActivation } : {}),
    });
    
    applyDesktopBootstrapConfig(await resolveDenBootstrapConfigWithRuntimeApi({ ...persisted, source: "file" }));
  } else {
    applyDesktopBootstrapConfig(normalized);
  }

  if (options?.dispatchSettingsChanged !== false) {
    dispatchDenSettingsChanged({
      settings: readDenSettings(),
    });
  }

  return readDenBootstrapConfig();
}

/**
 * Hosted Den only approves Cloud web handoff return URLs that are HTTPS
 * gateway / signed-preview origins. Loopback and plain HTTP (local headless
 * web) can never be approved, so those clients must use the desktop handoff
 * (copy link / paste grant) instead of webAuth auto-return.
 */
function canUseCloudWebAuthReturn(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.trim().toLowerCase();
    if (
      host === "localhost"
      || host === "0.0.0.0"
      || host === "::1"
      || host === "[::1]"
      || /^127(?:\.\d{1,3}){3}$/.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function buildDenAuthUrl(baseUrl: string, mode: "sign-in" | "sign-up"): string {
  const target = new URL(resolveDenBaseUrls(baseUrl).baseUrl);
  target.searchParams.set("mode", mode);
  const webReturnOrigin =
    isWebDeployment() && typeof window !== "undefined" ? window.location.origin : null;
  if (
    isDesktopDeployment()
    || (webReturnOrigin !== null && !canUseCloudWebAuthReturn(webReturnOrigin))
  ) {
    // Desktop app, or local/dev web that cannot receive an approved webAuth
    // redirect: Den shows the copyable openwork:// / grant handoff instead.
    target.searchParams.set("desktopAuth", "1");
    target.searchParams.set("desktopScheme", "openwork");
  } else if (webReturnOrigin !== null) {
    target.searchParams.set("webAuth", "1");
    target.searchParams.set("webAuthReturn", webReturnOrigin);
  }
  return target.toString();
}

function resolveRequestBaseUrl(baseUrls: DenBaseUrls, path: string): string {
  if (isDesktopRuntime() && path.startsWith("/api/auth/")) {
    return baseUrls.apiBaseUrl;
  }
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

  const bootstrapConfig = readDenBootstrapConfig();
  const baseUrls = resolveDenBaseUrls(
    isDesktopRuntime() || getOpenworkGatewayOrigin()
      ? bootstrapConfig
      : { baseUrl: window.localStorage.getItem(STORAGE_BASE_URL) ?? bootstrapConfig.baseUrl },
  );

  // Origin coherence: the retained token and organization are only usable
  // together with the origin that issued them. While the bootstrap is
  // unresolved, or when it resolved to a different control plane, the
  // retained session stays quarantined in storage — visible to no caller, so
  // no credential-bearing request can mix origins.
  if (shouldWithholdDenCredentials(bootstrapConfig.baseUrl)) {
    return {
      ...baseUrls,
      authToken: null,
      activeOrgId: null,
      activeOrgSlug: null,
      activeOrgName: null,
    };
  }

  return {
    ...baseUrls,
    authToken: (window.localStorage.getItem(STORAGE_AUTH_TOKEN) ?? "").trim() || null,
    activeOrgId: (window.localStorage.getItem(STORAGE_ACTIVE_ORG_ID) ?? "").trim() || null,
    activeOrgSlug: (window.localStorage.getItem(STORAGE_ACTIVE_ORG_SLUG) ?? "").trim() || null,
    activeOrgName: (window.localStorage.getItem(STORAGE_ACTIVE_ORG_NAME) ?? "").trim() || null,
  };
}

export function getDenDesktopConfigCacheKey(): string {
  const settings = readDenSettings();
  const baseUrl = settings.baseUrl.trim();
  const activeOrgId = settings.activeOrgId?.trim() ?? "";
  if (!baseUrl) return "";
  return `${DESKTOP_CONFIG_CACHE_PREFIX}${baseUrl}::${activeOrgId}`;
}

export function readCachedDenDesktopConfig(key: string): DenDesktopConfig | null {
  if (typeof window === "undefined" || !key) return null;

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return normalizeDenDesktopConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeCachedDenDesktopConfig(key: string, config: DenDesktopConfig) {
  if (typeof window === "undefined" || !key) return;
  try {
    window.localStorage.setItem(
      key,
      JSON.stringify(normalizeDenDesktopConfig(config)),
    );
  } catch {
    // Quota / private-browsing failures are non-fatal — we just miss the cache next boot.
  }
}

export function seedDenDesktopConfigConnectPolicy(input: {
  organizationId: string;
  connectEnabled: boolean | null;
}): boolean {
  if (input.connectEnabled === null) return false;

  const organizationId = input.organizationId.trim();
  const activeOrgId = readDenSettings().activeOrgId?.trim() ?? "";
  if (!organizationId || activeOrgId !== organizationId) return false;

  const key = getDenDesktopConfigCacheKey();
  const cached = readCachedDenDesktopConfig(key) ?? {};
  writeCachedDenDesktopConfig(key, { ...cached, connectEnabled: input.connectEnabled });
  return true;
}

function mergePassiveDenField(
  current: string | null | undefined,
  next: string | null | undefined,
): string | null {
  const trimmed = next?.trim() ?? "";
  return trimmed || current || null;
}

/**
 * Merge an in-memory den-session snapshot over the persisted settings for the
 * PASSIVE state->storage mirror. A passive sync must never delete persisted
 * credentials just because in-memory state has not (or could not) load them —
 * e.g. while the control plane is unreachable the org list never loads, and
 * mirroring `activeOrg: null` used to erase the stored org (and, after a
 * remount race, the auth token), permanently signing the user out on a
 * transient VPN/network outage. Explicit sign-out/change-server flows clear
 * storage through clearDenSession()/saveControlPlaneUrl() instead.
 */
export function mergePassiveDenSettings(current: DenSettings, next: DenSettings): DenSettings {
  return {
    ...resolveDenBaseUrls(next),
    authToken: mergePassiveDenField(current.authToken, next.authToken),
    activeOrgId: mergePassiveDenField(current.activeOrgId, next.activeOrgId),
    activeOrgSlug: mergePassiveDenField(current.activeOrgSlug, next.activeOrgSlug),
    activeOrgName: mergePassiveDenField(current.activeOrgName, next.activeOrgName),
  };
}

function warnOnUnexpectedActiveOrgDrop(input: {
  previousActiveOrgId: string | null | undefined;
  nextActiveOrgId: string | null | undefined;
  intentionalActiveOrgClear?: boolean;
}) {
  if (!import.meta.env.DEV || typeof window === "undefined" || input.intentionalActiveOrgClear) {
    return;
  }

  const previousActiveOrgId = input.previousActiveOrgId?.trim() ?? "";
  const nextActiveOrgId = input.nextActiveOrgId?.trim() ?? "";
  if (!previousActiveOrgId || nextActiveOrgId) return;

  const message = `[den-settings] activeOrgId dropped unexpectedly from ${previousActiveOrgId}`;
  const stack = new Error(message).stack ?? message;
  try {
    window.__openworkOrgDropWarnings ??= [];
    window.__openworkOrgDropWarnings.push(stack);
    console.warn(stack);
  } catch {
    // Diagnostics must never block the settings write they observe.
  }
}

export function writeDenSettings(
  next: DenSettings,
  options?: { persistBootstrap?: boolean; intentionalActiveOrgClear?: boolean },
) {
  if (typeof window === "undefined") {
    return;
  }

  const pendingBootstrap = getPendingBootstrapConfig(next);
  const previous = readDenSettings();
  const resolved = resolveDenBaseUrls(next);
  const baseUrl = resolved.baseUrl;
  const apiBaseUrl = resolved.apiBaseUrl;
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

  warnOnUnexpectedActiveOrgDrop({
    previousActiveOrgId: previous.activeOrgId,
    nextActiveOrgId: activeOrgId,
    intentionalActiveOrgClear: options?.intentionalActiveOrgClear,
  });

  // Quarantined credentials are invisible to callers, so a caller writing an
  // empty session cannot have meant to delete them. Preserve the stored
  // session untouched; explicit sign-out and server changes go through
  // clearDenSession(), which deletes storage directly.
  const preserveQuarantinedSession =
    !authToken
    && readStoredDenAuthToken() !== null
    && shouldWithholdDenCredentials(readDenBootstrapConfig().baseUrl);

  if (isDesktopRuntime()) {
    window.localStorage.removeItem(STORAGE_BASE_URL);
  } else {
    window.localStorage.setItem(STORAGE_BASE_URL, baseUrl);
  }
  window.localStorage.removeItem(LEGACY_STORAGE_API_BASE_URL);
  if (previous.baseUrl !== baseUrl || (previous.authToken ?? "") !== authToken) {
    window.localStorage.removeItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY);
  }
  if (!preserveQuarantinedSession) {
    if (authToken) {
      window.localStorage.setItem(STORAGE_AUTH_TOKEN, authToken);
      // Record which control plane issued this token so later boots can prove
      // origin coherence before using it.
      const sessionOrigin = denOriginComparisonKey(baseUrl);
      if (sessionOrigin) {
        window.localStorage.setItem(STORAGE_SESSION_ORIGIN, sessionOrigin);
      } else {
        window.localStorage.removeItem(STORAGE_SESSION_ORIGIN);
      }
    } else {
      window.localStorage.removeItem(STORAGE_AUTH_TOKEN);
      window.localStorage.removeItem(STORAGE_SESSION_ORIGIN);
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

  if (options?.persistBootstrap !== false && pendingBootstrap) {
    const currentBootstrap = readDenBootstrapConfig();
    if (
      pendingBootstrap.baseUrl !== currentBootstrap.baseUrl
    ) {
      void setDenBootstrapConfig({
        baseUrl: pendingBootstrap.baseUrl,
        apiBaseUrl: pendingBootstrap.apiBaseUrl,
        requireSignin: currentBootstrap.requireSignin,
        requireActivation: currentBootstrap.requireActivation,
        brandAppName: currentBootstrap.brandAppName,
        brandLogoUrl: currentBootstrap.brandLogoUrl,
        brandIconUrl: currentBootstrap.brandIconUrl,
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

  if (import.meta.env.DEV) {
    warnOnUnexpectedActiveOrgDrop({
      previousActiveOrgId: readDenSettings().activeOrgId,
      nextActiveOrgId: null,
      intentionalActiveOrgClear: true,
    });
  }

  if (options?.includeBaseUrls) {
    window.localStorage.removeItem(STORAGE_BASE_URL);
    window.localStorage.removeItem(LEGACY_STORAGE_API_BASE_URL);
  }

  window.localStorage.removeItem(STORAGE_AUTH_TOKEN);
  window.localStorage.removeItem(STORAGE_SESSION_ORIGIN);
  window.localStorage.removeItem(STORAGE_ACTIVE_ORG_ID);
  window.localStorage.removeItem(STORAGE_ACTIVE_ORG_SLUG);
  window.localStorage.removeItem(STORAGE_ACTIVE_ORG_NAME);
  window.localStorage.removeItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY);
  // Cached MCP results can contain member data. Clear every user/org
  // namespace so another account using this browser profile cannot recover it.
  clearDashboardTileCacheStorage(window.localStorage);
  // Sign-out resets any in-flight sign-in intent and pending org choice so a
  // later handoff starts from a clean slate.
  clearDesktopSignInIntent();
  clearOrgSelectionPending();

  dispatchDenSettingsChanged({
    settings: readDenSettings(),
  });
  dispatchDenSessionUpdated({
    status: "signed_out",
    baseUrl: readDenSettings().baseUrl,
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

  if (payload.error === "password_too_weak" && isRecord(payload.feedback)) {
    const feedback = payload.feedback;
    const messages = [
      typeof feedback.warning === "string" ? feedback.warning.trim() : "",
      ...(Array.isArray(feedback.suggestions) ? feedback.suggestions : [])
        .filter((suggestion): suggestion is string => typeof suggestion === "string" && suggestion.trim().length > 0)
        .map((suggestion) => suggestion.trim()),
    ].filter((message) => message.length > 0);

    if (messages.length > 0) {
      return messages.join("\n");
    }
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

function getExchangeOrganization(payload: unknown): DenDesktopHandoffExchangeOrganization | null {
  if (!isRecord(payload) || !isRecord(payload.organization)) {
    return null;
  }

  const organization = payload.organization;
  const id = typeof organization.id === "string" ? organization.id.trim() : "";
  if (!id) {
    return null;
  }

  return {
    id,
    slug: typeof organization.slug === "string" && organization.slug.trim() ? organization.slug.trim() : null,
    name: typeof organization.name === "string" && organization.name.trim() ? organization.name.trim() : null,
  };
}

function getExchangeConnectEnabled(payload: unknown): boolean | null {
  if (!isRecord(payload) || typeof payload.connectEnabled !== "boolean") {
    return null;
  }
  return payload.connectEnabled;
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
      typeof entry.role !== "string" ||
      !entry.role.trim()
    ) {
      return [];
    }

    return [
      {
        id: entry.id,
        name: entry.name,
        slug: entry.slug,
        role: entry.role.trim(),
      } satisfies DenOrgSummary,
    ];
  });
}

function getDashboardElement(entry: unknown): DenDashboardElement | null {
  if (!isRecord(entry)) return null;
  if (
    typeof entry.serverName !== "string"
    || typeof entry.toolName !== "string"
    || typeof entry.projectedToolName !== "string"
    || typeof entry.resourceUri !== "string"
    || typeof entry.title !== "string"
  ) {
    return null;
  }
  return {
    serverName: entry.serverName,
    ...(typeof entry.connectionId === "string" ? { connectionId: entry.connectionId } : {}),
    toolName: entry.toolName,
    projectedToolName: entry.projectedToolName,
    resourceUri: entry.resourceUri,
    title: entry.title,
    ...(isRecord(entry.launchArguments) ? { launchArguments: entry.launchArguments } : {}),
    ...(entry.requiresApproval === true ? { requiresApproval: true } : {}),
    ...(entry.organizationAutoLaunch === true ? { organizationAutoLaunch: true } : {}),
  };
}

function getGrantedDashboards(payload: unknown): DenGrantedDashboard[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return [];
  }

  return payload.items.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string") return [];
    const elements = Array.isArray(entry.elements)
      ? entry.elements.flatMap((element) => {
          const parsed = getDashboardElement(element);
          return parsed ? [parsed] : [];
        })
      : [];
    return [
      {
        id: entry.id,
        name: entry.name,
        elements,
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null,
      } satisfies DenGrantedDashboard,
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

function getMemoryContexts(value: unknown): DenMemoryContext[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.snippet !== "string") return [];
    return [
      {
        id: entry.id,
        snippet: entry.snippet,
        citation: isRecord(entry.citation) ? entry.citation : null,
        origin: typeof entry.origin === "string" ? entry.origin : null,
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : "",
      } satisfies DenMemoryContext,
    ];
  });
}

function getMemories(payload: unknown): DenMemory[] {
  if (!isRecord(payload) || !Array.isArray(payload.memories)) {
    return [];
  }
  return payload.memories.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.content !== "string") {
      return [];
    }
    return [
      {
        id: entry.id,
        content: entry.content,
        tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : null,
        source: typeof entry.source === "string" ? entry.source : "",
        scope: typeof entry.scope === "string" ? entry.scope : "user",
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : "",
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
        contexts: getMemoryContexts(entry.contexts),
      } satisfies DenMemory,
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

function parseCloudInstance(payload: unknown): DenCloudInstance | null {
  if (
    !isRecord(payload) ||
    (payload.status !== "provisioning" && payload.status !== "waking" && payload.status !== "ready" && payload.status !== "failed") ||
    (typeof payload.url !== "string" && payload.url !== null)
  ) {
    return null;
  }

  const failurePayload = isRecord(payload.failure) ? payload.failure : null;
  const failureStage = failurePayload?.stage;
  const failureCode = typeof failurePayload?.code === "string" ? failurePayload.code.trim() : "";
  const failureReference = typeof failurePayload?.reference === "string" ? failurePayload.reference.trim() : "";
  const failureOccurredAt = typeof failurePayload?.occurredAt === "string" ? failurePayload.occurredAt : "";
  const failure: DenCloudStartupFailure | null = failurePayload
    && failureCode
    && (failureStage === "provisioning" || failureStage === "recovery" || failureStage === "runtime")
    && failureReference
    && Number.isFinite(Date.parse(failureOccurredAt))
    ? {
        code: failureCode,
        stage: failureStage,
        reference: failureReference,
        occurredAt: failureOccurredAt,
      }
    : null;

  return {
    status: payload.status,
    url: payload.url,
    imageVersion: typeof payload.imageVersion === "string" ? payload.imageVersion : null,
    ...(typeof payload.instanceName === "string" ? { instanceName: payload.instanceName } : {}),
    latestVersion: typeof payload.latestVersion === "string" ? payload.latestVersion : null,
    ...(failure ? { failure } : {}),
  };
}

function parseCloudInstanceUpdateResult(payload: unknown): DenCloudInstanceUpdateResult | null {
  if (!isRecord(payload) || typeof payload.ok !== "boolean") {
    return null;
  }

  if (payload.ok === true && payload.status === "update_requested") {
    return { ok: true, status: "update_requested" };
  }

  if (payload.ok === false && (payload.error === "already_current" || payload.error === "flush_failed")) {
    return { ok: false, error: payload.error };
  }

  return null;
}

export function parseDenMcpToken(payload: unknown): DenMcpToken | null {
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
    ...(typeof payload.appHostToken === "string" && typeof payload.appHostExpiresAt === "string"
      ? { appHostToken: payload.appHostToken, appHostExpiresAt: payload.appHostExpiresAt }
      : {}),
  };
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

function parseDenExternalMcpConnection(value: unknown): DenExternalMcpConnection | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.url !== "string" ||
    (value.authType !== "oauth" && value.authType !== "apikey" && value.authType !== "none") ||
    (value.credentialMode !== "shared" && value.credentialMode !== "per_member")
  ) {
    return null;
  }

  return {
    id: value.id,
    name: value.name,
    url: value.url,
    authType: value.authType,
    credentialMode: value.credentialMode,
    connected: value.connected === true,
    connectedAt: typeof value.connectedAt === "string" ? value.connectedAt : null,
    connectedForMe: value.connectedForMe === true,
    ...(typeof value.needsReconnect === "boolean" ? { needsReconnect: value.needsReconnect } : {}),
    ...(typeof value.issuerReviewRequired === "boolean" ? { issuerReviewRequired: value.issuerReviewRequired } : {}),
    ...(value.reconnectActionOwner === "member" || value.reconnectActionOwner === "organization_admin" || value.reconnectActionOwner === null
      ? { reconnectActionOwner: value.reconnectActionOwner }
      : {}),
    ...(Array.isArray(value.missingFeatures) ? { missingFeatures: readStringArray(value.missingFeatures) } : {}),
    ...(typeof value.externalAccountId === "string" || value.externalAccountId === null ? { externalAccountId: value.externalAccountId } : {}),
    ...(Array.isArray(value.grantedScopes) ? { grantedScopes: readStringArray(value.grantedScopes) } : {}),
    ...(typeof value.tenantId === "string" || value.tenantId === null ? { tenantId: value.tenantId } : {}),
    ...(typeof value.nativeProviderKey === "string" || value.nativeProviderKey === null ? { nativeProviderKey: value.nativeProviderKey } : {}),
  };
}

function getDenExternalMcpConnections(payload: unknown): DenExternalMcpConnection[] {
  if (!isRecord(payload) || !Array.isArray(payload.connections)) {
    return [];
  }

  return payload.connections.flatMap((connection) => {
    const parsed = parseDenExternalMcpConnection(connection);
    return parsed ? [parsed] : [];
  });
}

function parseDenExternalMcpPreset(value: unknown): DenExternalMcpPreset | null {
  if (
    !isRecord(value) ||
    typeof value.presetId !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.description !== "string" ||
    typeof value.url !== "string" ||
    (value.authType !== "oauth" && value.authType !== "apikey" && value.authType !== "none")
  ) {
    return null;
  }

  return {
    presetId: value.presetId,
    displayName: value.displayName,
    description: value.description,
    url: value.url,
    authType: value.authType,
  };
}

function getDenExternalMcpPresets(payload: unknown): DenExternalMcpPreset[] {
  if (!isRecord(payload) || !Array.isArray(payload.presets)) {
    return [];
  }

  return payload.presets.flatMap((preset) => {
    const parsed = parseDenExternalMcpPreset(preset);
    return parsed ? [parsed] : [];
  });
}

function getDenMcpConnectionConnectStart(payload: unknown): DenMcpConnectionConnectStart | null {
  if (
    !isRecord(payload) ||
    (payload.status !== "connected" && payload.status !== "needs_auth")
  ) {
    return null;
  }

  return {
    status: payload.status,
    authorizeUrl: typeof payload.authorizeUrl === "string" ? payload.authorizeUrl : null,
  };
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
    apiKeys: parseApiKeysRecord(payload.llmProvider.apiKeys),
  };
}

function parseApiKeysRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) {
    return null;
  }

  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1].trim().length > 0,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function parsePluginConfigObjectType(value: unknown): DenPluginConfigObjectType | null {
  if (value === "script") return "workflow";
  return value === "skill" || value === "agent" || value === "command" || value === "tool" ||
    value === "mcp" || value === "hook" || value === "context" || value === "custom" || value === "workflow"
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
    case "agent-plugin":
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

function parsePluginCloudReadinessState(value: unknown): DenPluginCloudReadinessState | null {
  switch (value) {
    case "ready":
    case "needs_signin":
    case "needs_admin_setup":
    case "desktop_only":
    case "not_synced":
      return value;
    default:
      return null;
  }
}

function parsePluginCloudReadinessConnection(value: unknown): DenPluginCloudReadinessConnection | null {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.url !== "string") return null;
  if (value.id !== null && typeof value.id !== "string") return null;
  const credentialMode = value.credentialMode === "shared" || value.credentialMode === "per_member"
    ? value.credentialMode
    : undefined;
  return {
    id: value.id,
    name: value.name,
    url: value.url,
    ...(typeof value.configObjectId === "string" ? { configObjectId: value.configObjectId } : {}),
    ...(typeof value.serverName === "string" ? { serverName: value.serverName } : {}),
    ...(credentialMode ? { credentialMode } : {}),
    ...(typeof value.connectedForMe === "boolean" ? { connectedForMe: value.connectedForMe } : {}),
  };
}

function parsePluginCloudReadiness(value: unknown): DenPluginCloudReadiness | null {
  if (!isRecord(value) || typeof value.hasInstructional !== "boolean" || !Array.isArray(value.connections)) return null;
  const state = parsePluginCloudReadinessState(value.state);
  if (!state) return null;
  return {
    state,
    hasInstructional: value.hasInstructional,
    connections: value.connections.flatMap((entry) => {
      const connection = parsePluginCloudReadinessConnection(entry);
      return connection ? [connection] : [];
    }),
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
    ...(value.cloudReadiness === undefined ? {} : { cloudReadiness: parsePluginCloudReadiness(value.cloudReadiness) ?? undefined }),
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

function getAssignedMarketplaceCapabilities(payload: unknown): DenAssignedMarketplaceCapability[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return [];
  return payload.items.flatMap((item) => {
    if (
      !isRecord(item)
      || typeof item.configObjectId !== "string"
      || (item.marketplaceId !== null && typeof item.marketplaceId !== "string")
      || typeof item.objectType !== "string"
      || typeof item.pluginId !== "string"
    ) {
      return [];
    }
    const objectType = parsePluginConfigObjectType(item.objectType);
    return objectType ? [{
      configObjectId: item.configObjectId,
      marketplaceId: item.marketplaceId,
      objectType,
      pluginId: item.pluginId,
    }] : [];
  });
}

function getMeLibraryPlugins(payload: unknown): DenMeLibraryPlugin[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return [];
  return payload.items.flatMap((item) => {
    if (!isRecord(item) || item.type !== "plugin" || typeof item.id !== "string" || typeof item.name !== "string") {
      return [];
    }
    return [{
      id: item.id,
      name: item.name,
      description: typeof item.description === "string" ? item.description : null,
    }];
  });
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
      ? billing.invoices.flatMap((item) => {
          const invoice = getBillingInvoice(item);
          return invoice ? [invoice] : [];
        })
      : [],
    productId: typeof billing.productId === "string" ? billing.productId : null,
    benefitId: typeof billing.benefitId === "string" ? billing.benefitId : null,
  };
}

export function parseDenOpenWorkWebAccess(payload: unknown): DenOpenWorkWebAccess | null {
  if (!isRecord(payload) || !isRecord(payload.billing)) return null;
  const stripe = payload.billing.stripe;
  if (!isRecord(stripe) || !isRecord(stripe.web)) return null;

  const web = stripe.web;
  const accessSource: DenOpenWorkWebAccessSource | undefined =
    web.accessSource === "subscription" || web.accessSource === "complimentary"
      ? web.accessSource
      : web.accessSource === null
        ? null
        : undefined;
  if (
    typeof web.hasAccess !== "boolean"
    || accessSource === undefined
    || web.hasAccess !== (accessSource !== null)
    || (accessSource === "subscription" && web.hasEligibleSubscription !== true)
    || (accessSource === "complimentary" && web.complimentaryAccess !== true)
  ) {
    return null;
  }

  return {
    hasAccess: web.hasAccess,
    accessSource,
  };
}

// Den requests target a control plane that does not answer CORS preflights.
// On desktop, route cross-origin Den calls (including a Den API on a different
// loopback port than the renderer) through the Electron main process so the
// renderer never issues a blocked preflight. Same-origin requests can use the
// renderer's own fetch.
const resolveFetch = (url: string): FetchLike => {
  if (!isDesktopRuntime()) return globalThis.fetch;
  try {
    if (typeof window !== "undefined" && new URL(url).origin === window.location.origin) {
      return desktopFetch;
    }
  } catch {
    // fall through to the main-process proxy on unparseable URLs
  }
  return (input, init) => desktopFetchViaMain(input, init);
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type DenRequestOptions = {
  method?: string;
  token?: string | null;
  body?: unknown;
  timeoutMs?: number;
  organizationId?: string | null;
  automationModelAttentionCapable?: boolean;
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
    headers[ORG_SCOPE_HEADER] = organizationId;
    headers[ORG_PROXY_HEADER] = organizationId;
  }
  if (options.automationModelAttentionCapable) {
    headers[AUTOMATION_MODEL_ATTENTION_CAPABILITY_HEADER] = AUTOMATION_MODEL_ATTENTION_CAPABILITY;
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetchWithTimeout(
    resolveFetch(url),
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
  const baseUrls = resolveDenClientBaseUrls(options);
  const token = options.token?.trim() ?? null;

  return {
    /** The resolved web base URL and API base URL. */
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

    /**
     * @deprecated Desktop email/password signup is no longer supported directly.
     * Open the Den browser signup flow with `buildDenAuthUrl(baseUrl, "sign-up")`
     * so password-strength feedback and invite handling stay server-compatible.
     */
    async signUpEmail(_email: string, _password: string): Promise<DenAuthResult> {
      throw new DenApiError(
        410,
        "desktop_signup_deprecated",
        "Create your account in the browser to choose a secure password.",
      );
    },

    async signOut() {
      await requestJson<unknown>(baseUrls, "/api/auth/sign-out", {
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

    async getDesktopConfig(orgId?: string | null): Promise<DenDesktopConfig> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/me/desktop-config", {
        method: "GET",
        token,
        organizationId: orgId,
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
      return {
        user: getUser(payload),
        token: getToken(payload),
        organization: getExchangeOrganization(payload),
        connectEnabled: getExchangeConnectEnabled(payload),
      };
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

    /** Organization-managed dashboards granted to the signed-in member. */
    async listGrantedDashboards(orgId: string): Promise<DenGrantedDashboard[]> {
      const context = await requestJson<unknown>(baseUrls, "/v1/org", {
        method: "GET",
        token,
        organizationId: orgId,
      });
      const capabilities = isRecord(context) && isRecord(context.capabilities)
        ? context.capabilities
        : null;
      // Missing means unsupported. This makes a newer Desktop safe against a
      // Den deployment that predates the managed-dashboard API.
      if (capabilities?.orgManagedDashboards !== true) return [];

      const payload = await requestJson<unknown>(baseUrls, "/v1/me/dashboards", {
        method: "GET",
        token,
        organizationId: orgId,
      });
      return getGrantedDashboards(payload);
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

    async listMemory(orgId: string): Promise<DenMemory[]> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/memory", {
        method: "GET",
        token,
        organizationId: orgId,
      });
      return getMemories(payload);
    },

    async deleteMemory(orgId: string, memoryId: string): Promise<void> {
      const result = await requestJsonRaw<unknown>(baseUrls, `/v1/memory/${encodeURIComponent(memoryId)}`, {
        method: "DELETE",
        token,
        organizationId: orgId,
      });
      // 404 means the memory is already gone (or not owned) — idempotent from the caller's view.
      if (!result.ok && result.status !== 404) {
        const payload = result.json;
        const code = isRecord(payload) && typeof payload.error === "string" ? payload.error : "request_failed";
        throw new DenApiError(result.status, code, getErrorMessage(payload, `Delete failed with ${result.status}.`));
      }
    },

    async mintMcpToken(orgId: string): Promise<DenMcpToken> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/mcp/token", {
        method: "POST",
        token,
        organizationId: orgId,
        body: { scopes: ["mcp:read", "mcp:write"] },
      });
      const minted = parseDenMcpToken(payload);
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

    async getCloudInstance(orgId: string): Promise<DenCloudInstance> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/cloud/instance", {
        method: "GET",
        token,
        organizationId: orgId,
      });
      const instance = parseCloudInstance(payload);
      if (!instance) {
        throw new DenApiError(500, "invalid_cloud_instance_payload", "Cloud instance response was invalid.");
      }
      return instance;
    },

    async retryCloudInstance(orgId: string): Promise<DenCloudInstance> {
      let payload: unknown;
      try {
        payload = await requestJson<unknown>(baseUrls, "/v1/cloud/instance/retry", {
          method: "POST",
          token,
          organizationId: orgId,
          body: {},
        });
      } catch (error) {
        // Desktop releases can reach a Den that predates explicit recovery.
        // Fall back to the established status request so the Retry action stays
        // safe during staggered rollouts; newer Dens still bypass the cooldown.
        if (!(error instanceof DenApiError) || error.status !== 404) throw error;
        payload = await requestJson<unknown>(baseUrls, "/v1/cloud/instance", {
          method: "GET",
          token,
          organizationId: orgId,
        });
      }
      const instance = parseCloudInstance(payload);
      if (!instance) {
        throw new DenApiError(500, "invalid_cloud_instance_payload", "Cloud retry response was invalid.");
      }
      return instance;
    },

    async getOpenWorkWebAccess(orgId: string): Promise<DenOpenWorkWebAccess> {
      const context = await requestJson<unknown>(baseUrls, "/v1/org", {
        method: "GET",
        token,
        organizationId: orgId,
      });
      const capabilities = isRecord(context) && isRecord(context.capabilities)
        ? context.capabilities
        : null;
      // Missing means unsupported. This follows the established Den capability
      // negotiation pattern so a newer hosted client never calls the Web billing
      // route on an older Den deployment that does not advertise the contract.
      if (capabilities?.openworkWeb !== true) {
        return { hasAccess: false, accessSource: null };
      }

      const payload = await requestJson<unknown>(baseUrls, "/v1/billing/web", {
        method: "GET",
        token,
        organizationId: orgId,
      });
      const access = parseDenOpenWorkWebAccess(payload);
      if (!access) {
        throw new DenApiError(500, "invalid_openwork_web_access_payload", "OpenWork Web access response was invalid.");
      }
      return access;
    },

    async updateCloudInstance(orgId: string): Promise<DenCloudInstanceUpdateResult> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/cloud/instance/update", {
        method: "POST",
        token,
        organizationId: orgId,
        body: {},
      });
      const result = parseCloudInstanceUpdateResult(payload);
      if (!result) {
        throw new DenApiError(500, "invalid_cloud_update_payload", "Cloud update response was invalid.");
      }
      return result;
    },

    async listOrgLlmProviders(orgId: string): Promise<DenOrgLlmProvider[]> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/llm-providers", {
        method: "GET",
        token,
        organizationId: orgId,
      });
      return getDenOrgLlmProviders(payload);
    },

    async listAutomations(
      orgId: string,
      options: { cursor?: string; limit?: number } = {},
    ): Promise<AutomationList> {
      const params = new URLSearchParams();
      if (options.cursor) params.set("cursor", options.cursor);
      if (options.limit) params.set("limit", String(options.limit));
      const query = params.size > 0 ? `?${params.toString()}` : "";
      return requestJson<AutomationList>(baseUrls, `/v1/automations${query}`, {
        method: "GET",
        token,
        organizationId: orgId,
        automationModelAttentionCapable: true,
      });
    },

    /**
     * Null when this Den cannot report presence: desktops outlive the Den they
     * were released against, and self-hosted Dens lag further still. Unknown
     * presence is not an absent desktop, so callers must not warn on it.
     */
    async getAutomationDesktopRunnerPresence(orgId: string): Promise<AutomationDesktopRunnerPresence | null> {
      try {
        return await requestJson<AutomationDesktopRunnerPresence>(baseUrls, "/v1/automation-runners/presence", {
          method: "GET",
          token,
          organizationId: orgId,
          automationModelAttentionCapable: true,
        });
      } catch (error) {
        if (error instanceof DenApiError && error.status === 404) return null;
        throw error;
      }
    },

    async mintAutomationRunnerToken(orgId: string, registration: AutomationDesktopRunnerRegistration): Promise<AutomationRunnerTokenResponse> {
      return requestJson<AutomationRunnerTokenResponse>(baseUrls, "/v1/automation-runners/token", {
        method: "POST",
        token,
        organizationId: orgId,
        body: registration,
        automationModelAttentionCapable: true,
      });
    },

    async createAutomation(orgId: string, input: CreateAutomation): Promise<AutomationDetail> {
      return requestJson<AutomationDetail>(baseUrls, "/v1/automations", {
        method: "POST",
        token,
        organizationId: orgId,
        body: input,
        automationModelAttentionCapable: true,
      });
    },

    async getAutomation(orgId: string, automationId: string): Promise<AutomationDetail> {
      return requestJson<AutomationDetail>(
        baseUrls,
        `/v1/automations/${encodeURIComponent(automationId)}`,
        { method: "GET", token, organizationId: orgId, automationModelAttentionCapable: true },
      );
    },

    async updateAutomation(
      orgId: string,
      automationId: string,
      input: UpdateAutomation,
    ): Promise<AutomationDetail> {
      return requestJson<AutomationDetail>(
        baseUrls,
        `/v1/automations/${encodeURIComponent(automationId)}`,
        { method: "PATCH", token, organizationId: orgId, body: input, automationModelAttentionCapable: true },
      );
    },

    async activateAutomation(orgId: string, automationId: string): Promise<AutomationDetail> {
      return requestJson<AutomationDetail>(
        baseUrls,
        `/v1/automations/${encodeURIComponent(automationId)}/activate`,
        { method: "POST", token, organizationId: orgId, body: {}, automationModelAttentionCapable: true },
      );
    },

    async deactivateAutomation(orgId: string, automationId: string): Promise<AutomationDetail> {
      return requestJson<AutomationDetail>(
        baseUrls,
        `/v1/automations/${encodeURIComponent(automationId)}/deactivate`,
        { method: "POST", token, organizationId: orgId, body: {}, automationModelAttentionCapable: true },
      );
    },

    async archiveAutomation(orgId: string, automationId: string): Promise<AutomationDetail> {
      return requestJson<AutomationDetail>(
        baseUrls,
        `/v1/automations/${encodeURIComponent(automationId)}`,
        { method: "DELETE", token, organizationId: orgId, automationModelAttentionCapable: true },
      );
    },

    async runAutomationNow(orgId: string, automationId: string): Promise<AutomationRun> {
      const payload = await requestJson<{ run: AutomationRun }>(
        baseUrls,
        `/v1/automations/${encodeURIComponent(automationId)}/run`,
        { method: "POST", token, organizationId: orgId, body: {}, automationModelAttentionCapable: true },
      );
      return payload.run;
    },

    async listAutomationRuns(
      orgId: string,
      automationId: string,
      options: { cursor?: string; limit?: number } = {},
    ): Promise<{ items: AutomationRun[]; nextCursor: string | null }> {
      const params = new URLSearchParams();
      if (options.cursor) params.set("cursor", options.cursor);
      if (options.limit) params.set("limit", String(options.limit));
      const query = params.size > 0 ? `?${params.toString()}` : "";
      return requestJson<{ items: AutomationRun[]; nextCursor: string | null }>(
        baseUrls,
        `/v1/automations/${encodeURIComponent(automationId)}/runs${query}`,
        { method: "GET", token, organizationId: orgId, automationModelAttentionCapable: true },
      );
    },

    async getAutomationRun(orgId: string, runId: string): Promise<AutomationRunReceipt> {
      return requestJson<AutomationRunReceipt>(
        baseUrls,
        `/v1/automation-runs/${encodeURIComponent(runId)}`,
        { method: "GET", token, organizationId: orgId, automationModelAttentionCapable: true },
      );
    },

    async cancelAutomationRun(orgId: string, runId: string): Promise<AutomationRun> {
      const payload = await requestJson<{ run: AutomationRun }>(
        baseUrls,
        `/v1/automation-runs/${encodeURIComponent(runId)}/cancel`,
        { method: "POST", token, organizationId: orgId, body: {}, automationModelAttentionCapable: true },
      );
      return payload.run;
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

    async listMcpConnections(orgId: string, scope: "usable" | "manageable" = "usable"): Promise<DenExternalMcpConnection[]> {
      const payload = await requestJson<unknown>(
        baseUrls,
        `/v1/mcp-connections?scope=${scope}`,
        { method: "GET", token, organizationId: orgId },
      );
      return getDenExternalMcpConnections(payload);
    },

    async listMcpConnectionPresets(orgId: string): Promise<DenExternalMcpPreset[]> {
      const payload = await requestJson<unknown>(
        baseUrls,
        "/v1/mcp-connections/presets",
        { method: "GET", token, organizationId: orgId },
      );
      return getDenExternalMcpPresets(payload);
    },

    async startMcpConnectionConnect(orgId: string, connectionId: string): Promise<DenMcpConnectionConnectStart> {
      const payload = await requestJson<unknown>(
        baseUrls,
        `/v1/mcp-connections/${encodeURIComponent(connectionId)}/connect/start`,
        { method: "GET", token, organizationId: orgId },
      );
      const result = getDenMcpConnectionConnectStart(payload);
      if (!result) {
        throw new DenApiError(500, "invalid_mcp_connection_payload", "MCP connection connect response was invalid.");
      }
      return result;
    },

    async disconnectOauthProviderAccount(orgId: string, providerId: string): Promise<void> {
      await requestJson<unknown>(
        baseUrls,
        `/v1/oauth-providers/${encodeURIComponent(providerId)}/disconnect`,
        { method: "POST", token, organizationId: orgId },
      );
    },

    async disconnectMyMcpConnectionAccount(orgId: string, connectionId: string): Promise<void> {
      await requestJson<unknown>(
        baseUrls,
        `/v1/mcp-connections/${encodeURIComponent(connectionId)}/disconnect-my-account`,
        { method: "POST", token, organizationId: orgId },
      );
    },

    async listOrgMarketplaces(orgId: string): Promise<DenOrgMarketplace[]> {
      const payload = await requestJson<unknown>(
        baseUrls,
        `/v1/marketplaces?status=active&limit=100`,
        { method: "GET", token, organizationId: orgId },
      );
      return getOrgMarketplaces(payload);
    },

    async listAssignedMarketplaceCapabilities(orgId: string): Promise<DenAssignedMarketplaceCapability[]> {
      const payload = await requestJson<unknown>(
        baseUrls,
        "/v1/resources/marketplace-capabilities",
        { method: "GET", token, organizationId: orgId },
      );
      return getAssignedMarketplaceCapabilities(payload);
    },

    async listMeLibraryPlugins(orgId: string): Promise<DenMeLibraryPlugin[]> {
      const payload = await requestJson<unknown>(
        baseUrls,
        "/v1/me/library",
        { method: "GET", token, organizationId: orgId },
      );
      return getMeLibraryPlugins(payload);
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

    async createOrgPlugin(
      orgId: string,
      input: {
        name: string;
        description?: string | null;
        components: Array<{
          type: "skill" | "command" | "agent" | "mcp";
          input: {
            rawSourceText?: string;
            normalizedPayloadJson?: Record<string, unknown>;
            metadata: { name: string; description?: string };
          };
        }>;
        orgWide?: boolean;
        marketplaceId?: string;
      },
    ): Promise<string> {
      const marketplaceId = input.marketplaceId?.trim() || undefined;
      const payload = await requestJson<unknown>(
        baseUrls,
        "/v1/plugins",
        {
          method: "POST",
          token,
          organizationId: orgId,
          body: {
            name: input.name,
            description: input.description ?? null,
            components: input.components,
            orgWide: input.orgWide === true,
            ...(marketplaceId ? { marketplaceId } : {}),
          },
        },
      );
      const item = isRecord(payload) && isRecord(payload.item) ? payload.item : null;
      const pluginId = item && typeof item.id === "string" ? item.id : null;
      if (!pluginId) {
        throw new DenApiError(500, "invalid_plugin_payload", "Plugin was created but no id was returned.");
      }
      return pluginId;
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

/**
 * Mint an org-scoped MCP access token for the Den cloud MCP using the
 * current desktop Den session. Returns null when signed out or no active
 * organization is selected.
 */
export type DenMcpTokenMintContext = {
  baseUrl: string;
  authToken: string | null;
  orgId: string | null;
};

export async function mintCloudControlMcpToken(context?: DenMcpTokenMintContext): Promise<DenMcpToken | null> {
  const settings = context ?? readDenSettings();
  const token = settings.authToken?.trim() ?? "";
  const orgId = ("orgId" in settings ? settings.orgId : settings.activeOrgId)?.trim() ?? "";
  if (!token || !orgId) {
    return null;
  }
  const client = createDenClient({
    baseUrl: settings.baseUrl,
    token,
  });
  return client.mintMcpToken(orgId);
}
