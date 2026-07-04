import { installerConfigSourceLabel, resolveInstallerConfig } from "./config"
import { runInstall } from "./install"

const rawArgs = Bun.argv.slice(2)
const args = new Set(rawArgs)
const headless = args.has("--headless") || process.env.OPENWORK_INSTALLER_HEADLESS === "1"
const dryRun = args.has("--dry-run") || process.env.OPENWORK_INSTALLER_DRY_RUN === "1"

function argValue(name: string) {
  const inline = rawArgs.find((entry) => entry.startsWith(`${name}=`))
  if (inline) {
    return inline.slice(name.length + 1).trim()
  }
  const index = rawArgs.indexOf(name)
  return index >= 0 ? rawArgs[index + 1]?.trim() ?? "" : ""
}

if (headless) {
  const resolution = await resolveInstallerConfig({ installLink: argValue("--install-link") }).catch((error): never => {
    console.error(`[openwork-installer] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  })

  const { config, source } = resolution
  console.log(`OpenWork Installer — ${config.clientName}`)
  console.log(`[openwork-installer] Configured via ${installerConfigSourceLabel(source)}.`)
  const result = await runInstall(config, {
    dryRun,
    onStatus: (status) => {
      if (status.message) console.log(`[${status.step ?? status.state}] ${status.message}`)
    },
  })
  if (result.state === "error") {
    console.error(`Install failed: ${result.error}`)
    process.exit(1)
  }
  process.exit(0)
}

// UI mode. The HTTP server and install run live on a worker thread; the
// native window must own the main thread (Cocoa requires it on macOS, and
// Webview.run() blocks its thread until the window closes).
// Referenced as .js (not .ts): Bun's compiled executables embed the worker
// entrypoint as server-worker.js, and its rewrite of .ts worker URLs breaks
// when the worker shares imports with the main entrypoint. Bun's resolver
// maps the .js specifier back to server-worker.ts when running from source.
const worker = new Worker(new URL("./server-worker.js", import.meta.url))
const ready = await new Promise<{ url: string; token: string }>((resolve, reject) => {
  worker.onmessage = (event: MessageEvent<{ type: string; url?: string; token?: string; error?: string }>) => {
    if (event.data.type === "ready" && event.data.url && event.data.token) {
      resolve({ url: event.data.url, token: event.data.token })
    } else if (event.data.type === "error") {
      reject(new Error(event.data.error))
    }
  }
  worker.onerror = (event) => reject(new Error(event.message))
  worker.postMessage({ type: "start" })
}).catch((error) => {
  console.error(`[openwork-installer] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
})

async function installIsRunning(): Promise<boolean> {
  try {
    const response = await fetch(`${ready.url}api/status`, { headers: { "x-installer-token": ready.token } })
    const status: unknown = await response.json()
    return typeof status === "object" && status !== null && "state" in status && status.state === "running"
  } catch {
    return false
  }
}

async function exitWhenInstallSettles(): Promise<never> {
  // Window closed mid-install: let a running install finish before exiting.
  while (await installIsRunning()) {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  process.exit(0)
}

function openInBrowser(url: string) {
  const command = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url]
  Bun.spawn(command, { stdio: ["ignore", "ignore", "ignore"] })
}

if (process.env.OPENWORK_INSTALLER_UI === "manual") {
  // Manual UI mode: serve the installer UI without opening any window or
  // browser (headless CI, remote debugging, UI evals). The URL is printed so
  // the operator can attach their own browser.
  console.log(`[openwork-installer] UI ready at ${ready.url}`)
  worker.addEventListener("message", (event: MessageEvent<{ type: string }>) => {
    if (event.data.type === "exit") void exitWhenInstallSettles()
  })
} else {
try {
  const { Webview, SizeHint } = await import("webview-bun")
  const webview = new Webview(false, { width: 420, height: 440, hint: SizeHint.FIXED })
  webview.title = "OpenWork Installer"
  // The page's Exit button calls this bound global; terminating the run loop
  // is the only clean way to close the window from page JS.
  webview.bind("openworkInstallerExit", () => webview.destroy())
  webview.navigate(ready.url)
  webview.run()
  await exitWhenInstallSettles()
} catch (error) {
  // Native webview unavailable (e.g. no WebkitGTK): same UI in the browser.
  console.warn(`[openwork-installer] native window unavailable (${error instanceof Error ? error.message : String(error)}); opening browser UI`)
  openInBrowser(ready.url)
  worker.addEventListener("message", (event: MessageEvent<{ type: string }>) => {
    if (event.data.type === "exit") void exitWhenInstallSettles()
  })
}
}
