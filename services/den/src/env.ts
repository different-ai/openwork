import { z } from "zod"

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().min(1),
  PORT: z.string().optional(),
  CORS_ORIGINS: z.string().optional(),
  PROVISIONER_MODE: z.enum(["stub", "render"]).optional(),
  WORKER_URL_TEMPLATE: z.string().optional(),
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
  RENDER_PROVISION_TIMEOUT_MS: z.string().optional(),
  RENDER_HEALTHCHECK_TIMEOUT_MS: z.string().optional(),
  RENDER_POLL_INTERVAL_MS: z.string().optional(),
  POLAR_FEATURE_GATE_ENABLED: z.string().optional(),
  POLAR_API_BASE: z.string().optional(),
  POLAR_ACCESS_TOKEN: z.string().optional(),
  POLAR_PRODUCT_ID: z.string().optional(),
  POLAR_BENEFIT_ID: z.string().optional(),
  POLAR_SUCCESS_URL: z.string().optional(),
  POLAR_RETURN_URL: z.string().optional(),
})

const parsed = schema.parse(process.env)

const corsOrigins = parsed.CORS_ORIGINS?.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)

const polarFeatureGateEnabled = (parsed.POLAR_FEATURE_GATE_ENABLED ?? "false").toLowerCase() === "true"

export const env = {
  databaseUrl: parsed.DATABASE_URL,
  betterAuthSecret: parsed.BETTER_AUTH_SECRET,
  betterAuthUrl: parsed.BETTER_AUTH_URL,
  port: Number(parsed.PORT ?? "8788"),
  corsOrigins: corsOrigins ?? [],
  provisionerMode: parsed.PROVISIONER_MODE ?? "stub",
  workerUrlTemplate: parsed.WORKER_URL_TEMPLATE,
  render: {
    apiBase: parsed.RENDER_API_BASE ?? "https://api.render.com/v1",
    apiKey: parsed.RENDER_API_KEY,
    ownerId: parsed.RENDER_OWNER_ID,
    workerRepo: parsed.RENDER_WORKER_REPO ?? "https://github.com/different-ai/openwork",
    workerBranch: parsed.RENDER_WORKER_BRANCH ?? "dev",
    workerRootDir: parsed.RENDER_WORKER_ROOT_DIR ?? "services/den-worker-runtime",
    workerPlan: parsed.RENDER_WORKER_PLAN ?? "standard",
    workerRegion: parsed.RENDER_WORKER_REGION ?? "oregon",
    workerOpenworkVersion: parsed.RENDER_WORKER_OPENWORK_VERSION ?? "0.11.113",
    workerNamePrefix: parsed.RENDER_WORKER_NAME_PREFIX ?? "den-worker",
    provisionTimeoutMs: Number(parsed.RENDER_PROVISION_TIMEOUT_MS ?? "900000"),
    healthcheckTimeoutMs: Number(parsed.RENDER_HEALTHCHECK_TIMEOUT_MS ?? "180000"),
    pollIntervalMs: Number(parsed.RENDER_POLL_INTERVAL_MS ?? "5000"),
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
}
