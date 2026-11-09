import { env } from "../env.js"
import { isPublicMcpAppSite } from "../mcp-apps.js"

/**
 * A browser opening an App's MCP URL: a GET that asks for HTML and carries no
 * credentials. MCP clients send POST, or GET for an event stream, so they
 * never match and keep getting the answers they got before.
 */
export function wantsAppSite(request: Request): boolean {
  return request.method === "GET"
    && !request.headers.has("authorization")
    && (request.headers.get("accept") ?? "").includes("text/html")
}

/**
 * The page's script: a small MCP client and MCP Apps host. It talks to the
 * same URL it was served from, loads the App's HTML into a sandboxed frame,
 * and answers the frame's requests. It holds no App content itself.
 */
const SITE_SCRIPT = `
(() => {
  const root = document.documentElement
  const mode = root.dataset.mode
  const frame = document.getElementById("app")
  const status = document.getElementById("status")
  const endpoint = location.pathname
  let token = null
  let nextId = 1
  let opened = null
  let tools = []

  const show = (text) => { status.textContent = text; status.hidden = false; frame.hidden = true }

  async function rpc(method, params) {
    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "omit",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: "Bearer " + token, "x-openwork-app-site": "1" } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params: params || {} }),
    })
    const text = await response.text()
    const line = text.split("\\n").find((entry) => entry.startsWith("data:"))
    let message = null
    try { message = JSON.parse(line ? line.slice(5) : text) } catch { message = null }
    if (!message || message.error || !("result" in message)) {
      throw new Error(message && message.error && message.error.message || "This App is not available.")
    }
    return message.result
  }

  const post = (message) => frame.contentWindow.postMessage({ jsonrpc: "2.0", ...message }, "*")
  const theme = () => matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"

  // A tool the server does not mark read-only runs only after the person agrees, once per call.
  function allowed(name) {
    const tool = tools.find((entry) => entry.name === name)
    if (!tool) return false
    if (tool.annotations && tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint !== true) return true
    return confirm(document.title + " wants to run \\u201c" + (tool.title || tool.name) + "\\u201d. Allow it?")
  }

  async function answer(message) {
    const reply = (result) => post({ id: message.id, result })
    const refuse = (text) => post({ id: message.id, error: { code: -32000, message: text } })
    const params = message.params || {}
    switch (message.method) {
      case "ui/initialize":
        return reply({
          protocolVersion: params.protocolVersion || "2026-01-26",
          hostInfo: { name: "OpenWork App site", version: "1.0.0" },
          hostCapabilities: { serverTools: {}, openLinks: {}, logging: {} },
          hostContext: {
            theme: theme(),
            displayMode: "fullscreen",
            availableDisplayModes: ["fullscreen"],
            platform: "web",
            locale: navigator.language,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
        })
      case "ui/notifications/initialized":
        post({ method: "ui/notifications/tool-input", params: { arguments: { input: {} } } })
        return post({ method: "ui/notifications/tool-result", params: opened })
      case "tools/call":
        if (!allowed(params.name)) return refuse("This tool was not run.")
        try { return reply(await rpc("tools/call", { name: params.name, arguments: params.arguments || {} })) }
        catch (error) { return refuse(error.message) }
      case "ui/open-link": {
        let url = null
        try { url = new URL(params.url) } catch { url = null }
        if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return refuse("Only web links can be opened.")
        if (!confirm("Open " + url.href + " ?")) return reply({ isError: true })
        window.open(url.href, "_blank", "noopener,noreferrer")
        return reply({})
      }
      case "ping":
        return reply({})
      default:
        if (message.id !== undefined) refuse("This page does not support that request.")
    }
  }

  addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return
    const message = event.data
    if (message && message.jsonrpc === "2.0" && typeof message.method === "string") void answer(message)
  })

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (opened) post({ method: "ui/notifications/host-context-changed", params: { theme: theme() } })
  })

  async function start() {
    if (mode === "member") {
      const minted = await fetch("/v1/mcp/token", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
      }).catch(() => null)
      if (!minted || !minted.ok) {
        status.textContent = "Sign in to OpenWork in this browser to open this App, then reload this page. "
        const link = document.createElement("a")
        link.href = root.dataset.signIn
        link.textContent = "Sign in"
        status.append(link)
        return
      }
      token = (await minted.json()).token
    }
    tools = (await rpc("tools/list")).tools || []
    const launch = tools.find((tool) => tool.name === "open_app")
    const uri = launch && launch._meta && launch._meta.ui && launch._meta.ui.resourceUri
    if (!uri) throw new Error("This App is not available.")
    opened = await rpc("tools/call", { name: "open_app", arguments: { input: {} } })
    const resource = await rpc("resources/read", { uri })
    const html = resource.contents && resource.contents[0] && resource.contents[0].text
    if (typeof html !== "string") throw new Error("This App is not available.")
    const title = opened.structuredContent && opened.structuredContent.app && opened.structuredContent.app.title
    if (typeof title === "string") document.title = title
    status.hidden = true
    frame.hidden = false
    frame.srcdoc = html
  }

  start().catch((error) => show(error.message || "This App is not available."))
})()
`.trim()

function escapeAttribute(value: string): string {
  return value.replace(/[&"<>]/gu, (char) => `&#${char.charCodeAt(0)};`)
}

/**
 * The frame has no `allow-same-origin`, so the App's HTML runs on an opaque
 * origin and cannot read this origin's cookies or the page's token. The page's
 * policy must allow inline scripts because a srcdoc frame inherits it; the
 * App's HTML then narrows itself with its own hash-only policy. Nothing
 * untrusted is written into this page.
 */
const SITE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ")

function sitePage(mode: "public" | "member"): string {
  return `<!doctype html><html lang="en" data-mode="${mode}" data-sign-in="${escapeAttribute(env.webUrl)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>OpenWork App</title><style>html,body{margin:0;height:100%}body{font:15px system-ui,sans-serif;color-scheme:light dark}#app{display:block;width:100%;height:100%;border:0}#status{margin:0;padding:24px}</style></head><body><p id="status" role="status">Opening…</p><iframe id="app" title="App" sandbox="allow-scripts allow-forms" hidden></iframe><script>${SITE_SCRIPT}</script></body></html>`
}

/** Sent by the page on its signed-in requests, so the App's server refuses an App that was not made a site. */
export const APP_SITE_HEADER = "x-openwork-app-site"

/**
 * The site page for a browser at an App's MCP URL, or null so the caller
 * answers as it did before.
 *
 * At the public URL the page is served only for an App that is public and a
 * site. At the signed-in URL nobody has signed in yet, so the App is not
 * looked up at all: every App id gets the same page, which says nothing about
 * whether the App exists. Once the visitor has signed in, the App's server
 * decides whether they may open it as a site.
 */
export async function appSiteResponse(input: { appIdOrName: string; publicOnly: boolean }): Promise<Response | null> {
  if (!env.appMcpServersEnabled) return null
  if (input.publicOnly && !await isPublicMcpAppSite({ appIdOrName: input.appIdOrName })) return null
  return new Response(sitePage(input.publicOnly ? "public" : "member"), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": SITE_CSP,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  })
}
