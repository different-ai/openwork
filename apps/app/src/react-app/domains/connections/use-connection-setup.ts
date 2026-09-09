import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import type { ConnectionDiagnostic, ConnectionSetup, CreateSetupConnection, SetupConnection } from "@openwork/types/connection-setup"
import { createDenClient, DenApiError, readDenSettings } from "@/app/lib/den"
import { openDesktopUrl } from "@/app/lib/desktop"
import { denSettingsChangedEvent } from "@/app/lib/den-session-events"
import { clearCloudInventoryCache } from "./cloud-inventory-cache"

export type SetupPhase = "idle" | "loading" | "configure" | "sign_in" | "opening" | "waiting" | "checking" | "ready" | "failed" | "blocked" | "unsupported"
const attemptSchema = z.object({ externalKey: z.string(), connectionId: z.string().optional() })

export function useConnectionSetup(input: {
  principalId: string | undefined
  scopeId: string
  onReady: (connection: { id: string; name: string }) => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [setup, setSetup] = useState<ConnectionSetup | null>(null)
  const [connection, setConnection] = useState<SetupConnection | null>(null)
  const [phase, setPhase] = useState<SetupPhase>("idle")
  const [diagnostic, setDiagnostic] = useState<ConnectionDiagnostic | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [readyTargets, setReadyTargets] = useState<ReadonlySet<string>>(new Set())
  const generation = useRef(0)
  const active = useRef<ReturnType<typeof context> | null>(null)
  const busy = useRef(false)
  const delivered = useRef(new Set<string>())

  function context(target: string) {
    const settings = readDenSettings()
    if (!settings.authToken || !settings.activeOrgId || !input.principalId) throw new Error("Sign in to OpenWork and select an organization to set up a connection.")
    const storageKey = `openwork.connectionSetup.${JSON.stringify([settings.baseUrl, settings.activeOrgId, input.principalId, target])}`
    let attempt: z.infer<typeof attemptSchema>
    try { attempt = attemptSchema.parse(JSON.parse(localStorage.getItem(storageKey) ?? "null")) }
    catch { attempt = { externalKey: `chat-${crypto.randomUUID()}` } }
    // Only the non-secret attempt locator is persisted; credentials stay in the form.
    localStorage.setItem(storageKey, JSON.stringify(attempt))
    return { client: createDenClient({ baseUrl: settings.baseUrl, token: settings.authToken }), baseUrl: settings.baseUrl, token: settings.authToken, orgId: settings.activeOrgId, storageKey, attempt, target, scopeId: input.scopeId, generation: generation.current }
  }

  function current(ctx: NonNullable<typeof active.current>) {
    const settings = readDenSettings()
    return ctx.scopeId === input.scopeId && ctx.generation === generation.current && settings.baseUrl === ctx.baseUrl && settings.authToken === ctx.token && settings.activeOrgId === ctx.orgId
  }

  useEffect(() => {
    const reset = () => {
      generation.current += 1
      active.current = null
      busy.current = false
      setAuthorizeUrl(null)
      setConnection(null)
      setSetup(null)
      setOpen(false)
      setPhase("idle")
      setReadyTargets(new Set())
      delivered.current.clear()
    }
    reset()
    window.addEventListener(denSettingsChangedEvent, reset)
    return () => { window.removeEventListener(denSettingsChangedEvent, reset); generation.current += 1 }
  }, [input.principalId, input.scopeId])

  async function load(target: string) {
    setReadyTargets(targets => new Set([...targets].filter(value => value !== target)))
    setOpen(true)
    setQuery(target)
    setSetup(null)
    setConnection(null)
    setError(null); setDiagnostic(null)
    setPhase("loading")
    setAuthorizeUrl(null)
    busy.current = false
    const loadGeneration = ++generation.current
    try {
      const ctx = context(target)
      active.current = ctx
      const next = await ctx.client.readConnectionSetup(ctx.orgId, { query: target, ...ctx.attempt })
      if (!current(ctx)) return
      setSetup(next)
      const selected = next.connections.find(entry => entry.id === ctx.attempt.connectionId) ?? (next.connections.length === 1 ? next.connections[0] : null)
      setConnection(selected ?? null)
      setPhase(selected ? "sign_in" : next.canManage || next.connections.length > 0 ? "configure" : "blocked")
    } catch (cause) {
      if (generation.current !== loadGeneration) return
      if (cause instanceof DenApiError && (cause.status === 404 || cause.status === 405)) {
        setError(null); setDiagnostic(null)
        setPhase("unsupported")
        return
      }
      setError(cause instanceof Error ? cause.message : "Could not check this connection.")
      setPhase("failed")
    }
  }

  async function verify(ctx: NonNullable<typeof active.current>, entry: { id: string; name: string }) {
    setPhase("checking")
    const result = await ctx.client.checkConnectionReadiness(ctx.orgId, entry.id)
    if (!current(ctx)) return
    if (result.state !== "ready") {
      if (result.state === "needs_auth") setConnection(value => value ? { ...value, connectedForMe: false } : value)
      setError(result.message)
      setDiagnostic(result.diagnostic ?? null)
      setPhase(result.state === "needs_auth" ? "sign_in" : result.state === "blocked" ? "blocked" : "failed")
      return
    }
    clearCloudInventoryCache()
    setError(null); setDiagnostic(null)
    setPhase("ready")
    setReadyTargets(targets => new Set([...targets, ctx.target]))
    const key = `${ctx.orgId}:${entry.id}`
    if (!delivered.current.has(key)) {
      delivered.current.add(key)
      try { await input.onReady(entry) }
      catch { if (current(ctx)) setError("Connection is ready. Send a message in your task to continue.") }
    }
  }

  async function connect(ctx: NonNullable<typeof active.current>, entry: SetupConnection) {
    if (!entry.canUse) { setError("You need to be granted access to use this connection."); setPhase("blocked"); return }
    if (entry.authType !== "oauth" || entry.connectedForMe && !entry.needsReconnect) return verify(ctx, entry)
    if (entry.credentialMode === "shared" && !setup?.canManage) {
      setError("A connection manager needs to sign in to the shared account.")
      setPhase("blocked")
      return
    }
    setPhase("opening")
    const started = await ctx.client.startMcpConnectionConnect(ctx.orgId, entry.id)
    if (!current(ctx)) return
    if (started.status === "connected") return verify(ctx, entry)
    if (!started.authorizeUrl) throw new Error("The service did not return a sign-in link.")
    const authorization = new URL(started.authorizeUrl)
    if (!["https:", "http:"].includes(authorization.protocol)) throw new Error("The service returned an invalid sign-in link.")
    setAuthorizeUrl(started.authorizeUrl)
    await openDesktopUrl(started.authorizeUrl)
    if (!current(ctx)) return
    setPhase("waiting")
    const deadline = Date.now() + 180_000
    while (current(ctx) && Date.now() < deadline) {
      await new Promise(resolve => window.setTimeout(resolve, 2_000))
      if (!current(ctx)) return
      let authorized = false
      if (started.attemptId) {
        const attempt = await ctx.client.readConnectionAttempt(ctx.orgId, entry.id, started.attemptId)
        if (!current(ctx)) return
        if (attempt.state === "failed" || attempt.state === "expired" || attempt.state === "configuration_changed") {
          setAuthorizeUrl(null)
          setDiagnostic(attempt.diagnostic)
          setError(attempt.diagnostic?.message ?? (attempt.state === "expired" ? "This sign-in request expired. Sign in again." : "The connection changed during sign-in. Reopen setup and try again."))
          setPhase("failed")
          return
        }
        authorized = attempt.state === "authorized"
      } else {
        // Compatibility with servers that predate attempt outcomes.
        const inventory = await ctx.client.listMcpConnections(ctx.orgId).catch(() => null)
        if (!current(ctx)) return
        const account = inventory?.find(item => item.id === entry.id)
        authorized = Boolean(account?.connectedForMe && !account.needsReconnect)
      }
      if (authorized) {
        const connected = { ...entry, connectedForMe: true, needsReconnect: false }
        setConnection(connected)
        setAuthorizeUrl(null)
        return verify(ctx, connected)
      }
    }
    if (current(ctx)) throw new Error("Sign-in hasn't finished. Complete it in the provider window, then check again.")
  }

  async function submit(values?: Omit<CreateSetupConnection, "externalKey">) {
    const ctx = active.current
    if (!ctx || !current(ctx) || busy.current) return
    busy.current = true
    setError(null); setDiagnostic(null)
    try {
      let selected = connection
      if (!selected) {
        if (!values || !setup?.canManage) throw new Error("Connection management permission is required.")
        setPhase("loading")
        try {
          const created = await ctx.client.createSetupConnection(ctx.orgId, { ...values, externalKey: ctx.attempt.externalKey })
          if (!current(ctx)) return
          ctx.attempt.connectionId = created.id
          localStorage.setItem(ctx.storageKey, JSON.stringify(ctx.attempt))
        } catch (cause) {
          // A lost response or validation failure may follow a committed create.
          // Recover that exact attempt, without making a second connection.
          const resumed = await ctx.client.readConnectionSetup(ctx.orgId, { query: ctx.target, ...ctx.attempt, resumeOnly: true })
          if (!current(ctx)) return
          setSetup(resumed)
          const existing = resumed.connections.find(item => item.id === ctx.attempt.connectionId) ?? (resumed.connections.length === 1 ? resumed.connections[0] : undefined)
          if (existing) { setConnection(existing); ctx.attempt.connectionId = existing.id; localStorage.setItem(ctx.storageKey, JSON.stringify(ctx.attempt)) }
          throw cause
        }
        const next = await ctx.client.readConnectionSetup(ctx.orgId, { query: ctx.target, ...ctx.attempt })
        if (!current(ctx)) return
        setSetup(next)
        selected = next.connections.find(item => item.id === ctx.attempt.connectionId) ?? null
        if (!selected) throw new Error("The connection was saved, but could not be loaded. Check your access and try again.")
        setConnection(selected)
      }
      await connect(ctx, selected)
    } catch (cause) {
      if (current(ctx)) { setError(cause instanceof Error ? cause.message : "Connection setup could not finish."); setPhase("failed") }
    } finally { if (current(ctx)) busy.current = false }
  }

  async function replaceCredentials(credentials: Pick<CreateSetupConnection, "apiKey" | "oauthClient">) {
    const ctx = active.current
    if (!ctx || !current(ctx) || busy.current || !connection || !setup?.canManage || !setup.target) return
    busy.current = true
    setError(null); setDiagnostic(null)
    setPhase("checking")
    try {
      await ctx.client.replaceSetupCredentials(ctx.orgId, connection, setup.target.kind, credentials)
      if (!current(ctx)) return
      const next = await ctx.client.readConnectionSetup(ctx.orgId, { query: ctx.target, connectionId: connection.id })
      if (!current(ctx)) return
      setSetup(next)
      const updated = next.connections.find(entry => entry.id === connection.id)
      if (!updated) throw new Error("Check your access and reopen setup.")
      const nextConnection = credentials.oauthClient ? { ...updated, connectedForMe: false } : updated
      setConnection(nextConnection)
      await connect(ctx, nextConnection)
    } catch (cause) {
      if (current(ctx)) { setError(cause instanceof Error ? cause.message : "The credentials could not be updated."); setPhase("failed") }
    } finally { if (current(ctx)) busy.current = false }
  }

  function stopWaiting() {
    const ctx = active.current
    if (!ctx || !current(ctx)) return
    active.current = { ...ctx, generation: ++generation.current }
    busy.current = false
    setPhase("sign_in")
    setError(null); setDiagnostic(null)
    setAuthorizeUrl(null)
  }

  async function openSettings() {
    const ctx = active.current
    if (!ctx || !current(ctx)) return
    try { await openDesktopUrl(new URL("/dashboard/mcp-connections", ctx.baseUrl).toString()) }
    catch { if (current(ctx)) setError("Organization settings could not be opened. Try again.") }
  }

  function select(entry: SetupConnection) {
    const ctx = active.current
    if (!ctx || !current(ctx)) return
    ctx.attempt.connectionId = entry.id
    localStorage.setItem(ctx.storageKey, JSON.stringify(ctx.attempt))
    setConnection(entry)
    setError(null); setDiagnostic(null)
    setPhase("sign_in")
  }

  return { open, setOpen, setup, connection, phase, error, diagnostic, query, readyTargets, authorizeUrl, load, submit, select, replaceCredentials, stopWaiting, openSettings }
}
