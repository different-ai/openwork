/** Explicitly approved native Location -> OpenWork session runner. Scheduling belongs here, not the shared core. */
import { createHash, randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import { hostname } from "node:os"
import {
  createRemoteSessionTransport, createSessionRunner, emptyJournal, parseJournal,
  RemoteSessionHttpError,
  type SessionRunner,
} from "../../remote-sessions/src/index.ts"
import { INTEGRATION_ID, readCredentialMetadata } from "./auth.ts"
import { DenAuthError, DenRequestError, denRequest, isAllowedApiBaseUrl, isRecord, type DenSession, type Fetch } from "./den.ts"
import { createNativeOpenCodeAdapter, nativeWorkspace } from "./native-opencode.ts"
export { hasNativeSessionHost } from "./native-opencode.ts"
import type { NativePluginContext } from "./opencode.ts"
import { acquireRunnerOwnership, type RunnerOwnership } from "./runner-ownership.ts"

const CAPABILITIES = ["remote_session_v1", "remote_session_control_v1", "remote_session_only_v1", "remote_session_recovery_v1"]
const RENEW_MS = 30 * 60_000
const INVENTORY_MS = 60_000
const POLL_MS = 3000

function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 32) }
/** The pinned Promise host ignores RequestOptions.signal on API methods; bound our wait anyway. */
function hostRead<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  bounded.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(bounded.reason)
    bounded.addEventListener("abort", abort, { once: true })
    Promise.resolve().then(() => { bounded.throwIfAborted(); return read() })
      .then(resolve, reject).finally(() => bounded.removeEventListener("abort", abort))
  })
}

function platform(): "darwin" | "linux" | "win32" {
  if (process.platform !== "darwin" && process.platform !== "linux" && process.platform !== "win32") {
    throw new Error("Remote OpenCode sessions require macOS, Linux, or Windows.")
  }
  return process.platform
}

interface Account {
  identity: string
  session: DenSession
  credentialExpiresAt: number
}
interface Active {
  account: Account
  runnerId: string
  workspaceId: string
  runner: SessionRunner
  token: string | null
  tokenExpiresAt: number
  registeredAt: number
  inventoryAt: number
}

export interface RemoteRunnerController {
  /** Starts in the background. Never wait for Den from plugin setup or a prompt hook. */
  start(): void
  /** Call immediately on credential events; cancel old in-flight work before resolving credentials again. */
  credentialsChanged(): void
  close(): Promise<void>
  /** Single-flight manual cycle, also used by deterministic local tests. */
  poll(): Promise<void>
}

export function createRemoteRunnerController(input: {
  ctx: NativePluginContext
  apiBaseUrl: string
  label?: string
  fetch?: Fetch
  now?: () => number
  random?: () => number
  /** Test seams for timers and process-safe locking, not plugin options. */
  schedule?: (callback: () => void, delayMs: number) => () => void
  acquireOwnership?: (directory: string) => Promise<RunnerOwnership | null>
}): RemoteRunnerController {
  const { ctx } = input
  const now = input.now ?? Date.now
  const random = input.random ?? Math.random
  const fetcher = input.fetch ?? ((url, init) => fetch(url, init))
  const schedule = input.schedule ?? ((callback, delay) => {
    const timer = setTimeout(callback, delay)
    timer.unref?.()
    return () => clearTimeout(timer)
  })
  let disposed = false
  let started = false
  let active: Active | null = null
  let ownership: RunnerOwnership | null = null
  let directory: string | null = null
  let cancelTimer: (() => void) | null = null
  let operation: AbortController | null = null
  let flight: Promise<void> | null = null
  let queued = false
  let failures = 0

  async function account(signal: AbortSignal): Promise<Account | null> {
    const connection = await hostRead(() => ctx.integration.connection.active(INTEGRATION_ID), signal)
    signal.throwIfAborted()
    if (!connection || connection.type !== "credential" || connection.status?.status === "needs_auth") return null
    const credential = await hostRead(() => ctx.integration.connection.resolve(connection), signal)
    signal.throwIfAborted()
    if (!credential || credential.type !== "oauth" || !Number.isFinite(credential.expires) || credential.expires <= now()) return null
    const metadata = readCredentialMetadata(credential, input.apiBaseUrl)
    if (!metadata.orgId || !isAllowedApiBaseUrl(metadata.apiBaseUrl)) return null
    return {
      identity: hash(JSON.stringify([metadata.apiBaseUrl, metadata.orgId, connection.id])),
      session: { apiBaseUrl: metadata.apiBaseUrl, orgId: metadata.orgId, token: credential.access },
      credentialExpiresAt: credential.expires,
    }
  }

  async function initialize(value: Account, signal: AbortSignal): Promise<Active | null> {
    directory ??= await realpath(ctx.location.directory)
    signal.throwIfAborted()
    ownership ??= await (input.acquireOwnership ?? acquireRunnerOwnership)(directory)
    if (!ownership) return null
    signal.throwIfAborted()
    const directoryKey = hash(directory)
    // storage is plugin-wide; the directory lock is acquired before any identity/journal writes.
    let installation = await ctx.storage.get("remoteSessions/installation")
    if (typeof installation !== "string" || !installation) {
      installation = randomUUID()
      await ctx.storage.set("remoteSessions/installation", installation)
    }
    // Den binds each runner to one organization member. Keep identities stable within an account,
    // but never try to register the previous member's runner after an account switch.
    const identityKey = `remoteSessions/runner/${hash(JSON.stringify([directoryKey, value.identity]))}`
    let runnerId = await ctx.storage.get(identityKey)
    if (typeof runnerId !== "string" || !/^oc_runner_[a-f0-9]{32}$/.test(runnerId)) {
      runnerId = `oc_runner_${hash(JSON.stringify([installation, directory, value.identity]))}`
      await ctx.storage.set(identityKey, runnerId)
    }
    if (typeof runnerId !== "string") throw new Error("Runner identity is unavailable.")
    const workspaceId = `oc_workspace_${directoryKey}`
    const prefix = `remoteSessions/${hash(JSON.stringify([value.identity, runnerId, directory]))}`
    const journalKey = `${prefix}/journal`
    const native = createNativeOpenCodeAdapter({ ctx, directory, workspaceId, storagePrefix: prefix, now })
    // Token closure is evaluated on every retry. Renewing it never replaces the core or its journal/watch state.
    const state: Active = {
      account: value, runnerId, workspaceId, runner: createSessionRunner({
        adapter: native,
        store: {
          async load() {
            const stored = await ctx.storage.get(journalKey)
            return stored === undefined ? emptyJournal() : parseJournal(stored)
          },
          async save(journal) { await ctx.storage.set(journalKey, JSON.parse(JSON.stringify(journal))) },
        },
        transport: createRemoteSessionTransport({ baseUrl: value.session.apiBaseUrl,
          token: () => disposed || active !== state || state.account.credentialExpiresAt <= now() || state.tokenExpiresAt <= now() ? null : state.token,
          fetch: (url, init) => fetcher(String(url), init), timeoutMs: 10_000 }),
        now,
      }),
      token: null, tokenExpiresAt: 0, registeredAt: 0, inventoryAt: 0,
    }
    // Invalid storage must fail closed before claiming any work.
    await state.runner.inspect()
    signal.throwIfAborted()
    return state
  }

  async function register(state: Active, signal: AbortSignal): Promise<void> {
    const response = await hostRead(() => denRequest(fetcher, state.account.session, "/v1/session-runners/token", { method: "POST", signal,
      body: { runnerId: state.runnerId, protocolVersion: 1, supportedExecutionTargets: ["desktop"],
        capabilities: CAPABILITIES, platform: platform(), appVersion: ctx.app.version, concurrency: 1 } }), signal)
    signal.throwIfAborted()
    if (!isRecord(response) || typeof response.token !== "string" || response.token.length < 32
      || response.token.length > 512 || /[\r\n]/.test(response.token)
      || typeof response.expiresAt !== "number" || !Number.isFinite(response.expiresAt) || response.expiresAt <= now()) {
      throw new Error("OpenWork returned an invalid session-runner registration.")
    }
    state.token = response.token
    state.tokenExpiresAt = response.expiresAt
    state.registeredAt = now()
    state.inventoryAt = 0
  }

  async function runnerRequest(state: Active, path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const token = state.token
    if (!token || state.tokenExpiresAt <= now()) throw new RemoteSessionHttpError(401)
    return hostRead(() => denRequest(fetcher, { ...state.account.session, token }, path,
      { signal, ...(body === undefined ? {} : { method: "PUT", body }) }), signal)
  }

  async function cycle(signal: AbortSignal): Promise<void> {
    let value: Account | null
    try { value = await account(signal) }
    catch (error) {
      // A failed credential resolution cannot authorize remote native work, even if an old runner token remains valid.
      if (error instanceof DenAuthError) active = null
      throw error
    }
    if (!value) { active = null; return }
    signal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(2_147_483_647, value.credentialExpiresAt - now())))])
    if (active && active.account.identity !== value.identity) active = null
    if (!active) active = await initialize(value, signal)
    const state = active
    if (!state) return
    state.account = value
    signal.throwIfAborted()
    if (!state.token || state.tokenExpiresAt <= now() + 2 * 60_000 || now() - state.registeredAt >= RENEW_MS) await register(state, signal)
    const transport = createRemoteSessionTransport({ baseUrl: value.session.apiBaseUrl, token: () => state.token,
      fetch: (url, init) => fetcher(String(url), init), timeoutMs: 10_000 })
    if (state.inventoryAt === 0 || now() - state.inventoryAt >= INVENTORY_MS) {
      const workspace = await hostRead(() => nativeWorkspace(ctx, state.workspaceId, signal), signal)
      const published = await runnerRequest(state, "/v1/session-runners/inventory", signal, {
        computer: { label: (input.label?.trim() || hostname() || "OpenCode").slice(0, 120), platform: platform(), appVersion: ctx.app.version },
        workspaces: [workspace],
      })
      signal.throwIfAborted()
      if (!isRecord(published) || published.ok !== true || typeof published.updatedAt !== "number" || !Number.isFinite(published.updatedAt)) {
        throw new Error("OpenWork returned an invalid inventory acknowledgement.")
      }
      state.inventoryAt = now()
    }
    // Restore receipts and pending outboxes before fetching more claimed work.
    await state.runner.reconcile(signal)
    const journal = await state.runner.inspect()
    if (journal.commands.length >= 200 || journal.requests.length >= 200) {
      await state.runner.prune({ retainCommands: 128, retainRequests: 128 })
    }
    const response = await runnerRequest(state, "/v1/session-runners/work", signal)
    signal.throwIfAborted()
    if (!isRecord(response) || !Array.isArray(response.items) || response.items.length > 10) throw new Error("Invalid session-runner work response.")
    for (const item of response.items) {
      signal.throwIfAborted()
      if (!isRecord(item)) throw new Error("Invalid session-runner work item.")
      try {
        if (item.kind === "remote_session_create" && typeof item.commandId === "string") {
          await state.runner.accept(await transport.claimCommand(item.commandId, signal), signal)
        } else if (item.kind === "remote_session_request" && typeof item.requestId === "string") {
          await state.runner.execute(await transport.claimRequest(item.requestId, signal), signal)
        } else {
          // Never interpret Automation runs, unknown future work kinds, or arbitrary session IDs as native work.
          throw new Error("Unexpected session-runner work kind.")
        }
      } catch (error) {
        if (error instanceof RemoteSessionHttpError && error.status === 409) continue
        throw error
      }
    }
    await state.runner.reconcile(signal)
  }

  function poll(): Promise<void> {
    if (disposed) return Promise.resolve()
    if (flight) { queued = true; return flight }
    cancelTimer?.()
    cancelTimer = null
    const controller = new AbortController()
    operation = controller
    flight = cycle(controller.signal).then(() => { failures = 0 }).catch(error => {
      if (!controller.signal.aborted) {
        failures++
        // Server-side feature disable/revocation withdraws approval immediately. Keep journals for safe reconnect.
        if (error instanceof DenAuthError || error instanceof RemoteSessionHttpError && (error.status === 401 || error.status === 403)
          || error instanceof DenRequestError && (error.status === 403 || error.status === 404)) active = null
      }
    }).finally(() => {
      flight = null
      if (operation === controller) operation = null
      if (disposed || !started) return
      const delay = queued ? 0 : Math.round((failures ? Math.min(30_000, POLL_MS * 2 ** Math.min(failures, 4)) : POLL_MS) * (0.8 + random() * 0.4))
      queued = false
      cancelTimer = schedule(() => { void poll() }, delay)
    })
    return flight
  }

  return {
    start() { if (started || disposed) return; started = true; void poll() },
    poll,
    credentialsChanged() {
      if (disposed) return
      operation?.abort(new Error("OpenWork credentials changed."))
      queued = true
      if (!flight) void poll()
    },
    async close() {
      if (disposed) return
      disposed = true
      started = false
      cancelTimer?.()
      operation?.abort(new Error("The OpenWork plugin unloaded."))
      await flight
      active = null
      await ownership?.release()
      ownership = null
    },
  }
}
