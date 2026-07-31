import { normalize, resolve, sep } from "node:path";

// The `openwork-app://` protocol.
//
// Every byte an installed app loads comes through here, and this is the only
// way its content can be reached. Resolution is pure and total so it can be
// tested exhaustively: given a URL it returns either a concrete file path inside
// that app's own install directory, or a reason it was refused.
//
// The rules are deliberately narrow:
//
//   openwork-app://<appId>/<path>
//
// The authority is the app id and nothing else. An app can only ever address
// files inside its own installed version — there is no syntax for reaching
// another app, another version, or anywhere else on the disk.

/** Only these extensions are servable. An app cannot ship a `.node` and load it. */
const ALLOWED_EXTENSIONS = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".map", "application/json; charset=utf-8"],
])

export const APP_PROTOCOL = "openwork-app"

const APP_ID = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/

/**
 * Resolve a protocol URL to a file on disk.
 *
 * `installedApps` maps app id to the absolute directory of its **active**
 * version. An app not in that map is not running, so its URLs resolve to
 * nothing — that is what makes disabling an app cut off its content instantly
 * rather than eventually.
 */
export function resolveAppUrl(rawUrl, installedApps) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, reason: "invalid_url" }
  }
  if (url.protocol !== `${APP_PROTOCOL}:`) return { ok: false, reason: "wrong_protocol" }

  const appId = url.hostname
  if (!APP_ID.test(appId)) return { ok: false, reason: "invalid_app_id" }

  const root = installedApps.get(appId)
  if (!root) return { ok: false, reason: "app_not_running" }

  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return { ok: false, reason: "invalid_path" }
  }
  // A NUL or a backslash is never legitimate here, and both are classic ways to
  // make a path mean one thing to a check and another to the filesystem.
  if (pathname.includes("\0") || pathname.includes("\\")) {
    return { ok: false, reason: "invalid_path" }
  }

  const relative = pathname.replace(/^\/+/, "")
  const target = relative === "" ? "index.html" : relative
  if (target.split("/").some((segment) => segment === "." || segment === "..")) {
    return { ok: false, reason: "path_traversal" }
  }

  const extension = extensionOf(target)
  const mimeType = ALLOWED_EXTENSIONS.get(extension)
  if (!mimeType) return { ok: false, reason: "unsupported_type" }

  const absoluteRoot = resolve(root)
  const absolute = resolve(absoluteRoot, normalize(target))
  // Belt and braces: even after the segment check, the resolved path must sit
  // under the root. A symlink planted inside the install directory would be
  // caught by the reader that verified the package, but this costs nothing.
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${sep}`)) {
    return { ok: false, reason: "path_traversal" }
  }

  return { ok: true, path: absolute, mimeType }
}

function extensionOf(target) {
  const name = target.slice(target.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  return dot === -1 ? "" : name.slice(dot).toLowerCase()
}

/**
 * Content-Security-Policy for an app surface.
 *
 * `default-src 'none'` is the starting point, and everything else is added back
 * only because something genuinely needs it. Notably absent: `unsafe-eval`,
 * `object-src`, `frame-src`, and any wildcard origin.
 *
 * `connectHosts` are exactly the hosts the app's `network.host` permission
 * names. An app with no network permission gets no `connect-src` at all.
 */
export function buildContentSecurityPolicy(appId, connectHosts) {
  const origin = `${APP_PROTOCOL}://${appId}`
  const connect = connectHosts.map((host) => `https://${host} wss://${host}`).join(" ")
  return [
    "default-src 'none'",
    `script-src ${origin}`,
    // Inline styles are how most UI frameworks apply dynamic layout. Inline
    // *scripts* remain forbidden, which is the part that matters.
    `style-src ${origin} 'unsafe-inline'`,
    `img-src ${origin} data: blob:`,
    `font-src ${origin} data:`,
    `media-src ${origin} blob:`,
    connect ? `connect-src ${connect}` : "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "worker-src blob:",
  ].join("; ")
}

/**
 * Whether a surface may navigate to a URL.
 *
 * Only same-app protocol URLs. External links are not blocked *and* silently
 * dropped: the caller opens them in the user's browser instead, so a legitimate
 * link still works without the app ever leaving its sandbox.
 */
export function isPermittedNavigation(rawUrl, appId) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  return url.protocol === `${APP_PROTOCOL}:` && url.hostname === appId
}

/**
 * Whether a network request from an app surface may proceed.
 *
 * Enforced at the session level, so it holds for fetch, XHR, WebSocket, images,
 * and anything else the renderer can originate — not only what CSP covers.
 */
export function isPermittedRequest(rawUrl, appId, allowedHosts) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.protocol === `${APP_PROTOCOL}:`) return url.hostname === appId
  // devtools and blob/data URLs the renderer creates for itself.
  if (url.protocol === "devtools:" || url.protocol === "blob:" || url.protocol === "data:") return true
  if (url.protocol !== "https:" && url.protocol !== "wss:") return false
  // Exact host match only. No wildcards, no suffix matching: `evil-openai.com`
  // must never satisfy a permission for `api.openai.com`.
  return allowedHosts.includes(url.hostname)
}

export const APP_PROTOCOL_PRIVILEGES = Object.freeze({
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: false,
  stream: true,
})
