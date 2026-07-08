import { spawn } from "node:child_process"

import { installerConfigSourceLabel, resolveInstallerConfig, resolveOptionalInstallerConfig } from "./config"
import { runInstall } from "./install"
import { startInstallerServer } from "./server"

const rawArgs = Bun.argv.slice(2)
const args = new Set(rawArgs)
const headless = args.has("--headless") || process.env.OPENWORK_INSTALLER_HEADLESS === "1"
const dryRun = args.has("--dry-run") || process.env.OPENWORK_INSTALLER_DRY_RUN === "1"
const smokeExitMs = Number.parseInt(process.env.OPENWORK_INSTALLER_SMOKE_EXIT_MS ?? "", 10)

type ReadyServer = {
  url: string
  token: string
  onExit: (listener: () => void) => void
  stop: () => void
}

function argValue(name: string) {
  const inline = rawArgs.find((entry) => entry.startsWith(`${name}=`))
  if (inline) {
    return inline.slice(name.length + 1).trim()
  }
  const index = rawArgs.indexOf(name)
  return index >= 0 ? rawArgs[index + 1]?.trim() ?? "" : ""
}

function isReadyMessage(value: unknown): value is { type: "ready"; url: string; token: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "ready" &&
    "url" in value &&
    typeof value.url === "string" &&
    "token" in value &&
    typeof value.token === "string"
  )
}

function isExitMessage(value: unknown): value is { type: "exit" } {
  return typeof value === "object" && value !== null && "type" in value && value.type === "exit"
}

async function runServerProcess(): Promise<never> {
  try {
    const resolution = await resolveOptionalInstallerConfig()
    const server = startInstallerServer(resolution, () => console.log(JSON.stringify({ type: "exit" })))
    console.log(JSON.stringify({ type: "ready", url: server.url, token: server.token }))
  } catch (error) {
    console.error(`[openwork-installer] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
  return await new Promise<never>(() => undefined)
}

if (args.has("--server-worker")) {
  await runServerProcess()
}

function selfCommand() {
  const executable = Bun.argv[0] || process.execPath
  const script = Bun.argv[1]
  const virtualScript = script ? script.includes("$bunfs") || /[\\/]~BUN[\\/]/.test(script) : false
  if (virtualScript) return { command: process.execPath, args: [] }
  if (!script) return { command: executable, args: [] }
  return { command: executable, args: [script] }
}

async function startChildInstallerServer(): Promise<ReadyServer> {
  const command = selfCommand()
  const child = spawn(command.command, [...command.args, "--server-worker"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  const exitListeners = new Set<() => void>()
  let settled = false
  let stderr = ""
  let stdout = ""

  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
  })

  return await new Promise<ReadyServer>((resolve, reject) => {
    function fail(error: Error) {
      if (settled) return
      settled = true
      reject(error)
    }

    function handleLine(line: string) {
      if (!line) return
      let payload: unknown
      try {
        payload = JSON.parse(line)
      } catch {
        return
      }
      if (isExitMessage(payload)) {
        for (const listener of exitListeners) listener()
      }
      if (!isReadyMessage(payload) || settled) return
      settled = true
      resolve({
        url: payload.url,
        token: payload.token,
        onExit: (listener) => {
          exitListeners.add(listener)
        },
        stop: () => {
          child.kill()
        },
      })
    }

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
      let newline = stdout.indexOf("\n")
      while (newline >= 0) {
        handleLine(stdout.slice(0, newline).trim())
        stdout = stdout.slice(newline + 1)
        newline = stdout.indexOf("\n")
      }
    })
    child.on("error", (error) => fail(error))
    child.on("exit", (code) => {
      fail(new Error(`installer server exited before it was ready (${code ?? "signal"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`))
    })
  })
}

async function startWorkerInstallerServer(): Promise<ReadyServer> {
  // Referenced as .js (not .ts): Bun's compiled executables embed the worker
  // entrypoint as server-worker.js, and its rewrite of .ts worker URLs breaks
  // when the worker shares imports with the main entrypoint. Bun's resolver
  // maps the .js specifier back to server-worker.ts when running from source.
  const worker = new Worker(new URL("./server-worker.js", import.meta.url))
  return await new Promise<ReadyServer>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<{ type: string; url?: string; token?: string; error?: string }>) => {
      if (event.data.type === "ready" && event.data.url && event.data.token) {
        resolve({
          url: event.data.url,
          token: event.data.token,
          onExit: (listener) => {
            worker.addEventListener("message", (event: MessageEvent<{ type: string }>) => {
              if (event.data.type === "exit") listener()
            })
          },
          stop: () => {
            worker.terminate()
          },
        })
      } else if (event.data.type === "error") {
        reject(new Error(event.data.error))
      }
    }
    worker.onerror = (event) => reject(new Error(event.message))
    worker.postMessage({ type: "start" })
  })
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

// UI mode. The HTTP server and install run away from the native window's main
// thread because Webview.run() blocks until the window closes. Windows uses a
// child copy of this executable instead of Bun Worker: compiled Worker URLs can
// resolve to Bun's virtual B:/... filesystem there and fail before the server
// starts.
const uiServer = await (process.platform === "win32" ? startChildInstallerServer() : startWorkerInstallerServer()).catch((error) => {
  console.error(`[openwork-installer] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
})
const ready = { url: uiServer.url, token: uiServer.token }
process.on("exit", () => uiServer.stop())

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
  uiServer.stop()
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
  uiServer.onExit(() => void exitWhenInstallSettles())
} else {
try {
  const { Webview, SizeHint } = await import("webview-bun")
  const { lib } = await import("webview-bun/src/ffi")
  const webview = new Webview(false, { width: 420, height: 440, hint: SizeHint.FIXED })
  webview.title = "OpenWork Installer"
  // The page's Exit button calls this bound global. Only terminate the native
  // run loop here — run() destroys the webview after the loop exits.
  // Destroying inside the callback frees the executing FFI trampoline and
  // tears down the webview mid-dispatch (use-after-free; segfaults on
  // Windows, where WebView2 dispatches bindings from the Win32 message pump).
  webview.bind("openworkInstallerExit", () => {
    const handle = webview.unsafeHandle
    if (handle) lib.symbols.webview_terminate(handle)
  })
  if (Number.isFinite(smokeExitMs) && smokeExitMs > 0) {
    // Automated smoke: drive the exact production exit path (page JS -> bound
    // FFI callback) without a human click.
    webview.init(`setTimeout(() => { if (window.openworkInstallerExit) window.openworkInstallerExit(); }, ${smokeExitMs})`)
  }
  webview.navigate(ready.url)
  webview.run()
  await exitWhenInstallSettles()
} catch (error) {
  // Native webview unavailable (e.g. no WebkitGTK): same UI in the browser.
  if (Number.isFinite(smokeExitMs) && smokeExitMs > 0) {
    console.error("[openwork-installer] smoke mode: native webview unavailable")
    process.exit(3)
  }
  console.warn(`[openwork-installer] native window unavailable (${error instanceof Error ? error.message : String(error)}); opening browser UI`)
  openInBrowser(ready.url)
  uiServer.onExit(() => void exitWhenInstallSettles())
}
}
