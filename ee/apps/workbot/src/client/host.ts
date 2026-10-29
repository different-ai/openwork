import type { WorkbotHost } from "@openwork-ee/workbot-ui"
import { z } from "zod"
import { appIconCandidates } from "./app-icons"

/** Who is signed in, from this site's own server (which asked Den). */
export const meSchema = z.object({
  userId: z.string().nullable().default(null),
  organizationId: z.string().nullable().default(null),
  name: z.string().nullable(),
  email: z.string(),
  organizationName: z.string(),
  enabled: z.boolean(),
  computer: z.boolean().default(false),
  browser: z.boolean().default(false),
  browserDemonstrations: z.boolean().default(false),
  browserLiveView: z.boolean().default(false),
  /** Workbot's Calendar tab (on while Workbot is on); older servers omit it. */
  calendar: z.boolean().default(false),
  documents: z.boolean().default(false),
  documentEditing: z.boolean().default(false),
  nativeDictation: z.boolean().default(false),
  workspaceAssistant: z.boolean().default(false),
  guidedNavigation: z.boolean().default(false),
  usageRecovery: z.boolean().default(false),
  /** The Get set up checklist in the header; older servers omit it. */
  activationChecklist: z.boolean().default(false),
  /** The organization runs Automations in the cloud, so the Calendar can create them. */
  canSchedule: z.boolean().default(false),
  /** Side chats are on for this person (while Workbot is on). */
  sideChats: z.boolean().default(false),
  /** The Cmd+K / Ctrl+K command palette; older servers omit it. */
  denUrl: z.string().nullable(),
})
export type Me = z.infer<typeof meSchema>

/** Sends the browser to sign in with OpenWork, then back to where it was. */
export function signIn() {
  const back = `${window.location.pathname}${window.location.search}`
  window.location.assign(`/auth/login?return=${encodeURIComponent(back)}`)
}

/** The conversation read index.html started for the person its early /me answer named. */
type EarlyThread = { path: string; userId: string; organizationId: string; response: Promise<Response> }

declare global {
  interface Window { __workbotMe?: Promise<Response | null>; __workbotThread?: Promise<EarlyThread | null> }
}

/** The answer index.html started fetching before this script loaded; given out once, so later reads are fresh. */
function takeEarlyMe() {
  const early = window.__workbotMe
  window.__workbotMe = undefined
  return early
}

/** The signed-in person, or null when nobody is (the caller sends them to sign in). */
export async function fetchMe(): Promise<Me | null> {
  const response = (await takeEarlyMe()) ?? await fetch("/v1/workbot/me", { credentials: "same-origin", headers: { accept: "application/json" } })
  if (response.status === 401) return null
  if (!response.ok) throw new Error("Workbot couldn't reach OpenWork. Try again in a minute.")
  return meSchema.parse(await response.json())
}

/**
 * index.html's conversation read, given out once to the page's first conversation read, and only when it asked for
 * the same chat for the same person. Any other first read leaves it unused and asks the server itself.
 */
async function takeEarlyThread(path: string, me: Me) {
  const pending = window.__workbotThread
  if (!pending || !path.startsWith("/v1/workbot?")) return null
  window.__workbotThread = undefined
  const early = await pending
  if (!early || early.path !== path || early.userId !== me.userId || early.organizationId !== me.organizationId) return null
  return early.response.catch(() => null)
}

const noApps: Array<{ id: string; name: string }> = []

function messageOf(payload: unknown, fallback: string) {
  if (typeof payload === "object" && payload !== null && "message" in payload && typeof payload.message === "string") return payload.message
  return fallback
}

/** Workbot's page on its own site: same-origin requests with the session cookie; signed out means sign in again. */
export function createHost(me: Me, recovery: { authorization?: WorkbotHost["documentAuthorization"]; refreshIdentity?(): Promise<Me | null> } = {}): WorkbotHost {
  const scopedHeaders = (init?: HeadersInit) => {
    const headers = new Headers(init)
    if (me.userId && me.organizationId) {
      headers.set("x-openwork-client-user", me.userId)
      headers.set("x-openwork-client-organization", me.organizationId)
    }
    return headers
  }
  return {
    async requestJson(path, init = {}, timeoutMs = 30_000) {
      const headers = scopedHeaders(init.headers)
      headers.set("Accept", "application/json")
      if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")
      const early = (init.method ?? "GET") === "GET" ? await takeEarlyThread(path, me) : null
      const response = early ?? await fetch(path, { ...init, headers, credentials: "same-origin", signal: init.signal ?? AbortSignal.timeout(timeoutMs) })
      // The parent owns auth recovery, including when Documents is retained
      // behind another workspace page. Never navigate that owner away on 401.
      if (response.status === 401) {
        if (recovery.refreshIdentity) { if (!recovery.authorization) void recovery.refreshIdentity().catch(() => {}) }
        else if (window.location.pathname !== "/documents") signIn()
      }
      const payload: unknown = await response.json().catch(() => null)
      return { response, payload }
    },
    async prepare(path) {
      return { url: path, headers: scopedHeaders(), credentials: "same-origin" }
    },
    errorMessage: messageOf,
    user: { name: me.name },
    useConnectedApps: () => noApps,
    appIcons: (name) => appIconCandidates(name, me.denUrl),
    homeHref: me.denUrl ? `${me.denUrl}/dashboard` : "/",
    calendar: me.calendar,
    documents: me.documents,
    computer: me.computer,
    browser: me.browser,
    browserDemonstrations: me.browserDemonstrations,
    browserLiveView: me.browserLiveView,
    documentEditing: me.documents && me.documentEditing,
    nativeDictation: me.nativeDictation,
    workspaceAssistant: me.workspaceAssistant,
    guidedNavigation: me.workspaceAssistant && me.guidedNavigation,
    usageRecovery: me.usageRecovery && me.denUrl && me.organizationId ? { denUrl: me.denUrl, organizationId: me.organizationId } : undefined,
    activation: me.activationChecklist && me.denUrl && me.organizationId ? { denUrl: me.denUrl, organizationId: me.organizationId } : undefined,
    canSchedule: me.canSchedule,
    connectionsHref: me.denUrl ? `${me.denUrl}/dashboard/your-connections` : null,
    get signInHref() { return `/auth/login?return=${encodeURIComponent(window.location.pathname + window.location.search)}` },
    documentAuthorization: recovery.authorization,
    async verifyDocumentIdentity() {
      const current = await (recovery.refreshIdentity ? recovery.refreshIdentity() : fetchMe())
      return current !== null && current.userId !== null && current.organizationId !== null
        && current.userId === me.userId && current.organizationId === me.organizationId
    },
    sideChats: me.sideChats,
    identity: me.userId && me.organizationId ? { principalId: me.userId, organizationId: me.organizationId } : undefined,
  }
}
