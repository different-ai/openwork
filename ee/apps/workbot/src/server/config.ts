import { z } from "zod"

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

/** An origin (scheme, host, port): https, or plain http on loopback or an internal service name (no dots). */
const origin = (allowInternal: boolean) =>
  z.string().transform((value, context) => {
    try {
      const url = new URL(value)
      const internal = allowInternal && url.protocol === "http:" && !url.hostname.includes(".")
      if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) || internal) return url.origin
    } catch {
      // reported below
    }
    context.addIssue({ code: "custom", message: "must be an https URL (http only for localhost)" })
    return z.NEVER
  })

/** Empty means unset, as an env file's `NAME=` line usually intends. */
const optionalText = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined)

const schema = z.object({
  /** Where people reach Workbot, e.g. https://chat.openworklabs.com. Den sends them back to `${this}/auth/callback`. */
  WORKBOT_PUBLIC_URL: origin(false),
  /** Den's API, e.g. https://api.openworklabs.com: where Workbot discovers Den's sign-in and asks who someone is. */
  WORKBOT_DEN_API_URL: origin(false),
  /** Den's web app for the "back to OpenWork" link and app logos; defaults to the origin of Den's sign-in. */
  WORKBOT_DEN_WEB_URL: origin(false).optional(),
  /** The headless runner every Workbot conversation runs on, and its service token. */
  WORKBOT_RUNNER_URL: origin(true),
  WORKBOT_RUNNER_TOKEN: z.string().min(32, "must be at least 32 characters"),
  /** Encrypts the sign-in cookies (Den tokens and sign-ins in progress). Changing it signs everyone out. */
  WORKBOT_SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
  /** The port to listen on; Render sets PORT. */
  PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  WORKBOT_PORT: z.coerce.number().int().min(1).max(65_535).default(3020),
  /**
   * Testing only: read Calendar meetings from the calendar mock (evals/packages/labs/src/calendar-mock.mjs), which
   * serves Den's calendar routes, instead of the member's real connections through Den. Unset in production.
   */
  WORKBOT_CALENDAR_MOCK_URL: origin(false).optional(),
  /** Serve the page from Vite with hot reload instead of the built files. */
  WORKBOT_DEV: z.enum(["0", "1"]).default("0"),
  /** The Workbot app's Apple team ID: iOS then trusts it with its sign-in return address (apple-app-site-association). */
  WORKBOT_IOS_TEAM_ID: z.string().regex(/^[A-Z0-9]{10}$/, "must be a 10-character Apple team ID").optional(),
  /**
   * SHA-256 fingerprints of the Workbot Android app's signing certificates, comma-separated: Android then trusts it
   * with its sign-in return address (assetlinks.json).
   */
  WORKBOT_ANDROID_CERT_SHA256: z.string().optional(),
  /**
   * Optional error reports to Sentry (see error-reporting.ts). Unset, nothing is sent anywhere: self-hosted
   * installs ship without one. The release defaults to `workbot@<WORKBOT_VERSION>`.
   */
  WORKBOT_SENTRY_DSN: optionalText.pipe(z.url().optional()),
  WORKBOT_SENTRY_ENVIRONMENT: optionalText,
  WORKBOT_SENTRY_RELEASE: optionalText,
  /** Set by the Workbot image at build time. */
  WORKBOT_VERSION: optionalText,
})

/** The Workbot phone app (its production build). */
export const WORKBOT_APP_ID = "com.openworklabs.workbot"
/**
 * Where the phone app comes back after signing in: a page on Workbot itself that iOS and Android open only in the
 * Workbot app they verified (/.well-known); any other app can't receive it, and a browser just shows the page.
 */
export const WORKBOT_APP_CALLBACK_PATH = "/auth/app/callback"
function appRedirectUris(publicUrl: string): string[] {
  // A loopback address cannot establish app-link ownership. Never send OAuth
  // codes to a private-use scheme, including on a development server.
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
  /** Testing only: where Calendar meetings come from instead of Den (see WORKBOT_CALENDAR_MOCK_URL). */
  calendarMockUrl: string | null
  /** Cookies are Secure (and __Host- prefixed) whenever Workbot is served over https. */
  secureCookies: boolean
  /** Where the phone app may be sent back after signing in (exact matches). */
  appRedirectUris: string[]
  /** What verifies the Workbot app as the owner of its return address; nothing is served for what's unset. */
  appLinks: { iosTeamId: string | null; androidCertSha256: string[] }
  /** Where error reports go; null (no DSN) sends none. */
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
