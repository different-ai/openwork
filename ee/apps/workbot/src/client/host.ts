import type { WorkbotHost } from "@openwork-ee/workbot-ui"
import { z } from "zod"
import { appIconCandidates } from "./app-icons"

/** Who is signed in, from this site's own server (which asked Den). */
export const meSchema = z.object({
  name: z.string().nullable(),
  email: z.string(),
  organizationName: z.string(),
  enabled: z.boolean(),
  /** Workbot's Calendar tab (Den's workbotCalendar feature); older servers omit it. */
  calendar: z.boolean().default(false),
  /** The organization runs Automations in the cloud, so the Calendar can create them. */
  canSchedule: z.boolean().default(false),
  /** Side chats are on for this person (the workbotSideChats feature). */
  sideChats: z.boolean().default(false),
  denUrl: z.string().nullable(),
})
export type Me = z.infer<typeof meSchema>

/** Sends the browser to sign in with OpenWork, then back to where it was. */
export function signIn() {
  const back = `${window.location.pathname}${window.location.search}`
  window.location.assign(`/auth/login?return=${encodeURIComponent(back)}`)
}

/** The signed-in person, or null when nobody is (the caller sends them to sign in). */
export async function fetchMe(): Promise<Me | null> {
  const response = await fetch("/v1/workbot/me", { credentials: "same-origin", headers: { accept: "application/json" } })
  if (response.status === 401) return null
  if (!response.ok) throw new Error("Workbot couldn't reach OpenWork. Try again in a minute.")
  return meSchema.parse(await response.json())
}

const noApps: Array<{ id: string; name: string }> = []

function messageOf(payload: unknown, fallback: string) {
  if (typeof payload === "object" && payload !== null && "message" in payload && typeof payload.message === "string") return payload.message
  return fallback
}

/** Workbot's page on its own site: same-origin requests with the session cookie; signed out means sign in again. */
export function createHost(me: Me): WorkbotHost {
  return {
    async requestJson(path, init = {}, timeoutMs = 30_000) {
      const headers = new Headers(init.headers)
      headers.set("Accept", "application/json")
      if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")
      const response = await fetch(path, { ...init, headers, credentials: "same-origin", signal: init.signal ?? AbortSignal.timeout(timeoutMs) })
      if (response.status === 401) signIn()
      const payload: unknown = await response.json().catch(() => null)
      return { response, payload }
    },
    async prepare(path) {
      return { url: path, headers: new Headers(), credentials: "same-origin" }
    },
    errorMessage: messageOf,
    user: { name: me.name },
    useConnectedApps: () => noApps,
    appIcons: (name) => appIconCandidates(name, me.denUrl),
    homeHref: me.denUrl ? `${me.denUrl}/dashboard` : "/",
    calendar: me.calendar,
    canSchedule: me.canSchedule,
    connectionsHref: me.denUrl ? `${me.denUrl}/dashboard/your-connections` : null,
    sideChats: me.sideChats,
  }
}
