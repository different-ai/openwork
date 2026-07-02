// Owns the UI/control HTTP server and the install run. Lives on a worker
// thread because the native window must own the process main thread on macOS
// (Cocoa aborts with SIGTRAP when windows are created off-main-thread), and
// Webview.run() blocks whichever thread it runs on.
import { resolveInstallerConfig } from "./config"
import { startInstallerServer } from "./server"

declare var self: Worker

self.onmessage = (event: MessageEvent<{ type: string }>) => {
  if (event.data.type !== "start") return
  try {
    const config = resolveInstallerConfig()
    const server = startInstallerServer(config, () => postMessage({ type: "exit" }))
    postMessage({ type: "ready", url: server.url, token: server.token })
  } catch (error) {
    postMessage({ type: "error", error: error instanceof Error ? error.message : String(error) })
  }
}
