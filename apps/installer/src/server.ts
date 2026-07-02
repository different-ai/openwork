import { randomBytes } from "node:crypto"

import type { InstallerConfig } from "./config"
import { installStatus, launchInstalledApp, runInstall } from "./install"
import { renderInstallerHtml } from "./ui-html"

export type InstallerServer = {
  url: string
  token: string
  stop: () => void
}

/**
 * Loopback-only UI/control server. Mutating routes require the per-process
 * token embedded in the served page so other local processes can't drive the
 * installer.
 */
export function startInstallerServer(config: InstallerConfig, onExit: () => void): InstallerServer {
  const token = randomBytes(16).toString("hex")

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/") {
        return new Response(renderInstallerHtml(config, token), {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      }

      if (url.pathname.startsWith("/api/")) {
        if (request.headers.get("x-installer-token") !== token) {
          return Response.json({ error: "forbidden" }, { status: 403 })
        }
        if (request.method === "GET" && url.pathname === "/api/status") {
          return Response.json(installStatus())
        }
        if (request.method === "POST" && url.pathname === "/api/install") {
          void runInstall(config)
          return Response.json({ ok: true })
        }
        if (request.method === "POST" && url.pathname === "/api/launch") {
          const installedPath = installStatus().installedPath
          if (!installedPath) return Response.json({ error: "not_installed" }, { status: 409 })
          launchInstalledApp(installedPath)
          return Response.json({ ok: true })
        }
        if (request.method === "POST" && url.pathname === "/api/exit") {
          setTimeout(onExit, 50)
          return Response.json({ ok: true })
        }
      }
      return new Response("Not found", { status: 404 })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}/`,
    token,
    stop: () => server.stop(true),
  }
}
