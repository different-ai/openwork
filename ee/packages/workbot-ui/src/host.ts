"use client";

import { createContext, useContext, type CSSProperties } from "react";

/**
 * What the page needs from the app that hosts it (Den today): signed-in requests to the Workbot API, the person,
 * their connected apps, and where app logos come from. Workbot itself knows nothing about the host's sign-in.
 */
export type WorkbotHost = {
  requestJson(path: string, init?: RequestInit, timeoutMs?: number): Promise<{ response: Response; payload: unknown }>
  prepare(path: string): Promise<{ url: string; headers: Headers; credentials: RequestCredentials }>
  errorMessage?: (payload: unknown, fallback: string) => string
  user: { name: string | null } | null
  useConnectedApps: () => Array<{ id: string; name: string }>
  appIcons: (name: string, site?: string) => string[]
  homeHref: string
  calendar?: boolean
  documents?: boolean
  computer?: boolean
  browser?: boolean
  browserDemonstrations?: boolean
  workspaceAssistant?: boolean
  guidedNavigation?: boolean
  usageRecovery?: { denUrl: string; organizationId: string }
  activation?: { denUrl: string; organizationId: string }
  canSchedule?: boolean
  connectionsHref?: string | null
  signInHref?: string | null
  verifyDocumentIdentity?(): Promise<boolean>
  documentAuthorization?: "signin" | "blocked" | "disabled"
  calmChat?: boolean
  sideChats?: boolean
  account?: { email: string; organizationName: string; signOut(): Promise<void>; switchWorkspace(): void }
  identity?: { principalId: string; organizationId: string }
}

const AuthorizationContext = createContext<WorkbotHost["documentAuthorization"]>(undefined)
export const WorkbotAuthorizationProvider = AuthorizationContext.Provider

/** Portals are outside the owner's DOM. Suspend their interaction/focus while
 * retaining an already-open form's DOM and state for the same owner. */
export function useRetainedSurface(open: boolean) {
  const blocked = useContext(AuthorizationContext) !== undefined
  const style: CSSProperties | undefined = blocked ? { display: "none" } : undefined
  return { blocked, open: open && !blocked, portal: { keepMounted: open && blocked, hidden: blocked, inert: blocked, style } }
}

let current: WorkbotHost | null = null

/** Set by WorkbotScreen before anything below it renders. */
export function setWorkbotHost(host: WorkbotHost) {
  current = host
}

/** The views of Workbot's computer this person has, Browser first; the Computer tab shows while there is one. */
export function computerViews(host: WorkbotHost): Array<"browser" | "computer"> {
  return [...(host.browser === true ? ["browser" as const] : []), ...(host.computer === true ? ["computer" as const] : [])];
}

/**
 * What the tab for Workbot's computer is called everywhere it is offered (header, navigation drawer, command palette,
 * the Open action under a reply): "Browser" when the browser is the only view this person has, "Computer" otherwise.
 */
export function computerTabLabel(host: WorkbotHost): "Browser" | "Computer" {
  const views = computerViews(host);
  return views.length === 1 && views[0] === "browser" ? "Browser" : "Computer";
}

/** The calm chat look is on (`calmChat`). False before a host is set, so shared pieces render their usual look. */
export function calmChat(): boolean {
  return current?.calmChat === true
}

export function workbotHost(): WorkbotHost {
  if (!current) throw new Error("Workbot needs a host: render it through <WorkbotScreen host={...} />.")
  return current
}

/** A raw request to a Workbot API path, signed in (streams and files). */
export async function hostFetch(path: string, init: RequestInit = {}) {
  const host = workbotHost()
  const { url, headers, credentials } = await host.prepare(path)
  new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  if (host.identity) {
    headers.set("x-openwork-client-user", host.identity.principalId)
    headers.set("x-openwork-client-organization", host.identity.organizationId)
  }
  return fetch(url, { ...init, headers, credentials })
}

export function errorMessage(payload: unknown, fallback: string) {
  if (typeof payload === "object" && payload !== null && "error" in payload && payload.error === "workbot_model_unavailable") {
    return "I can't answer with your workspace's model right now. Ask your workspace admin to check Workbot's model."
  }
  const host = workbotHost()
  if (host.errorMessage) return host.errorMessage(payload, fallback)
  if (typeof payload === "object" && payload !== null && "message" in payload && typeof payload.message === "string") return payload.message
  return fallback
}
