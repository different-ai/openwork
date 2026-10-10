"use client";

/**
 * What the page needs from the app that hosts it (Den today): signed-in requests to the Workbot API, the person,
 * their connected apps, and where app logos come from. Workbot itself knows nothing about the host's sign-in.
 */
export type WorkbotHost = {
  /** A JSON request to the Workbot API (`/v1/workbot/...`), signed in as the person; resolves with the parsed body. */
  requestJson(path: string, init?: RequestInit, timeoutMs?: number): Promise<{ response: Response; payload: unknown }>
  /** Where a path is served and how to sign a raw request to it (the live stream, downloads, uploads with progress). */
  prepare(path: string): Promise<{ url: string; headers: Headers; credentials: RequestCredentials }>
  /** A person-readable message from a failed response's body; Workbot falls back to its own wording. */
  errorMessage?: (payload: unknown, fallback: string) => string
  /** The signed-in person. */
  user: { name: string | null } | null
  /** The apps the person has connected, for the header. A hook: called once on every render of the header. */
  useConnectedApps: () => Array<{ id: string; name: string }>
  /** Logo URLs to try in order for an app, by its display name. */
  appIcons: (name: string) => string[]
  /** Where the avatar in the header leads. */
  homeHref: string
  /** Workbot's Calendar tab is on for this person (Den's workbotCalendar feature). */
  calendar?: boolean
  /** The organization runs Automations in the cloud, so the Calendar can create them. Off when unset. */
  canSchedule?: boolean
  /** Where the person connects their own Google or Microsoft account, for the Calendar's connect links. */
  connectionsHref?: string | null
  /** The person can start side chats next to their main chat (the workbotSideChats feature). Off when unset. */
  sideChats?: boolean
}

let current: WorkbotHost | null = null

/** Set by WorkbotScreen before anything below it renders. */
export function setWorkbotHost(host: WorkbotHost) {
  current = host
}

export function workbotHost(): WorkbotHost {
  if (!current) throw new Error("Workbot needs a host: render it through <WorkbotScreen host={...} />.")
  return current
}

/** A raw request to a Workbot API path, signed in (streams and files). */
export async function hostFetch(path: string, init: RequestInit = {}) {
  const { url, headers, credentials } = await workbotHost().prepare(path)
  new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  return fetch(url, { ...init, headers, credentials })
}

export function errorMessage(payload: unknown, fallback: string) {
  const host = workbotHost()
  if (host.errorMessage) return host.errorMessage(payload, fallback)
  if (typeof payload === "object" && payload !== null && "message" in payload && typeof payload.message === "string") return payload.message
  return fallback
}
