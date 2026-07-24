import { randomBytes } from "node:crypto"

import { installerConfigSourceLabel, parseInstallLinkInput, resolveInstallLinkConfig, type InstallerConfigResolution } from "./config"
import { installStatus, launchInstalledApp, runInstall } from "./install"
import { loadSystemCaCertificates } from "./system-ca"
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
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function installLinkFromPayload(value: unknown) {
  if (!isRecord(value)) {
    return ""
  }
  const installLink = value.installLink
  return typeof installLink === "string" ? installLink.trim() : ""
}

function tlsUntrustedMessage(installLink: string): string {
  const host = parseInstallLinkInput(installLink)?.host
  const certificateTarget = host ? `the certificate for ${host}` : "the workspace certificate"
  return `Reached your workspace, but the secure connection isn't trusted on this computer yet. This usually means your company inspects secure traffic. Try again — if it keeps failing, ask IT to check ${certificateTarget}.`
}

export function startInstallerServer(initialResolution: InstallerConfigResolution | null, onExit: () => void): InstallerServer {
  const token = randomBytes(16).toString("hex")
  let resolution = initialResolution
  // Warm the OS trust-store CA cache now so the first resolve-link fetch does
  // not spend its 10s abort budget waiting on PowerShell/security exports.
  void loadSystemCaCertificates()

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/") {
        return new Response(renderInstallerHtml(resolution, token), {
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
        if (request.method === "POST" && url.pathname === "/api/resolve-link") {
          const installLink = installLinkFromPayload(await request.json().catch(() => null))
          if (!installLink) {
            return Response.json({ error: "missing_install_link", message: "Paste an OpenWork install link." }, { status: 400 })
          }
          const result = await resolveInstallLinkConfig(installLink)
          if (result.status !== "resolved") {
            if (result.status === "not-found") {
              return Response.json({ error: "install_link_expired", message: "This install link has expired or was replaced. Ask your workspace admin for a fresh one from the Members page." }, { status: 400 })
            }
            if (result.status === "invalid-input") {
              return Response.json({ error: "install_link_invalid", message: "That doesn't look like an install link. On your team's install page, copy the link shown in step 2 — it ends with ?token=..." }, { status: 400 })
            }
            if (result.status === "unreachable") {
              if (result.reason === "tls") {
                return Response.json({ error: "install_link_tls_untrusted", message: tlsUntrustedMessage(installLink) }, { status: 400 })
              }
              return Response.json({ error: "install_link_unreachable", message: "Could not reach your workspace. Check your internet or VPN connection and try again." }, { status: 400 })
            }
            return Response.json({ error: "install_link_invalid", message: "Install link could not be resolved." }, { status: 400 })
          }
          resolution = { config: result.config, source: "install-link" }
          return Response.json({ ok: true, source: installerConfigSourceLabel(resolution.source) })
        }
        if (request.method === "POST" && url.pathname === "/api/install") {
          if (!resolution) {
            return Response.json({ error: "missing_config" }, { status: 409 })
          }
          void runInstall(resolution.config)
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
