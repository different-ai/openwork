import { resolveInstallerConfig } from "./config"
import { runInstall } from "./install"

const args = new Set(Bun.argv.slice(2))
const headless = args.has("--headless") || process.env.OPENWORK_INSTALLER_HEADLESS === "1"
const dryRun = args.has("--dry-run") || process.env.OPENWORK_INSTALLER_DRY_RUN === "1"

let config
try {
  config = resolveInstallerConfig()
} catch (error) {
  console.error(`[openwork-installer] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}

if (headless) {
  console.log(`OpenWork Installer — ${config.clientName}`)
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
const worker = new Worker(new URL("./server-worker.ts", import.meta.url))
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
    const status = (await response.json()) as { state?: string }
    return status.state === "running"
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
