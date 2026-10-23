import type { Fetch } from "./den.ts"
import { isRecord } from "./den.ts"
import { fetchDesktopEnvironment } from "./desktop-credential-channel.ts"
import type { PluginContext } from "./opencode.ts"

/**
 * Organization environment variables, applied live inside the OpenCode V2
 * engine like provider inventory: the OpenWork server publishes them on the
 * loopback session bridge, and this polls them with the fd-delivered
 * capability. Values only live in this process's memory.
 *
 * New shells get them through the `shell` `create.before` hook. The process
 * environment is updated too, so terminals, MCP servers and language servers
 * started afterwards inherit them. Keys removed by an admin are removed again,
 * restoring whatever the process had before OpenWork set them.
 */

export type EnvironmentSnapshot = { digest: string; env: Record<string, string> }

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_KEYS = 500
const MAX_VALUE = 32_768

export function parseEnvironmentSnapshot(value: unknown): EnvironmentSnapshot | null {
  if (!isRecord(value) || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest) || !isRecord(value.env)) return null
  const entries = Object.entries(value.env)
  if (entries.length > MAX_KEYS) return null
  const env: Record<string, string> = {}
  for (const [key, entry] of entries) {
    if (!KEY.test(key) || typeof entry !== "string" || entry.length > MAX_VALUE) return null
    env[key] = entry
  }
  return { digest: value.digest, env }
}

/**
 * Process-wide state: setup runs once per Location, but the environment is
 * the process's. One poller, one set of owned keys.
 */
export class EnvironmentApplier {
  private current: Record<string, string> = {}
  private digest = ""
  /** Values the process had before OpenWork set each key; undefined when unset. */
  private readonly originals = new Map<string, string | undefined>()

  private readonly processEnv: Record<string, string | undefined>

  constructor(processEnv: Record<string, string | undefined>, ownedAtStart: readonly string[] = []) {
    this.processEnv = processEnv
    // Keys the server put in the spawn environment are ours from the start: nothing to restore.
    for (const key of ownedAtStart) {
      if (!KEY.test(key)) continue
      this.originals.set(key, undefined)
      const value = processEnv[key]
      if (value !== undefined) this.current[key] = value
    }
  }

  apply(snapshot: EnvironmentSnapshot): boolean {
    if (snapshot.digest === this.digest) return false
    for (const key of Object.keys(this.current)) {
      if (key in snapshot.env) continue
      const original = this.originals.get(key)
      if (original === undefined) delete this.processEnv[key]
      else this.processEnv[key] = original
      // Still tracked: shells built from an older environment are cleaned too.
    }
    for (const [key, value] of Object.entries(snapshot.env)) {
      if (!this.originals.has(key)) this.originals.set(key, this.processEnv[key])
      this.processEnv[key] = value
    }
    this.current = { ...snapshot.env }
    this.digest = snapshot.digest
    return true
  }

  /** Brings one shell's environment up to date, including keys removed since the engine started. */
  applyToShell(env: Record<string, string | undefined>): void {
    for (const [key, original] of this.originals) {
      if (key in this.current) continue
      if (original === undefined) delete env[key]
      else env[key] = original
    }
    Object.assign(env, this.current)
  }

  keys(): string[] {
    return Object.keys(this.current)
  }
}

type Applier = Pick<EnvironmentApplier, "apply" | "applyToShell">
type Shared = { applier: Applier; started: boolean; first: Promise<void> | null }
const SHARED = Symbol.for("openwork.desktop-environment")

// Each Location loads its own copy of this module, so the shared state is
// found by shape on globalThis rather than by class identity.
function isShared(value: unknown): value is Shared {
  return isRecord(value) && isRecord(value.applier)
    && typeof value.applier.apply === "function" && typeof value.applier.applyToShell === "function"
    && typeof value.started === "boolean"
}

function shared(): Shared {
  const holder: Record<symbol, unknown> = globalThis
  const existing = holder[SHARED]
  if (isShared(existing)) return existing
  const created: Shared = {
    applier: new EnvironmentApplier(process.env, (process.env.OPENWORK_CLOUD_ENV_KEYS ?? "").split(",").filter(Boolean)),
    started: false,
    first: null,
  }
  holder[SHARED] = created
  return created
}

/**
 * Starts polling (once per process) and registers this Location's shell hook.
 * Waits briefly for the first answer so the first shells already have it.
 */
export async function setupDesktopEnvironment(ctx: PluginContext, endpoint: string, deps: { fetch?: Fetch; intervalMs?: number } = {}): Promise<() => void> {
  const fetcher = deps.fetch ?? fetch
  const state = shared()
  await ctx.shell?.hook("create.before", (event) => state.applier.applyToShell(event.env))
  if (state.started) {
    await state.first
    return () => {}
  }
  state.started = true
  const poll = async () => {
    try {
      const response = await fetchDesktopEnvironment(fetcher, endpoint)
      if (!response?.ok) return
      const snapshot = parseEnvironmentSnapshot(await response.json())
      if (snapshot) state.applier.apply(snapshot)
    } catch {
      // The server restarts or is busy: keep the last values and try again.
    }
  }
  state.first = Promise.race([poll(), new Promise<void>((resolve) => setTimeout(resolve, 2_000))])
  await state.first
  // The environment belongs to the engine process, not one Location: polling
  // lives as long as the process (Locations come and go when idle).
  const timer = setInterval(() => { void poll() }, deps.intervalMs ?? 2_000)
  timer.unref?.()
  return () => {}
}
