import os from "node:os"
import { readFileSync } from "node:fs"
import path from "node:path"
import { denUrls } from "@openwork-ee/utils/den-urls"
import { DEN_WORKER_POLL_INTERVAL_MS } from "./CONSTS.js"
import { normalizeConfiguredPublicApiBaseUrl } from "./request-url.js"
import { resolveDenServiceVersion } from "./service-version.js"
import { denApiAppVersion } from "./version.js"
import { z } from "zod"

export const DEFAULT_DEN_DIAGNOSTICS_ORIGIN = "https://diagnostic.openworklabs.com"

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_HOST: z.string().min(1).optional(),
  DATABASE_USERNAME: z.string().min(1).optional(),
  DATABASE_PASSWORD: z.string().optional(),
  DEN_DB_ENCRYPTION_KEY: z.string().trim().min(32),
  DB_MODE: z.enum(["mysql", "planetscale"]).optional(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().trim().min(1).optional(),
  DEN_BASE_URL: z.string().trim().min(1).optional(),
  DATABASE_REDIS_URL: z.string().optional(),
  DATABASE_REDIS_ALLOW_INSECURE_INTERNAL: z.string().optional(),
  DEN_MCP_RESOURCE_URL: z.string().optional(),
  DEN_MCP_ADDITIONAL_RESOURCES: z.string().optional(),
  DEN_BETTER_AUTH_COOKIE_DOMAIN: z.string().optional(),
  DEN_BETTER_AUTH_TRUSTED_ORIGINS: z.string().optional(),
  DEN_WEB_APP_HOSTS: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_CONNECTOR_APP_ID: z.string().optional(),
  GITHUB_CONNECTOR_APP_CLIENT_ID: z.string().optional(),
  GITHUB_CONNECTOR_APP_CLIENT_SECRET: z.string().optional(),
  GITHUB_CONNECTOR_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_CONNECTOR_APP_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_SYNC_WORKER_INTERVAL_MS: z.string().optional(),
  GITHUB_SYNC_RETRY_BASE_MS: z.string().optional(),
  GITHUB_SYNC_MAX_ATTEMPTS: z.string().optional(),
  GITHUB_RECONCILE_INTERVAL_MS: z.string().optional(),
  GITHUB_RECONCILE_BATCH_SIZE: z.string().optional(),
  GITHUB_RECONCILE_MIN_AGE_MS: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  DEN_ORG_MODE: z.string().optional(),
  DEN_SINGLE_ORG_NAME: z.string().optional(),
  DEN_SINGLE_ORG_SLUG: z.string().optional(),
  DEN_SINGLE_ORG_OWNER_EMAILS: z.string().optional(),
  DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: z.string().optional(),
  DEN_REQUIRE_EMAIL_VERIFICATION: z.string().optional(),
  DEN_PASSWORD_BREACH_SCREENING_ENABLED: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: z.string().optional(),
  LOOPS_API_KEY: z.string().optional(),
  LOOPS_MARKETING_ENABLED: z.string().optional(),
  LINEAR_API_KEY: z.string().optional(),
  LINEAR_COMPLIANCE_TEAM_ID: z.string().optional(),
  LINEAR_API_BASE: z.string().optional(),
  LINEAR_COMPLIANCE_COMPLETED_STATE_ID: z.string().optional(),
  OPENWORK_DEV_MODE: z.string().optional(),
  DEN_BOTID_PROTECTION_ENABLED: z.string().optional(),
  DEN_ALLOW_PRIVATE_MCP_URLS: z.string().optional(),
  DEN_DIAGNOSTICS_ORIGIN: z.string().optional(),
  DEN_DIAGNOSTICS_BEARER_TOKEN: z.string().optional(),
  DEN_GATEWAY_KEY: z.string().optional(),
  DEN_GATEWAY_ORIGIN: z.string().optional(),
  DEN_GOOGLE_OAUTH_AUTHORIZE_URL: z.string().optional(),
  DEN_GOOGLE_OAUTH_TOKEN_URL: z.string().optional(),
  DEN_GOOGLE_OAUTH_USERINFO_URL: z.string().optional(),
  DEN_GOOGLE_API_BASE_URL: z.string().optional(),
  DEN_MICROSOFT_OAUTH_AUTHORIZE_URL: z.string().optional(),
  DEN_MICROSOFT_OAUTH_TOKEN_URL: z.string().optional(),
  DEN_MICROSOFT_GRAPH_BASE_URL: z.string().optional(),
  PORT: z.string().optional(),
  CORS_ORIGINS: z.string().optional(),
  DEN_API_PUBLIC_URL: z.string().optional(),
  DEN_API_VERSION: z.string().optional(),
  RENDER_GIT_COMMIT: z.string().optional(),
  OPENWORK_INSTALLER_ARTIFACTS_DIR: z.string().optional(),
  OPENWORK_INSTALLER_RELEASE_TAG: z.string().optional(),
  OPENWORK_INSTALLER_RELEASE_REPO: z.string().optional(),
  OPENWORK_INSTALLER_CACHE_DIR: z.string().optional(),
  DEN_DESKTOP_RELEASES_BASE_URL: z.string().optional(),
  DEN_DESKTOP_RELEASES_MODE: z.enum(["github", "static"]).optional(),
  DEN_DESKTOP_DEN_BASE_URL: z.string().optional(),
  DEN_MARKETING_URL: z.string().optional(),
  DEN_MCP_CLAIM_NAMESPACE: z.string().optional(),
  DEN_BOOTSTRAP_ADMIN_EMAILS: z.string().optional(),
  DEN_INITIAL_ADMIN_BOOTSTRAP_CODE: z.string().optional(),
  DEN_INITIAL_ADMIN_BOOTSTRAP_CODE_FILE: z.string().optional(),
  WORKER_PROVISIONING_RECONCILE_INTERVAL_MS: z.string().optional(),
  WORKER_PROVISIONING_RECONCILE_STALE_MS: z.string().optional(),
  WORKER_PROVISIONING_RECONCILE_BATCH_SIZE: z.string().optional(),
  CLOUD_PROVISION_DEADLINE_MS: z.string().optional(),
  CLOUD_MATERIALIZATION_FAILURE_COOLDOWN_MS: z.string().optional(),
  CLOUD_IDLE_STOP_MINUTES: z.string().optional(),
  CLOUD_IDLE_LOOP_SECONDS: z.string().optional(),
  CLOUD_IDLE_STOP_BATCH_SIZE: z.string().optional(),
  PROVISIONER_MODE: z.enum(["stub", "render", "daytona"]).optional(),
  WORKER_URL_TEMPLATE: z.string().optional(),
  WORKER_ACTIVITY_BASE_URL: z.string().optional(),
  DEN_AUTOMATIONS_ENABLED: z.string().optional(),
  DEN_DASHBOARDS_ENABLED: z.string().optional(),
  DEN_OPENWORK_WEB_ENABLED: z.string().optional(),
  DEN_AUTOMATIONS_RUNTIME_ENABLED: z.string().optional(),
  DEN_AUTOMATIONS_POLL_INTERVAL_MS: z.string().optional(),
  DEN_AUTOMATIONS_BATCH_SIZE: z.string().optional(),
  DEN_AUTOMATIONS_MAX_CONCURRENCY: z.string().optional(),
  DEN_AUTOMATIONS_LEASE_MS: z.string().optional(),
  DEN_AUTOMATIONS_RUN_TIMEOUT_MS: z.string().optional(),
  DEN_AUTOMATIONS_RUNNER_CLAIM_DEADLINE_MS: z.string().optional(),
  OPENWORK_DAYTONA_ENV_PATH: z.string().optional(),
  RENDER_API_BASE: z.string().optional(),
  RENDER_API_KEY: z.string().optional(),
  RENDER_OWNER_ID: z.string().optional(),
  RENDER_WORKER_REPO: z.string().optional(),
  RENDER_WORKER_BRANCH: z.string().optional(),
  RENDER_WORKER_ROOT_DIR: z.string().optional(),
  RENDER_WORKER_PLAN: z.string().optional(),
  RENDER_WORKER_REGION: z.string().optional(),
  RENDER_WORKER_OPENWORK_VERSION: z.string().optional(),
  RENDER_WORKER_NAME_PREFIX: z.string().optional(),
  RENDER_WORKER_PUBLIC_DOMAIN_SUFFIX: z.string().optional(),
  RENDER_CUSTOM_DOMAIN_READY_TIMEOUT_MS: z.string().optional(),
  RENDER_PROVISION_TIMEOUT_MS: z.string().optional(),
  RENDER_HEALTHCHECK_TIMEOUT_MS: z.string().optional(),
  RENDER_POLL_INTERVAL_MS: z.string().optional(),
  VERCEL_API_BASE: z.string().optional(),
  VERCEL_TOKEN: z.string().optional(),
  VERCEL_TEAM_ID: z.string().optional(),
  VERCEL_TEAM_SLUG: z.string().optional(),
  VERCEL_DNS_DOMAIN: z.string().optional(),
  DEN_PLAN_GATING_ENABLED: z.string().optional(),
  DEN_INSTALL_LINKS_GATING_ENABLED: z.string().optional(),
  DEN_CONNECT_LINK_MODE: z.enum(["exchange", "signed"]).optional(),
  DEN_CONNECT_LINK_PRIVATE_KEY: z.string().optional(),
  DEN_CONNECT_LINK_KEY_ID: z.string().max(64).optional(),
  DEN_MCP_CONNECTIONS_GATING_ENABLED: z.string().optional(),
  DEN_GENERATED_ARTIFACT_VIEWS_ENABLED: z.string().optional(),
  SCIM_MAINTENANCE_INTERVAL_MS: z.string().optional(),
  POLAR_FEATURE_GATE_ENABLED: z.string().optional(),
  POLAR_API_BASE: z.string().optional(),
  POLAR_ACCESS_TOKEN: z.string().optional(),
  POLAR_PRODUCT_ID: z.string().optional(),
  POLAR_BENEFIT_ID: z.string().optional(),
  POLAR_SUCCESS_URL: z.string().optional(),
  POLAR_RETURN_URL: z.string().optional(),
  DAYTONA_API_URL: z.string().optional(),
  DAYTONA_API_KEY: z.string().optional(),
  DAYTONA_TARGET: z.string().optional(),
  DAYTONA_SNAPSHOT: z.string().optional(),
  DAYTONA_SANDBOX_IMAGE: z.string().optional(),
  DAYTONA_SANDBOX_CPU: z.string().optional(),
  DAYTONA_SANDBOX_MEMORY: z.string().optional(),
  DAYTONA_SANDBOX_DISK: z.string().optional(),
  DAYTONA_SANDBOX_PUBLIC: z.string().optional(),
  DAYTONA_SANDBOX_AUTO_STOP_INTERVAL: z.string().optional(),
  DAYTONA_SANDBOX_AUTO_ARCHIVE_INTERVAL: z.string().optional(),
  DAYTONA_SANDBOX_AUTO_DELETE_INTERVAL: z.string().optional(),
  DAYTONA_SIGNED_PREVIEW_EXPIRES_SECONDS: z.string().optional(),
  DAYTONA_SANDBOX_NAME_PREFIX: z.string().optional(),
  DAYTONA_SHARED_VOLUME_NAME: z.string().optional(),
  DAYTONA_VOLUME_NAME_PREFIX: z.string().optional(),
  DAYTONA_WORKSPACE_MOUNT_PATH: z.string().optional(),
  DAYTONA_DATA_MOUNT_PATH: z.string().optional(),
  DAYTONA_RUNTIME_WORKSPACE_PATH: z.string().optional(),
  DAYTONA_RUNTIME_DATA_PATH: z.string().optional(),
  DAYTONA_SIDECAR_DIR: z.string().optional(),
  DAYTONA_OPENWORK_PORT: z.string().optional(),
  DAYTONA_OPENCODE_PORT: z.string().optional(),
  DAYTONA_CREATE_TIMEOUT_SECONDS: z.string().optional(),
  DAYTONA_DELETE_TIMEOUT_SECONDS: z.string().optional(),
  DAYTONA_STOP_TIMEOUT_SECONDS: z.string().optional(),
  DAYTONA_HEALTHCHECK_TIMEOUT_MS: z.string().optional(),
  DEN_CKPT_INTERVAL_SECONDS: z.string().optional(),
  DEN_CKPT_KEEP: z.string().optional(),
  INFERENCE_PROXY_BASE_URL: z.string().optional(),
  OPENROUTER_MANAGEMENT_API_KEY: z.string().optional(),
  OPENROUTER_WORKSPACE_ID: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_INFERENCE_PRICE_ID: z.string().optional(),
  STRIPE_SEAT_PRICE_ID: z.string().optional(),
  STRIPE_OPENWORK_WEB_PRICE_ID: z.string().optional(),
  STRIPE_BILLING_SUCCESS_URL: z.string().optional(),
  STRIPE_BILLING_CANCEL_URL: z.string().optional(),
}).superRefine((value, ctx) => {
  if (!value.BETTER_AUTH_URL && !value.DEN_BASE_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "BETTER_AUTH_URL or DEN_BASE_URL is required",
      path: ["BETTER_AUTH_URL"],
    })
  }

  const inferredMode = value.DB_MODE ?? (value.DATABASE_URL ? "mysql" : "planetscale")

  if (inferredMode === "mysql" && !value.DATABASE_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "DATABASE_URL is required when using mysql mode",
      path: ["DATABASE_URL"],
    })
  }

  if (inferredMode === "planetscale") {
    for (const key of ["DATABASE_HOST", "DATABASE_USERNAME", "DATABASE_PASSWORD"] as const) {
      if (!value[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${key} is required when using planetscale mode`,
          path: [key],
        })
      }
    }
  }

  if (value.PROVISIONER_MODE === "daytona") {
    for (const key of ["DAYTONA_API_KEY"] as const) {
      if (!value[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${key} is required when PROVISIONER_MODE=daytona`,
          path: [key],
        })
      }
    }
  }
})

const parsed = EnvSchema.parse(process.env)

function splitCsv(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function uniqueStrings(values: readonly string[]) {
  return Array.from(new Set(values.filter(Boolean)))
}

// Lease and deadline math must never see NaN or a non-positive interval, so a
// malformed tuning value falls back to the default instead of poisoning it.
function automationTuning(value: string | undefined, fallback: number) {
  const tuned = Number(value)
  return Number.isSafeInteger(tuned) && tuned > 0 ? tuned : fallback
}

function optionalString(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function readOptionalSecretFile(envName: string, pathValue: string | undefined) {
  const filePath = optionalString(pathValue)
  if (!filePath) {
    return undefined
  }
  try {
    return readFileSync(filePath, "utf8").trim()
  } catch {
    throw new Error(`${envName} must point to a readable file`)
  }
}

export type DenOrgMode = "single_org" | "multi_org"

export function parseDenOrgMode(value: string | undefined): DenOrgMode {
  const normalized = value?.trim()
  if (!normalized) {
    return "single_org"
  }
  if (normalized === "single_org") {
    return "single_org"
  }
  if (normalized === "multi_org") {
    return "multi_org"
  }
  throw new Error("DEN_ORG_MODE must be single_org or multi_org")
}

export function normalizeSingleOrgSlug(value: string | undefined) {
  const normalized = (value ?? "default").trim().toLowerCase()
  if (!normalized) {
    return "default"
  }

  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalized)) {
    throw new Error("DEN_SINGLE_ORG_SLUG must contain only lowercase letters, numbers, and single hyphens")
  }

  return normalized
}

export function parseSingleOrgAllowPublicSignup(value: string | undefined, orgMode: DenOrgMode) {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) {
    return orgMode === "multi_org"
  }

  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true
  }

  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false
  }

  throw new Error("DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP must be true or false")
}

function normalizeOrigin(origin: string) {
  const value = origin.trim()
  if (value === "*") {
    return value
  }
  return value.replace(/\/+$/, "")
}

function normalizePublicWebOrigin(origin: string) {
  const value = origin.trim()
  const url = new URL(value)
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("BETTER_AUTH_URL or DEN_BASE_URL must use http or https")
  }
  return url.origin
}

function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "0.0.0.0" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]"
}

function denBaseUrlIsLoopback(denBaseUrl: string | undefined) {
  if (!denBaseUrl) return false
  try {
    return isLoopbackHostname(new URL(denBaseUrl).hostname)
  } catch {
    return false
  }
}

function deriveApiPublicUrlFromWebOrigin(input: { devMode: boolean; port: number; webOrigin: string }) {
  const web = new URL(input.webOrigin)
  if (input.devMode && isLoopbackHostname(web.hostname)) {
    return `http://127.0.0.1:${input.port}`
  }
  const api = new URL(web.toString())
  api.hostname = `api.${web.hostname}`
  return api.origin
}

function isLocalRedisHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"
}

function parseBooleanFlag(value: string | undefined) {
  const normalized = value?.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
}

function normalizeRedisUrl(value: string | undefined, allowInsecureInternal: boolean) {
  const configured = optionalString(value)
  if (!configured) {
    return undefined
  }

  let url: URL
  try {
    url = new URL(configured)
  } catch {
    throw new Error("DATABASE_REDIS_URL must be an absolute redis:// or rediss:// URL.")
  }

  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("DATABASE_REDIS_URL must use redis:// or rediss://.")
  }

  if (url.protocol === "redis:" && !isLocalRedisHost(url.hostname) && !allowInsecureInternal) {
    throw new Error("DATABASE_REDIS_URL must use rediss:// for non-local Redis endpoints unless DATABASE_REDIS_ALLOW_INSECURE_INTERNAL=1 is set for a trusted private network.")
  }

  return url.toString()
}

function normalizeDiagnosticsOrigin(value: string | undefined, allowInsecureHttp: boolean) {
  const configured = optionalString(value) ?? DEFAULT_DEN_DIAGNOSTICS_ORIGIN

  let url: URL
  try {
    url = new URL(configured)
  } catch {
    throw new Error("DEN_DIAGNOSTICS_ORIGIN must be an absolute http or https origin.")
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("DEN_DIAGNOSTICS_ORIGIN must be an absolute http or https origin.")
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("DEN_DIAGNOSTICS_ORIGIN cannot contain credentials, a path, a query string, or a fragment.")
  }
  if (url.protocol !== "https:" && !allowInsecureHttp) {
    throw new Error("DEN_DIAGNOSTICS_ORIGIN must use HTTPS outside development.")
  }
  return url.origin
}

function normalizeOptionalHttpsOrigin(envName: string, value: string | undefined) {
  const configured = optionalString(value)
  if (!configured) {
    return undefined
  }

  let url: URL
  try {
    url = new URL(configured)
  } catch {
    throw new Error(`${envName} must be an absolute https origin.`)
  }

  if (url.protocol !== "https:") {
    throw new Error(`${envName} must be an absolute https origin.`)
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error(`${envName} cannot contain credentials, a path, a query string, or a fragment.`)
  }

  return url.origin
}

function normalizeAbsoluteUrlCsv(envName: string, value: string | undefined) {
  const entries = splitCsv(value)
  const invalidEntries: string[] = []

  for (const entry of entries) {
    try {
      new URL(entry)
    } catch {
      invalidEntries.push(entry)
    }
  }

  if (invalidEntries.length > 0) {
    const label = invalidEntries.length === 1 ? "entry" : "entries"
    throw new Error(`${envName} must contain only absolute URLs; invalid ${label}: ${invalidEntries.join(", ")}`)
  }

  return entries.map((entry) => normalizeOrigin(entry))
}

const configuredDenUrls = optionalString(parsed.DEN_BASE_URL)
  ? denUrls({ DEN_BASE_URL: parsed.DEN_BASE_URL })
  : undefined
const configuredDenWebOrigin = configuredDenUrls?.web
const betterAuthUrlInput = optionalString(parsed.BETTER_AUTH_URL) ?? configuredDenUrls?.web
if (!betterAuthUrlInput) {
  throw new Error("BETTER_AUTH_URL or DEN_BASE_URL is required")
}
const betterAuthUrl = normalizeOrigin(betterAuthUrlInput)
const betterAuthPublicWebOrigin = normalizePublicWebOrigin(betterAuthUrl)
const derivedWebOrigins = uniqueStrings([
  ...(configuredDenWebOrigin ? [configuredDenWebOrigin] : []),
  betterAuthPublicWebOrigin,
])
const corsOrigins = uniqueStrings([
  ...derivedWebOrigins,
  ...splitCsv(parsed.CORS_ORIGINS).map((origin) => normalizeOrigin(origin)),
])
const betterAuthTrustedOrigins = uniqueStrings([
  ...derivedWebOrigins,
  ...splitCsv(parsed.DEN_BETTER_AUTH_TRUSTED_ORIGINS).map((origin) => normalizeOrigin(origin)),
])
const configuredMcpResourceUrl = optionalString(parsed.DEN_MCP_RESOURCE_URL)
const mcpAdditionalResources = normalizeAbsoluteUrlCsv(
  "DEN_MCP_ADDITIONAL_RESOURCES",
  parsed.DEN_MCP_ADDITIONAL_RESOURCES,
)

const polarFeatureGateEnabled =
  (parsed.POLAR_FEATURE_GATE_ENABLED ?? "false").toLowerCase() === "true"

const planGatingEnabled =
  (parsed.DEN_PLAN_GATING_ENABLED ?? "false").toLowerCase() === "true"

// Deprecated compatibility knob for organization install links. The environment
// variable is still parsed so existing deployment configs keep starting, but
// organizationInstallLinksEnabled ignores this value: install links are
// default-on unless org metadata explicitly disables them.
const installLinksGatingEnabled =
  (parsed.DEN_INSTALL_LINKS_GATING_ENABLED ?? String(planGatingEnabled)).toLowerCase() === "true"

// Exchange mode is the zero-config default. Signed mode is an explicit v2
// opt-in because its public key must already be trusted by the desktop build.
const connectLinkMode = parsed.DEN_CONNECT_LINK_MODE ?? "exchange"
const connectLinkPrivateKeyPem = optionalString(parsed.DEN_CONNECT_LINK_PRIVATE_KEY)
const connectLinkKid = optionalString(parsed.DEN_CONNECT_LINK_KEY_ID)
if (connectLinkMode === "signed" && (!connectLinkPrivateKeyPem || !connectLinkKid)) {
  throw new Error(
    "DEN_CONNECT_LINK_MODE=signed requires DEN_CONNECT_LINK_PRIVATE_KEY and DEN_CONNECT_LINK_KEY_ID.",
  )
}
const initialAdminBootstrapCode = optionalString(parsed.DEN_INITIAL_ADMIN_BOOTSTRAP_CODE)
  ?? readOptionalSecretFile("DEN_INITIAL_ADMIN_BOOTSTRAP_CODE_FILE", parsed.DEN_INITIAL_ADMIN_BOOTSTRAP_CODE_FILE)
const connectLink = connectLinkMode === "signed" && connectLinkPrivateKeyPem && connectLinkKid
  ? { privateKeyPem: connectLinkPrivateKeyPem, kid: connectLinkKid }
  : null

// Deprecated compatibility knob for member-facing org MCP connections. The
// environment variable is still parsed so existing deployment configs keep
// starting, but memberFacingMcpConnectionsEnabled ignores this value: Connect is
// default-on unless org metadata explicitly disables it.
const mcpConnectionsGatingEnabled =
  (parsed.DEN_MCP_CONNECTIONS_GATING_ENABLED ?? "false").toLowerCase() === "true"

// Generated custom views require the matching desktop MCP Apps host release.
// Keep the Den capability fail-closed so a Den deployment cannot advertise
// bridge-dependent resources to older published desktop builds.
const generatedArtifactViewsEnabled =
  (parsed.DEN_GENERATED_ARTIFACT_VIEWS_ENABLED ?? "false").trim().toLowerCase() === "true"

// Desktop availability stays fail-closed, while an entirely unconfigured
// server preserves the published-client runtime. An explicit availability
// value also supplies the runtime default, so DEN_AUTOMATIONS_ENABLED=false is
// a complete shutdown unless a mixed-version deployment explicitly keeps the
// compatibility runtime on. A disabled runtime always forces availability off.
const automationsRuntimeEnabled = parseBooleanFlag(
  parsed.DEN_AUTOMATIONS_RUNTIME_ENABLED
    ?? parsed.DEN_AUTOMATIONS_ENABLED
    ?? "true",
)
const automationsEnabled = automationsRuntimeEnabled
  && parseBooleanFlag(parsed.DEN_AUTOMATIONS_ENABLED ?? "false")
const dashboardsEnabled = parseBooleanFlag(parsed.DEN_DASHBOARDS_ENABLED ?? "false")
const openworkWebEnabled = parseBooleanFlag(parsed.DEN_OPENWORK_WEB_ENABLED ?? "false")

const devMode = (parsed.OPENWORK_DEV_MODE ?? "0").trim() === "1"
const port = Number(parsed.PORT ?? "8790")
const botIdProtectionEnabled = (parsed.DEN_BOTID_PROTECTION_ENABLED ?? "0").trim() === "1"
const diagnosticsOrigin = normalizeDiagnosticsOrigin(parsed.DEN_DIAGNOSTICS_ORIGIN, devMode)
const diagnosticsBearerToken = optionalString(parsed.DEN_DIAGNOSTICS_BEARER_TOKEN)
if (diagnosticsBearerToken && diagnosticsBearerToken.length < 24) {
  throw new Error("DEN_DIAGNOSTICS_BEARER_TOKEN must contain at least 24 characters.")
}
const derivedDenApiPublicUrl = configuredDenUrls && devMode && denBaseUrlIsLoopback(configuredDenUrls.web)
  ? `http://127.0.0.1:${port}`
  : configuredDenUrls?.api ?? deriveApiPublicUrlFromWebOrigin({ devMode, port, webOrigin: betterAuthPublicWebOrigin })
const apiPublicUrl = normalizeConfiguredPublicApiBaseUrl(
  optionalString(parsed.DEN_API_PUBLIC_URL) ?? derivedDenApiPublicUrl,
  {
    allowInsecureHttp: devMode,
  },
)
function deriveBetterAuthCookieDomain(input: { webOrigin: string; apiPublicUrl: string | undefined }) {
  if (!input.apiPublicUrl) return undefined
  const web = new URL(input.webOrigin)
  const api = new URL(input.apiPublicUrl)
  if (web.protocol !== "https:" || api.protocol !== "https:") return undefined
  const webHost = web.hostname.toLowerCase()
  const apiHost = api.hostname.toLowerCase()
  return apiHost.endsWith(`.${webHost}`) ? webHost : undefined
}
function normalizeBetterAuthCookieDomain(value: string | undefined) {
  const configured = optionalString(value)
  if (!configured) return undefined

  const domain = configured.replace(/^\.+/, "").trim().toLowerCase()
  if (!domain) {
    throw new Error("DEN_BETTER_AUTH_COOKIE_DOMAIN must be a domain name, not an empty value.")
  }

  let parsedDomain: URL
  try {
    parsedDomain = new URL(`https://${domain}`)
  } catch {
    throw new Error("DEN_BETTER_AUTH_COOKIE_DOMAIN must be a valid domain name without protocol, path, query, or fragment.")
  }

  if (parsedDomain.hostname !== domain || parsedDomain.port || parsedDomain.username || parsedDomain.password || parsedDomain.pathname !== "/" || parsedDomain.search || parsedDomain.hash) {
    throw new Error("DEN_BETTER_AUTH_COOKIE_DOMAIN must be a valid domain name without protocol, path, query, or fragment.")
  }

  return domain
}
const betterAuthCookieDomain = normalizeBetterAuthCookieDomain(parsed.DEN_BETTER_AUTH_COOKIE_DOMAIN) ?? deriveBetterAuthCookieDomain({
  webOrigin: betterAuthPublicWebOrigin,
  apiPublicUrl,
})
const mcpResourceUrl = configuredMcpResourceUrl ?? (configuredDenUrls ? `${apiPublicUrl}/mcp` : undefined)
const publicUrlTrustedOrigins = Array.from(new Set([
  ...corsOrigins,
  ...betterAuthTrustedOrigins,
])).filter((origin) => origin !== "*")
// Den Web serves this API under /api/den on the better-auth origin, so a
// request forwarded from that origin is first-party by construction. Hosted
// deployments proxy browser and desktop calls server-side and never need that
// origin in CORS_ORIGINS, so deriving public routes from the CORS allowlist
// alone silently drops the one origin clients actually call.
const publicProxyTrustedOrigins = Array.from(new Set([
  betterAuthUrl,
  ...publicUrlTrustedOrigins,
]))
const orgMode = parseDenOrgMode(parsed.DEN_ORG_MODE)
// SSRF guard for External MCP Connection URLs: on hosted (multi-tenant)
// deployments, Den must not fetch private/reserved addresses on behalf of
// users. Self-hosted deployments whose MCP servers legitimately live on a
// private network can opt out with DEN_ALLOW_PRIVATE_MCP_URLS=1; local dev
// (OPENWORK_DEV_MODE=1) is exempt automatically so evals against a local
// stand-in server keep working.
const allowPrivateMcpUrls = devMode || (parsed.DEN_ALLOW_PRIVATE_MCP_URLS ?? "0").trim() === "1"
const allowInsecureInternalRedis = parseBooleanFlag(parsed.DATABASE_REDIS_ALLOW_INSECURE_INTERNAL)
const requireEmailVerification = parsed.DEN_REQUIRE_EMAIL_VERIFICATION === undefined
  ? orgMode === "multi_org" && !devMode
  : parsed.DEN_REQUIRE_EMAIL_VERIFICATION.trim().toLowerCase() !== "false"
// Fail-closed even in dev mode: offline rigs opt out explicitly via DEN_PASSWORD_BREACH_SCREENING_ENABLED=false.
const passwordBreachScreeningEnabled = parsed.DEN_PASSWORD_BREACH_SCREENING_ENABLED === undefined
  ? true
  : parsed.DEN_PASSWORD_BREACH_SCREENING_ENABLED.trim().toLowerCase() !== "false"

const daytonaSandboxPublic =
  (parsed.DAYTONA_SANDBOX_PUBLIC ?? "false").toLowerCase() === "true"

const planetscaleCredentials =
  parsed.DATABASE_HOST && parsed.DATABASE_USERNAME && parsed.DATABASE_PASSWORD !== undefined
    ? {
        host: parsed.DATABASE_HOST,
        username: parsed.DATABASE_USERNAME,
        password: parsed.DATABASE_PASSWORD,
      }
    : null

export const env = {
  databaseUrl: parsed.DATABASE_URL,
  dbEncryptionKey: optionalString(parsed.DEN_DB_ENCRYPTION_KEY),
  dbMode: parsed.DB_MODE ?? (parsed.DATABASE_URL ? "mysql" : "planetscale"),
  planetscale: planetscaleCredentials,
  betterAuthSecret: parsed.BETTER_AUTH_SECRET,
  betterAuthUrl,
  betterAuthCookieDomain,
  webUrl: normalizePublicWebOrigin(betterAuthUrl),
  // SECURITY: `redis://` carries cached auth-session material in plaintext.
  // Non-local redis:// is rejected by default. Hosted platforms such as Render
  // may provide a private, non-public internal Redis URL without TLS; operators
  // must explicitly opt in with DATABASE_REDIS_ALLOW_INSECURE_INTERNAL=1 after
  // confirming the endpoint is only reachable inside a trusted private network.
  databaseRedisUrl: normalizeRedisUrl(parsed.DATABASE_REDIS_URL, allowInsecureInternalRedis),
  databaseRedisAllowInsecureInternal: allowInsecureInternalRedis,
  mcpResourceUrl: mcpResourceUrl
    ? normalizeOrigin(mcpResourceUrl)
    : devMode
      ? `http://127.0.0.1:${port}/mcp`
      : undefined,
  mcpAdditionalResources,
  betterAuthTrustedOrigins: betterAuthTrustedOrigins.length > 0 ? betterAuthTrustedOrigins : corsOrigins,
  // Extra hostnames that serve the den-web frontend (and therefore expose
  // the Den API behind the /api/den proxy path). Entries starting with "."
  // are treated as suffix matches, e.g. ".example.com".
  webAppHosts: uniqueStrings([
    ...derivedWebOrigins.map((origin) => new URL(origin).hostname.toLowerCase()),
    ...splitCsv(parsed.DEN_WEB_APP_HOSTS).map((host) => host.toLowerCase()),
  ]),
  devMode,
  botIdProtectionEnabled,
  allowPrivateMcpUrls,
  diagnostics: {
    origin: diagnosticsOrigin,
    bearerToken: diagnosticsBearerToken,
  },
  gatewayKey: optionalString(parsed.DEN_GATEWAY_KEY),
  gatewayOrigin: normalizeOptionalHttpsOrigin("DEN_GATEWAY_ORIGIN", parsed.DEN_GATEWAY_ORIGIN),
  planGatingEnabled,
  installLinksGatingEnabled,
  connectLink,
  mcpConnectionsGatingEnabled,
  generatedArtifactViewsEnabled,
  scimMaintenanceIntervalMs: Number(parsed.SCIM_MAINTENANCE_INTERVAL_MS ?? "300000"),
  requireEmailVerification,
  passwordBreachScreeningEnabled,
  github: {
    clientId: optionalString(parsed.GITHUB_CLIENT_ID),
    clientSecret: optionalString(parsed.GITHUB_CLIENT_SECRET),
  },
  githubConnectorApp: {
    appId: optionalString(parsed.GITHUB_CONNECTOR_APP_ID),
    clientId: optionalString(parsed.GITHUB_CONNECTOR_APP_CLIENT_ID),
    clientSecret: optionalString(parsed.GITHUB_CONNECTOR_APP_CLIENT_SECRET),
    privateKey: optionalString(parsed.GITHUB_CONNECTOR_APP_PRIVATE_KEY),
    webhookSecret: optionalString(parsed.GITHUB_CONNECTOR_APP_WEBHOOK_SECRET),
  },
  githubSync: {
    workerIntervalMs: Number(parsed.GITHUB_SYNC_WORKER_INTERVAL_MS ?? "5000"),
    retryBaseMs: Number(parsed.GITHUB_SYNC_RETRY_BASE_MS ?? "30000"),
    maxAttempts: Number(parsed.GITHUB_SYNC_MAX_ATTEMPTS ?? "5"),
    reconcileIntervalMs: Number(parsed.GITHUB_RECONCILE_INTERVAL_MS ?? "900000"),
    reconcileBatchSize: Number(parsed.GITHUB_RECONCILE_BATCH_SIZE ?? "25"),
    reconcileMinAgeMs: Number(parsed.GITHUB_RECONCILE_MIN_AGE_MS ?? "21600000"),
  },
  google: {
    clientId: optionalString(parsed.GOOGLE_CLIENT_ID),
    clientSecret: optionalString(parsed.GOOGLE_CLIENT_SECRET),
  },
  email: {
    from: optionalString(parsed.EMAIL_FROM),
  },
  resend: {
    apiKey: optionalString(parsed.RESEND_API_KEY),
  },
  smtp: {
    host: optionalString(parsed.SMTP_HOST),
    port: Number(parsed.SMTP_PORT ?? "587"),
    user: optionalString(parsed.SMTP_USER),
    pass: optionalString(parsed.SMTP_PASS),
    secure: (parsed.SMTP_SECURE ?? "false").toLowerCase() === "true",
  },
  loops: {
    apiKey: optionalString(parsed.LOOPS_API_KEY),
    marketingEnabled: parsed.LOOPS_MARKETING_ENABLED?.trim() === "1",
  },
  linear: {
    apiKey: optionalString(parsed.LINEAR_API_KEY),
    teamId: optionalString(parsed.LINEAR_COMPLIANCE_TEAM_ID),
    apiBase: optionalString(parsed.LINEAR_API_BASE) ?? "https://api.linear.app/graphql",
    completedStateId: optionalString(parsed.LINEAR_COMPLIANCE_COMPLETED_STATE_ID),
  },
  orgMode,
  singleOrg: {
    name: optionalString(parsed.DEN_SINGLE_ORG_NAME) ?? "OpenWork",
    slug: normalizeSingleOrgSlug(parsed.DEN_SINGLE_ORG_SLUG),
    allowPublicSignup: parseSingleOrgAllowPublicSignup(parsed.DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP, orgMode),
    ownerEmails: splitCsv(parsed.DEN_SINGLE_ORG_OWNER_EMAILS)
      .map((email) => email.toLowerCase()),
  },
  port,
  corsOrigins,
  apiPublicUrl,
  serviceVersion: resolveDenServiceVersion({
    configuredVersion: parsed.DEN_API_VERSION,
    renderGitCommit: parsed.RENDER_GIT_COMMIT,
  }),
  publicUrlTrustedOrigins,
  publicProxyTrustedOrigins,
  installerArtifactsDir: optionalString(parsed.OPENWORK_INSTALLER_ARTIFACTS_DIR),
  // Standard desktop release assets: the release tag to download from,
  // defaulting to the pinned app release this den-api build shipped with.
  installerReleaseTag: optionalString(parsed.OPENWORK_INSTALLER_RELEASE_TAG) ?? `v${denApiAppVersion.latestAppVersion}`,
  installerReleaseTagExplicit: optionalString(parsed.OPENWORK_INSTALLER_RELEASE_TAG) !== undefined,
  installerReleaseRepo: optionalString(parsed.OPENWORK_INSTALLER_RELEASE_REPO) ?? "different-ai/openwork",
  installerCacheDir: optionalString(parsed.OPENWORK_INSTALLER_CACHE_DIR) ?? path.join(os.tmpdir(), "openwork-desktop-artifacts"),
  // Desktop-release endpoint overrides for evals/self-host testing. Static mode
  // keeps air-gapped deployments on the committed release snapshot.
  desktopReleasesBaseUrl: optionalString(parsed.DEN_DESKTOP_RELEASES_BASE_URL),
  desktopReleasesMode: parsed.DEN_DESKTOP_RELEASES_MODE ?? "github",
  // Native-provider endpoint overrides for evals/self-host testing. Unset in
  // production so Google, Microsoft Entra, and Graph use their public APIs.
  googleOAuthAuthorizeUrl: optionalString(parsed.DEN_GOOGLE_OAUTH_AUTHORIZE_URL),
  googleOAuthTokenUrl: optionalString(parsed.DEN_GOOGLE_OAUTH_TOKEN_URL),
  googleOAuthUserinfoUrl: optionalString(parsed.DEN_GOOGLE_OAUTH_USERINFO_URL),
  googleApiBaseUrl: optionalString(parsed.DEN_GOOGLE_API_BASE_URL),
  microsoftOAuthAuthorizeUrl: optionalString(parsed.DEN_MICROSOFT_OAUTH_AUTHORIZE_URL),
  microsoftOAuthTokenUrl: optionalString(parsed.DEN_MICROSOFT_OAUTH_TOKEN_URL),
  microsoftGraphBaseUrl: optionalString(parsed.DEN_MICROSOFT_GRAPH_BASE_URL),
  desktopDenBaseUrl: optionalString(parsed.DEN_DESKTOP_DEN_BASE_URL),
  marketingUrl: optionalString(parsed.DEN_MARKETING_URL) ?? configuredDenUrls?.web,
  mcpClaimNamespace: normalizeOrigin(optionalString(parsed.DEN_MCP_CLAIM_NAMESPACE) ?? betterAuthUrl),
  bootstrapAdminEmails: splitCsv(parsed.DEN_BOOTSTRAP_ADMIN_EMAILS).map((email) => email.toLowerCase()),
  initialAdminBootstrapCode,
  provisionerMode: parsed.PROVISIONER_MODE ?? "stub",
  workerProvisioningReconcileIntervalMs: Number(parsed.WORKER_PROVISIONING_RECONCILE_INTERVAL_MS ?? "60000"),
  // Live provisioning owners heartbeat `updated_at` every 30 seconds, so this
  // staleness only fires after several missed beats. Keep it several multiples
  // of `provisioningHeartbeatIntervalMs`.
  workerProvisioningReconcileStaleMs: Number(parsed.WORKER_PROVISIONING_RECONCILE_STALE_MS ?? "180000"),
  workerProvisioningReconcileBatchSize: Number(parsed.WORKER_PROVISIONING_RECONCILE_BATCH_SIZE ?? "10"),
  cloudProvisionDeadlineMs: Number(parsed.CLOUD_PROVISION_DEADLINE_MS ?? "900000"),
  cloudMaterializationFailureCooldownMs: Number(parsed.CLOUD_MATERIALIZATION_FAILURE_COOLDOWN_MS ?? "120000"),
  cloudIdleStopMs: Number(parsed.CLOUD_IDLE_STOP_MINUTES ?? "30") * 60_000,
  cloudIdleLoopIntervalMs: Number(parsed.CLOUD_IDLE_LOOP_SECONDS ?? "60") * 1000,
  cloudIdleStopBatchSize: Number(parsed.CLOUD_IDLE_STOP_BATCH_SIZE ?? "10"),
  workerUrlTemplate: parsed.WORKER_URL_TEMPLATE,
  workerActivityBaseUrl:
    optionalString(parsed.WORKER_ACTIVITY_BASE_URL) ??
    betterAuthUrl,
  automations: {
    enabled: automationsEnabled,
    runtimeEnabled: automationsRuntimeEnabled,
    pollIntervalMs: automationTuning(parsed.DEN_AUTOMATIONS_POLL_INTERVAL_MS, 15_000),
    batchSize: automationTuning(parsed.DEN_AUTOMATIONS_BATCH_SIZE, 25),
    maxConcurrency: automationTuning(parsed.DEN_AUTOMATIONS_MAX_CONCURRENCY, 4),
    leaseMs: automationTuning(parsed.DEN_AUTOMATIONS_LEASE_MS, 60_000),
    runTimeoutMs: automationTuning(parsed.DEN_AUTOMATIONS_RUN_TIMEOUT_MS, 900_000),
    // How long a desktop occurrence stays claimable. A desktop is a laptop
    // that sleeps, restarts, and changes networks, so this is a recovery
    // window rather than a liveness check: a desktop that returns inside it
    // still runs the occurrence, and only a genuinely absent desktop misses.
    // Runs never stay claimable past their own next occurrence.
    runnerClaimDeadlineMs: automationTuning(parsed.DEN_AUTOMATIONS_RUNNER_CLAIM_DEADLINE_MS, 900_000),
  },
  dashboardsEnabled,
  openworkWebEnabled,
  inferenceProxyBaseUrl: optionalString(parsed.INFERENCE_PROXY_BASE_URL) ?? "http://127.0.0.1:8791",
  openRouterManagementApiKey: optionalString(parsed.OPENROUTER_MANAGEMENT_API_KEY),
  openRouterWorkspaceId: optionalString(parsed.OPENROUTER_WORKSPACE_ID),
  stripe: {
    secretKey: optionalString(parsed.STRIPE_SECRET_KEY),
    webhookSecret: optionalString(parsed.STRIPE_WEBHOOK_SECRET),
    inferencePriceId: optionalString(parsed.STRIPE_INFERENCE_PRICE_ID),
    seatPriceId: optionalString(parsed.STRIPE_SEAT_PRICE_ID),
    openworkWebPriceId: optionalString(parsed.STRIPE_OPENWORK_WEB_PRICE_ID),
    billingSuccessUrl: optionalString(parsed.STRIPE_BILLING_SUCCESS_URL),
    billingCancelUrl: optionalString(parsed.STRIPE_BILLING_CANCEL_URL),
  },
  render: {
    apiBase: parsed.RENDER_API_BASE ?? "https://api.render.com/v1",
    apiKey: parsed.RENDER_API_KEY,
    ownerId: parsed.RENDER_OWNER_ID,
    workerRepo:
      // TODO(ent): require RENDER_WORKER_REPO for hosted/customer Render deployments instead of using OpenWork's public repo default.
      parsed.RENDER_WORKER_REPO ?? "https://github.com/different-ai/openwork",
    workerBranch: parsed.RENDER_WORKER_BRANCH ?? "dev",
    workerRootDir:
      parsed.RENDER_WORKER_ROOT_DIR ?? "ee/apps/den-worker-runtime",
    workerPlan: parsed.RENDER_WORKER_PLAN ?? "standard",
    workerRegion: parsed.RENDER_WORKER_REGION ?? "oregon",
    workerOpenworkVersion: parsed.RENDER_WORKER_OPENWORK_VERSION,
    workerNamePrefix: parsed.RENDER_WORKER_NAME_PREFIX ?? "den-worker",
    workerPublicDomainSuffix: parsed.RENDER_WORKER_PUBLIC_DOMAIN_SUFFIX,
    customDomainReadyTimeoutMs: Number(
      parsed.RENDER_CUSTOM_DOMAIN_READY_TIMEOUT_MS ?? "240000",
    ),
    provisionTimeoutMs: Number(parsed.RENDER_PROVISION_TIMEOUT_MS ?? "900000"),
    healthcheckTimeoutMs: Number(
      parsed.RENDER_HEALTHCHECK_TIMEOUT_MS ?? "180000",
    ),
    pollIntervalMs: Number(parsed.RENDER_POLL_INTERVAL_MS ?? "5000"),
  },
  vercel: {
    apiBase: parsed.VERCEL_API_BASE ?? "https://api.vercel.com",
    token: parsed.VERCEL_TOKEN,
    teamId: parsed.VERCEL_TEAM_ID,
    teamSlug: parsed.VERCEL_TEAM_SLUG,
    dnsDomain: parsed.VERCEL_DNS_DOMAIN,
  },
  polar: {
    featureGateEnabled: polarFeatureGateEnabled,
    apiBase: parsed.POLAR_API_BASE ?? "https://api.polar.sh",
    accessToken: parsed.POLAR_ACCESS_TOKEN,
    productId: parsed.POLAR_PRODUCT_ID,
    benefitId: parsed.POLAR_BENEFIT_ID,
    successUrl: parsed.POLAR_SUCCESS_URL,
    returnUrl: parsed.POLAR_RETURN_URL,
  },
  daytona: {
    envPath: optionalString(parsed.OPENWORK_DAYTONA_ENV_PATH),
    apiUrl: optionalString(parsed.DAYTONA_API_URL) ?? "https://app.daytona.io/api",
    apiKey: optionalString(parsed.DAYTONA_API_KEY),
    target: optionalString(parsed.DAYTONA_TARGET),
    snapshot: optionalString(parsed.DAYTONA_SNAPSHOT),
    image: optionalString(parsed.DAYTONA_SANDBOX_IMAGE) ?? "node:20-bookworm",
    resources: {
      cpu: Number(parsed.DAYTONA_SANDBOX_CPU ?? "2"),
      memory: Number(parsed.DAYTONA_SANDBOX_MEMORY ?? "4"),
      disk: Number(parsed.DAYTONA_SANDBOX_DISK ?? "8"),
    },
    public: daytonaSandboxPublic,
    autoStopInterval: Number(parsed.DAYTONA_SANDBOX_AUTO_STOP_INTERVAL ?? "0"),
    autoArchiveInterval: Number(
      parsed.DAYTONA_SANDBOX_AUTO_ARCHIVE_INTERVAL ?? "10080",
    ),
    autoDeleteInterval: Number(
      parsed.DAYTONA_SANDBOX_AUTO_DELETE_INTERVAL ?? "-1",
    ),
    signedPreviewExpiresSeconds: Number(
      parsed.DAYTONA_SIGNED_PREVIEW_EXPIRES_SECONDS ?? "86400",
    ),
    sandboxNamePrefix:
      optionalString(parsed.DAYTONA_SANDBOX_NAME_PREFIX) ?? "den-daytona-worker",
    sharedVolumeName:
      optionalString(parsed.DAYTONA_SHARED_VOLUME_NAME) ??
      optionalString(parsed.DAYTONA_VOLUME_NAME_PREFIX) ??
      "den-daytona-workers",
    workspaceMountPath:
      optionalString(parsed.DAYTONA_WORKSPACE_MOUNT_PATH) ?? "/workspace",
    dataMountPath:
      optionalString(parsed.DAYTONA_DATA_MOUNT_PATH) ?? "/persist/openwork",
    runtimeWorkspacePath:
      optionalString(parsed.DAYTONA_RUNTIME_WORKSPACE_PATH) ??
      "/tmp/openwork-workspace",
    runtimeDataPath:
      optionalString(parsed.DAYTONA_RUNTIME_DATA_PATH) ?? "/tmp/openwork-data",
    sidecarDir:
      optionalString(parsed.DAYTONA_SIDECAR_DIR) ?? "/tmp/openwork-sidecars",
    openworkPort: Number(parsed.DAYTONA_OPENWORK_PORT ?? "8787"),
    opencodePort: Number(parsed.DAYTONA_OPENCODE_PORT ?? "4096"),
    createTimeoutSeconds: Number(parsed.DAYTONA_CREATE_TIMEOUT_SECONDS ?? "300"),
    deleteTimeoutSeconds: Number(parsed.DAYTONA_DELETE_TIMEOUT_SECONDS ?? "120"),
    stopTimeoutSeconds: parsed.DAYTONA_STOP_TIMEOUT_SECONDS === undefined
      ? undefined
      : Number(parsed.DAYTONA_STOP_TIMEOUT_SECONDS),
    healthcheckTimeoutMs: Number(
      parsed.DAYTONA_HEALTHCHECK_TIMEOUT_MS ?? "300000",
    ),
    checkpointIntervalSeconds: Number(parsed.DEN_CKPT_INTERVAL_SECONDS ?? "300"),
    checkpointKeep: Number(parsed.DEN_CKPT_KEEP ?? "3"),
    pollIntervalMs: DEN_WORKER_POLL_INTERVAL_MS,
  },
}
