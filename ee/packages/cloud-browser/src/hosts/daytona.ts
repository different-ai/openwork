import { shellQuote } from "@openwork-ee/cloud-runtime/bootstrap"
import {
  runtimeProviderErrorCode,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxSpec,
} from "@openwork-ee/cloud-runtime/contract"
import { readBrowserVersion, withBrowser } from "../cdp"
import { CloudBrowserError, browserKeyId, type BrowserEndpoint, type BrowserHost, type BrowserKey } from "../contract"

/**
 * Each member's browser is one persistent, private Daytona sandbox booted from
 * a Chromium snapshot (packaging/docker/Dockerfile.cloud-browser). The profile
 * on the sandbox disk is the remembered sign-in, so the sandbox is stopped when
 * idle (cheap), archived after days, and never deleted automatically.
 *
 * DevTools is reached only through a signed preview URL whose token is in the
 * hostname, used server-side by Den. It is never returned to a browser or a
 * model, and the sandbox itself is never public.
 */
export type DaytonaBrowserHostConfig = {
  /** A Daytona `SandboxProvider` (from `createDaytonaProvider`). */
  provider: SandboxProvider
  /** Snapshot with Chromium, curl and procps installed. */
  snapshot: string
  /** Sandbox names are `<prefix>-<hash of organization and member>`. */
  namePrefix?: string
  profileDir?: string
  port?: number
  windowSize?: { width: number; height: number }
  autoStopMinutes?: number
  autoArchiveMinutes?: number
  endpointTtlSeconds?: number
  /** Bound for creating or starting the sandbox. */
  startTimeoutMs?: number
  /** Bound for Chrome to answer after launch. */
  chromeStartTimeoutMs?: number
  pollIntervalMs?: number
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<unknown>
}

export const DAYTONA_BROWSER_HOST_ID = "daytona"
/** Server-side requests skip Daytona's interstitial for previews. */
export const DAYTONA_PREVIEW_HEADERS: Readonly<Record<string, string>> = { "X-Daytona-Skip-Preview-Warning": "true" }
export const DEFAULT_DAYTONA_PROFILE_DIR = "/home/daytona/.openwork/browser-profile"

const DEFAULT_PORT = 9222
/** Refresh the signed URL this long before it expires. */
const ENDPOINT_REFRESH_LEAD_MS = 5 * 60_000
/** Reuse a successful liveness probe this long (live view polls twice a second). */
const PROBE_REUSE_MS = 3_000
/** Remember "not running" this long so status polling does not hit the Daytona API. */
const NOT_RUNNING_REUSE_MS = 10_000
/** Count use as activity at most this often. */
const TOUCH_INTERVAL_MS = 60_000

export function daytonaBrowserSandboxName(key: BrowserKey, prefix = "owb"): string {
  return `${prefix}-${browserKeyId(key)}`.toLowerCase()
}

/**
 * Starts Chrome fully detached (own session, no inherited stdio), because the
 * exec session that launches it ends right away. Idempotent: does nothing when
 * DevTools already answers, waits for a Chrome that is still starting, and
 * replaces one that stopped answering. Processes are matched by name, never
 * by command line, which would also match this script.
 */
export function chromeLaunchScript(options: { profileDir: string; port: number; windowSize: { width: number; height: number } }): string {
  const profile = shellQuote(options.profileDir)
  const probe = `curl -fsS --max-time 2 http://127.0.0.1:${options.port}/json/version >/dev/null 2>&1`
  // DevTools listens on loopback only (new headless ignores
  // --remote-debugging-address); Daytona's preview proxy reaches it from
  // inside the sandbox, and nothing else can.
  const flags = [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${options.port}`,
    `--user-data-dir=${options.profileDir}`,
    "--password-store=basic",
    `--window-size=${options.windowSize.width},${options.windowSize.height}`,
  ].map(shellQuote).join(" ")
  return [
    `if ${probe}; then exit 0; fi`,
    `CHROME="$(command -v chromium || command -v chromium-browser || command -v google-chrome-stable || command -v google-chrome || true)"`,
    `if [ -z "$CHROME" ]; then echo "No Chromium binary in this sandbox." >&2; exit 127; fi`,
    `if pgrep -x 'chromium|chrome' >/dev/null 2>&1; then`,
    `  for attempt in 1 2 3 4 5 6 7 8 9 10; do sleep 1; if ${probe}; then exit 0; fi; done`,
    `  pkill -x 'chromium|chrome' >/dev/null 2>&1 || true`,
    "  sleep 1",
    "fi",
    `mkdir -p ${profile}`,
    // A stop without shutdown leaves Chrome's single-instance lock behind.
    `rm -f ${profile}/SingletonLock ${profile}/SingletonSocket ${profile}/SingletonCookie`,
    `setsid nohup "$CHROME" ${flags} about:blank >/tmp/openwork-cloud-browser.log 2>&1 </dev/null &`,
    "exit 0",
  ].join("\n")
}

type Entry = {
  handle: SandboxHandle
  endpoint: BrowserEndpoint
  probedAt: number
  touchedAt: number
}

export function createDaytonaBrowserHost(config: DaytonaBrowserHostConfig): BrowserHost {
  const provider = config.provider
  const prefix = config.namePrefix ?? "owb"
  const profileDir = config.profileDir ?? DEFAULT_DAYTONA_PROFILE_DIR
  const port = config.port ?? DEFAULT_PORT
  const windowSize = config.windowSize ?? { width: 1280, height: 800 }
  const ttlSeconds = config.endpointTtlSeconds ?? 3_600
  const startTimeoutMs = config.startTimeoutMs ?? 75_000
  const chromeStartTimeoutMs = config.chromeStartTimeoutMs ?? 20_000
  const pollIntervalMs = config.pollIntervalMs ?? 1_000
  const now = config.now ?? Date.now
  const sleep = config.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const entries = new Map<string, Entry>()
  const notRunningUntil = new Map<string, number>()
  const opening = new Map<string, Promise<BrowserEndpoint>>()

  function providerFailure(error: unknown, message: string): CloudBrowserError {
    if (error instanceof CloudBrowserError) return error
    const code = runtimeProviderErrorCode(error)
    if (code === "timeout") return new CloudBrowserError("timeout", "The cloud browser took too long to start. Try again in a minute.", { cause: error })
    if (code === "auth" || code === "capacity" || code === "rate_limited" || code === "transient") {
      return new CloudBrowserError("browser_unavailable", "The cloud browser is unavailable right now. Try again in a minute.", { cause: error })
    }
    return new CloudBrowserError("browser_start_failed", message, { cause: error })
  }

  function aborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) throw new CloudBrowserError("timeout", "The cloud browser took too long to start. Try again in a minute.")
  }

  async function answers(endpoint: BrowserEndpoint): Promise<boolean> {
    return readBrowserVersion(endpoint, { timeoutMs: 4_000, fetch: config.fetch }).then(() => true, () => false)
  }

  function fresh(endpoint: BrowserEndpoint): boolean {
    return endpoint.expiresAt === null || endpoint.expiresAt.getTime() - now() > ENDPOINT_REFRESH_LEAD_MS
  }

  function touch(entry: Entry) {
    if (!provider.touch || now() - entry.touchedAt < TOUCH_INTERVAL_MS) return
    entry.touchedAt = now()
    void provider.touch(entry.handle).catch(() => undefined)
  }

  async function signedEndpoint(handle: SandboxHandle): Promise<BrowserEndpoint> {
    const endpoint = await provider.endpoint(handle, port, { ttlSeconds })
    return { cdpUrl: endpoint.url, headers: { ...DAYTONA_PREVIEW_HEADERS }, expiresAt: endpoint.expiresAt }
  }

  function spec(name: string, key: BrowserKey): SandboxSpec {
    return {
      workerId: name,
      idempotencyKey: name,
      image: { id: config.snapshot, version: config.snapshot },
      labels: {
        "openwork.cloud-browser": "1",
        "openwork.organization-id": key.organizationId,
        "openwork.member-id": key.memberId,
      },
      env: {},
      storage: [],
      exposePorts: [port],
      lifecycle: {
        autoStopMinutes: config.autoStopMinutes ?? 15,
        autoArchiveMinutes: config.autoArchiveMinutes ?? 7 * 24 * 60,
        // Never: the profile on this disk is the person's remembered sign-in.
        autoDeleteMinutes: -1,
      },
      public: false,
    }
  }

  async function findOrCreate(name: string, key: BrowserKey): Promise<SandboxHandle> {
    const existing = await provider.find({ idempotencyKey: name })
    if (existing && existing.state !== "missing") return existing
    try {
      return await provider.create(spec(name, key), { timeoutMs: startTimeoutMs })
    } catch (error) {
      // Another Den replica created it first.
      if (runtimeProviderErrorCode(error) === "conflict") {
        const created = await provider.find({ idempotencyKey: name })
        if (created) return created
      }
      throw error
    }
  }

  async function ensureRunning(handle: SandboxHandle, signal: AbortSignal | undefined): Promise<SandboxHandle> {
    const deadline = now() + startTimeoutMs
    let current = handle
    while (now() < deadline) {
      aborted(signal)
      if (current.state === "running") return current
      if (current.state === "error" || current.state === "missing") {
        throw new CloudBrowserError("browser_start_failed", "The cloud browser could not start. Try again in a minute.")
      }
      if (current.state === "stopped" || current.state === "archived") {
        try {
          await provider.start(current, { timeoutMs: Math.max(1_000, deadline - now()) })
        } catch (error) {
          // A start already in progress converges below.
          if (runtimeProviderErrorCode(error) !== "invalid_state") throw error
        }
      } else {
        await sleep(pollIntervalMs)
      }
      current = await provider.inspect(current)
    }
    throw new CloudBrowserError("timeout", "The cloud browser took too long to start. Try again in a minute.")
  }

  async function launchChrome(handle: SandboxHandle) {
    const exec = await provider.exec(handle, {
      command: `sh -lc ${shellQuote(chromeLaunchScript({ profileDir, port, windowSize }))}`,
      detach: false,
      timeoutMs: 30_000,
      sessionId: `openwork-browser-${now()}`,
    })
    const exitCode = await exec.exitCode()
    if (exitCode === 0) return
    const logs = await exec.logs().catch(() => ({ stdout: "", stderr: "" }))
    const detail = (logs.stderr || logs.stdout).trim().slice(-300)
    throw new CloudBrowserError("browser_start_failed", `Chrome did not start in the cloud browser${detail ? `: ${detail}` : ""}.`)
  }

  async function waitForChrome(endpoint: BrowserEndpoint, signal: AbortSignal | undefined) {
    const deadline = now() + chromeStartTimeoutMs
    while (now() < deadline) {
      aborted(signal)
      if (await answers(endpoint)) return
      await sleep(500)
    }
    throw new CloudBrowserError("browser_start_failed", "Chrome did not answer in the cloud browser.")
  }

  async function startBrowser(name: string, key: BrowserKey, signal: AbortSignal | undefined): Promise<BrowserEndpoint> {
    try {
      const handle = await ensureRunning(await findOrCreate(name, key), signal)
      // A restarted sandbox gets a newly signed endpoint.
      const endpoint = await signedEndpoint(handle)
      if (!(await answers(endpoint))) {
        await launchChrome(handle)
        await waitForChrome(endpoint, signal)
      }
      const entry: Entry = { handle, endpoint, probedAt: now(), touchedAt: 0 }
      entries.set(name, entry)
      notRunningUntil.delete(name)
      touch(entry)
      return endpoint
    } catch (error) {
      throw providerFailure(error, "The cloud browser could not start. Try again in a minute.")
    }
  }

  /** A cached endpoint that still answers, without calling the Daytona API. */
  async function cachedEndpoint(name: string): Promise<BrowserEndpoint | null> {
    const entry = entries.get(name)
    if (!entry || !fresh(entry.endpoint)) return null
    if (now() - entry.probedAt > PROBE_REUSE_MS) {
      if (!(await answers(entry.endpoint))) {
        entries.delete(name)
        return null
      }
      entry.probedAt = now()
    }
    touch(entry)
    return entry.endpoint
  }

  return {
    id: DAYTONA_BROWSER_HOST_ID,
    async open(key, options = {}) {
      const name = daytonaBrowserSandboxName(key, prefix)
      const cached = await cachedEndpoint(name)
      if (cached) return cached
      const pending = opening.get(name)
      if (pending) return pending
      const started = startBrowser(name, key, options.signal).finally(() => opening.delete(name))
      opening.set(name, started)
      return started
    },
    async peek(key) {
      const name = daytonaBrowserSandboxName(key, prefix)
      const cached = await cachedEndpoint(name)
      if (cached) return cached
      if ((notRunningUntil.get(name) ?? 0) > now()) return null
      try {
        const handle = await provider.find({ idempotencyKey: name })
        if (handle?.state === "running") {
          const endpoint = await signedEndpoint(handle)
          if (await answers(endpoint)) {
            const entry: Entry = { handle, endpoint, probedAt: now(), touchedAt: 0 }
            entries.set(name, entry)
            touch(entry)
            return endpoint
          }
        }
      } catch (error) {
        throw providerFailure(error, "The cloud browser is unavailable right now.")
      }
      notRunningUntil.set(name, now() + NOT_RUNNING_REUSE_MS)
      return null
    },
    async stop(key) {
      const name = daytonaBrowserSandboxName(key, prefix)
      const entry = entries.get(name)
      entries.delete(name)
      notRunningUntil.delete(name)
      const handle = entry?.handle ?? await provider.find({ idempotencyKey: name })
      if (!handle) return
      const current = await provider.inspect(handle)
      if (current.state !== "running") return
      // Let Chrome write cookies and the rest of the profile before the disk is frozen.
      const endpoint = entry?.endpoint ?? await signedEndpoint(current).catch(() => null)
      if (endpoint) {
        await withBrowser(endpoint, (cdp) => cdp.send("Browser.close", {}, { timeoutMs: 5_000 }), { timeoutMs: 5_000, fetch: config.fetch }).catch(() => undefined)
      }
      await provider.stop(current, { timeoutMs: 60_000 })
    },
  }
}
