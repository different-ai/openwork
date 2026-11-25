import { z } from "zod"

const coreEnv = {
  DEN_BASE_URL: z.string().trim().min(1).optional(),
  DATABASE_URL: z.string().min(1).optional(),
  BETTER_AUTH_SECRET: z.string().min(32),
  DEN_DB_ENCRYPTION_KEY: z.string().trim().min(32),
  DEN_BOOTSTRAP_ADMIN_EMAILS: z.string().optional(),
  DEN_INITIAL_ADMIN_BOOTSTRAP_CODE: z.string().optional(),
  PORT: z.string().optional(),
  DATABASE_REDIS_URL: z.string().optional(),
  DEN_ORG_MODE: z.string().optional(),
  DEN_SINGLE_ORG_NAME: z.string().optional(),
  DEN_SINGLE_ORG_SLUG: z.string().optional(),
  DEN_SINGLE_ORG_OWNER_EMAILS: z.string().optional(),
}

const addressesThatDifferFromDenBaseUrl = {
  DEN_API_PUBLIC_URL: z.string().optional(),
  CORS_ORIGINS: z.string().optional(),
  DEN_BETTER_AUTH_TRUSTED_ORIGINS: z.string().optional(),
  DEN_BETTER_AUTH_COOKIE_DOMAIN: z.string().optional(),
  DEN_AUTH_COOKIE_PREFIX: z.string().regex(/^openwork-den(-[a-z0-9]{1,32})?$/).optional(),
  DEN_TRUSTED_PROXIES: z.string().optional(),
  DEN_WEB_APP_HOSTS: z.string().optional(),
  DEN_DESKTOP_DEN_BASE_URL: z.string().optional(),
  DEN_MARKETING_URL: z.string().optional(),
  DATABASE_REDIS_ALLOW_INSECURE_INTERNAL: z.string().optional(),
}

const firstAdministratorAndSignIn = {
  DEN_INITIAL_ADMIN_BOOTSTRAP_CODE_FILE: z.string().optional(),
  DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: z.string().optional(),
  DEN_REQUIRE_EMAIL_VERIFICATION: z.string().optional(),
  DEN_PASSWORD_BREACH_SCREENING_ENABLED: z.string().optional(),
  DEN_API_KEY_RATE_LIMIT_MAX: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
}

const email = {
  EMAIL_FROM: z.string().optional(),
  EMAIL_SUPPORT_ADDRESS: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: z.string().optional(),
}

const mcpConnectorsAndArtifacts = {
  DEN_MCP_RESOURCE_URL: z.string().optional(),
  DEN_MCP_ADDITIONAL_RESOURCES: z.string().optional(),
  DEN_MCP_CLAIM_NAMESPACE: z.string().optional(),
  DEN_ALLOW_PRIVATE_MCP_URLS: z.string().optional(),
  DEN_APP_MCP_SERVERS_ENABLED: z.string().optional(),
  DEN_GENERATED_ARTIFACT_VIEWS_ENABLED: z.string().optional(),
  DEN_CONFIG_BLOB_SECRET_ENV_ALLOWLIST: z.string().optional(),
  GITHUB_CONNECTOR_APP_ID: z.string().optional(),
  GITHUB_CONNECTOR_APP_CLIENT_ID: z.string().optional(),
  GITHUB_CONNECTOR_APP_CLIENT_SECRET: z.string().optional(),
  GITHUB_CONNECTOR_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_CONNECTOR_APP_WEBHOOK_SECRET: z.string().optional(),
}

const desktopReleases = {
  OPENWORK_INSTALLER_ARTIFACTS_DIR: z.string().optional(),
  OPENWORK_INSTALLER_RELEASE_TAG: z.string().optional(),
  OPENWORK_INSTALLER_RELEASE_REPO: z.string().optional(),
  OPENWORK_INSTALLER_CACHE_DIR: z.string().optional(),
  DEN_DESKTOP_RELEASES_BASE_URL: z.string().optional(),
  DEN_DESKTOP_RELEASES_MODE: z.enum(["github", "static"]).optional(),
}

const automationsDashboardsAndAudit = {
  DEN_AUTOMATIONS_ENABLED: z.string().optional(),
  DEN_AUTOMATIONS_RUNTIME_ENABLED: z.string().optional(),
  DEN_AUTOMATIONS_MAX_CONCURRENCY: z.string().optional(),
  DEN_HEADLESS_AUTOMATIONS_MAX_CONCURRENCY: z.string().optional(),
  DEN_DASHBOARDS_ENABLED: z.string().optional(),
  DEN_AUDIT_CAPTURE_ENABLED: z.enum(["true", "false"]).default("true"),
  DEN_AUDIT_VISIBILITY_ENABLED: z.enum(["true", "false"]).default("true"),
  DEN_AUDIT_SELF_HOSTED_ENABLED: z.enum(["true", "false"]).default("false"),
  DEN_MAINTENANCE_TOKEN: z.string().optional(),
}

const headlessRunnerWorkbotAndGateway = {
  DEN_HEADLESS_RUNNER_TOKEN: z.string().optional(),
  DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: z.string().optional(),
  DEN_AGENT_EVALUATION_API_KEY: z.string().optional(),
  GATEWAY_PROXY_BASE_URL: z.string().optional(),
  DEN_GATEWAY_KEY: z.string().optional(),
  DEN_GATEWAY_ORIGIN: z.string().optional(),
}

const documents = {
  DEN_DOCUMENTS_COLLABORA_URL: z.string().url().optional(),
  DEN_DOCUMENTS_HOST_ORIGIN: z.string().url().optional(),
  DEN_DOCUMENTS_CALLBACK_BASE_URL: z.string().url().optional(),
  DEN_DOCUMENTS_EDITOR: z.enum(["fixed", "cloud-worker"]).optional(),
  DEN_DOCUMENTS_WORKER_EDITOR_PORT: z.string().optional(),
}

const openworkWebAndCloudComputers = {
  DEN_OPENWORK_WEB_ENABLED: z.string().optional(),
  CLOUD_RUNTIME_PROVIDER: z.enum(["stub", "render", "daytona"]).optional(),
  WORKER_URL_TEMPLATE: z.string().optional(),
  WORKER_ACTIVITY_BASE_URL: z.string().optional(),
  DAYTONA_API_URL: z.string().optional(),
  DAYTONA_API_KEY: z.string().optional(),
  DAYTONA_TARGET: z.string().optional(),
  DAYTONA_SNAPSHOT: z.string().optional(),
  DAYTONA_SANDBOX_CLASS: z.enum(["container", "linux-vm"]).default("container"),
  DAYTONA_SANDBOX_IMAGE: z.string().optional(),
  DAYTONA_SANDBOX_CPU: z.string().optional(),
  DAYTONA_SANDBOX_MEMORY: z.string().optional(),
  DAYTONA_SANDBOX_DISK: z.string().optional(),
  DAYTONA_SANDBOX_PUBLIC: z.string().optional(),
  DAYTONA_SANDBOX_AUTO_STOP_INTERVAL: z.string().optional(),
  DAYTONA_SANDBOX_AUTO_PAUSE_INTERVAL: z.coerce.number().int().min(1).max(1440).default(5),
  DAYTONA_SANDBOX_AUTO_ARCHIVE_INTERVAL: z.string().optional(),
  DAYTONA_SANDBOX_AUTO_DELETE_INTERVAL: z.string().optional(),
  DAYTONA_SIGNED_PREVIEW_EXPIRES_SECONDS: z.string().optional(),
  DAYTONA_SANDBOX_NAME_PREFIX: z.string().optional(),
  DAYTONA_SHARED_VOLUME_NAME: z.string().optional(),
  DAYTONA_WORKSPACE_MOUNT_PATH: z.string().optional(),
  DAYTONA_DATA_MOUNT_PATH: z.string().optional(),
  DAYTONA_RUNTIME_WORKSPACE_PATH: z.string().optional(),
  DAYTONA_RUNTIME_DATA_PATH: z.string().optional(),
  DAYTONA_SIDECAR_DIR: z.string().optional(),
  DAYTONA_OPENWORK_PORT: z.string().optional(),
  DAYTONA_OPENCODE_PORT: z.string().optional(),
}

const hostedDatabaseCredentials = {
  DB_MODE: z.enum(["mysql", "planetscale"]).optional(),
  DATABASE_HOST: z.string().min(1).optional(),
  DATABASE_USERNAME: z.string().min(1).optional(),
  DATABASE_PASSWORD: z.string().optional(),
  DATABASE_READ_USERNAME: z.string().optional(),
  DATABASE_READ_PASSWORD: z.string().optional(),
}

const billingAndHostedModels = {
  DEN_PLAN_GATING_ENABLED: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_INFERENCE_PRICE_ID: z.string().optional(),
  STRIPE_SEAT_PRICE_ID: z.string().optional(),
  STRIPE_OPENWORK_WEB_PRICE_ID: z.string().optional(),
  STRIPE_BILLING_SUCCESS_URL: z.string().optional(),
  STRIPE_BILLING_CANCEL_URL: z.string().optional(),
  OPENROUTER_MANAGEMENT_API_KEY: z.string().optional(),
  OPENROUTER_WORKSPACE_ID: z.string().optional(),
  OPENAI_SAFETY_WEBHOOK_SECRET: z.string().optional(),
  OPENAI_SAFETY_READ_KEY: z.string().optional(),
}

const lifecycleEmailMarketingAndCompliance = {
  LIFECYCLE_EMAILS_ENABLED: z.string().optional(),
  LOOPS_API_KEY: z.string().optional(),
  LOOPS_MARKETING_ENABLED: z.string().optional(),
  LINEAR_API_KEY: z.string().optional(),
  LINEAR_COMPLIANCE_TEAM_ID: z.string().optional(),
  LINEAR_COMPLIANCE_COMPLETED_STATE_ID: z.string().optional(),
}

const edgeInFrontOfApiAndWeb = {
  DEN_WEB_CLIENT_IP_SECRET: z.string().optional(),
  DEN_CORS_HANDLED_BY_EDGE: z.string().optional(),
  DEN_BOTID_PROTECTION_ENABLED: z.string().optional(),
}

const platformAdministration = {
  ADMIN_METRICS_REFRESH_ENABLED: z.string().optional(),
  MCP_REGISTRATION_PROBE_ENABLED: z.string().optional(),
  MCP_REGISTRATION_PROBE_TRY_REGISTRATION: z.string().optional(),
  DEN_SANDBOX_WORKPLACE_URL: z.string().optional(),
  DEN_SANDBOX_GATEWAY_PROVIDER: z.string().optional(),
  DEN_SANDBOX_GATEWAY_MODELS: z.string().optional(),
  DEN_SANDBOX_GATEWAY_API_KEY: z.string().optional(),
  DEN_SANDBOX_CREDIT_USD: z.string().optional(),
}

const renderWorkersWithVercelDns = {
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
  VERCEL_TOKEN: z.string().optional(),
  VERCEL_TEAM_ID: z.string().optional(),
  VERCEL_TEAM_SLUG: z.string().optional(),
  VERCEL_DNS_DOMAIN: z.string().optional(),
}

const olderNamesStillRead = {
  BETTER_AUTH_URL: z.string().trim().min(1).optional(),
  PROVISIONER_MODE: z.enum(["stub", "render", "daytona"]).optional(),
  DAYTONA_VOLUME_NAME_PREFIX: z.string().optional(),
}

const setByBuildPlatformOrLocalDevelopment = {
  OPENWORK_DEV_MODE: z.string().optional(),
  DEN_API_VERSION: z.string().optional(),
  RENDER_GIT_COMMIT: z.string().optional(),
  OPENWORK_DAYTONA_ENV_PATH: z.string().optional(),
}

const setByTheHelmChart = {
  OPENWORK_HELM_CHART_VERSION: z.string().optional(),
  OPENWORK_HELM_APP_VERSION: z.string().optional(),
}

const endpointOverridesForTests = {
  DEN_GOOGLE_OAUTH_AUTHORIZE_URL: z.string().optional(),
  DEN_GOOGLE_OAUTH_TOKEN_URL: z.string().optional(),
  DEN_GOOGLE_OAUTH_USERINFO_URL: z.string().optional(),
  DEN_GOOGLE_API_BASE_URL: z.string().optional(),
  DEN_MICROSOFT_OAUTH_AUTHORIZE_URL: z.string().optional(),
  DEN_MICROSOFT_OAUTH_TOKEN_URL: z.string().optional(),
  DEN_MICROSOFT_GRAPH_BASE_URL: z.string().optional(),
  LINEAR_API_BASE: z.string().optional(),
  RENDER_API_BASE: z.string().optional(),
  VERCEL_API_BASE: z.string().optional(),
}

const optionalCapabilityEnv = {
  ...addressesThatDifferFromDenBaseUrl,
  ...firstAdministratorAndSignIn,
  ...email,
  ...mcpConnectorsAndArtifacts,
  ...desktopReleases,
  ...automationsDashboardsAndAudit,
  ...headlessRunnerWorkbotAndGateway,
  ...documents,
  ...openworkWebAndCloudComputers,
}

const cloudOnlyEnv = {
  ...hostedDatabaseCredentials,
  ...billingAndHostedModels,
  ...lifecycleEmailMarketingAndCompliance,
  ...edgeInFrontOfApiAndWeb,
  ...platformAdministration,
  ...renderWorkersWithVercelDns,
}

const legacyAliasEnv = {
  ...olderNamesStillRead,
  ...setByBuildPlatformOrLocalDevelopment,
  ...setByTheHelmChart,
  ...endpointOverridesForTests,
}

function names(group: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.keys(group)
}

export const DEN_API_ENV_GROUPS = {
  core: names(coreEnv),
  optionalCapabilities: names(optionalCapabilityEnv),
  cloudOnly: names(cloudOnlyEnv),
  legacyAliases: names(legacyAliasEnv),
} as const

export const EnvSchema = z.object({
  ...coreEnv,
  ...optionalCapabilityEnv,
  ...cloudOnlyEnv,
  ...legacyAliasEnv,
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

  if ((value.CLOUD_RUNTIME_PROVIDER ?? value.PROVISIONER_MODE) === "daytona") {
    if (value.DAYTONA_SANDBOX_CLASS === "linux-vm" && !value.DAYTONA_SNAPSHOT) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Daytona microVMs require a prepared Linux VM DAYTONA_SNAPSHOT", path: ["DAYTONA_SNAPSHOT"] })
    for (const key of ["DAYTONA_API_KEY"] as const) {
      if (!value[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${key} is required when CLOUD_RUNTIME_PROVIDER=daytona`,
          path: [key],
        })
      }
    }
  }
})
