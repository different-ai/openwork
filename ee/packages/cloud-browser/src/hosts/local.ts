import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readBrowserVersion, withBrowser } from "../cdp"
import { CloudBrowserError, browserKeyId, type BrowserEndpoint, type BrowserHost, type BrowserKey } from "../contract"

/**
 * Runs each member's browser as a local Chrome or Chromium process with its
 * own profile folder. For development and tests; Den deployments use a
 * private box such as the Daytona host.
 */
export type LocalBrowserHostOptions = {
  /** Chrome or Chromium binary; defaults to CHROME_PATH or a well-known install path. */
  chromePath?: string
  /** One profile folder per member lives here (default: the OS temp folder). */
  profileRoot?: string
  windowSize?: { width: number; height: number }
  extraArgs?: readonly string[]
  startTimeoutMs?: number
}

export type LocalBrowserHost = BrowserHost & {
  /** Stops every browser this host started. */
  close(): Promise<void>
}

const KNOWN_CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
]

/** The configured or first installed Chrome, or `null`. */
export function findChrome(configured: string | undefined = process.env.CHROME_PATH): string | null {
  if (configured?.trim()) return existsSync(configured.trim()) ? configured.trim() : null
  return KNOWN_CHROME_PATHS.find((path) => existsSync(path)) ?? null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Running = { child: ChildProcess | null; endpoint: BrowserEndpoint }

export function createLocalBrowserHost(options: LocalBrowserHostOptions = {}): LocalBrowserHost {
  const profileRoot = options.profileRoot ?? join(tmpdir(), "openwork-cloud-browser")
  const windowSize = options.windowSize ?? { width: 1280, height: 800 }
  const startTimeoutMs = options.startTimeoutMs ?? 20_000
  const running = new Map<string, Running>()
  const starting = new Map<string, Promise<BrowserEndpoint>>()

  async function answers(endpoint: BrowserEndpoint): Promise<boolean> {
    return readBrowserVersion(endpoint, { timeoutMs: 2_000 }).then(() => true, () => false)
  }

  async function activePort(profileDir: string): Promise<string | null> {
    const text = await readFile(join(profileDir, "DevToolsActivePort"), "utf8").catch(() => "")
    const port = text.split("\n")[0]?.trim() ?? ""
    return /^\d+$/.test(port) ? port : null
  }

  function endpointFor(port: string): BrowserEndpoint {
    return { cdpUrl: `http://127.0.0.1:${port}`, headers: {}, expiresAt: null }
  }

  async function launch(id: string, signal: AbortSignal | undefined): Promise<BrowserEndpoint> {
    const chromePath = findChrome(options.chromePath)
    if (!chromePath) throw new CloudBrowserError("browser_unavailable", "No Chrome or Chromium binary was found; set CHROME_PATH.")
    const profileDir = join(profileRoot, id)
    await mkdir(profileDir, { recursive: true })
    // A browser left running by an earlier process keeps working with the same profile.
    const previous = await activePort(profileDir)
    if (previous && await answers(endpointFor(previous))) {
      const endpoint = endpointFor(previous)
      running.set(id, { child: null, endpoint })
      return endpoint
    }
    await rm(join(profileDir, "DevToolsActivePort"), { force: true })
    const args = [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--password-store=basic",
      "--use-mock-keychain",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      `--window-size=${windowSize.width},${windowSize.height}`,
      ...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : []),
      ...(options.extraArgs ?? []),
      "about:blank",
    ]
    const child = spawn(chromePath, args, { stdio: "ignore" })
    let exited = false
    child.once("exit", () => {
      exited = true
      if (running.get(id)?.child === child) running.delete(id)
    })
    const started = Date.now()
    while (Date.now() - started < startTimeoutMs) {
      if (signal?.aborted || exited) break
      const port = await activePort(profileDir)
      if (port && await answers(endpointFor(port))) {
        const endpoint = endpointFor(port)
        running.set(id, { child, endpoint })
        return endpoint
      }
      await sleep(100)
    }
    child.kill("SIGKILL")
    throw new CloudBrowserError("browser_start_failed", exited ? "Chrome exited while starting." : "Chrome did not start in time.")
  }

  async function peek(key: BrowserKey): Promise<BrowserEndpoint | null> {
    const id = browserKeyId(key)
    const current = running.get(id)
    if (current && await answers(current.endpoint)) return current.endpoint
    running.delete(id)
    // A browser an earlier Den process started is still this member's browser.
    const previous = await activePort(join(profileRoot, id))
    if (previous && await answers(endpointFor(previous))) {
      const endpoint = endpointFor(previous)
      running.set(id, { child: null, endpoint })
      return endpoint
    }
    return null
  }

  async function stopId(id: string) {
    const current = running.get(id)
    if (!current) return
    running.delete(id)
    // Graceful close writes cookies and the rest of the profile to disk.
    await withBrowser(current.endpoint, (cdp) => cdp.send("Browser.close", {}, { timeoutMs: 5_000 }), { timeoutMs: 5_000 }).catch(() => undefined)
    const child = current.child
    if (!child || child.exitCode !== null) return
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    const deadline = sleep(5_000).then(() => "timeout" as const)
    if (await Promise.race([exited.then(() => "exited" as const), deadline]) === "timeout") child.kill("SIGKILL")
  }

  return {
    id: "local",
    async open(key, openOptions = {}) {
      const existing = await peek(key)
      if (existing) return existing
      const id = browserKeyId(key)
      const pending = starting.get(id)
      if (pending) return pending
      const launching = launch(id, openOptions.signal).finally(() => starting.delete(id))
      starting.set(id, launching)
      return launching
    },
    peek,
    async stop(key) {
      await stopId(browserKeyId(key))
    },
    async close() {
      await Promise.all([...running.keys()].map((id) => stopId(id)))
    },
  }
}
