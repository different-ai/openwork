/**
 * What an OpenWork MCP Apps host needs, wherever it runs (the desktop app, Workbot): the launch reference OpenWork
 * Connect puts on a tool result, which tools a view may see and call, the resource policy an App declares, and the
 * HTML its sandbox receives. The desktop's local server keeps its own copy of the server-side rules, because the
 * packaged server cannot load this package at runtime.
 */

/** OpenWork Connect's key on a tool result's `_meta`: the App that result opens. */
export const MCP_APP_LAUNCH_META_KEY = "openwork/mcpApp"

/**
 * Which App a tool result opens: `toolName` on the connection `connectionId` (an App built in OpenWork is its own
 * connection) declared `resourceUri`, and the App receives `arguments` as its tool input. Without `connectionId` the
 * App lives on OpenWork Connect itself.
 */
export type McpAppLaunch = {
  connectionId?: string
  toolName: string
  resourceUri: string
  arguments: Record<string, unknown>
}

/** The sources an App's page may load from or connect to; everything else is refused. */
export type McpAppCsp = {
  connectDomains: string[]
  resourceDomains: string[]
  frameDomains: string[]
  baseUriDomains: string[]
}

/** The tool fields these rules read; any MCP tool definition fits. */
export type McpAppHostTool = {
  name: string
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
  _meta?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The launch on a tool result's `_meta`, or null when it opens no App. */
export function parseMcpAppLaunch(meta: unknown): McpAppLaunch | null {
  if (!isRecord(meta) || !isRecord(meta[MCP_APP_LAUNCH_META_KEY])) return null
  const launch = meta[MCP_APP_LAUNCH_META_KEY]
  if ((launch.connectionId !== undefined && typeof launch.connectionId !== "string")
    || typeof launch.toolName !== "string"
    || typeof launch.resourceUri !== "string"
    || !isRecord(launch.arguments)) return null
  return {
    ...(typeof launch.connectionId === "string" ? { connectionId: launch.connectionId } : {}),
    toolName: launch.toolName,
    resourceUri: launch.resourceUri,
    arguments: launch.arguments,
  }
}

function toolUi(tool: McpAppHostTool): Record<string, unknown> {
  return isRecord(tool._meta) && isRecord(tool._meta.ui) ? tool._meta.ui : {}
}

/** The `ui://` page a tool declares (`_meta.ui.resourceUri`, or the older `_meta["ui/resourceUri"]`), if any. */
export function toolUiResourceUri(tool: McpAppHostTool): string | null {
  const nested = toolUi(tool).resourceUri
  const legacy = isRecord(tool._meta) ? tool._meta["ui/resourceUri"] : undefined
  const uri = typeof nested === "string" ? nested : typeof legacy === "string" ? legacy : null
  return uri?.startsWith("ui://") ? uri : null
}

/** Whether the model may see a tool. A tool that says nothing is visible to both the model and Apps. */
export function toolVisibleToModel(tool: McpAppHostTool): boolean {
  const visibility = toolUi(tool).visibility
  return visibility === undefined || (Array.isArray(visibility) && visibility.includes("model"))
}

/** Whether an App's view may call a tool. */
export function toolVisibleToApp(tool: McpAppHostTool): boolean {
  const visibility = toolUi(tool).visibility
  return visibility === undefined || (Array.isArray(visibility) && visibility.includes("app"))
}

/** A view runs only read-only, non-destructive tools on its own; anything else needs the person's click. */
export function toolRequiresApproval(tool: McpAppHostTool): boolean {
  return tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint === true
}

export class McpAppResourceError extends Error {
  constructor(readonly code: "invalid_resource" | "invalid_resource_csp" | "unsupported_resource_permissions", message: string) {
    super(message)
    this.name = "McpAppResourceError"
  }
}

const MAX_CSP_DOMAINS = 16

function cspOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null
    if (url.protocol === "https:") return url.origin
    if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return url.origin
  } catch {
    return null
  }
  return null
}

function cspDomains(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_CSP_DOMAINS) {
    throw new McpAppResourceError("invalid_resource_csp", `An App's CSP lists at most ${MAX_CSP_DOMAINS} origins each.`)
  }
  const origins = value.map(cspOrigin)
  if (origins.some((origin) => origin === null)) {
    throw new McpAppResourceError("invalid_resource_csp", "An App's CSP origins must be HTTPS (or loopback HTTP) origins.")
  }
  return [...new Set(origins.filter((origin) => origin !== null))]
}

/**
 * The policy an App's `ui://` resource declares in `_meta.ui`: where its page may load from and whether it wants a
 * border. Device permissions and a dedicated origin are refused, because no OpenWork host grants them.
 */
export function parseMcpAppResourceMeta(meta: unknown): { csp: McpAppCsp; prefersBorder: boolean } {
  const ui = isRecord(meta) && isRecord(meta.ui) ? meta.ui : {}
  const csp = isRecord(ui.csp) ? ui.csp : {}
  const permissions = isRecord(ui.permissions) ? ui.permissions : {}
  if (Object.keys(permissions).length > 0 || ui.domain !== undefined) {
    throw new McpAppResourceError("unsupported_resource_permissions", "OpenWork doesn't grant Apps device permissions or their own origin.")
  }
  return {
    csp: {
      connectDomains: cspDomains(csp.connectDomains),
      resourceDomains: cspDomains(csp.resourceDomains),
      frameDomains: cspDomains(csp.frameDomains),
      baseUriDomains: cspDomains(csp.baseUriDomains),
    },
    prefersBorder: ui.prefersBorder !== false,
  }
}

/** The Content Security Policy an App's page runs under: nothing beyond what the App declared. */
export function buildMcpAppCsp(app: { csp: McpAppCsp }): string {
  const resources = app.csp.resourceDomains.join(" ")
  const withResources = (source: string) => resources ? `${source} ${resources}` : source
  const sourceList = (values: string[]) => values.length ? values.join(" ") : "'none'"
  return [
    "default-src 'none'",
    `script-src ${withResources("'unsafe-inline'")}`,
    `style-src ${withResources("'unsafe-inline'")}`,
    `img-src ${withResources("data: blob:")}`,
    `font-src ${withResources("data:")}`,
    `media-src ${withResources("blob:")}`,
    `connect-src ${sourceList(app.csp.connectDomains)}`,
    `frame-src ${sourceList(app.csp.frameDomains)}`,
    `base-uri ${sourceList(app.csp.baseUriDomains)}`,
    "object-src 'none'",
    "form-action 'none'",
  ].join("; ")
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
}

/** Where the first `<name>` or `<name …>` opening tag starts and ends; one forward scan, no backtracking. */
function findOpeningTag(html: string, pattern: RegExp): { index: number; end: number } | null {
  const start = pattern.exec(html)
  if (!start) return null
  const close = html.indexOf(">", start.index)
  return close < 0 ? null : { index: start.index, end: close + 1 }
}

/** The App's HTML with its policy placed first in `<head>`, so nothing in the page runs before the policy applies. */
export function secureMcpAppHtml(app: { html: string; csp: McpAppCsp }): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(buildMcpAppCsp(app))}">`
  const html = findOpeningTag(app.html, /<html(?=[\s>])/i)
  if (html) {
    const prefix = app.html.slice(0, html.index).replace(/^\uFEFF/, "").trim()
    if (prefix && !/^<!doctype\s+html\s*>$/i.test(prefix)) {
      throw new McpAppResourceError("invalid_resource", "The MCP App document contains executable markup before its HTML root.")
    }
    const htmlEnd = html.end
    const head = findOpeningTag(app.html, /<head(?=[\s>])/i)
    if (head) {
      if (head.index < htmlEnd || app.html.slice(htmlEnd, head.index).trim()) {
        throw new McpAppResourceError("invalid_resource", "The MCP App document contains markup before its policy-bearing head.")
      }
      const headEnd = head.end
      return `${app.html.slice(0, headEnd)}${meta}${app.html.slice(headEnd)}`
    }
    const body = findOpeningTag(app.html, /<body(?=[\s>])/i)
    if (body && (body.index < htmlEnd || app.html.slice(htmlEnd, body.index).trim())) {
      throw new McpAppResourceError("invalid_resource", "The MCP App document contains markup before its policy-bearing head.")
    }
    return `${app.html.slice(0, htmlEnd)}<head>${meta}</head>${app.html.slice(htmlEnd)}`
  }
  return `<!doctype html><html><head>${meta}</head><body>${app.html}</body></html>`
}
