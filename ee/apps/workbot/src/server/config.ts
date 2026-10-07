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
  /** Encrypts the Den tokens Workbot keeps for each signed-in person. */
  WORKBOT_SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
  WORKBOT_DB_PATH: z.string().min(1).default("./data/workbot.sqlite"),
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
})

export type Config = {
  publicUrl: string
  denApiUrl: string
  denWebUrl: string | null
  runner: { url: string; token: string }
  sessionSecret: string
  dbPath: string
  port: number
  dev: boolean
  /** Testing only: where Calendar meetings come from instead of Den (see WORKBOT_CALENDAR_MOCK_URL). */
  calendarMockUrl: string | null
  /** Cookies are Secure (and __Host- prefixed) whenever Workbot is served over https. */
  secureCookies: boolean
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
    dbPath: value.WORKBOT_DB_PATH,
    port: value.PORT ?? value.WORKBOT_PORT,
    dev: value.WORKBOT_DEV === "1",
    calendarMockUrl: value.WORKBOT_CALENDAR_MOCK_URL ?? null,
    secureCookies: value.WORKBOT_PUBLIC_URL.startsWith("https:"),
  }
}
