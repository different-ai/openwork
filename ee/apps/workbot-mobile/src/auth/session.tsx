import { WorkbotTransportProvider, type WorkbotTransport } from "@openwork-ee/workbot-client/hooks"
import { useQueryClient } from "@tanstack/react-query"
import { fetch as streamingFetch } from "expo/fetch"
import * as WebBrowser from "expo-web-browser"
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { z } from "zod"
import { build, normalizeServer, serverUrl, setServerUrl } from "../config"
import { clearCachedFiles } from "../files/cache"
import { newSignIn } from "./pkce"
import { sessionStore, type StoredSession } from "./storage"

/**
 * Who is signed in on this phone, and the one way the app talks to Workbot. The person signs in with OpenWork in the
 * system's sign-in browser; Workbot hands the app a sealed session (it never sees Den's tokens), kept in the Keychain
 * or Keystore. Every request carries it; Workbot sends back a replacement when it refreshed it, and the app refreshes
 * it itself a few minutes before it runs out, so images and downloads never carry one about to be replaced.
 */

/** The app asks for a fresh session this long before its access token runs out (Workbot refreshes within six). */
const REFRESH_AHEAD_MS = 5 * 60_000

export type SessionState = { status: "loading" } | { status: "signedOut"; error: string | null } | { status: "signedIn" }

type SessionApi = {
  state: SessionState
  server: string
  signIn(): Promise<void>
  signOut(): Promise<void>
  /** Development builds: talk to another Workbot from now on. */
  changeServer(value: string): boolean
  /** The headers a raw request (an image, a download) needs, with a session fresh enough to use. */
  authHeaders(): Promise<Record<string, string>>
  url(path: string): string
}

const SessionContext = createContext<SessionApi | null>(null)

export function useSession(): SessionApi {
  const value = useContext(SessionContext)
  if (!value) throw new Error("useSession needs <SessionProvider>.")
  return value
}

const appSessionSchema = z.object({ session: z.string().min(1), expiresAt: z.number() })

/** The query string of an app address (`scheme:/path?a=b`), read without relying on URL support for custom schemes. */
function queryOf(url: string) {
  const index = url.indexOf("?")
  return new URLSearchParams(index === -1 ? "" : url.slice(index + 1).split("#")[0])
}

function withTimeout(ms: number, outer?: AbortSignal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  outer?.addEventListener("abort", () => controller.abort(), { once: true })
  return { signal: controller.signal, done: () => clearTimeout(timer) }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [state, setState] = useState<SessionState>({ status: "loading" })
  const [server, setServer] = useState(() => serverUrl())
  const current = useRef<StoredSession | null>(null)
  const refreshing = useRef<Promise<void> | null>(null)

  const keep = useCallback(async (session: StoredSession) => {
    current.current = session
    await sessionStore.write(session).catch(() => undefined)
  }, [])

  /** Signed out on this phone only (Workbot or Den already ended the sign-in). */
  const forget = useCallback(async (error: string | null) => {
    current.current = null
    await sessionStore.clear().catch(() => undefined)
    queryClient.clear()
    await clearCachedFiles()
    setState({ status: "signedOut", error })
  }, [queryClient])

  useEffect(() => {
    let cancelled = false
    void sessionStore.read().then((stored) => {
      if (cancelled) return
      current.current = stored
      setState(stored ? { status: "signedIn" } : { status: "signedOut", error: null })
    })
    return () => {
      cancelled = true
    }
  }, [])

  /** A rotated session from any response's headers replaces the one kept. */
  const takeRotation = useCallback((headers: Headers) => {
    const value = headers.get("workbot-session")
    const expiresAt = Number(headers.get("workbot-session-expires"))
    if (value && Number.isFinite(expiresAt) && expiresAt > 0) void keep({ value, expiresAt })
  }, [keep])

  /** One refresh at a time, only when the session runs out soon. */
  const fresh = useCallback(async () => {
    const session = current.current
    if (!session || session.expiresAt - Date.now() > REFRESH_AHEAD_MS) return
    refreshing.current ??= (async () => {
      try {
        const timeout = withTimeout(20_000)
        const response = await fetch(`${server}/auth/app/refresh`, { method: "POST", headers: { authorization: `Bearer ${session.value}`, accept: "application/json" }, signal: timeout.signal }).finally(timeout.done)
        if (response.status === 401) {
          await forget("You were signed out. Sign in again to keep going.")
          return
        }
        const parsed = appSessionSchema.safeParse(await response.json().catch(() => null))
        if (response.ok && parsed.success) await keep({ value: parsed.data.session, expiresAt: parsed.data.expiresAt })
      } catch {
        // Offline or Workbot unreachable: the request goes ahead with what we have, and Workbot refreshes if it must.
      } finally {
        refreshing.current = null
      }
    })()
    await refreshing.current
  }, [server, keep, forget])

  const authHeaders = useCallback(async (): Promise<Record<string, string>> => {
    await fresh()
    return current.current ? { authorization: `Bearer ${current.current.value}` } : {}
  }, [fresh])

  const transport = useMemo<WorkbotTransport>(() => ({
    async request(path, init = {}) {
      const headers: Record<string, string> = { accept: "application/json", ...(await authHeaders()) }
      if (init.body !== undefined) headers["content-type"] = "application/json"
      const timeout = withTimeout(init.timeoutMs ?? 30_000)
      try {
        const response = await fetch(`${server}${path}`, {
          method: init.method ?? "GET",
          headers,
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
          signal: timeout.signal,
        })
        takeRotation(response.headers)
        const payload: unknown = await response.json().catch(() => null)
        if (response.status === 401) await forget("You were signed out. Sign in again to keep going.")
        return { status: response.status, ok: response.ok, payload }
      } finally {
        timeout.done()
      }
    },
    async stream(path, signal) {
      const response = await streamingFetch(`${server}${path}`, { headers: { accept: "text/event-stream", ...(await authHeaders()) }, signal })
      takeRotation(response.headers)
      if (response.status === 401) await forget("You were signed out. Sign in again to keep going.")
      if (!response.ok || !response.body) throw new Error(`events_${response.status}`)
      // Text as it arrives; a character split across two chunks is decoded whole.
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      return {
        async *[Symbol.asyncIterator]() {
          try {
            for (;;) {
              const { value, done } = await reader.read()
              if (done) return
              yield value
            }
          } finally {
            reader.releaseLock()
          }
        },
      }
    },
    async bytes(path) {
      const response = await fetch(`${server}${path}`, { headers: await authHeaders() })
      takeRotation(response.headers)
      if (!response.ok) throw new Error("This file is no longer available.")
      return new Uint8Array(await response.arrayBuffer())
    },
    timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  }), [server, authHeaders, takeRotation, forget])

  const signIn = useCallback(async () => {
    const pending = await newSignIn()
    const start = `${server}/auth/app/login?${new URLSearchParams({ code_challenge: pending.challenge, code_challenge_method: "S256", state: pending.state, redirect_uri: build.redirectUri })}`
    const result = await WebBrowser.openAuthSessionAsync(start, build.redirectUri, { preferEphemeralSession: false })
    if (result.type !== "success") return
    const returned = queryOf(result.url)
    if (returned.get("state") !== pending.state) {
      setState({ status: "signedOut", error: "That sign-in didn't come from this app. Try again." })
      return
    }
    const code = returned.get("code")
    if (!code) {
      setState({ status: "signedOut", error: "OpenWork didn't finish signing you in." })
      return
    }
    try {
      const timeout = withTimeout(30_000)
      const response = await fetch(`${server}/auth/app/token`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ code, codeVerifier: pending.verifier, redirectUri: build.redirectUri }),
        signal: timeout.signal,
      }).finally(timeout.done)
      const parsed = appSessionSchema.safeParse(await response.json().catch(() => null))
      if (!response.ok || !parsed.success) {
        setState({ status: "signedOut", error: "OpenWork didn't finish signing you in." })
        return
      }
      await keep({ value: parsed.data.session, expiresAt: parsed.data.expiresAt })
      queryClient.clear()
      setState({ status: "signedIn" })
    } catch {
      setState({ status: "signedOut", error: "Workbot can't reach OpenWork right now." })
    }
  }, [server, keep, queryClient])

  const signOut = useCallback(async () => {
    const session = current.current
    if (session) {
      const timeout = withTimeout(10_000)
      await fetch(`${server}/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${session.value}` }, signal: timeout.signal }).catch(() => undefined).finally(timeout.done)
    }
    await forget(null)
  }, [server, forget])

  const changeServer = useCallback((value: string) => {
    const origin = normalizeServer(value)
    if (!origin || !setServerUrl(origin)) return false
    setServer(origin)
    return true
  }, [])

  const api = useMemo<SessionApi>(() => ({ state, server, signIn, signOut, changeServer, authHeaders, url: (path) => `${server}${path}` }), [state, server, signIn, signOut, changeServer, authHeaders])

  return (
    <SessionContext.Provider value={api}>
      <WorkbotTransportProvider transport={transport}>{children}</WorkbotTransportProvider>
    </SessionContext.Provider>
  )
}
