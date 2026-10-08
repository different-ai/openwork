import Constants from "expo-constants"
import { prefs } from "./prefs"
import { z } from "zod"

const extraSchema = z.object({
  variant: z.enum(["development", "production"]),
  workbotUrl: z.string(),
  redirectUri: z.string(),
})

/** What this build of the app was made with (app.config.ts). */
export const build = extraSchema.parse(Constants.expoConfig?.extra ?? {})
export const isDevelopment = build.variant === "development"

const SERVER_KEY = "server"

/** An origin (scheme, host, port): https, or plain http on this computer or the local network. */
export function normalizeServer(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * The Workbot this app talks to. Production builds always use chat.openworklabs.com; development builds start from
 * the build's address and can point at another one (kept on this phone).
 */
export function serverUrl(): string {
  if (!isDevelopment) return build.workbotUrl
  return normalizeServer(prefs.get(SERVER_KEY) ?? "") ?? build.workbotUrl
}

export function setServerUrl(value: string) {
  const origin = normalizeServer(value)
  if (!origin || !isDevelopment) return false
  prefs.set(SERVER_KEY, origin)
  return true
}
