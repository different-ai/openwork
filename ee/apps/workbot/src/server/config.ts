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
  /**
   * Where the phone app may be sent back after signing in, exact and comma-separated. Unset: the Workbot app's own
   * address, plus its development build's when Workbot runs on this machine.
   */
  WORKBOT_APP_REDIRECT_URIS: z.string().optional(),
})

/** The Workbot phone app's sign-in return address, and its development build's. */
export const WORKBOT_APP_REDIRECT_URI = "com.openworklabs.workbot:/auth/callback"
export const WORKBOT_DEV_APP_REDIRECT_URI = "com.openworklabs.workbot.dev:/auth/callback"

/** A private-use, reverse-domain scheme (RFC 8252 §7.1) and a path, nothing else: never a web address. */
const APP_REDIRECT_URI = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+:\/[A-Za-z0-9/_-]*$/

function appRedirectUris(value: string | undefined, publicUrl: string): string[] {
  if (value === undefined) {
    const local = LOOPBACK_HOSTS.has(new URL(publicUrl).hostname)
    return local ? [WORKBOT_APP_REDIRECT_URI, WORKBOT_DEV_APP_REDIRECT_URI] : [WORKBOT_APP_REDIRECT_URI]
  }
  const list = value.split(",").map((entry) => entry.trim()).filter(Boolean)
  const invalid = list.filter((entry) => !APP_REDIRECT_URI.test(entry))
  if (invalid.length > 0) throw new Error(`Invalid Workbot configuration:\nWORKBOT_APP_REDIRECT_URIS: not an app address: ${invalid.join(", ")}`)
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
    appRedirectUris: appRedirectUris(value.WORKBOT_APP_REDIRECT_URIS, value.WORKBOT_PUBLIC_URL),
  }
}
