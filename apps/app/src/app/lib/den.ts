import { builtMcpAppCatalogSchema, type BuiltMcpAppCatalogEntry } from "./built-mcp-app-catalog";
import {
  normalizeDesktopConfig,
  type DesktopConfig as SharedDesktopConfig,
} from "@openwork/types/den/desktop-policies";
import {
  AUTOMATION_MODEL_ATTENTION_CAPABILITY,
  AUTOMATION_MODEL_ATTENTION_CAPABILITY_HEADER,
  AUTOMATION_SCHEDULE_KINDS,
  AUTOMATION_SCHEDULE_KINDS_HEADER,
} from "@openwork/types/automations";
import type { GatewayAuthorizationRequest, GatewayProviderSummary } from "@openwork/types/den/gateway";
import { parseGatewayUsableModel } from "./gateway-usable-model";
import type { DesktopStartupReport } from "@openwork/types/den/diagnostics";
import {
  parseModelRemovalInventory,
  type ModelRemovalInventory,
} from "../../react-app/domains/session/surface/model-removal-inventory";
export type { ModelRemovalInventory } from "../../react-app/domains/session/surface/model-removal-inventory";
import { activationStateSchema, type ActivationEventRequest, type ActivationState } from "@openwork/types/den/activation";
import { deviceShareOptionsSchema, type DeviceShareOptions } from "@openwork/types/den/device-provider-share";
import {
  remoteSessionStatusResultSchema,
  type RemoteSessionStatusRequest,
  type RemoteSessionStatusResult,
} from "@openwork/types/automations";
import { parseDenMcpDiscovery, type DenMcpDiscovery } from "./den-mcp-discovery";
import type {
  AutomationDetail,
  AutomationDesktopRunnerPresence,
  AutomationDesktopRunnerRegistration,
  AutomationExecutionTargetList,
  AutomationList,
  AutomationRun,
  AutomationRunReceipt,
  AutomationRunnerTokenResponse,
  AutomationSharing,
  UpdateAutomationSharing,
  SharedAutomationList,
  CopySharedAutomation,
  CreateAutomation,
  CreateCloudAutomation,
  RunAutomationNow,
  UpdateAutomation,
} from "@openwork/types/automations";
import { generatedArtifactViewSchema, savedAppDetailSchema, savedAppSummarySchema, type SaveApp, type WorkflowDetail } from "@openwork/types/workflows";
import { canScheduleWorkflow, type WorkflowAccessRole } from "./workflow-run-access";
import { gatewayUsageStatusSchema, gatewayUsageResetRequestSchema } from "@openwork/types/den/gateway-usage-limits";
import { GATEWAY_MEMBER_USAGE_DAYS, gatewayMemberUsageResponseSchema } from "@openwork/types/den/gateway-member-usage";
import {
  remoteDeviceDesktopReportResponseSchema,
  remoteDeviceDetailResponseSchema,
  remoteDeviceDisconnectResponseSchema,
  remoteDeviceListResponseSchema,
  remoteDeviceResponseSchema,
  type RemoteDevice,
  type RemoteDeviceDesktopReport,
  type RemoteDeviceDesktopReportResponse,
  type RemoteDeviceDetailResponse,
  type RemoteDeviceDisconnectResponse,
  type RemoteDeviceRegisterRequest,
} from "@openwork/types/den/remote-devices";

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
  readDesktopDistributionInfo,
  readInitialDesktopBootstrapConfig,
  setDesktopBootstrapConfig as setDesktopBootstrapConfigInShell,
  type DesktopBootstrapConfig as ShellDesktopBootstrapConfig,
} from "./desktop";
import { enterpriseActivationRequired } from "./enterprise-activation";
import { observeDenRequest } from "./den-request-diagnostics";
import { getOpenworkGatewayOrigin, readOpenworkGatewayDenBaseUrl } from "./gateway-runtime";
import { clearDesktopSignInIntent, clearOrgSelectionPending, readOrgSelectionPending } from "./den-sign-in-intent";
import { rememberDenOrganization } from "./den-org-memory";
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
export const STORAGE_SESSION_ORIGIN = "openwork.den.sessionOrigin";
const STORAGE_ACTIVE_ORG_ID = "openwork.den.activeOrgId";
const STORAGE_ACTIVE_ORG_SLUG = "openwork.den.activeOrgSlug";
const STORAGE_ACTIVE_ORG_NAME = "openwork.den.activeOrgName";
const DESKTOP_CONFIG_CACHE_PREFIX = "openwork.den.desktopConfig:";
export const CLOUD_MCP_SYNC_MARKER_STORAGE_KEY = "openwork.den.mcp.sync";
const ORG_PROXY_HEADER = "x-openwork-legacy-org-id";
const ORG_SCOPE_HEADER = "x-openwork-org-id";
const DEFAULT_DEN_TIMEOUT_MS = 12_000;

const BUILD_DEN_BASE_URL =
  readOpenworkGatewayDenBaseUrl() ||
  (typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_DEN_BASE_URL === "string"
    ? import.meta.env.VITE_DEN_BASE_URL
    : "").trim() || "https://app.openworklabs.com";
const BUILD_DEN_REQUIRE_SIGNIN =
  (typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_DEN_REQUIRE_SIGNIN === "string"
    ? /^(1|true|yes|on)$/i.test(import.meta.env.VITE_DEN_REQUIRE_SIGNIN.trim())
    : false);

function readBuildDenApiBaseUrl(): string {
  const apiBaseUrl = (typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_DEN_API_BASE_URL === "string"
    ? import.meta.env.VITE_DEN_API_BASE_URL
    : "").trim();
  return apiBaseUrl === "/api/den" && typeof window !== "undefined"
    ? new URL(apiBaseUrl, window.location.origin).href
    : apiBaseUrl;
}

function readForceEnvDenSettings(): boolean {
  return (typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_OPENWORK_FORCE_ENV_SETTINGS === "string"
    ? /^(1|true|yes|on)$/i.test(import.meta.env.VITE_OPENWORK_FORCE_ENV_SETTINGS.trim())
    : false);
}

export const HOSTED_DEFAULT_DEN_BASE_URL = "https://app.openworklabs.com";
export const DEFAULT_DEN_BASE_URL = BUILD_DEN_BASE_URL;
export const DEN_INFERENCE_PATH = "/dashboard/inference";

export type * from "./den-types";
import type {
  DenAssignedMarketplaceCapability,
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
import {
  parseDenLibraryAccessGrant,
  parseDenLibraryAccessGrants,
  parseDenLibraryConfigObjectVersion,
  parseDenLibraryItems,
  parseDenLibraryOrgDirectory,
  parseDenLibraryPluginFiles,
  parseDenPluginListAccess,
  type DenLibraryAccessGrant,
  type DenLibraryConfigObjectVersion,
  type DenLibraryItem,
  type DenLibraryOrgDirectory,
  type DenLibraryPluginFile,
} from "./den-library";

type DenBaseUrls = {
  baseUrl: string;
  apiBaseUrl: string;
};

export type DenBootstrapSource = "file" | "default";

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

export type DenCanonicalOrgRole = "owner" | "admin" | "member";
export type DenOrgRole = string;

export type DenOrgSummary = {
  id: string;
  name: string;
  slug: string;
  role: DenOrgRole;
};

function normalizeDenCanonicalOrgRole(role: string): DenCanonicalOrgRole | null {
  const normalized = role.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (normalized === "owner") return "owner";
  if (normalized === "admin" || normalized === "super-admin") return "admin";
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
  if (roles.has("admin")) return "admin";
  return "member";
}

export function isDenOrgAdminRole(roleValue: string | null | undefined) {
  if (!roleValue) return false;
  return getDenCanonicalOrgRole(roleValue) !== "member";
}

export function formatDenOrgRoleLabel(roleValue: string) {
  const labels = roleValue
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean)
    .map((role) => {
      if (role.toLowerCase().replace(/[\s_]+/g, "-") === "super-admin") return "Super admin";
      const canonicalRole = normalizeDenCanonicalOrgRole(role);
      if (canonicalRole === "owner") return "Owner";
      if (canonicalRole === "admin") return "Admin";
      if (canonicalRole === "member") return "Member";
      return role
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
        .join(" ");
    });
  return [...new Set(labels)].join(", ");
}

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

export type DenCloudInstanceUpdateDeferral = "busy" | "activity_unknown";

export type DenCloudInstanceUpdateResult =
  | { ok: true; status: "update_requested" }
  | { ok: false; error: "already_current" | "flush_failed" | DenCloudInstanceUpdateDeferral };

export type DenMcpToken = {
  token: string;
  appHostToken?: string;
  expiresAt: string;
  appHostExpiresAt?: string;
  organizationId: string;
  scopes: string[];
  resource: string;
};

export type DenOrgGatewayProvider = Pick<GatewayProviderSummary, "id" | "providerId" | "name" | "source">;

export type DenOrgUsableGatewayProvider = Pick<
  GatewayProviderSummary,
  "id" | "providerId" | "name" | "source" | "credentialStatus" | "updatedAt" | "models" | "authorizationRequests"
>;

export type DenOrgLlmProviderModel = {
  id: string;
  name: string;
  config: Record<string, unknown>;
  createdAt: string | null;
};

export type DenOrgLlmProviderAccess = {
  allMembers: boolean;
  teamNames: string[];
  memberCount: number;
};

export type DenOrgLlmProvider = {
  id: string;
  source: "models_dev" | "custom" | "openwork";
  providerId: string;
  name: string;
  providerConfig: Record<string, unknown>;
  hasApiKey: boolean;
  runtimeEnvKeys?: string[];
  hasMyCredential?: boolean;
  credentialMode?: "shared" | "per_member";
  access?: DenOrgLlmProviderAccess;
  models: DenOrgLlmProviderModel[];
  pinnedModelIds?: string[];
  createdAt: string | null;
  updatedAt: string | null;
};

export type DenExternalMcpConnection = {
  readiness?: {
    status: "ready" | "could_not_verify";
    checkedAt: string;
    lastSuccessfulAt: string | null;
    reason: string | null;
    failure?: DenConnectionReadinessFailure | null;
    referenceId?: string;
    providerSettingsUrl?: string;
  } | null;
  setupRequired?: boolean;
  credentialHealth?: "unknown" | "ready" | "reconnect_required";
  id: string;
  name: string;
  url: string;
  authType: "oauth" | "apikey" | "none";
  credentialMode: "shared" | "per_member";
  exposeDirectly: boolean;
  connected: boolean;
  connectedAt: string | null;
  connectedForMe: boolean;
  needsReconnect?: boolean;
  issuerReviewRequired?: boolean;
  reconnectActionOwner?: "member" | "organization_admin" | null;
  missingFeatures?: string[];
  externalAccountId?: string | null;
  grantedScopes?: string[];
  tenantId?: string | null;
  nativeProviderKey?: string | null;
};

export type DenExternalMcpPreset = {
  presetId: string;
  displayName: string;
  description: string;
  url: string;
  authType: "oauth" | "apikey" | "none";
  requiresOAuthClient?: boolean;
  defaultOAuthClientId?: string;
};

export type DenMcpConnectionConnectStart = {
  status: "connected" | "needs_auth";
  authorizeUrl: string | null;
};

export type DenOrgLlmProviderConnection = DenOrgLlmProvider & {
  apiKey: string | null;
  apiKeys: Record<string, string> | null;
};

export type DenOrgMarketplaceResolved = {
  marketplace: DenOrgMarketplace;
  plugins: DenOrgPlugin[];
};

export type DenOpenWorkWebAccessSource = "subscription" | "complimentary" | null;

export type DenOpenWorkWebAccess = {
  hasAccess: boolean;
  accessSource: DenOpenWorkWebAccessSource;
  memberHasAccess: boolean;
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

export type DenBootstrapResolution = "unresolved" | "resolved";
let desktopBootstrapResolution: DenBootstrapResolution = "unresolved";
let desktopBootstrapGeneration = 0;
let lastCredentialGateLog: string | null = null;

export function getDenBootstrapResolution(): DenBootstrapResolution {
  return desktopBootstrapResolution;
}

export type DenAppVersionMetadata = {
  minAppVersion: string;
  latestAppVersion: string;
  publishedDesktopVersions: string[];
  webUrl: string | null;
};

type RawJsonResponse<T> = {
  ok: boolean;
  status: number;
  json: T | null;
  retryAfterSeconds?: number;
};

const RESOLVED_PLUGINS_BATCH_SIZE = 100;

export class DenApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  retryAfterSeconds?: number;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "DenApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

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

  const buildDenApiBaseUrl = normalizedApiBaseUrl ? null : normalizeDenBaseUrl(readBuildDenApiBaseUrl());
  const deterministicApiBaseUrl = denApiOriginForDenBaseUrl(baseUrl);

  return {
    baseUrl,
    apiBaseUrl: normalizedApiBaseUrl
      ? normalizedApiBaseUrl
      : buildDenApiBaseUrl
        ? buildDenApiBaseUrl
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

export function getDenMcpUrl(): string {
  const { apiBaseUrl } = resolveDenBaseUrls(readDenBootstrapConfig());
  return `${apiBaseUrl.replace(/\/+$/, "")}/mcp`;
}

export function isLegacyWebAppMcpUrl(input: string | null | undefined): boolean {
  if (!input) return false;
  try {
    const url = new URL(input);
    return isHostedWebAppHost(url.hostname) && url.pathname.replace(/\/+$/, "") === "/mcp";
  } catch {
    return false;
  }
}

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

async function resolveBootBootstrapConfig(
  input: Parameters<typeof resolveDenBootstrapConfig>[0],
): Promise<DenBootstrapConfig> {
  const resolved = resolveDenBootstrapConfig(input);
  if (enterpriseActivationRequired(readDesktopDistributionInfo(), resolved)) {
    return resolved;
  }
  return resolveDenBootstrapConfigWithRuntimeApi(input);
}

export async function resolveDenBaseUrlsForDestination(
  input: { baseUrl: string; apiBaseUrl?: string | null },
): Promise<DenBaseUrls> {
  const resolved = resolveDenBaseUrls(input);
  if (input.apiBaseUrl || !isDesktopRuntime()) {
    return resolved;
  }

  const runtimeApiBaseUrl = await fetchRuntimeConfigDenApiUrl(resolved.baseUrl);
  if (!runtimeApiBaseUrl || !destinationApiOriginVerified(resolved.baseUrl, runtimeApiBaseUrl)) {
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

function destinationApiOriginVerified(webBaseUrl: string, candidate: string): boolean {
  try {
    const webOrigin = new URL(webBaseUrl).origin;
    const candidateOrigin = new URL(candidate).origin;
    if (candidateOrigin === webOrigin) return true;
    const deterministic = denApiOriginForDenBaseUrl(webBaseUrl);
    return deterministic !== null && new URL(deterministic).origin === candidateOrigin;
  } catch {
    return false;
  }
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

function adoptUntaggedDenSessionOrigin() {
  if (!isDesktopRuntime() || desktopBootstrapResolution !== "resolved") return;
  if (!readStoredDenAuthToken() || readStoredDenSessionOrigin()) return;
  const origin = denOriginComparisonKey(desktopBootstrapConfig.baseUrl);
  if (!origin) return;
  try {
    window.localStorage.setItem(STORAGE_SESSION_ORIGIN, origin);
  } catch {
  }
}

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
    if (readForceEnvDenSettings() && typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(STORAGE_BASE_URL);
      } catch {
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
    const resolved = await resolveBootBootstrapConfig(initialBootstrap);
    if (generation !== desktopBootstrapGeneration) return readDenBootstrapConfig();
    applyDesktopBootstrapConfig(resolved);
    adoptUntaggedDenSessionOrigin();
    return desktopBootstrapConfig;
  }

  const SHELL_BOOTSTRAP_ATTEMPTS = 3;
  const SHELL_BOOTSTRAP_RETRY_DELAY_MS = 350;
  for (let attempt = 1; attempt <= SHELL_BOOTSTRAP_ATTEMPTS; attempt += 1) {
    try {
      const bootstrap = await getDesktopBootstrapConfigFromShell();
      const resolved = await resolveBootBootstrapConfig(bootstrap);
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

  desktopBootstrapConfig = resolveDenBootstrapConfig({
    baseUrl: HOSTED_DEFAULT_DEN_BASE_URL,
    requireSignin: BUILD_DEN_REQUIRE_SIGNIN,
  });
  desktopBootstrapResolution = "unresolved";
  console.warn(
    "[den-bootstrap] Shell bootstrap is unavailable; using an in-memory placeholder and withholding Den credentials until the real config is read.",
  );

  void (async () => {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      if (generation !== desktopBootstrapGeneration) return;
      try {
        const bootstrap = await getDesktopBootstrapConfigFromShell();
        const resolved = await resolveBootBootstrapConfig(bootstrap);
        if (generation !== desktopBootstrapGeneration) return;
        applyDesktopBootstrapConfig(resolved);
        adoptUntaggedDenSessionOrigin();
        dispatchDenSettingsChanged({ settings: readDenSettings() });
        return;
      } catch {
      }
    }
  })();

  return desktopBootstrapConfig;
}

export async function refreshDenBootstrapConfigFromShell(): Promise<DenBootstrapConfig> {
  if (isDesktopRuntime()) {
    const generation = ++desktopBootstrapGeneration;
    try {
      const bootstrap = await getDesktopBootstrapConfigFromShell();
      const resolved = await resolveBootBootstrapConfig(bootstrap);
      if (generation === desktopBootstrapGeneration) {
        applyDesktopBootstrapConfig(resolved);
        adoptUntaggedDenSessionOrigin();
        dispatchDenSettingsChanged({ settings: readDenSettings() });
      }
    } catch {
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
    enterpriseActivation:
      next.enterpriseActivation !== undefined
        ? next.enterpriseActivation
        : previous.enterpriseActivation,
  });

  if (isDesktopRuntime()) {
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
    || import.meta.env?.VITE_OPENWORK_FORCE_MANUAL_AUTH === "1"
    || (webReturnOrigin !== null && !canUseCloudWebAuthReturn(webReturnOrigin))
  ) {
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
    (previous.activeOrgName ?? "") === activeOrgName &&
    (isDesktopRuntime() || window.localStorage.getItem(STORAGE_BASE_URL) === baseUrl)
  ) {
    return;
  }

  warnOnUnexpectedActiveOrgDrop({
    previousActiveOrgId: previous.activeOrgId,
    nextActiveOrgId: activeOrgId,
    intentionalActiveOrgClear: options?.intentionalActiveOrgClear,
  });

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
  clearDashboardTileCacheStorage(window.localStorage);
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

export function isDenSessionSnapshotCurrent(snapshot: DenSettings): boolean {
  const current = readDenSettings();
  return denOriginComparisonKey(current.baseUrl) === denOriginComparisonKey(snapshot.baseUrl)
    && current.apiBaseUrl === snapshot.apiBaseUrl
    && current.authToken === snapshot.authToken
    && current.activeOrgId === snapshot.activeOrgId;
}

export async function selectDenActiveOrganization(organization: DenOrgSummary, settings: DenSettings): Promise<void> {
  const selectionWasPending = readOrgSelectionPending().pending;
  const requireCurrentSession = () => {
    if (!settings.authToken?.trim() || !isDenSessionSnapshotCurrent(settings)
      || selectionWasPending !== readOrgSelectionPending().pending) {
      throw new Error("Your sign-in or organization changed. Choose an organization again.");
    }
  };
  requireCurrentSession();
  const client = createDenClient({ ...settings, token: settings.authToken });
  const user = await client.getSession();
  requireCurrentSession();
  await client.setActiveOrganization({ organizationId: organization.id });
  requireCurrentSession();
  rememberDenOrganization({
    serverKey: denOriginComparisonKey(settings.baseUrl),
    userId: user.id,
  }, organization.id);
  clearOrgSelectionPending();
  writeDenSettings({
    ...settings,
    activeOrgId: organization.id,
    activeOrgSlug: organization.slug,
    activeOrgName: organization.name,
  });
}

export async function ensureDenActiveOrganization(options?: {
  forceServerSync?: boolean;
  verifiedSession?: { userId: string; token: string; baseUrl: string };
}) {
  const settings = readDenSettings();
  const token = settings.authToken?.trim() ?? "";
  const verifiedSession = options?.verifiedSession;
  if (verifiedSession && (
    verifiedSession.token !== token
    || denOriginComparisonKey(verifiedSession.baseUrl) !== denOriginComparisonKey(settings.baseUrl)
  )) return null;
  if (!token) {
    return null;
  }

  const client = createDenClient({
    baseUrl: settings.baseUrl,
    token,
  });

  const response = await client.listOrgs();
  if (!isDenSessionSnapshotCurrent(settings)) return null;
  const selectedOrgId = settings.activeOrgId?.trim() ?? "";
  const selectedOrgSlug = settings.activeOrgSlug?.trim() ?? "";
  const targetOrg =
    response.orgs.find((org) => org.id === selectedOrgId) ??
    response.orgs.find((org) => org.slug === selectedOrgSlug) ??
    response.orgs.find((org) => org.id === response.activeOrgId) ??
    response.orgs.find((org) => org.slug === response.activeOrgSlug) ??
    (response.orgs.length === 1 ? response.orgs[0] : null);

  if (!targetOrg) {
    return null;
  }

  if (
    options?.forceServerSync &&
    (!response.activeOrgId || response.activeOrgId !== targetOrg.id)
  ) {
    await client.setActiveOrganization({ organizationId: targetOrg.id });
  }
  if (!isDenSessionSnapshotCurrent(settings)) return null;

  if (verifiedSession && selectedOrgId === targetOrg.id) {
    rememberDenOrganization({
      serverKey: denOriginComparisonKey(settings.baseUrl),
      userId: verifiedSession.userId,
    }, targetOrg.id);
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

  if (
    payload.ok === false
    && (payload.error === "already_current"
      || payload.error === "flush_failed"
      || payload.error === "busy"
      || payload.error === "activity_unknown")
  ) {
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

function parseDenOrgLlmProviderAccess(value: Record<string, unknown>): DenOrgLlmProviderAccess {
  const teams = Array.isArray(value.teams) ? value.teams : [];
  return {
    allMembers: value.allMembers === true,
    teamNames: teams.flatMap((team) => isRecord(team) && typeof team.name === "string" && team.name.trim() ? [team.name.trim()] : []),
    memberCount: Array.isArray(value.members) ? value.members.length : 0,
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
    runtimeEnvKeys: parseStringList(value.runtimeEnvKeys),
    pinnedModelIds: [...new Set(parseStringList(value.pinnedModelIds))],
    ...(typeof value.hasMyCredential === "boolean" ? { hasMyCredential: value.hasMyCredential } : {}),
    ...(value.credentialMode === "shared" || value.credentialMode === "per_member" ? { credentialMode: value.credentialMode } : {}),
    ...(isRecord(value.access) ? { access: parseDenOrgLlmProviderAccess(value.access) } : {}),
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

function getDenOrgGatewayProviders(payload: unknown): DenOrgGatewayProvider[] {
  const invalidPayload = () => new DenApiError(
    500,
    "invalid_gateway_providers_payload",
    "AI Gateway provider response was invalid.",
  );
  if (!isRecord(payload) || !Array.isArray(payload.inferenceProviders)) {
    throw invalidPayload();
  }

  return payload.inferenceProviders.map((provider: unknown) => {
    if (
      !isRecord(provider) ||
      typeof provider.id !== "string" || !provider.id.trim() ||
      typeof provider.providerId !== "string" || !provider.providerId.trim() ||
      typeof provider.name !== "string" || !provider.name.trim() ||
      provider.source !== "openwork_gateway"
    ) {
      throw invalidPayload();
    }
    return {
      id: provider.id,
      providerId: provider.providerId,
      name: provider.name,
      source: provider.source,
    };
  });
}

function parseDenOrgUsableGatewayProvider(value: unknown): DenOrgUsableGatewayProvider | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" || !/^ipr_/i.test(value.id) ||
    typeof value.providerId !== "string" || !value.providerId.trim() ||
    typeof value.name !== "string" || !value.name.trim() ||
    value.source !== "openwork_gateway" ||
    (value.credentialStatus !== "ready" && value.credentialStatus !== "member_auth_required" && value.credentialStatus !== "org_credential_missing")
  ) {
    return null;
  }
  const models = Array.isArray(value.models)
    ? value.models.flatMap((model) => {
        const parsed = parseGatewayUsableModel(model);
        return parsed ? [parsed] : [];
      })
    : [];
  const authorizationRequests: GatewayAuthorizationRequest[] = Array.isArray(value.authorizationRequests)
    ? value.authorizationRequests.flatMap((request) => {
        if (
          !isRecord(request) ||
          typeof request.credentialSetId !== "string" || !/^gcs_[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(request.credentialSetId) ||
          typeof request.name !== "string" || !request.name.trim() ||
          typeof request.authUrl !== "string" || !request.authUrl.trim()
        ) {
          return [];
        }
        const credentialSetId = request.credentialSetId;
        return [{
          credentialSetId,
          name: request.name,
          authUrl: request.authUrl,
          ...(Array.isArray(request.models)
            ? { models: request.models.flatMap((model) => {
                const parsed = parseGatewayUsableModel(model, credentialSetId);
                return parsed ? [parsed] : [];
              }) }
            : {}),
        }];
      })
    : [];
  return {
    id: value.id,
    providerId: value.providerId,
    name: value.name,
    source: value.source,
    credentialStatus: value.credentialStatus,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    models,
    authorizationRequests,
  };
}

function getDenOrgUsableGatewayProviders(payload: unknown): DenOrgUsableGatewayProvider[] {
  if (!isRecord(payload) || !Array.isArray(payload.inferenceProviders)) {
    throw new DenApiError(500, "invalid_gateway_providers_payload", "AI Gateway provider response was invalid.");
  }
  return payload.inferenceProviders.flatMap((provider: unknown) => {
    const parsed = parseDenOrgUsableGatewayProvider(provider);
    return parsed ? [parsed] : [];
  });
}

const CONNECTION_READINESS_FAILURES = ["sign_in_required", "sign_in_rejected", "setup_required", "provider_setup_required", "unavailable", "timed_out", "settings_changed", "tools_unreadable"] as const;
export type DenConnectionReadinessFailure = (typeof CONNECTION_READINESS_FAILURES)[number];

function parseConnectionReadinessFailure(value: unknown): DenConnectionReadinessFailure | null {
  return CONNECTION_READINESS_FAILURES.find((failure) => failure === value) ?? null;
}

export function parseConnectionReadiness(value: unknown): DenExternalMcpConnection["readiness"] {
  if (value === undefined) return undefined;
  if (!isRecord(value) || (value.status !== "ready" && value.status !== "could_not_verify")
    || typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt))) return null;
  return {
    status: value.status,
    checkedAt: value.checkedAt,
    lastSuccessfulAt: typeof value.lastSuccessfulAt === "string" ? value.lastSuccessfulAt : null,
    reason: typeof value.reason === "string" ? value.reason : null,
    failure: parseConnectionReadinessFailure(value.failure),
    ...(typeof value.referenceId === "string" && value.referenceId.trim() ? { referenceId: value.referenceId } : {}),
    ...(typeof value.providerSettingsUrl === "string" && value.providerSettingsUrl.trim() ? { providerSettingsUrl: value.providerSettingsUrl } : {}),
  };
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
    ...(value.readiness !== undefined ? { readiness: parseConnectionReadiness(value.readiness) } : {}),
    ...(typeof value.setupRequired === "boolean" ? { setupRequired: value.setupRequired } : {}),
    ...(value.credentialHealth === "unknown" || value.credentialHealth === "ready" || value.credentialHealth === "reconnect_required"
      ? { credentialHealth: value.credentialHealth } : {}),
    name: value.name,
    url: value.url,
    authType: value.authType,
    credentialMode: value.credentialMode,
    exposeDirectly: value.exposeDirectly === true,
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
    ...(value.requiresOAuthClient === true ? { requiresOAuthClient: true } : {}),
    ...(typeof value.defaultOAuthClientId === "string" && value.defaultOAuthClientId.trim()
      ? { defaultOAuthClientId: value.defaultOAuthClientId }
      : {}),
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

function hasModeledObjectType(value: unknown): boolean {
  return !isRecord(value) || typeof value.objectType !== "string" || parsePluginConfigObjectType(value.objectType) !== null;
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
    memberHasAccess: web.hasAccess && web.memberHasAccess !== false,
  };
}

const resolveFetch = (url: string): FetchLike => {
  if (!isDesktopRuntime()) return globalThis.fetch;
  try {
    if (typeof window !== "undefined" && new URL(url).origin === window.location.origin) {
      return desktopFetch;
    }
  } catch {
  }
  return (input, init) => desktopFetchViaMain(input, init);
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type DenRequestOptions = {
  method?: string;
  cache?: RequestCache;
  token?: string | null;
  body?: unknown;
  timeoutMs?: number;
  organizationId?: string | null;
  automationModelAttentionCapable?: boolean;
  browserUploadPermissionsCapable?: boolean;
  signal?: AbortSignal;
  unobserved?: boolean;
};

async function fetchWithTimeout(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number, onTimeout?: () => void) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetchImpl(url, init);
  }

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const signal = controller?.signal;
  const initWithSignal = signal && !init.signal
    ? { ...init, signal }
    : signal && init.signal && typeof AbortSignal.any === "function"
      ? { ...init, signal: AbortSignal.any([init.signal, signal]) }
      : init;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      onTimeout?.();
      try {
        controller?.abort();
      } catch {
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

const FEATURE_USAGE_FLUSH_MS = 2_000;
const reportedFeatureUsage = new Set<string>();
const pendingFeatureUsage = new Set<string>();
let featureUsageTimer: ReturnType<typeof setTimeout> | null = null;

function flushFeatureUsage() {
  featureUsageTimer = null;
  const features = [...pendingFeatureUsage];
  pendingFeatureUsage.clear();
  const settings = readDenSettings();
  const token = settings.authToken?.trim() ?? "";
  const orgId = settings.activeOrgId?.trim() ?? "";
  if (features.length === 0) return;
  if (!token || !orgId) {
    for (const key of features) reportedFeatureUsage.delete(key);
    return;
  }
  void createDenClient({ ...settings, token }).reportFeatureUsage(orgId, features).catch(() => {
  });
}

export function markFeatureUsed(key: string): void {
  if (reportedFeatureUsage.has(key)) return;
  reportedFeatureUsage.add(key);
  pendingFeatureUsage.add(key);
  featureUsageTimer ??= setTimeout(flushFeatureUsage, FEATURE_USAGE_FLUSH_MS);
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
  if (options.browserUploadPermissionsCapable) {
    headers["X-OpenWork-Browser-Upload-Permissions"] = "1";
  }
  if (path === "/v1/me/desktop-config") {
    headers["X-OpenWork-Sandbox-Only"] = "1";
    headers["X-OpenWork-Sandbox-Modes"] = "1";
  }
  if (options.automationModelAttentionCapable) {
    headers[AUTOMATION_MODEL_ATTENTION_CAPABILITY_HEADER] = AUTOMATION_MODEL_ATTENTION_CAPABILITY;
    headers[AUTOMATION_SCHEDULE_KINDS_HEADER] = AUTOMATION_SCHEDULE_KINDS.join(",");
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const send = async (onTimeout?: () => void): Promise<RawJsonResponse<T>> => {
    const response = await fetchWithTimeout(
      resolveFetch(url),
      url,
      {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: "include",
        ...(options.cache ? { cache: options.cache } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
      options.timeoutMs ?? DEFAULT_DEN_TIMEOUT_MS,
      onTimeout,
    );

    const text = await response.text();
    let json: T | null = null;
    try {
      json = text ? (JSON.parse(text) as T) : null;
    } catch {
      json = null;
    }
    const retryAfter = response.ok ? "" : response.headers?.get("Retry-After")?.trim() ?? "";
    return { ok: response.ok, status: response.status, json, ...(/^\d{1,6}$/.test(retryAfter) ? { retryAfterSeconds: Number(retryAfter) } : {}) };
  };
  return options.unobserved ? send() : observeDenRequest(send);
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
    const error = new DenApiError(raw.status, code, message, isRecord(payload) ? payload.details : undefined);
    if (raw.retryAfterSeconds !== undefined) error.retryAfterSeconds = raw.retryAfterSeconds;
    throw error;
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

export function createDenClient(options: {
  baseUrl: string;
  apiBaseUrl?: string | null;
  token?: string | null;
  requireCompleteInventory?: boolean;
}) {
  const baseUrls = resolveDenClientBaseUrls(options);
  const token = options.token?.trim() ?? null;

  function verifyInventory(payload: unknown, key: string, parsedCount: number, accept?: (item: unknown) => boolean) {
    if (!options.requireCompleteInventory) return;
    const rows = isRecord(payload) ? payload[key] : null;
    if (!Array.isArray(rows)
      || rows.filter(accept ?? (() => true)).length !== parsedCount
      || (isRecord(payload) && (payload.hasMore === true || payload.hasNextPage === true || Boolean(payload.nextCursor)))) {
      throw new DenApiError(502, "incomplete_inventory", "The resource inventory could not be verified.");
    }
  }

  function pluginResolvedFrom(plugin: DenOrgPlugin, payload: unknown): DenOrgPluginResolved {
    const resolved = getOrgPluginResolved(plugin, payload);
    verifyInventory(
      payload,
      "items",
      resolved.memberships.filter((item) => item.configObject).length,
      (item) => !isRecord(item) || hasModeledObjectType(item.configObject),
    );
    return resolved;
  }

  async function getPluginResolved(orgId: string, plugin: DenOrgPlugin): Promise<DenOrgPluginResolved> {
    const payload = await requestJson<unknown>(
      baseUrls,
      `/v1/plugins/${encodeURIComponent(plugin.id)}/resolved`,
      { method: "GET", token, organizationId: orgId },
    );
    return pluginResolvedFrom(plugin, payload);
  }

  function pluginResolvedFromBatch(plugin: DenOrgPlugin, payload: unknown): DenOrgPluginResolved {
    const failure = isRecord(payload) && isRecord(payload.failures) ? payload.failures[plugin.id] : null;
    if (isRecord(failure)) {
      const status = typeof failure.status === "number" ? failure.status : 500;
      const code = typeof failure.error === "string" ? failure.error : "request_failed";
      throw new DenApiError(status, code, getErrorMessage(failure, `Request failed with ${status}.`));
    }
    const body = isRecord(payload) && isRecord(payload.plugins) ? payload.plugins[plugin.id] : null;
    if (!isRecord(body)) {
      throw new DenApiError(502, "incomplete_inventory", "The resource inventory could not be verified.");
    }
    return pluginResolvedFrom(plugin, body);
  }

  return {
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

    async reportDesktopStartup(
      report: DesktopStartupReport,
      options: { organizationId?: string | null; timeoutMs?: number } = {},
    ): Promise<number> {
      const response = await requestJsonRaw<unknown>(baseUrls, "/v1/diagnostics/desktop-startup", {
        method: "POST",
        token,
        body: report,
        organizationId: options.organizationId ?? null,
        timeoutMs: options.timeoutMs,
        unobserved: true,
      });
      return response.status;
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
        browserUploadPermissionsCapable: true,
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

    async getActivation(orgId: string): Promise<ActivationState | null> {
      try {
        return activationStateSchema.parse(await requestJson<unknown>(baseUrls, "/v1/me/activation", { method: "GET", token, organizationId: orgId }));
      } catch (error) {
        if (error instanceof DenApiError && error.status === 404) return null;
        throw error;
      }
    },

    async recordActivationEvent(orgId: string, event: ActivationEventRequest): Promise<ActivationState | null> {
      try {
        return activationStateSchema.parse(await requestJson<unknown>(baseUrls, "/v1/me/activation/events", { method: "POST", token, organizationId: orgId, body: event }));
      } catch (error) {
        if (error instanceof DenApiError && error.status === 404) return null;
        throw error;
      }
    },

    async listRemoteDevices(orgId: string): Promise<RemoteDevice[]> {
      return remoteDeviceListResponseSchema.parse(await requestJson<unknown>(baseUrls, "/v1/remote-devices", {
        method: "GET", token, organizationId: orgId,
      })).devices;
    },

    async getRemoteDevice(orgId: string, deviceId: string): Promise<RemoteDeviceDetailResponse> {
      return remoteDeviceDetailResponseSchema.parse(await requestJson<unknown>(baseUrls, `/v1/remote-devices/${encodeURIComponent(deviceId)}`, {
        method: "GET", token, organizationId: orgId,
      }));
    },

    async registerRemoteDevice(orgId: string, input: RemoteDeviceRegisterRequest): Promise<RemoteDevice> {
      return remoteDeviceResponseSchema.parse(await requestJson<unknown>(baseUrls, "/v1/remote-devices", {
        method: "POST", token, organizationId: orgId, body: input,
      })).device;
    },

    async renameRemoteDevice(orgId: string, deviceId: string, label: string): Promise<RemoteDevice> {
      return remoteDeviceResponseSchema.parse(await requestJson<unknown>(baseUrls, `/v1/remote-devices/${encodeURIComponent(deviceId)}`, {
        method: "PATCH", token, organizationId: orgId, body: { label },
      })).device;
    },

    async disconnectRemoteDevice(orgId: string, deviceId: string): Promise<RemoteDeviceDisconnectResponse> {
      return remoteDeviceDisconnectResponseSchema.parse(await requestJson<unknown>(baseUrls, `/v1/remote-devices/${encodeURIComponent(deviceId)}/disconnect`, {
        method: "POST", token, organizationId: orgId, body: {},
      }));
    },

    async removeRemoteDevice(orgId: string, deviceId: string): Promise<void> {
      await requestJson<unknown>(baseUrls, `/v1/remote-devices/${encodeURIComponent(deviceId)}`, {
        method: "DELETE", token, organizationId: orgId,
      });
    },

    async reportThisComputer(orgId: string, report: RemoteDeviceDesktopReport): Promise<RemoteDeviceDesktopReportResponse> {
      return remoteDeviceDesktopReportResponseSchema.parse(await requestJson<unknown>(baseUrls, "/v1/remote-devices/this-computer", {
        method: "PUT", token, organizationId: orgId, body: report, unobserved: true,
      }));
    },

    async reportFeatureUsage(orgId: string, features: readonly string[]): Promise<void> {
      await requestJson<unknown>(baseUrls, "/v1/org/feature-usage", { method: "POST", token, organizationId: orgId, body: { features }, unobserved: true });
    },

    async getGatewayUsageStatus(orgId: string) {
      if (!token || !orgId.trim()) throw new Error("Sign in and select an organization to view usage limits.");
      const status = gatewayUsageStatusSchema.parse(await requestJson<unknown>(baseUrls, "/v1/gateway/usage-limits/me", {
        method: "GET", token, organizationId: orgId,
      }));
      if (status.organizationId !== orgId) throw new Error("Usage response belongs to a different organization.");
      return status;
    },
    async getGatewayMemberUsage(orgId: string) {
      if (!token || !orgId.trim()) throw new Error("Sign in and select an organization to view your usage.");
      return gatewayMemberUsageResponseSchema.parse(await requestJson<unknown>(baseUrls, `/v1/gateway/usage/me?days=${GATEWAY_MEMBER_USAGE_DAYS}`, {
        method: "GET", token, organizationId: orgId, cache: "no-store",
      }));
    },
    async requestGatewayUsageReset(orgId: string, input: { bucketId: string; reason: string }) {
      if (!token || !orgId.trim()) throw new Error("Sign in and select an organization to request an increase.");
      const reason = input.reason.trim();
      if (!reason || reason.length > 2000 || !input.bucketId || input.bucketId.length > 64) {
        throw new Error("Choose a usage bucket and enter a reason (1–2000 characters).");
      }
      return gatewayUsageResetRequestSchema.parse(await requestJson<unknown>(baseUrls, "/v1/gateway/usage-limit-reset-requests", {
        method: "POST", token, organizationId: orgId, body: { bucketId: input.bucketId, reason },
      }));
    },
    async listBuiltMcpApps(orgId: string): Promise<BuiltMcpAppCatalogEntry[]> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/mcp-apps", {
        method: "GET", token, organizationId: orgId,
      });
      return builtMcpAppCatalogSchema.parse(payload).apps;
    },
    async listSavedApps(orgId: string) {
      const payload = await requestJson<unknown>(baseUrls, "/v1/apps", {
        method: "GET", token, organizationId: orgId,
      });
      if (!isRecord(payload) || !Array.isArray(payload.items) || typeof payload.enabled !== "boolean") {
        throw new Error("Your artifacts could not be loaded.");
      }
      return { enabled: payload.enabled, sharingEnabled: payload.sharingEnabled === true, items: payload.items.map((item) => savedAppSummarySchema.parse(item)) };
    },
    async getSavedApp(orgId: string, appId: string, options: { revisionId?: string; receiptId?: string; timeZone?: string } = {}) {
      const params = new URLSearchParams();
      if (options.revisionId) params.set("revisionId", options.revisionId);
      if (options.receiptId) params.set("receiptId", options.receiptId);
      if (options.timeZone) params.set("timeZone", options.timeZone);
      return savedAppDetailSchema.parse(await requestJson<unknown>(baseUrls, `/v1/apps/${encodeURIComponent(appId)}?${params}`, {
        method: "GET", token, organizationId: orgId,
      }));
    },
    async saveApp(orgId: string, appId: string, input: SaveApp) {
      return generatedArtifactViewSchema.parse(await requestJson<unknown>(baseUrls, `/v1/apps/${encodeURIComponent(appId)}/save`, {
        method: "POST", token, organizationId: orgId, body: input,
      }));
    },
    async deleteApp(orgId: string, appId: string) {
      await requestJson<unknown>(baseUrls, `/v1/artifact-views/${encodeURIComponent(appId)}/retire`, {
        method: "POST", token, organizationId: orgId,
      });
    },
    async shareSavedApp(orgId: string, appId: string, email: string) {
      await requestJson<unknown>(baseUrls, `/v1/apps/${encodeURIComponent(appId)}/share`, {
        method: "POST", token, organizationId: orgId, body: { email },
      });
    },
    async setAppOnDashboard(orgId: string, appId: string, added: boolean) {
      await requestJson<unknown>(baseUrls, `/v1/apps/${encodeURIComponent(appId)}/dashboard`, {
        method: "POST", token, organizationId: orgId, body: { added },
      });
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
      if (capabilities?.openworkWeb !== true) {
        return { hasAccess: false, accessSource: null, memberHasAccess: false };
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
        body: { acceptsDeferral: true },
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
      const providers = getDenOrgLlmProviders(payload);
      verifyInventory(payload, "llmProviders", providers.length);
      return providers;
    },

    async getModelRemovalInventory(orgId: string): Promise<ModelRemovalInventory> {
      const [legacy, gateway] = await Promise.all([
        requestJson<unknown>(baseUrls, "/v1/llm-providers", {
          method: "GET", token, organizationId: orgId, cache: "no-store",
        }),
        requestJson<unknown>(baseUrls, "/v1/inference-providers?scope=usable", {
          method: "GET", token, organizationId: orgId, cache: "no-store",
        }),
      ]);
      return parseModelRemovalInventory(legacy, gateway);
    },

    async listOrgGatewayProviders(orgId: string): Promise<DenOrgGatewayProvider[]> {
      try {
        const payload = await requestJson<unknown>(baseUrls, "/v1/inference-providers?scope=usable", {
          method: "GET",
          token,
          organizationId: orgId,
        });
        return getDenOrgGatewayProviders(payload);
      } catch (error) {
        if (!options.requireCompleteInventory && error instanceof DenApiError && [404, 405, 501].includes(error.status)) return [];
        throw error;
      }
    },

    async getDeviceShareOptions(orgId: string, providerIds: readonly string[]): Promise<DeviceShareOptions | null> {
      try {
        const payload = await requestJson<unknown>(baseUrls, `/v1/inference-providers/device-share-options?providerIds=${encodeURIComponent(providerIds.join(","))}`, {
          method: "GET",
          token,
          organizationId: orgId,
          cache: "no-store",
        });
        const options = deviceShareOptionsSchema.safeParse(payload);
        return options.success ? options.data : null;
      } catch (error) {
        if (error instanceof DenApiError && [400, 404, 405, 501].includes(error.status)) return null;
        throw error;
      }
    },

    async listOrgUsableGatewayProviders(orgId: string): Promise<DenOrgUsableGatewayProvider[]> {
      try {
        const payload = await requestJson<unknown>(baseUrls, "/v1/inference-providers?scope=usable", {
          method: "GET",
          token,
          organizationId: orgId,
          cache: "no-store",
        });
        return getDenOrgUsableGatewayProviders(payload);
      } catch (error) {
        if (error instanceof DenApiError && [404, 405, 501].includes(error.status)) return [];
        throw error;
      }
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

    async listAutomationRunners(orgId: string): Promise<AutomationExecutionTargetList | null> {
      try {
        return await requestJson<AutomationExecutionTargetList>(baseUrls, "/v1/automation-runners", {
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

    async mintSessionRunnerToken(orgId: string, registration: AutomationDesktopRunnerRegistration): Promise<AutomationRunnerTokenResponse> {
      return requestJson<AutomationRunnerTokenResponse>(baseUrls, "/v1/session-runners/token", {
        method: "POST",
        token,
        organizationId: orgId,
        body: registration,
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

    async createCloudAutomation(orgId: string, input: CreateCloudAutomation): Promise<AutomationDetail> {
      return requestJson<AutomationDetail>(baseUrls, "/v1/cloud-automations", {
        method: "POST",
        token,
        organizationId: orgId,
        body: input,
        automationModelAttentionCapable: true,
      });
    },

    async getWorkflow(orgId: string, configObjectId: string): Promise<WorkflowDetail & { canSchedule: boolean }> {
      const payload = await requestJson<{ script: WorkflowDetail; workflow: { role: WorkflowAccessRole } }>(
        baseUrls,
        `/v1/workflows/${encodeURIComponent(configObjectId)}?maxAgeMs=86400000`,
        { method: "GET", token, organizationId: orgId },
      );
      return { ...payload.script, canSchedule: canScheduleWorkflow(payload.workflow?.role) };
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

    async getAutomationSharing(orgId: string, automationId: string): Promise<AutomationSharing> {
      return requestJson<AutomationSharing>(baseUrls, `/v1/automations/${encodeURIComponent(automationId)}/sharing`, {
        method: "GET", token, organizationId: orgId, automationModelAttentionCapable: true,
      });
    },

    async updateAutomationSharing(orgId: string, automationId: string, input: UpdateAutomationSharing): Promise<AutomationSharing> {
      return requestJson<AutomationSharing>(baseUrls, `/v1/automations/${encodeURIComponent(automationId)}/sharing`, {
        method: "PUT", token, organizationId: orgId, body: input, automationModelAttentionCapable: true,
      });
    },

    async listSharedAutomations(orgId: string): Promise<SharedAutomationList> {
      return requestJson<SharedAutomationList>(baseUrls, "/v1/shared-automations", {
        method: "GET", token, organizationId: orgId, automationModelAttentionCapable: true,
      });
    },

    async copySharedAutomation(orgId: string, automationId: string, input: CopySharedAutomation = {}): Promise<AutomationDetail> {
      return requestJson<AutomationDetail>(baseUrls, `/v1/shared-automations/${encodeURIComponent(automationId)}/copy`, {
        method: "POST", token, organizationId: orgId, body: input, automationModelAttentionCapable: true,
      });
    },

    async getAutomationSharingContext(orgId: string) {
      const payload = await requestJson<unknown>(baseUrls, "/v1/org", { method: "GET", token, organizationId: orgId });
      const member = isRecord(payload) && isRecord(payload.currentMember) ? payload.currentMember : null;
      return {
        directory: parseDenLibraryOrgDirectory(payload),
        canShareOrgWide: readStringArray(member?.permissions).includes("sharing.share_org_wide"),
      };
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

    async runAutomationNow(orgId: string, automationId: string, options: RunAutomationNow = {}): Promise<AutomationRun> {
      const payload = await requestJson<{ run: AutomationRun }>(
        baseUrls,
        `/v1/automations/${encodeURIComponent(automationId)}/run`,
        {
          method: "POST",
          token,
          organizationId: orgId,
          body: options.executionTarget ? { executionTarget: options.executionTarget } : {},
          automationModelAttentionCapable: true,
        },
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

    async getRemoteSessionStatus(orgId: string, input: RemoteSessionStatusRequest, options: { signal?: AbortSignal } = {}): Promise<RemoteSessionStatusResult> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/remote-sessions/status", {
        method: "POST", token, organizationId: orgId, body: input, signal: options.signal,
        timeoutMs: (input.waitMs ?? 0) + DEFAULT_DEN_TIMEOUT_MS,
      });
      return remoteSessionStatusResultSchema.parse(payload);
    },

    async remoteSessionAction(orgId: string, action: "read" | "send" | "stop" | "answer", input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
      return requestJson<unknown>(baseUrls, `/v1/remote-sessions/${action}`, {
        method: "POST", token, organizationId: orgId, body: input, timeoutMs: 35_000, signal,
      });
    },

    async getDeploymentFeatures(options: { cache?: RequestCache } = {}): Promise<Record<string, boolean>> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/features", { method: "GET", ...(options.cache ? { cache: options.cache } : {}) });
      const features = isRecord(payload) && isRecord(payload.features) ? payload.features : {};
      return Object.fromEntries(Object.entries(features).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
    },

    async getOrgFeatures(orgId: string): Promise<Record<string, boolean>> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/org", { method: "GET", token, organizationId: orgId });
      const features = isRecord(payload) && isRecord(payload.features) ? payload.features : {};
      return Object.fromEntries(Object.entries(features).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
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
      const connections = getDenExternalMcpConnections(payload);
      verifyInventory(payload, "connections", connections.length);
      return connections;
    },

    async listMcpConnectionPresets(orgId: string): Promise<DenExternalMcpPreset[]> {
      const payload = await requestJson<unknown>(
        baseUrls,
        "/v1/mcp-connections/presets",
        { method: "GET", token, organizationId: orgId },
      );
      return getDenExternalMcpPresets(payload);
    },

    async discoverMcpConnectionRequirements(orgId: string, url: string): Promise<DenMcpDiscovery> {
      const payload = await requestJson<unknown>(
        baseUrls,
        "/v1/mcp-connections/discover",
        { method: "POST", token, organizationId: orgId, body: { url } },
      );
      const discovery = parseDenMcpDiscovery(payload);
      if (!discovery) {
        throw new DenApiError(500, "invalid_mcp_discovery_payload", "MCP discovery response was invalid.");
      }
      return discovery;
    },

    async createPersonalMcpConnection(
      orgId: string,
      input: { name: string; url: string; authType: "oauth" | "none" },
    ): Promise<string> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/mcp-connections", {
        method: "POST",
        token,
        organizationId: orgId,
        body: {
          name: input.name,
          url: input.url,
          authType: input.authType,
          credentialMode: input.authType === "oauth" ? "per_member" : "shared",
          access: { orgWide: false, memberIds: [], teamIds: [] },
        },
      });
      const id = isRecord(payload) && typeof payload.id === "string" ? payload.id : "";
      if (!id) throw new DenApiError(500, "invalid_mcp_connection_payload", "MCP connection create response was invalid.");
      return id;
    },

    async checkMcpConnection(orgId: string, connectionId: string): Promise<void> {
      await requestJson<unknown>(baseUrls, `/v1/mcp-connections/${encodeURIComponent(connectionId)}/check`, {
        method: "POST", token, organizationId: orgId,
      });
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

    async setMyMcpCredential(orgId: string, connectionId: string, apiKey: string): Promise<void> {
      await requestJson<unknown>(
        baseUrls,
        `/v1/mcp-connections/${encodeURIComponent(connectionId)}/my-credential`,
        { method: "PUT", token, organizationId: orgId, body: { apiKey } },
      );
    },

    async saveMcpConnectionSharedKey(orgId: string, connectionId: string, apiKey: string, options: { expectedUpdatedAt?: string } = {}): Promise<void> {
      await requestJson<unknown>(
        baseUrls,
        `/v1/mcp-connections/${encodeURIComponent(connectionId)}/shared-credential`,
        { method: "PUT", token, organizationId: orgId, body: { apiKey, ...(options.expectedUpdatedAt ? { expectedUpdatedAt: options.expectedUpdatedAt } : {}) } },
      );
    },

    async savePluginConnectionKey(orgId: string, input: { pluginId: string; configObjectId: string; serverName: string; apiKey: string }): Promise<void> {
      await requestJson<unknown>(
        baseUrls,
        `/v1/plugins/${encodeURIComponent(input.pluginId)}/mcp-connections`,
        { method: "POST", token, organizationId: orgId, body: { configObjectId: input.configObjectId, serverName: input.serverName, authType: "apikey", credentialMode: "shared", apiKey: input.apiKey } },
      );
    },

    async gatewayCredentialSetReady(orgId: string, inferenceProviderId: string, credentialSetId: string): Promise<boolean> {
      const payload = await requestJson<unknown>(
        baseUrls,
        `/v1/inference-providers/${encodeURIComponent(inferenceProviderId)}/credential-sets`,
        { method: "GET", token, organizationId: orgId },
      );
      const sets = isRecord(payload) && Array.isArray(payload.credentialSets) ? payload.credentialSets : [];
      return sets.some((set) => isRecord(set) && set.id === credentialSetId && set.credentialStatus === "ready");
    },

    async saveGatewayProviderCredential(orgId: string, inferenceProviderId: string, credentialSetId: string, body: { credential: { kind: "aws_keys" | "gcp_service_account"; secret: string } } | { apiKeys: Record<string, string> }): Promise<void> {
      await requestJson<unknown>(
        baseUrls,
        `/v1/inference-providers/${encodeURIComponent(inferenceProviderId)}/credential-sets/${encodeURIComponent(credentialSetId)}`,
        { method: "PATCH", token, organizationId: orgId, body },
      );
    },

    async saveGatewayProviderKey(orgId: string, inferenceProviderId: string, credentialSetId: string, apiKey: string): Promise<void> {
      await requestJson<unknown>(
        baseUrls,
        `/v1/inference-providers/${encodeURIComponent(inferenceProviderId)}/credential-sets/${encodeURIComponent(credentialSetId)}`,
        { method: "PATCH", token, organizationId: orgId, body: { credential: { kind: "api_key", secret: apiKey } } },
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
      const capabilities = getAssignedMarketplaceCapabilities(payload);
      verifyInventory(payload, "items", capabilities.length, hasModeledObjectType);
      return capabilities;
    },

    async listMeLibraryPlugins(orgId: string): Promise<DenMeLibraryPlugin[]> {
      const payload = await requestJson<unknown>(
        baseUrls,
        "/v1/me/library",
        { method: "GET", token, organizationId: orgId },
      );
      const plugins = getMeLibraryPlugins(payload);
      verifyInventory(payload, "items", plugins.length, (item) => isRecord(item) && item.type === "plugin");
      return plugins;
    },

    async getInventoryRevision(orgId: string): Promise<string | null> {
      try {
        const payload = await requestJson<unknown>(
          baseUrls,
          "/v1/org/inventory-revision",
          { method: "GET", token, organizationId: orgId },
        );
        return isRecord(payload) && typeof payload.revision === "string" ? payload.revision : null;
      } catch (error) {
        if (error instanceof DenApiError && [404, 405, 501].includes(error.status)) return null;
        throw error;
      }
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
      verifyInventory(isRecord(payload) ? payload.item : null, "plugins", resolved.plugins.length);
      return resolved;
    },

    getOrgPluginResolved: getPluginResolved,

    async getOrgPluginsResolved(orgId: string, plugins: DenOrgPlugin[]): Promise<DenOrgPluginResolved[]> {
      const batches: DenOrgPlugin[][] = [];
      for (let start = 0; start < plugins.length; start += RESOLVED_PLUGINS_BATCH_SIZE) {
        batches.push(plugins.slice(start, start + RESOLVED_PLUGINS_BATCH_SIZE));
      }
      try {
        return (await Promise.all(batches.map(async (batch) => {
          const payload = await requestJson<unknown>(
            baseUrls,
            `/v1/resolved-plugins?pluginIds=${batch.map((plugin) => encodeURIComponent(plugin.id)).join(",")}`,
            { method: "GET", token, organizationId: orgId },
          );
          return batch.map((plugin) => pluginResolvedFromBatch(plugin, payload));
        }))).flat();
      } catch (error) {
        if (!(error instanceof DenApiError) || error.status !== 404) throw error;
        return Promise.all(plugins.map((plugin) => getPluginResolved(orgId, plugin)));
      }
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
          connection?: {
            authType: "oauth" | "apikey" | "none";
            credentialMode: "per_member" | "shared";
            apiKey?: string;
            oauthClient?: { clientId: string; clientSecret?: string };
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

    async listMeLibraryItems(orgId: string): Promise<DenLibraryItem[]> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/me/library", { method: "GET", token, organizationId: orgId });
      return parseDenLibraryItems(payload);
    },

    async getLibraryOrgDirectory(orgId: string): Promise<DenLibraryOrgDirectory> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/org", { method: "GET", token, organizationId: orgId });
      return parseDenLibraryOrgDirectory(payload);
    },

    async listPluginAccess(orgId: string, pluginId: string): Promise<DenLibraryAccessGrant[]> {
      const payload = await requestJson<unknown>(
        baseUrls,
        `/v1/plugins/${encodeURIComponent(pluginId)}/access?limit=100`,
        { method: "GET", token, organizationId: orgId },
      );
      return parseDenLibraryAccessGrants(payload);
    },

    async listManagedPluginAccess(orgId: string): Promise<Map<string, DenLibraryAccessGrant[]>> {
      const payload = await requestJson<unknown>(
        baseUrls,
        "/v1/plugins?status=active&limit=100&includeAccess=true",
        { method: "GET", token, organizationId: orgId },
      );
      return parseDenPluginListAccess(payload);
    },

    async grantPluginAccess(
      orgId: string,
      pluginId: string,
      target: { teamId: string } | { orgMembershipId: string } | { orgWide: true },
    ): Promise<DenLibraryAccessGrant | null> {
      const payload = await requestJson<unknown>(
        baseUrls,
        `/v1/plugins/${encodeURIComponent(pluginId)}/access`,
        { method: "POST", token, organizationId: orgId, body: { ...target, role: "viewer" } },
      );
      return parseDenLibraryAccessGrant(payload);
    },

    async revokePluginAccess(orgId: string, pluginId: string, grantId: string): Promise<void> {
      await requestJson<unknown>(
        baseUrls,
        `/v1/plugins/${encodeURIComponent(pluginId)}/access/${encodeURIComponent(grantId)}`,
        { method: "DELETE", token, organizationId: orgId },
      );
    },

    async deleteBuiltMcpApp(orgId: string, appId: string): Promise<void> {
      await requestJson<unknown>(
        baseUrls,
        `/v1/config-objects/${encodeURIComponent(appId)}/delete`,
        { method: "POST", token, organizationId: orgId, body: {} },
      );
    },

    async archivePlugin(orgId: string, pluginId: string): Promise<void> {
      await requestJson<unknown>(
        baseUrls,
        `/v1/plugins/${encodeURIComponent(pluginId)}/archive`,
        { method: "POST", token, organizationId: orgId, body: {} },
      );
    },

    async restorePlugin(orgId: string, pluginId: string): Promise<void> {
      await requestJson<unknown>(
        baseUrls,
        `/v1/plugins/${encodeURIComponent(pluginId)}/restore`,
        { method: "POST", token, organizationId: orgId, body: {} },
      );
    },

    async listPluginFiles(orgId: string, pluginId: string): Promise<DenLibraryPluginFile[]> {
      const payload = await requestJson<unknown>(
        baseUrls,
        `/v1/plugins/${encodeURIComponent(pluginId)}/config-objects`,
        { method: "GET", token, organizationId: orgId },
      );
      return parseDenLibraryPluginFiles(payload);
    },

    async getLatestConfigObjectVersion(orgId: string, configObjectId: string): Promise<DenLibraryConfigObjectVersion | null> {
      const payload = await requestJson<unknown>(
        baseUrls,
        `/v1/config-objects/${encodeURIComponent(configObjectId)}/versions/latest`,
        { method: "GET", token, organizationId: orgId },
      );
      return parseDenLibraryConfigObjectVersion(payload);
    },

    async createConfigObjectVersion(
      orgId: string,
      configObjectId: string,
      input: { rawSourceText: string; metadata: { name: string; description?: string } },
    ): Promise<void> {
      await requestJson<unknown>(
        baseUrls,
        `/v1/config-objects/${encodeURIComponent(configObjectId)}/versions`,
        { method: "POST", token, organizationId: orgId, body: { input } },
      );
    },
  };
}

export type DenClient = ReturnType<typeof createDenClient>;

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
