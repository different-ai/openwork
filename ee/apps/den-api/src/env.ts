import os from "node:os"
import { readFileSync } from "node:fs"
import path from "node:path"
import { CLIENT_IP_SECRET_MIN_LENGTH } from "@openwork-ee/utils/client-ip-signature"
import { denUrls } from "@openwork-ee/utils/den-urls"
import { parseGatewayDeploymentEnv } from "@openwork-ee/utils/gateway-env"
import { readReplicaCredentialsFromEnv } from "@openwork-ee/den-db"
import { DEN_WORKER_POLL_INTERVAL_MS } from "./CONSTS.js"
import { DEN_API_KEY_RATE_LIMIT_MAX_DEFAULT } from "./api-key-constants.js"
import { normalizeConfiguredPublicApiBaseUrl } from "./request-url.js"
import { resolveDenServiceVersion } from "./service-version.js"
import { denApiAppVersion } from "./version.js"
import { readFreeInferenceConfig } from "@openwork/types/den/inference"
import { readWorkbotFreeGrantSecret } from "@openwork/free-auto/node"
import { parseFeatureEnvironment } from "@openwork/features"
import { partitionConfigSecretEnvAllowlist } from "./config-blobs/env-secrets.js"
import { EnvSchema } from "./env-schema.js"
import { tuning } from "./tuning.js"

const gatewayDeployment = parseGatewayDeploymentEnv(process.env)
const parsed = EnvSchema.parse({
  ...process.env,
  GATEWAY_PROXY_BASE_URL: process.env.GATEWAY_PROXY_BASE_URL ?? process.env.INFERENCE_PROXY_BASE_URL,
})

function splitCsv(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function uniqueStrings(values: readonly string[]) {
  return Array.from(new Set(values.filter(Boolean)))
}

function positiveInteger(value: string | undefined, fallback: number) {
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

export function parseApiKeyRateLimitMax(value: string | undefined): number {
  const trimmed = value?.trim()
  if (!trimmed) return DEN_API_KEY_RATE_LIMIT_MAX_DEFAULT
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("DEN_API_KEY_RATE_LIMIT_MAX must be a whole number of at least 1")
  }
  return parsed
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

const planGatingEnabled =
  (parsed.DEN_PLAN_GATING_ENABLED ?? "false").toLowerCase() === "true"

const initialAdminBootstrapCode = optionalString(parsed.DEN_INITIAL_ADMIN_BOOTSTRAP_CODE)
  ?? readOptionalSecretFile("DEN_INITIAL_ADMIN_BOOTSTRAP_CODE_FILE", parsed.DEN_INITIAL_ADMIN_BOOTSTRAP_CODE_FILE)
const generatedArtifactViewsEnabled =
  (parsed.DEN_GENERATED_ARTIFACT_VIEWS_ENABLED ?? "false").trim().toLowerCase() === "true"

const appMcpServersEnabled = parseBooleanFlag(optionalString(parsed.DEN_APP_MCP_SERVERS_ENABLED) ?? "true")

const automationsRuntimeEnabled = parseBooleanFlag(
  parsed.DEN_AUTOMATIONS_RUNTIME_ENABLED
    ?? parsed.DEN_AUTOMATIONS_ENABLED
    ?? "true",
)
const automationsEnabled = automationsRuntimeEnabled
  && parseBooleanFlag(parsed.DEN_AUTOMATIONS_ENABLED ?? "true")
const dashboardsEnabled = parseBooleanFlag(parsed.DEN_DASHBOARDS_ENABLED ?? "false")

const featureEnvironment = parseFeatureEnvironment(process.env)
const fatalFeatureProblems = featureEnvironment.problems.filter((problem) => problem.fatal)
if (fatalFeatureProblems.length > 0) {
  throw new Error(fatalFeatureProblems.map((problem) => `${problem.variable} ${problem.message}`).join(" "))
}
for (const problem of featureEnvironment.problems) {
  console.warn(`[features] ${problem.variable} ${problem.message}`)
}

const corsHandledByEdge = parseBooleanFlag(parsed.DEN_CORS_HANDLED_BY_EDGE ?? "false")
const openworkWebEnabled = parseBooleanFlag(parsed.DEN_OPENWORK_WEB_ENABLED ?? "false")

const configSecretEnvAllowlist = partitionConfigSecretEnvAllowlist(splitCsv(parsed.DEN_CONFIG_BLOB_SECRET_ENV_ALLOWLIST))
for (const { entry, problem } of configSecretEnvAllowlist.ignored) {
  console.warn(`[config-blobs] DEN_CONFIG_BLOB_SECRET_ENV_ALLOWLIST entry "${entry}" is ignored: ${problem}`)
}

const devMode = (parsed.OPENWORK_DEV_MODE ?? "0").trim() === "1"
const port = Number(parsed.PORT ?? "8790")
const botIdProtectionEnabled = (parsed.DEN_BOTID_PROTECTION_ENABLED ?? "0").trim() === "1"
const maintenanceToken = optionalString(parsed.DEN_MAINTENANCE_TOKEN)
if (maintenanceToken && maintenanceToken.length < 24) {
  throw new Error("DEN_MAINTENANCE_TOKEN must contain at least 24 characters.")
}
const headlessRunnerCallbackToken = optionalString(parsed.DEN_HEADLESS_RUNNER_CALLBACK_TOKEN)
if (headlessRunnerCallbackToken && headlessRunnerCallbackToken.length < 32) {
  throw new Error("DEN_HEADLESS_RUNNER_CALLBACK_TOKEN must contain at least 32 characters.")
}
if (headlessRunnerCallbackToken && headlessRunnerCallbackToken === optionalString(parsed.DEN_HEADLESS_RUNNER_TOKEN)) {
  throw new Error("DEN_HEADLESS_RUNNER_CALLBACK_TOKEN must differ from DEN_HEADLESS_RUNNER_TOKEN.")
}
const webClientIpSecret = optionalString(parsed.DEN_WEB_CLIENT_IP_SECRET)
if (webClientIpSecret && webClientIpSecret.length < CLIENT_IP_SECRET_MIN_LENGTH) {
  throw new Error(`DEN_WEB_CLIENT_IP_SECRET must contain at least ${CLIENT_IP_SECRET_MIN_LENGTH} characters.`)
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
const publicProxyTrustedOrigins = Array.from(new Set([
  betterAuthUrl,
  ...publicUrlTrustedOrigins,
]))
const orgMode = parseDenOrgMode(parsed.DEN_ORG_MODE)
const allowPrivateMcpUrls = devMode || (parsed.DEN_ALLOW_PRIVATE_MCP_URLS ?? "0").trim() === "1"
const allowInsecureInternalRedis = parseBooleanFlag(parsed.DATABASE_REDIS_ALLOW_INSECURE_INTERNAL)
const requireEmailVerification = parsed.DEN_REQUIRE_EMAIL_VERIFICATION === undefined
  ? orgMode === "multi_org" && !devMode
  : parsed.DEN_REQUIRE_EMAIL_VERIFICATION.trim().toLowerCase() !== "false"
const passwordBreachScreeningEnabled = parsed.DEN_PASSWORD_BREACH_SCREENING_ENABLED === undefined
  ? true
  : parsed.DEN_PASSWORD_BREACH_SCREENING_ENABLED.trim().toLowerCase() !== "false"
const apiKeyRateLimitMax = parseApiKeyRateLimitMax(parsed.DEN_API_KEY_RATE_LIMIT_MAX)

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

const readReplicaCredentials = readReplicaCredentialsFromEnv(parsed)

const sandboxWorkplaceUrl = optionalString(parsed.DEN_SANDBOX_WORKPLACE_URL)
  ?? (featureEnvironment.deployment === "cloud" ? "https://open-workplace-workshop.onrender.com" : null)
const sandboxGatewayApiKey = optionalString(parsed.DEN_SANDBOX_GATEWAY_API_KEY)
const sandboxGatewayProvider = optionalString(parsed.DEN_SANDBOX_GATEWAY_PROVIDER) ?? (sandboxGatewayApiKey ? "openai" : "openrouter")
const sandboxMintsOpenRouterKeys = !sandboxGatewayApiKey && sandboxGatewayProvider === "openrouter" && Boolean(optionalString(parsed.OPENROUTER_MANAGEMENT_API_KEY))
const sandboxDefaultModels = sandboxGatewayProvider === "openrouter"
  ? "openai/gpt-6.1-sol,anthropic/claude-sonnet-5.5,deepseek/deepseek-v4.1-flash"
  : "gpt-6-luna"
const sandboxCreditUsd = Number.parseInt(optionalString(parsed.DEN_SANDBOX_CREDIT_USD) ?? "50", 10)

export const env = {
  databaseUrl: parsed.DATABASE_URL,
  dbEncryptionKey: optionalString(parsed.DEN_DB_ENCRYPTION_KEY),
  dbMode: parsed.DB_MODE ?? (parsed.DATABASE_URL ? "mysql" : "planetscale"),
  planetscale: planetscaleCredentials,
  readReplica: readReplicaCredentials,
  betterAuthSecret: parsed.BETTER_AUTH_SECRET,
  betterAuthUrl,
  betterAuthCookieDomain,
  authCookiePrefix: parsed.DEN_AUTH_COOKIE_PREFIX ?? "openwork-den",
  trustedProxies: splitCsv(parsed.DEN_TRUSTED_PROXIES),
  webClientIpSecret,
  webUrl: normalizePublicWebOrigin(betterAuthUrl),
  databaseRedisUrl: normalizeRedisUrl(parsed.DATABASE_REDIS_URL, allowInsecureInternalRedis),
  databaseRedisAllowInsecureInternal: allowInsecureInternalRedis,
  mcpResourceUrl: mcpResourceUrl
    ? normalizeOrigin(mcpResourceUrl)
    : devMode
      ? `http://127.0.0.1:${port}/mcp`
      : undefined,
  mcpAdditionalResources,
  betterAuthTrustedOrigins: betterAuthTrustedOrigins.length > 0 ? betterAuthTrustedOrigins : corsOrigins,
  webAppHosts: uniqueStrings([
    ...derivedWebOrigins.map((origin) => new URL(origin).hostname.toLowerCase()),
    ...splitCsv(parsed.DEN_WEB_APP_HOSTS).map((host) => host.toLowerCase()),
  ]),
  devMode,
  botIdProtectionEnabled,
  allowPrivateMcpUrls,
  configBlobs: {
    secretEnvAllowlist: configSecretEnvAllowlist.allowed,
  },
  maintenanceToken,
  headlessRunnerCallbackToken,
  agentEvaluationApiKey: optionalString(parsed.DEN_AGENT_EVALUATION_API_KEY),
  gatewayKey: optionalString(parsed.DEN_GATEWAY_KEY),
  gatewayOrigin: normalizeOptionalHttpsOrigin("DEN_GATEWAY_ORIGIN", parsed.DEN_GATEWAY_ORIGIN),
  planGatingEnabled,
  generatedArtifactViewsEnabled,
  appMcpServersEnabled,
  scimMaintenanceIntervalMs: tuning.scimMaintenanceIntervalMs,
  lifecycleEmails: {
    enabled: parsed.LIFECYCLE_EMAILS_ENABLED?.trim() === "1",
    intervalMs: tuning.lifecycleEmailsIntervalMs,
  },
  adminMetrics: {
    enabled: parsed.ADMIN_METRICS_REFRESH_ENABLED?.trim() !== "0",
    fastIntervalMs: tuning.adminMetrics.fastIntervalMs,
    heavyIntervalMs: tuning.adminMetrics.heavyIntervalMs,
  },
  mcpRegistrationProbe: {
    enabled: parsed.MCP_REGISTRATION_PROBE_ENABLED?.trim() === "1",
    tryRegistration: parsed.MCP_REGISTRATION_PROBE_TRY_REGISTRATION?.trim() === "1",
    intervalMs: tuning.mcpRegistrationProbeIntervalMs,
  },
  requireEmailVerification,
  passwordBreachScreeningEnabled,
  apiKeyRateLimitMax,
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
  githubSync: tuning.githubSync,
  google: {
    clientId: optionalString(parsed.GOOGLE_CLIENT_ID),
    clientSecret: optionalString(parsed.GOOGLE_CLIENT_SECRET),
  },
  email: {
    from: optionalString(parsed.EMAIL_FROM),
    supportAddress: optionalString(parsed.EMAIL_SUPPORT_ADDRESS),
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
  documentsOffice: {
    mode: parsed.DEN_DOCUMENTS_EDITOR ?? (optionalString(parsed.DEN_DOCUMENTS_COLLABORA_URL) ? "fixed" : null),
    workerPort: Number(parsed.DEN_DOCUMENTS_WORKER_EDITOR_PORT ?? "9980"),
    serverUrl: optionalString(parsed.DEN_DOCUMENTS_COLLABORA_URL),
    hostOrigin: optionalString(parsed.DEN_DOCUMENTS_HOST_ORIGIN),
    callbackBaseUrl: optionalString(parsed.DEN_DOCUMENTS_CALLBACK_BASE_URL) ?? apiPublicUrl,
  },
  apiPublicUrl,
  serviceVersion: resolveDenServiceVersion({
    configuredVersion: parsed.DEN_API_VERSION,
    renderGitCommit: parsed.RENDER_GIT_COMMIT,
  }),
  publicUrlTrustedOrigins,
  publicProxyTrustedOrigins,
  installerArtifactsDir: optionalString(parsed.OPENWORK_INSTALLER_ARTIFACTS_DIR),
  installerReleaseTag: optionalString(parsed.OPENWORK_INSTALLER_RELEASE_TAG) ?? `v${denApiAppVersion.latestAppVersion}`,
  installerReleaseTagExplicit: optionalString(parsed.OPENWORK_INSTALLER_RELEASE_TAG) !== undefined,
  installerReleaseRepo: optionalString(parsed.OPENWORK_INSTALLER_RELEASE_REPO) ?? "different-ai/openwork",
  installerCacheDir: optionalString(parsed.OPENWORK_INSTALLER_CACHE_DIR) ?? path.join(os.tmpdir(), "openwork-desktop-artifacts"),
  desktopReleasesBaseUrl: optionalString(parsed.DEN_DESKTOP_RELEASES_BASE_URL),
  desktopReleasesMode: parsed.DEN_DESKTOP_RELEASES_MODE ?? "github",
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
  provisionerMode: parsed.CLOUD_RUNTIME_PROVIDER ?? parsed.PROVISIONER_MODE ?? "stub",
  workerProvisioningReconcileIntervalMs: tuning.workerProvisioning.reconcileIntervalMs,
  workerProvisioningReconcileStaleMs: tuning.workerProvisioning.reconcileStaleMs,
  workerProvisioningReconcileBatchSize: tuning.workerProvisioning.reconcileBatchSize,
  cloudProvisionDeadlineMs: tuning.cloud.provisionDeadlineMs,
  cloudMaterializationFailureCooldownMs: tuning.cloud.materializationFailureCooldownMs,
  cloudIdleStopMs: tuning.cloud.idleStopMs,
  cloudIdleLoopIntervalMs: tuning.cloud.idleLoopIntervalMs,
  cloudIdleStopBatchSize: tuning.cloud.idleStopBatchSize,
  cloudActivityProbeTimeoutMs: tuning.cloud.activityProbeTimeoutMs,
  cloudUnreachableGraceMs: tuning.cloud.unreachableGraceMs,
  cloudStopFlushTimeoutMs: tuning.cloud.stopFlushTimeoutMs,
  workerUrlTemplate: parsed.WORKER_URL_TEMPLATE,
  workerActivityBaseUrl:
    optionalString(parsed.WORKER_ACTIVITY_BASE_URL) ??
    betterAuthUrl,
  automations: {
    enabled: automationsEnabled,
    runtimeEnabled: automationsRuntimeEnabled,
    pollIntervalMs: tuning.automations.pollIntervalMs,
    batchSize: tuning.automations.batchSize,
    maxConcurrency: positiveInteger(parsed.DEN_AUTOMATIONS_MAX_CONCURRENCY, 4),
    headlessMaxConcurrency: positiveInteger(parsed.DEN_HEADLESS_AUTOMATIONS_MAX_CONCURRENCY, 16),
    leaseMs: tuning.automations.leaseMs,
    runTimeoutMs: tuning.automations.runTimeoutMs,
    runnerClaimDeadlineMs: tuning.automations.runnerClaimDeadlineMs,
  },
  dashboardsEnabled,
  sandbox: {
    workplaceUrl: sandboxWorkplaceUrl,
    gateway: sandboxGatewayApiKey || sandboxMintsOpenRouterKeys
      ? {
          providerId: sandboxGatewayProvider,
          modelIds: (optionalString(parsed.DEN_SANDBOX_GATEWAY_MODELS) ?? sandboxDefaultModels).split(",").map(value => value.trim()).filter(Boolean),
          apiKey: sandboxGatewayApiKey ?? null,
          creditUsd: sandboxMintsOpenRouterKeys ? (Number.isFinite(sandboxCreditUsd) && sandboxCreditUsd > 0 ? sandboxCreditUsd : 50) : null,
        }
      : null,
  },
  features: { deployment: featureEnvironment.deployment, locks: featureEnvironment.locks },
  auditCaptureEnabled: parsed.DEN_AUDIT_CAPTURE_ENABLED === "true",
  auditVisibilityEnabled: parsed.DEN_AUDIT_VISIBILITY_ENABLED === "true",
  auditSelfHostedEnabled: parsed.DEN_AUDIT_SELF_HOSTED_ENABLED === "true",
  corsHandledByEdge,
  openworkWebEnabled,
  openaiSafety: { webhookSecret: optionalString(parsed.OPENAI_SAFETY_WEBHOOK_SECRET), readKey: optionalString(parsed.OPENAI_SAFETY_READ_KEY) },
  inferenceFree: readFreeInferenceConfig(process.env),
  workbotFreeGrantSecret: readWorkbotFreeGrantSecret(process.env),
  inferenceProxyBaseUrl: optionalString(parsed.GATEWAY_PROXY_BASE_URL) ?? "http://127.0.0.1:8791",
  modelsPublicBaseUrl: gatewayDeployment.modelsPublicBaseUrl ?? optionalString(parsed.GATEWAY_PROXY_BASE_URL) ?? "http://127.0.0.1:8791",
  gatewayEnabled: gatewayDeployment.enabled,
  gatewayProxyBaseUrl: gatewayDeployment.proxyBaseUrl,
  gatewayPublicBaseUrl: gatewayDeployment.publicBaseUrl ?? optionalString(parsed.GATEWAY_PROXY_BASE_URL) ?? "http://127.0.0.1:8791",
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
      parsed.RENDER_WORKER_REPO ?? "https://github.com/different-ai/openwork",
    workerBranch: parsed.RENDER_WORKER_BRANCH ?? "dev",
    workerRootDir:
      parsed.RENDER_WORKER_ROOT_DIR ?? "ee/apps/den-worker-runtime",
    workerPlan: parsed.RENDER_WORKER_PLAN ?? "standard",
    workerRegion: parsed.RENDER_WORKER_REGION ?? "oregon",
    workerOpenworkVersion: parsed.RENDER_WORKER_OPENWORK_VERSION,
    workerNamePrefix: parsed.RENDER_WORKER_NAME_PREFIX ?? "den-worker",
    workerPublicDomainSuffix: parsed.RENDER_WORKER_PUBLIC_DOMAIN_SUFFIX,
    customDomainReadyTimeoutMs: tuning.render.customDomainReadyTimeoutMs,
    provisionTimeoutMs: tuning.render.provisionTimeoutMs,
    healthcheckTimeoutMs: tuning.render.healthcheckTimeoutMs,
    pollIntervalMs: tuning.render.pollIntervalMs,
  },
  vercel: {
    apiBase: parsed.VERCEL_API_BASE ?? "https://api.vercel.com",
    token: parsed.VERCEL_TOKEN,
    teamId: parsed.VERCEL_TEAM_ID,
    teamSlug: parsed.VERCEL_TEAM_SLUG,
    dnsDomain: parsed.VERCEL_DNS_DOMAIN,
  },
  daytona: {
    envPath: optionalString(parsed.OPENWORK_DAYTONA_ENV_PATH),
    apiUrl: optionalString(parsed.DAYTONA_API_URL) ?? "https://app.daytona.io/api",
    apiKey: optionalString(parsed.DAYTONA_API_KEY),
    target: optionalString(parsed.DAYTONA_TARGET),
    snapshot: optionalString(parsed.DAYTONA_SNAPSHOT),
    sandboxClass: parsed.DAYTONA_SANDBOX_CLASS,
    image: optionalString(parsed.DAYTONA_SANDBOX_IMAGE) ?? "node:24.22.1-bookworm",
    resources: {
      cpu: Number(parsed.DAYTONA_SANDBOX_CPU ?? "2"),
      memory: Number(parsed.DAYTONA_SANDBOX_MEMORY ?? "4"),
      disk: Number(parsed.DAYTONA_SANDBOX_DISK ?? "8"),
    },
    public: daytonaSandboxPublic,
    autoStopInterval: Number(parsed.DAYTONA_SANDBOX_AUTO_STOP_INTERVAL ?? "0"),
    autoPauseInterval: parsed.DAYTONA_SANDBOX_AUTO_PAUSE_INTERVAL,
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
    createTimeoutSeconds: tuning.daytona.createTimeoutSeconds,
    deleteTimeoutSeconds: tuning.daytona.deleteTimeoutSeconds,
    stopTimeoutSeconds: tuning.daytona.stopTimeoutSeconds,
    healthcheckTimeoutMs: tuning.daytona.healthcheckTimeoutMs,
    checkpointIntervalSeconds: tuning.daytona.checkpointIntervalSeconds,
    checkpointKeep: tuning.daytona.checkpointKeep,
    pollIntervalMs: DEN_WORKER_POLL_INTERVAL_MS,
  },
}
