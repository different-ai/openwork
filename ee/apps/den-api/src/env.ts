import { DEN_WORKER_POLL_INTERVAL_MS } from "./CONSTS.js"
import { z } from "zod"

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_HOST: z.string().min(1).optional(),
  DATABASE_USERNAME: z.string().min(1).optional(),
  DATABASE_PASSWORD: z.string().optional(),
  DEN_DB_ENCRYPTION_KEY: z.string().trim().min(32),
  DB_MODE: z.enum(["mysql", "planetscale"]).optional(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().min(1),
  DEN_BETTER_AUTH_TRUSTED_ORIGINS: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  LOOPS_API_KEY: z.string().optional(),
  LOOPS_TRANSACTIONAL_ID_DEN_VERIFY_EMAIL: z.string().optional(),
  LOOPS_TRANSACTIONAL_ID_DEN_ORG_INVITE_EMAIL: z.string().optional(),
  OPENWORK_DEV_MODE: z.string().optional(),
  PORT: z.string().optional(),
  CORS_ORIGINS: z.string().optional(),
  WORKER_PROXY_PORT: z.string().optional(),
  PROVISIONER_MODE: z.enum(["stub", "render", "daytona"]).optional(),
  WORKER_URL_TEMPLATE: z.string().optional(),
  WORKER_ACTIVITY_BASE_URL: z.string().optional(),
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
  DAYTONA_WORKER_PROXY_BASE_URL: z.string().optional(),
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
  DAYTONA_HEALTHCHECK_TIMEOUT_MS: z.string().optional(),
}).superRefine((value, ctx) => {
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
})

const parsed = EnvSchema.parse(process.env)

function splitCsv(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function optionalString(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function normalizeOrigin(origin: string) {
  const value = origin.trim()
  if (value === "*") {
    return value
  }
  return value.replace(/\/+$/, "")
}

const corsOrigins = splitCsv(parsed.CORS_ORIGINS).map((origin) => normalizeOrigin(origin))
const betterAuthTrustedOrigins = splitCsv(parsed.DEN_BETTER_AUTH_TRUSTED_ORIGINS)
  .map((origin) => normalizeOrigin(origin))

const polarFeatureGateEnabled =
  (parsed.POLAR_FEATURE_GATE_ENABLED ?? "false").toLowerCase() === "true"

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
  betterAuthUrl: normalizeOrigin(parsed.BETTER_AUTH_URL),
  betterAuthTrustedOrigins: betterAuthTrustedOrigins.length > 0 ? betterAuthTrustedOrigins : corsOrigins,
  devMode: (parsed.OPENWORK_DEV_MODE ?? "0").trim() === "1",
  github: {
    clientId: optionalString(parsed.GITHUB_CLIENT_ID),
    clientSecret: optionalString(parsed.GITHUB_CLIENT_SECRET),
  },
  google: {
    clientId: optionalString(parsed.GOOGLE_CLIENT_ID),
    clientSecret: optionalString(parsed.GOOGLE_CLIENT_SECRET),
  },
  loops: {
    apiKey: optionalString(parsed.LOOPS_API_KEY),
    transactionalIdDenVerifyEmail: optionalString(parsed.LOOPS_TRANSACTIONAL_ID_DEN_VERIFY_EMAIL),
    transactionalIdDenOrgInviteEmail: optionalString(parsed.LOOPS_TRANSACTIONAL_ID_DEN_ORG_INVITE_EMAIL),
  },
  port: Number(parsed.PORT ?? "8790"),
  workerProxyPort: Number(parsed.WORKER_PROXY_PORT ?? "8789"),
  corsOrigins,
  provisionerMode: parsed.PROVISIONER_MODE ?? "daytona",
  workerUrlTemplate: parsed.WORKER_URL_TEMPLATE,
  workerActivityBaseUrl:
    optionalString(parsed.WORKER_ACTIVITY_BASE_URL) ??
    parsed.BETTER_AUTH_URL.trim().replace(/\/+$/, ""),
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
    workerProxyBaseUrl:
      optionalString(parsed.DAYTONA_WORKER_PROXY_BASE_URL) ?? "https://workers.den.openworklabs",
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
    healthcheckTimeoutMs: Number(
      parsed.DAYTONA_HEALTHCHECK_TIMEOUT_MS ?? "300000",
    ),
    pollIntervalMs: DEN_WORKER_POLL_INTERVAL_MS,
  },
}
