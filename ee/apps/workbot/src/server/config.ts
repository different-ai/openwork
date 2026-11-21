import { z } from "zod"

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

const origin = (allowInternal: boolean) =>
  z.string().transform((value, context) => {
    try {
      const url = new URL(value)
      const internal = allowInternal && url.protocol === "http:" && !url.hostname.includes(".")
      if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) || internal) return url.origin
    } catch {
    }
    context.addIssue({ code: "custom", message: "must be an https URL (http only for localhost)" })
    return z.NEVER
  })

const optionalText = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined)

const schema = z.object({
  WORKBOT_PUBLIC_URL: origin(false),
  WORKBOT_DEN_API_URL: origin(false),
  WORKBOT_DEN_WEB_URL: optionalText.pipe(origin(false).optional()),
  WORKBOT_RUNNER_URL: origin(true),
  WORKBOT_RUNNER_TOKEN: z.string().min(32, "must be at least 32 characters"),
  WORKBOT_SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
  PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  WORKBOT_PORT: z.coerce.number().int().min(1).max(65_535).default(3020),
  WORKBOT_CALENDAR_MOCK_URL: optionalText.pipe(origin(false).optional()),
  WORKBOT_DEV: z.enum(["0", "1"]).default("0"),
  WORKBOT_IOS_TEAM_ID: z.string().regex(/^[A-Z0-9]{10}$/, "must be a 10-character Apple team ID").optional(),
  WORKBOT_ANDROID_CERT_SHA256: z.string().optional(),
  WORKBOT_SENTRY_DSN: optionalText.pipe(z.url().optional()),
  WORKBOT_SENTRY_ENVIRONMENT: optionalText,
  WORKBOT_SENTRY_RELEASE: optionalText,
  WORKBOT_VERSION: optionalText,
})

export const WORKBOT_APP_ID = "com.differentai.openwork"
export const WORKBOT_IOS_APP_ID = "com.differentai.openwork.ios"
export const WORKBOT_APP_CALLBACK_PATH = "/auth/app/callback"
function appRedirectUris(publicUrl: string): string[] {
  return publicUrl.startsWith("https:") ? [`${publicUrl}${WORKBOT_APP_CALLBACK_PATH}`] : []
}

const CERT_SHA256 = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/

function certFingerprints(value: string | undefined): string[] {
  const list = (value ?? "").split(",").map((entry) => entry.trim().toUpperCase()).filter(Boolean)
  const invalid = list.filter((entry) => !CERT_SHA256.test(entry))
  if (invalid.length > 0) throw new Error(`Invalid Workbot configuration:\nWORKBOT_ANDROID_CERT_SHA256: not a SHA-256 certificate fingerprint: ${invalid.join(", ")}`)
  return list
}

export type Config = {
  publicUrl: string
  denApiUrl: string
  denWebUrl: string | null
  runner: { url: string; token: string }
  sessionSecret: string
  port: number
  dev: boolean
  calendarMockUrl: string | null
  secureCookies: boolean
  appRedirectUris: string[]
  appLinks: { iosTeamId: string | null; androidCertSha256: string[] }
  errorReporting: { dsn: string; environment?: string; release?: string } | null
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    throw new Error(`Invalid Workbot configuration:\n${issues.join("\n")}`)
  }
  const value = parsed.data
  return {
    publicUrl: value.WORKBOT_PUBLIC_URL,
    denApiUrl: value.WORKBOT_DEN_API_URL,
    denWebUrl: value.WORKBOT_DEN_WEB_URL ?? null,
    runner: { url: value.WORKBOT_RUNNER_URL, token: value.WORKBOT_RUNNER_TOKEN },
    sessionSecret: value.WORKBOT_SESSION_SECRET,
    port: value.PORT ?? value.WORKBOT_PORT,
    dev: value.WORKBOT_DEV === "1",
    calendarMockUrl: value.WORKBOT_CALENDAR_MOCK_URL ?? null,
    secureCookies: value.WORKBOT_PUBLIC_URL.startsWith("https:"),
    appRedirectUris: appRedirectUris(value.WORKBOT_PUBLIC_URL),
    appLinks: { iosTeamId: value.WORKBOT_IOS_TEAM_ID ?? null, androidCertSha256: certFingerprints(value.WORKBOT_ANDROID_CERT_SHA256) },
    errorReporting: value.WORKBOT_SENTRY_DSN
      ? {
          dsn: value.WORKBOT_SENTRY_DSN,
          environment: value.WORKBOT_SENTRY_ENVIRONMENT,
          release: value.WORKBOT_SENTRY_RELEASE ?? (value.WORKBOT_VERSION && value.WORKBOT_VERSION !== "dev" ? `workbot@${value.WORKBOT_VERSION}` : undefined),
        }
      : null,
  }
}
